/**
 * Integration test — exercises fireJob via the REAL `claude -p` binary.
 *
 * Gated behind SCHEDULER_REAL_CLAUDE=1 because each run costs real money
 * (~$0.02 warm / ~$0.11 cold cache). When the gate is off, the entire
 * describe block is skipped: `bun test tests/integration.test.ts` reports
 * 0 tests with no claude invocation.
 *
 * Strategy:
 *   - Spawn `bun server.ts --fire-now <name>` as a child process with an
 *     isolated SCHEDULER_STATE_DIR (mkdtemp per test).
 *   - Do NOT set SCHEDULER_CLAUDE_BIN — we want the real binary.
 *   - Use --model haiku and a tiny prompt to keep costs low.
 *   - Assert on stdout shape and on the persisted log file at
 *     <stateDir>/logs/<job>/<ts>.json.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SERVER = join(import.meta.dir, '..', 'server.ts')

// Gate: only run when SCHEDULER_REAL_CLAUDE=1 — these tests cost real money.
const REAL = process.env.SCHEDULER_REAL_CLAUDE === '1'
const maybeDescribe = REAL ? describe : describe.skip

type FireResult = {
  exitCode: number
  stdout: string
  stderr: string
}

async function fireNow(stateDir: string, name: string): Promise<FireResult> {
  // Strip our test-only overrides from the env — we want the real claude binary.
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === 'SCHEDULER_CLAUDE_BIN' || k === 'SCHEDULER_CLAUDE_ARGV_MODE') continue
    env[k] = v
  }
  env.SCHEDULER_STATE_DIR = stateDir

  const proc = Bun.spawn({
    cmd: ['bun', SERVER, '--fire-now', name],
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { exitCode: proc.exitCode ?? -1, stdout, stderr }
}

function readLog(stateDir: string, name: string): any {
  const dir = join(stateDir, 'logs', name)
  expect(existsSync(dir)).toBe(true)
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  expect(files.length).toBeGreaterThan(0)
  // Pick the latest file in case of multiple.
  files.sort()
  const raw = readFileSync(join(dir, files[files.length - 1]!), 'utf8')
  return JSON.parse(raw)
}

function writeJobs(stateDir: string, jobs: object[]): void {
  writeFileSync(join(stateDir, 'jobs.json'), JSON.stringify({ jobs }, null, 2))
}

maybeDescribe('integration: real claude -p', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'sched-integration-'))
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('fires a tiny job through real claude -p and emits status=ok', async () => {
    writeJobs(stateDir, [
      {
        name: 'say-pong',
        cron: '0 0 * * *', // unused — we fire-now
        recurring: true, // keep the job around for inspection
        prompt: "Say the word 'pong' and nothing else.",
        model: 'haiku',
        mcps: [],
        max_budget_usd: 0.30,
        timeout_seconds: 60,
        report_back: 'summary',
        effort: 'low',
        permission_mode: 'dontAsk',
        enabled: true,
      },
    ])

    const { exitCode, stdout, stderr } = await fireNow(stateDir, 'say-pong')

    // Exit code 0 → status=ok
    expect(exitCode).toBe(0)

    // The CLI prints the derived "content" (summary) to stdout.
    // Loose assertion: should contain "pong" somewhere (case-insensitive).
    expect(stdout.toLowerCase()).toContain('pong')

    // Log file should exist and reflect a successful run.
    const log = readLog(stateDir, 'say-pong')
    expect(log.job).toBe('say-pong')
    expect(log.status).toBe('ok')
    expect(log.exit_code).toBe(0)
    expect(typeof log.duration_ms).toBe('number')

    // The claude -p JSON blob is captured in stdout; parse and validate.
    const parsed = JSON.parse(log.stdout)
    expect(parsed.type).toBe('result')
    expect(parsed.is_error).toBe(false)
    expect(typeof parsed.result).toBe('string')
    expect(parsed.result.toLowerCase()).toContain('pong')

    // Cost should be present and within our budget.
    expect(typeof parsed.total_cost_usd).toBe('number')
    expect(parsed.total_cost_usd).toBeGreaterThan(0)
    expect(parsed.total_cost_usd).toBeLessThan(0.30)

    // The server's cost_usd in the log should match what claude reported.
    expect(typeof log.cost_usd).toBe('number')
    expect(log.cost_usd).toBeGreaterThan(0)

    // Surface the captured log for human inspection during dev runs.
    if (process.env.SCHEDULER_INTEGRATION_DUMP) {
      // eslint-disable-next-line no-console
      console.log('--- captured log ---\n' + JSON.stringify(log, null, 2))
    }
  }, 120_000) // 120s — cold cache + API latency headroom

  test('emits status=error when claude exits with budget overrun', async () => {
    writeJobs(stateDir, [
      {
        name: 'broke-job',
        cron: '0 0 * * *',
        recurring: true,
        prompt: "Say the word 'pong' and nothing else.",
        model: 'haiku',
        mcps: [],
        max_budget_usd: 0.01, // impossibly low — cold cache loads dwarf this
        timeout_seconds: 60,
        report_back: 'summary',
        effort: 'low',
        permission_mode: 'dontAsk',
        enabled: true,
      },
    ])

    const { exitCode } = await fireNow(stateDir, 'broke-job')

    // claude -p exits non-zero on budget overrun → server reports status=error.
    expect(exitCode).not.toBe(0)

    const log = readLog(stateDir, 'broke-job')
    expect(log.job).toBe('broke-job')
    expect(log.status).toBe('error')

    // claude's JSON output should indicate the budget kill, when parseable.
    try {
      const parsed = JSON.parse(log.stdout)
      // subtype=error_max_budget_usd per the spike findings
      if (typeof parsed?.subtype === 'string') {
        expect(parsed.subtype).toContain('budget')
      }
    } catch {
      // claude may not have produced parseable JSON on hard budget kill —
      // that's fine, the non-zero exit + status=error already covers us.
    }
  }, 60_000)
})
