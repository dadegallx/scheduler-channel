#!/usr/bin/env bun
/**
 * scheduler-channel — cron-driven channel for Claude Code.
 *
 * Reads job specs from $SCHEDULER_STATE_DIR/jobs.json, registers croner
 * timers for each enabled job, and on each fire spawns a self-contained
 * `claude -p` subprocess. The result is emitted to the parent session as
 * a notifications/claude/channel event.
 *
 * One-way channel — no tools, no permission relay. Replies happen via the
 * subprocess and whatever other MCPs it loads (e.g. telegram).
 *
 * CLI mode: `bun server.ts --fire-now <name>` runs one job synchronously,
 * prints a summary to stdout, exits 0/1/2.
 *
 * Test-only env: SCHEDULER_CLAUDE_BIN overrides the spawned binary,
 * SCHEDULER_CLAUDE_ARGV_MODE=shell uses `-c <prompt>`, and in shell mode
 * a `test/fire` JSON-RPC notification triggers fireJob directly.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import chokidar from 'chokidar'
import { loadJobs, type Job } from './src/schema'
import { makeCron, type Cron } from './src/cron'
import { buildArgv } from './src/argv'

const STATE_DIR = process.env.SCHEDULER_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'scheduler')
const JOBS_FILE = join(STATE_DIR, 'jobs.json')
const LOGS_DIR = join(STATE_DIR, 'logs')
const LOCKS_DIR = join(STATE_DIR, 'locks')
const CLAUDE_BIN = process.env.SCHEDULER_CLAUDE_BIN ?? 'claude'
const SHELL_MODE = process.env.SCHEDULER_CLAUDE_ARGV_MODE === 'shell'
const TEST_HOOKS = SHELL_MODE // test fire hook only active under shell mode

mkdirSync(STATE_DIR, { recursive: true })
mkdirSync(LOGS_DIR, { recursive: true })
mkdirSync(LOCKS_DIR, { recursive: true })

type RunResult = {
  status: 'ok' | 'error'
  exit_code: number
  reason?: 'timeout'
  duration_ms: number
  stdout: string
  stderr: string
  cost_usd?: number
}

function buildSpawnArgv(job: Job): string[] {
  if (SHELL_MODE) return ['-c', job.prompt]
  return buildArgv(job)
}

async function runSubprocess(job: Job): Promise<RunResult> {
  const start = Date.now()
  const proc = Bun.spawn({
    cmd: [CLAUDE_BIN, ...buildSpawnArgv(job)],
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  })

  let timedOut = false
  const killer = setTimeout(() => {
    timedOut = true
    try { proc.kill('SIGKILL') } catch {}
  }, job.timeout_seconds * 1000)

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  clearTimeout(killer)

  const duration_ms = Date.now() - start
  const exit_code = proc.exitCode ?? -1
  // claude -p --output-format json prints a JSON blob; try to pull cost.
  let cost_usd: number | undefined
  try {
    const p = JSON.parse(stdout)
    cost_usd = typeof p?.cost_usd === 'number' ? p.cost_usd
      : typeof p?.total_cost_usd === 'number' ? p.total_cost_usd : undefined
  } catch {}

  const status = timedOut || exit_code !== 0 ? 'error' : 'ok'
  return {
    status, exit_code, duration_ms, stdout, stderr, cost_usd,
    ...(timedOut ? { reason: 'timeout' as const } : {}),
  }
}

function deriveContent(job: Job, r: RunResult): string {
  if (r.status === 'error') {
    if (r.reason === 'timeout') return `timed out after ${job.timeout_seconds}s`
    const lastErr = r.stderr.trim().split('\n').filter(Boolean).pop()
    return lastErr || `exited ${r.exit_code}`
  }
  if (job.report_back === 'full') {
    return r.stdout.trim() || '(no output)'
  }
  // summary: prefer JSON "result" field, else first non-empty stdout line
  try {
    const parsed = JSON.parse(r.stdout)
    if (typeof parsed?.result === 'string' && parsed.result.trim()) {
      return parsed.result.trim()
    }
  } catch {}
  const firstLine = r.stdout.trim().split('\n').filter(Boolean)[0]
  return firstLine || '(no output)'
}

function buildMeta(job: Job, r: RunResult): Record<string, string> {
  const meta: Record<string, string> = {
    job: job.name,
    status: r.status,
    duration: `${Math.round(r.duration_ms / 1000)}s`,
  }
  if (r.status === 'error') {
    meta.exit_code = String(r.exit_code)
    if (r.reason) meta.reason = r.reason
  }
  if (typeof r.cost_usd === 'number') meta.cost_usd = String(r.cost_usd)
  return meta
}

function lockPath(name: string): string { return join(LOCKS_DIR, name) }

function tryAcquireLock(name: string): boolean {
  const path = lockPath(name)
  if (existsSync(path)) return false
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

function releaseLock(name: string): void {
  try { rmSync(lockPath(name), { force: true }) } catch {}
}

function writeLog(name: string, payload: object): void {
  const dir = join(LOGS_DIR, name)
  mkdirSync(dir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(join(dir, `${ts}.json`), JSON.stringify(payload, null, 2))
}

function rewriteJobs(remaining: Job[]): void {
  const tmp = JOBS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify({ jobs: remaining }, null, 2) + '\n')
  renameSync(tmp, JOBS_FILE)
}

const inFlight = new Set<Promise<void>>()

async function fireJob(job: Job, mcp: Server | null): Promise<RunResult | null> {
  if (!tryAcquireLock(job.name)) {
    process.stderr.write(`scheduler: ${job.name} skipped — lock held\n`)
    return null
  }
  let result: RunResult
  try {
    result = await runSubprocess(job)
  } catch (err) {
    result = {
      status: 'error',
      exit_code: -1,
      duration_ms: 0,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }
  } finally {
    releaseLock(job.name)
  }

  writeLog(job.name, {
    job: job.name,
    fired_at: new Date().toISOString(),
    ...result,
  })

  if (job.report_back !== 'silent' && mcp) {
    const content = deriveContent(job, result)
    const meta = buildMeta(job, result)
    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    }).catch(err => {
      process.stderr.write(`scheduler: notification failed: ${err}\n`)
    })
  }

  // One-shot job → remove from jobs.json after a successful or failed fire.
  if (!job.recurring) {
    try {
      const current = loadJobs(JOBS_FILE)
      rewriteJobs(current.jobs.filter(j => j.name !== job.name))
    } catch (err) {
      process.stderr.write(`scheduler: failed to remove one-shot ${job.name}: ${err}\n`)
    }
  }

  return result
}

const timers = new Map<string, Cron>()

function applyJobs(jobs: Job[], mcp: Server): void {
  const want = new Map(jobs.filter(j => j.enabled).map(j => [j.name, j]))
  // Always replace existing timers — cheap, prevents drift if cron expr changed.
  for (const [name, cron] of timers) { cron.stop(); timers.delete(name) }
  for (const [name, job] of want) {
    try {
      timers.set(name, makeCron(job.cron, () => {
        const p = fireJob(job, mcp).then(() => undefined)
        inFlight.add(p)
        void p.finally(() => inFlight.delete(p))
      }, { name }))
    } catch (err) {
      process.stderr.write(`scheduler: failed to register ${name}: ${err}\n`)
    }
  }
}

async function cliFireNow(name: string): Promise<number> {
  const { jobs } = loadJobs(JOBS_FILE)
  const job = jobs.find(j => j.name === name)
  if (!job) {
    process.stderr.write(`scheduler: no job named "${name}"\n`)
    return 2
  }
  const result = await fireJob(job, null)
  if (!result) {
    // Lock held — treat as error so callers know not to expect output.
    process.stdout.write(`skipped (lock held)\n`)
    return 1
  }
  const content = deriveContent(job, result)
  process.stdout.write(content + '\n')
  return result.status === 'ok' ? 0 : 1
}

const args = process.argv.slice(2)
if (args[0] === '--fire-now') {
  const name = args[1]
  if (!name) {
    process.stderr.write('usage: server.ts --fire-now <job-name>\n')
    process.exit(2)
  }
  const code = await cliFireNow(name)
  process.exit(code)
}

// Singleton lock — mirrors the telegram channel's bot.pid trick (see
// claude-plugins-official/telegram/server.ts:58–69). Scheduler doesn't have
// an exclusive external resource the way Telegram's getUpdates does, but the
// per-state-dir invariant we want is the same: exactly ONE MCP server emits
// channel notifications for a given jobs.json, so the parent claude session
// that owns the channel listener always receives the events. If another
// server is already running in this STATE_DIR, SIGTERM it before we claim
// ownership.
const SERVER_PID_FILE = join(STATE_DIR, 'server.pid')
try {
  const prior = parseInt(readFileSync(SERVER_PID_FILE, 'utf8'), 10)
  if (prior > 1 && prior !== process.pid) {
    process.kill(prior, 0) // throws ESRCH if dead → outer catch skips SIGTERM
    process.stderr.write(`scheduler: replacing prior owner pid=${prior}\n`)
    process.kill(prior, 'SIGTERM')
  }
} catch {}
writeFileSync(SERVER_PID_FILE, String(process.pid))

const mcp = new Server(
  { name: 'scheduler', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions: [
      'Scheduled events arrive as <channel source="scheduler" job="..." status="ok|error" duration="...">summary</channel>.',
      'They are one-way: read them, optionally follow up with the user. No reply expected — the scheduled subprocess already did its own work (e.g. sent a Telegram DM).',
      'On status="error", the summary contains the failure reason. Suggest /scheduler:run <job> to re-test, or /scheduler:remove <job> if the user wants to cancel it.',
    ].join('\n'),
  },
)

// Test-hook: receive `test/fire` notifications and fire the named job.
if (TEST_HOOKS) {
  mcp.setNotificationHandler(
    z.object({
      method: z.literal('test/fire'),
      params: z.object({ name: z.string() }),
    }),
    async ({ params }) => {
      const { jobs } = loadJobs(JOBS_FILE)
      const job = jobs.find(j => j.name === params.name)
      if (!job) return
      void fireJob(job, mcp)
    },
  )
}

await mcp.connect(new StdioServerTransport())

// Initial load + register timers
applyJobs(loadJobs(JOBS_FILE).jobs, mcp)

// Watch the state directory (not the file directly) — atomic rename
// (write tmp + mv, used by most editors and Claude Code's Write tool)
// unlinks the watched inode, after which a single-file fs.watch goes
// permanently stale. Watching the parent dir at depth 0 is robust.
const watcher = chokidar.watch(STATE_DIR, {
  persistent: true,
  ignoreInitial: true,
  depth: 0,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
})
const reload = (path: string): void => {
  if (path !== JOBS_FILE) return
  try {
    const { jobs } = loadJobs(JOBS_FILE)
    applyJobs(jobs, mcp)
    process.stderr.write(`scheduler: reloaded jobs.json (${jobs.length} job${jobs.length === 1 ? '' : 's'})\n`)
  } catch (err) {
    process.stderr.write(`scheduler: reload failed: ${err}\n`)
  }
}
watcher.on('change', reload).on('add', reload).on('unlink', reload)
// Emit a readiness signal once chokidar's initial scan completes. Without
// this, tests that race a rename against watcher setup can drop the first
// event. The line is harmless in production and load-bearing in tests.
watcher.on('ready', () => process.stderr.write('scheduler: watcher ready\n'))

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('scheduler: shutting down\n')

  for (const cron of timers.values()) cron.stop()
  timers.clear()

  void watcher.close()

  const grace = setTimeout(() => process.exit(0), 5000)
  void Promise.allSettled([...inFlight]).then(() => {
    clearTimeout(grace)
    process.exit(0)
  })
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// Orphan watchdog — same pattern as the telegram channel. If the parent
// chain dies without sending SIGTERM, ppid changes and we self-terminate.
const bootPpid = process.ppid
setInterval(() => {
  const orphaned =
    (process.platform !== 'win32' && process.ppid !== bootPpid) ||
    process.stdin.destroyed ||
    process.stdin.readableEnded
  if (orphaned) shutdown()
}, 5000).unref()
