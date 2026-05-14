#!/usr/bin/env bun
/**
 * scheduler-channel — SPIKE
 *
 * Smallest possible MCP server that registers as a channel, emits one
 * hardcoded notification 2 seconds after `initialize`, then waits to be
 * shut down. Used to validate the wire before the full implementation.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const mcp = new Server(
  { name: 'scheduler', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions: 'spike',
  },
)

await mcp.connect(new StdioServerTransport())

setTimeout(() => {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: 'spike fired', meta: { source_check: 'true' } },
  })
}, 2000)

function shutdown(): void {
  process.exit(0)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
