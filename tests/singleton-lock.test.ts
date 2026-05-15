/**
 * Singleton-lock tests — ensures only one scheduler server.ts owns a state dir
 * at a time, even when started concurrently. Mirrors the telegram channel's
 * bot.pid mechanism (server.ts:58–69 in claude-plugins-official/telegram).
 *
 * Strategy:
 *   - Spawn server A with isolated SCHEDULER_STATE_DIR. Wait for it to write
 *     its pid to <stateDir>/server.pid.
 *   - Spawn server B with the SAME stateDir. Expect:
 *       1) A exits with signalCode === 'SIGTERM' (B sent the signal).
 *       2) server.pid now contains B's pid.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SERVER = join(import.meta.dir, '..', 'server.ts')

function spawnServerRaw(stateDir: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn({
    cmd: ['bun', SERVER],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      SCHEDULER_STATE_DIR: stateDir,
      // We don't fire jobs in these tests, but the test bins need to be set
      // so server.ts doesn't try to invoke the real `claude` binary anywhere
      // in its startup path. Both flags are no-op when no job fires.
      SCHEDULER_CLAUDE_BIN: '/bin/sh',
      SCHEDULER_CLAUDE_ARGV_MODE: 'shell',
    },
  })
}

async function waitForPid(stateDir: string, expectedPid: number, timeoutMs = 5000): Promise<void> {
  const pidFile = join(stateDir, 'server.pid')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (pid === expectedPid) return
    }
    await new Promise(r => setTimeout(r, 25))
  }
  const actual = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '(missing)'
  throw new Error(`server.pid did not equal ${expectedPid} within ${timeoutMs}ms (actual: ${actual})`)
}

describe('singleton lock', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'sched-singleton-'))
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('second startup SIGTERMs the first and takes ownership of server.pid', async () => {
    const a = spawnServerRaw(stateDir)
    await waitForPid(stateDir, a.pid)

    // Capture B's stderr so we can verify it emitted the "replacing" log line.
    const b = spawnServerRaw(stateDir)
    const bStderr = new Response(b.stderr).text()

    // Wait for A to die. A's SIGTERM handler calls process.exit(0), so the
    // exit looks "normal" (signalCode === null) — but A wouldn't exit on its
    // own in the test window, so a.exited resolving is the proof of takeover.
    await a.exited

    // B should have replaced A's pid in server.pid.
    await waitForPid(stateDir, b.pid)

    // And B should have logged the takeover, naming A's pid.
    b.kill('SIGTERM')
    await b.exited
    const stderr = await bStderr
    expect(stderr).toContain(`replacing prior owner pid=${a.pid}`)
  }, 10000)

  test('lone startup writes its own pid to server.pid', async () => {
    const a = spawnServerRaw(stateDir)
    await waitForPid(stateDir, a.pid)
    a.kill('SIGTERM')
    await a.exited
  }, 5000)

  test('stale pid file (dead owner) is replaced without SIGTERM error', async () => {
    // Seed server.pid with a pid that has never existed (use a very high number).
    // server.ts must NOT crash trying to SIGTERM a non-existent process.
    const fs = await import('node:fs')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(join(stateDir, 'server.pid'), '999999')

    const a = spawnServerRaw(stateDir)
    await waitForPid(stateDir, a.pid)
    a.kill('SIGTERM')
    await a.exited
  }, 5000)
})
