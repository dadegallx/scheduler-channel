/**
 * Channel contract — Tier 2 tests.
 *
 * Spawns server.ts as a child process and speaks MCP over stdio. Validates:
 *   - claude/channel capability advertisement (and nothing extra)
 *   - notifications/claude/channel emission shape on --fire-now
 *   - error / timeout / silent paths
 *   - log file creation
 *   - lock file behavior
 *   - file-watcher reload + corrupt jobs.json handling
 *
 * Strategy:
 *   - Tests use isolated SCHEDULER_STATE_DIR (mkdtemp per test).
 *   - Subprocess command is overridden via SCHEDULER_CLAUDE_BIN to /bin/sh,
 *     so we can synthesize exit codes / outputs / timeouts without ever
 *     spawning real `claude`.
 *   - The job.prompt is reused as the shell script (since buildArgv passes it
 *     after `-p`); server.ts is responsible for substituting argv when
 *     SCHEDULER_CLAUDE_BIN is set, OR we use a CLI flag that simply runs
 *     a shell command. See server.ts for the exact contract.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SERVER = join(import.meta.dir, '..', 'server.ts')

type Server = {
  proc: ReturnType<typeof Bun.spawn>
  send: (msg: object) => Promise<void>
  next: (matcher: (msg: any) => boolean, timeoutMs?: number) => Promise<any>
  collected: any[]
  stderr: string[]
  kill: () => Promise<void>
}

async function spawnServer(stateDir: string, extraEnv: Record<string, string> = {}): Promise<Server> {
  const proc = Bun.spawn({
    cmd: ['bun', SERVER],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      SCHEDULER_STATE_DIR: stateDir,
      // /bin/sh -c <prompt> — we encode shell scripts directly into job.prompt
      SCHEDULER_CLAUDE_BIN: '/bin/sh',
      SCHEDULER_CLAUDE_ARGV_MODE: 'shell',
      ...extraEnv,
    },
  })

  const collected: any[] = []
  const stderrLines: string[] = []
  const dec = new TextDecoder()
  const waiters: Array<(msg: any) => void> = []

  ;(async () => {
    const reader = proc.stdout.getReader()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const obj = JSON.parse(line)
          collected.push(obj)
          for (const w of waiters.splice(0)) w(obj)
        } catch {
          // non-JSON line — ignore
        }
      }
    }
  })()

  ;(async () => {
    const reader = proc.stderr.getReader()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        stderrLines.push(line)
      }
    }
  })()

  const enc = new TextEncoder()
  async function send(msg: object): Promise<void> {
    proc.stdin.write(enc.encode(JSON.stringify(msg) + '\n'))
    await proc.stdin.flush()
  }

  async function next(matcher: (msg: any) => boolean, timeoutMs = 5000): Promise<any> {
    // Check already-collected first
    for (const msg of collected) {
      if (matcher(msg)) return msg
    }
    return new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`timed out after ${timeoutMs}ms waiting for matching message; ` +
          `collected ${collected.length} messages, stderr: ${stderrLines.slice(-5).join(' | ')}`))
      }, timeoutMs)
      const onMsg = (msg: any): void => {
        if (matcher(msg)) {
          clearTimeout(t)
          resolve(msg)
        } else {
          waiters.push(onMsg)
        }
      }
      waiters.push(onMsg)
    })
  }

  async function kill(): Promise<void> {
    try { proc.stdin.end() } catch {}
    proc.kill('SIGTERM')
    await proc.exited
  }

  return { proc, send, next, collected, stderr: stderrLines, kill }
}

async function initialize(s: Server): Promise<any> {
  await s.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'contract-test', version: '0.0.1' },
    },
  })
  const resp = await s.next(m => m.id === 1 && m.result, 5000)
  // Complete the handshake — many SDKs ignore notifications before this lands.
  await s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return resp
}

async function waitForWatcherReady(s: Server, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (s.stderr.some(l => l.includes('scheduler: watcher ready'))) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`watcher ready stderr never appeared within ${timeoutMs}ms`)
}

async function fire(s: Server, name: string): Promise<void> {
  // test/fire is a JSON-RPC notification (no id). jsonrpc must be present
  // for JSONRPCMessageSchema in the MCP transport to accept it.
  await s.send({ jsonrpc: '2.0', method: 'test/fire', params: { name } })
}

function writeJobs(stateDir: string, jobs: any[]): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'jobs.json'), JSON.stringify({ jobs }, null, 2))
}

// Atomic rename — mirrors Claude Code's Write tool and most editors:
// write to a sibling temp file, then rename(2) it into place. The original
// inode is unlinked. A file-level fs.watch attached to the old inode goes
// stale; watching the parent directory survives.
function writeJobsAtomic(stateDir: string, jobs: any[]): void {
  mkdirSync(stateDir, { recursive: true })
  const file = join(stateDir, 'jobs.json')
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify({ jobs }, null, 2))
  renameSync(tmp, file)
}

describe('channel handshake', () => {
  let stateDir: string
  let server: Server

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'sched-contract-'))
  })

  afterEach(async () => {
    if (server) await server.kill()
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('advertises claude/channel capability in initialize response', async () => {
    server = await spawnServer(stateDir)
    const resp = await initialize(server)
    expect(resp.result.capabilities.experimental).toBeDefined()
    expect(resp.result.capabilities.experimental['claude/channel']).toEqual({})
  })

  test('does NOT advertise tools capability (one-way channel)', async () => {
    server = await spawnServer(stateDir)
    const resp = await initialize(server)
    expect(resp.result.capabilities.tools).toBeUndefined()
  })

  test('does NOT advertise claude/channel/permission (no permission relay)', async () => {
    server = await spawnServer(stateDir)
    const resp = await initialize(server)
    expect(resp.result.capabilities.experimental?.['claude/channel/permission']).toBeUndefined()
  })

  test('serverInfo.name is "scheduler"', async () => {
    server = await spawnServer(stateDir)
    const resp = await initialize(server)
    expect(resp.result.serverInfo.name).toBe('scheduler')
  })

  test('instructions field is present and references <channel source="scheduler">', async () => {
    server = await spawnServer(stateDir)
    const resp = await initialize(server)
    expect(resp.result.instructions).toBeTypeOf('string')
    expect(resp.result.instructions).toContain('scheduler')
  })

  test('server stays alive after initialize until killed', async () => {
    server = await spawnServer(stateDir)
    await initialize(server)
    // Give it a moment; ensure it doesn't exit on its own.
    await new Promise(r => setTimeout(r, 300))
    expect(server.proc.exitCode).toBeNull()
  })
})

describe('fire-now job execution', () => {
  let stateDir: string
  let server: Server

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'sched-contract-'))
  })

  afterEach(async () => {
    if (server) await server.kill()
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('emits notifications/claude/channel with status=ok for a successful fire-now', async () => {
    writeJobs(stateDir, [{
      name: 'okjob',
      cron: '0 0 1 1 *',
      prompt: 'echo done; exit 0',
      report_back: 'summary',
      timeout_seconds: 10,
    }])
    server = await spawnServer(stateDir)
    await initialize(server)
    await fire(server, 'okjob')

    const note = await server.next(
      m => m.method === 'notifications/claude/channel' && m.params?.meta?.job === 'okjob',
      8000,
    )
    expect(note.params.meta.status).toBe('ok')
    expect(note.params.meta.job).toBe('okjob')
    expect(note.params.content).toBeTypeOf('string')
  })

  test('emits status=error when subprocess exits non-zero', async () => {
    writeJobs(stateDir, [{
      name: 'failjob',
      cron: '0 0 1 1 *',
      prompt: 'echo bad >&2; exit 1',
      report_back: 'summary',
      timeout_seconds: 10,
    }])
    server = await spawnServer(stateDir)
    await initialize(server)
    await fire(server, 'failjob')
    const note = await server.next(
      m => m.method === 'notifications/claude/channel' && m.params?.meta?.job === 'failjob',
      8000,
    )
    expect(note.params.meta.status).toBe('error')
    expect(note.params.meta.exit_code).toBe('1')
  })

  test('emits status=error with reason=timeout when subprocess exceeds timeout_seconds', async () => {
    writeJobs(stateDir, [{
      name: 'slowjob',
      cron: '0 0 1 1 *',
      prompt: 'sleep 30',
      report_back: 'summary',
      timeout_seconds: 1,
    }])
    server = await spawnServer(stateDir)
    await initialize(server)
    await fire(server, 'slowjob')
    const note = await server.next(
      m => m.method === 'notifications/claude/channel' && m.params?.meta?.job === 'slowjob',
      8000,
    )
    expect(note.params.meta.status).toBe('error')
    expect(note.params.meta.reason).toBe('timeout')
  })

  test('respects report_back=silent (no event emitted)', async () => {
    writeJobs(stateDir, [{
      name: 'quietjob',
      cron: '0 0 1 1 *',
      prompt: 'echo silent; exit 0',
      report_back: 'silent',
      timeout_seconds: 10,
    }])
    server = await spawnServer(stateDir)
    await initialize(server)
    await fire(server, 'quietjob')
    // Wait long enough to be confident nothing fires.
    await new Promise(r => setTimeout(r, 1500))
    const note = server.collected.find(
      m => m.method === 'notifications/claude/channel' && m.params?.meta?.job === 'quietjob',
    )
    expect(note).toBeUndefined()
  })

  test('writes a log file to logs/<name>/<ts>.json', async () => {
    writeJobs(stateDir, [{
      name: 'loggedjob',
      cron: '0 0 1 1 *',
      prompt: 'echo logged; exit 0',
      report_back: 'summary',
      timeout_seconds: 10,
    }])
    server = await spawnServer(stateDir)
    await initialize(server)
    await fire(server, 'loggedjob')
    await server.next(
      m => m.method === 'notifications/claude/channel' && m.params?.meta?.job === 'loggedjob',
      8000,
    )
    const logDir = join(stateDir, 'logs', 'loggedjob')
    expect(existsSync(logDir)).toBe(true)
    const entries = readdirSync(logDir)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some(f => f.endsWith('.json'))).toBe(true)
  })

  test('skips a job whose lock file already exists', async () => {
    writeJobs(stateDir, [{
      name: 'lockedjob',
      cron: '0 0 1 1 *',
      prompt: 'echo done; exit 0',
      report_back: 'summary',
      timeout_seconds: 10,
    }])
    // Pre-create the lock file
    const locksDir = join(stateDir, 'locks')
    mkdirSync(locksDir, { recursive: true })
    writeFileSync(join(locksDir, 'lockedjob'), String(process.pid))

    server = await spawnServer(stateDir)
    await initialize(server)
    await fire(server, 'lockedjob')

    // Wait — no notification should arrive since the lock blocks it.
    await new Promise(r => setTimeout(r, 1500))
    const note = server.collected.find(
      m => m.method === 'notifications/claude/channel' && m.params?.meta?.job === 'lockedjob',
    )
    expect(note).toBeUndefined()
  })

  test('emits a content string non-empty on ok path', async () => {
    writeJobs(stateDir, [{
      name: 'echojob',
      cron: '0 0 1 1 *',
      prompt: 'echo "yo from echojob"; exit 0',
      report_back: 'full',
      timeout_seconds: 10,
    }])
    server = await spawnServer(stateDir)
    await initialize(server)
    await fire(server, 'echojob')
    const note = await server.next(
      m => m.method === 'notifications/claude/channel' && m.params?.meta?.job === 'echojob',
      8000,
    )
    expect(note.params.content.length).toBeGreaterThan(0)
    expect(note.params.content).toContain('yo from echojob')
  })

  test('emits duration meta field as "<n>s"', async () => {
    writeJobs(stateDir, [{
      name: 'durjob',
      cron: '0 0 1 1 *',
      prompt: 'echo q; exit 0',
      report_back: 'summary',
      timeout_seconds: 10,
    }])
    server = await spawnServer(stateDir)
    await initialize(server)
    await fire(server, 'durjob')
    const note = await server.next(
      m => m.method === 'notifications/claude/channel' && m.params?.meta?.job === 'durjob',
      8000,
    )
    expect(note.params.meta.duration).toBeTypeOf('string')
    expect(note.params.meta.duration).toMatch(/s$/)
  })

  test('unknown job name does not emit and does not crash server', async () => {
    writeJobs(stateDir, [])
    server = await spawnServer(stateDir)
    await initialize(server)
    await fire(server, 'nope')
    await new Promise(r => setTimeout(r, 500))
    expect(server.proc.exitCode).toBeNull()
    const note = server.collected.find(m => m.method === 'notifications/claude/channel')
    expect(note).toBeUndefined()
  })
})

describe('jobs.json file watcher', () => {
  let stateDir: string
  let server: Server

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'sched-contract-'))
  })

  afterEach(async () => {
    if (server) await server.kill()
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('reloads jobs when jobs.json changes (new job becomes fire-able)', async () => {
    writeJobs(stateDir, [])
    server = await spawnServer(stateDir)
    await initialize(server)
    // Trigger fire-now for a name that doesn't exist yet — should drop.
    await fire(server, 'newjob')
    await new Promise(r => setTimeout(r, 300))
    const before = server.collected.find(m => m.method === 'notifications/claude/channel')
    expect(before).toBeUndefined()

    // Add the job
    writeJobs(stateDir, [{
      name: 'newjob',
      cron: '0 0 1 1 *',
      prompt: 'echo arrived; exit 0',
      report_back: 'summary',
      timeout_seconds: 10,
    }])
    // chokidar settle
    await new Promise(r => setTimeout(r, 1200))

    await fire(server, 'newjob')
    const note = await server.next(
      m => m.method === 'notifications/claude/channel' && m.params?.meta?.job === 'newjob',
      8000,
    )
    expect(note.params.meta.status).toBe('ok')
  })

  test('survives repeated atomic-rename writes to jobs.json (regression: single-file watch goes stale)', async () => {
    // Pre-fix, server.ts called chokidar.watch(JOBS_FILE, ...). On macOS
    // (and Linux), a file-level fs.watch is bound to the inode; once the
    // file is replaced via write-temp + rename, that inode is unlinked
    // and the watcher fires no further events — scheduled fires for any
    // post-startup edit silently drop. The fix is to watch STATE_DIR at
    // depth 0 and filter to JOBS_FILE.
    writeJobsAtomic(stateDir, [])
    server = await spawnServer(stateDir)
    await initialize(server)
    await waitForWatcherReady(server)

    // Three successive atomic renames. Pre-fix: only the first reloads.
    const tags = ['one', 'two', 'three']
    for (const tag of tags) {
      writeJobsAtomic(stateDir, [{
        name: `after-${tag}`,
        cron: '0 0 1 1 *',
        prompt: 'echo ok; exit 0',
        report_back: 'summary',
        timeout_seconds: 10,
      }])
      // chokidar awaitWriteFinish stabilityThreshold (200ms) + headroom
      await new Promise(r => setTimeout(r, 600))
    }

    const reloads = server.stderr.filter(l => l.includes('scheduler: reloaded jobs.json'))
    expect(reloads.length).toBe(tags.length)
  })

  test('does not crash on corrupt jobs.json', async () => {
    writeJobs(stateDir, [])
    server = await spawnServer(stateDir)
    await initialize(server)

    // Write garbage
    writeFileSync(join(stateDir, 'jobs.json'), 'not json at all')
    await new Promise(r => setTimeout(r, 1200))

    // Server still alive?
    expect(server.proc.exitCode).toBeNull()

    // schema.ts is what renames; either jobs.json was moved aside OR
    // it stayed and the watcher tolerated it. Both are acceptable as long
    // as the server is still alive.
    const stillThere = existsSync(join(stateDir, 'jobs.json'))
    const corruptFiles = readdirSync(stateDir).filter(f => f.startsWith('jobs.json.corrupt-'))
    expect(stillThere || corruptFiles.length > 0).toBe(true)
  })
})

describe('--fire-now CLI mode', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'sched-contract-'))
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('runs a job synchronously and exits 0 on success', async () => {
    writeJobs(stateDir, [{
      name: 'cliok',
      cron: '0 0 1 1 *',
      prompt: 'echo cli-fired; exit 0',
      report_back: 'summary',
      timeout_seconds: 10,
    }])
    const proc = Bun.spawn({
      cmd: ['bun', SERVER, '--fire-now', 'cliok'],
      env: {
        ...process.env,
        SCHEDULER_STATE_DIR: stateDir,
        SCHEDULER_CLAUDE_BIN: '/bin/sh',
        SCHEDULER_CLAUDE_ARGV_MODE: 'shell',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await proc.exited
    expect(proc.exitCode).toBe(0)
  })

  test('exits 1 when the subprocess fails', async () => {
    writeJobs(stateDir, [{
      name: 'clifail',
      cron: '0 0 1 1 *',
      prompt: 'exit 1',
      report_back: 'summary',
      timeout_seconds: 10,
    }])
    const proc = Bun.spawn({
      cmd: ['bun', SERVER, '--fire-now', 'clifail'],
      env: {
        ...process.env,
        SCHEDULER_STATE_DIR: stateDir,
        SCHEDULER_CLAUDE_BIN: '/bin/sh',
        SCHEDULER_CLAUDE_ARGV_MODE: 'shell',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await proc.exited
    expect(proc.exitCode).toBe(1)
  })

  test('exits 2 for unknown job name', async () => {
    writeJobs(stateDir, [])
    const proc = Bun.spawn({
      cmd: ['bun', SERVER, '--fire-now', 'nosuch'],
      env: {
        ...process.env,
        SCHEDULER_STATE_DIR: stateDir,
        SCHEDULER_CLAUDE_BIN: '/bin/sh',
        SCHEDULER_CLAUDE_ARGV_MODE: 'shell',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await proc.exited
    expect(proc.exitCode).toBe(2)
  })
})
