# scheduler-channel

A Claude Code channel plugin that emits cron-driven events as `<channel source="scheduler" job="...">` blocks into your running session. Define jobs in `jobs.json`; each fire spawns a self-contained `claude -p` subprocess that does its end-to-end work (DMing you via the Telegram channel, posting to Notion, etc.), then reports back as a one-way channel notification into the live session.

## Status

Research preview. Built against the Claude Code v2.1.x channels feature ([docs](https://code.claude.com/docs/en/channels-reference)). Tested on macOS 26. Channel-event delivery to live sessions is verified for interactive `claude` sessions; it is **not** verified for `claude --print` mode — that appears to be a Claude Code limitation in 2.1.141, not a plugin bug. Use interactive mode for verification.

## Prerequisites

- [Bun](https://bun.sh) — the channel server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.
- Claude Code v2.1.80 or later. Channels are research-preview; orgs on Team/Enterprise plans must have channels enabled.
- A `claude` binary on `$PATH` — used to spawn job subprocesses.

## Install

### Local (development)

Clone and load via `--plugin-dir`:

```sh
git clone <repo-url> ~/Projects/scheduler-channel
cd ~/Projects/scheduler-channel && bun install
claude --plugin-dir ~/Projects/scheduler-channel
```

### Marketplace

Once published, install via:

```
/plugin install scheduler-channel@<marketplace>
/reload-plugins
```

Then relaunch with the channel flag:

```sh
claude --channels plugin:scheduler-channel@<marketplace>
```

## First-run setup

From a running session with the plugin loaded:

```
/scheduler:configure init
```

Creates `~/.claude/channels/scheduler/`, an empty `jobs.json`, and `logs/`/`locks/` subdirs. Then:

```
/scheduler:add
```

Walks you through defining the first job.

## Job schema

The canonical schema for `~/.claude/channels/scheduler/jobs.json`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | required | Matches `/^[a-z0-9][a-z0-9_-]*$/i`. Used as `<channel job="...">` attr and log dir. |
| `cron` | 5-field string | required | Standard cron, local TZ. |
| `prompt` | string | required | Self-contained brief for the subprocess. |
| `recurring` | bool | `true` | `false` = fire once then auto-delete. |
| `model` | string | `"haiku"` | Passed as `--model`. |
| `mcps` | string[] | `[]` | MCP names to whitelist via `--strict-mcp-config`. Empty = inherit all. |
| `max_budget_usd` | number | `0.5` | Passed as `--max-budget-usd`. Hard cap. |
| `permission_mode` | enum | `"dontAsk"` | One of `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`. |
| `effort` | enum | `"low"` | One of `low`, `medium`, `high`, `xhigh`, `max`. |
| `timeout_seconds` | number | `300` | Hard subprocess kill (max 3600). |
| `report_back` | enum | `"summary"` | `summary`, `full`, or `silent`. Controls channel event payload. |
| `enabled` | bool | `true` | Soft-disable without removing. |

Example:

```json
{
  "jobs": [
    {
      "name": "daily-budget",
      "cron": "57 7 * * *",
      "prompt": "Pull yesterday's Lunch Money transactions; DM summary to chat_id 1022678777 via the Telegram MCP.",
      "model": "haiku",
      "mcps": ["telegram", "lunch-money"],
      "max_budget_usd": 0.30,
      "timeout_seconds": 120
    }
  ]
}
```

## Cron semantics

- 5-field expressions (`m h dom mon dow`), parsed by [croner](https://github.com/Hexagon/croner) in the local timezone.
- Avoid `:00` and `:30` minutes. The internet is full of cron jobs firing on the hour and half-hour, and APIs (Lunch Money, Notion) sometimes rate-limit at those times. Prefer off-minutes like `:07`, `:23`, `:57`. Same jitter reasoning as the built-in `CronCreate` tool.
- Job names must be unique across `jobs.json` or the file fails schema validation.

## Skills

Five slash-commands ship with the plugin.

**`/scheduler:configure`** — Status and first-time setup. Reports on state dir, `jobs.json`, env file, log size, and next 5 fires across all jobs. Use when asking "is the scheduler set up?" or "scheduler status". `/scheduler:configure init` creates the state dir on first use.

**`/scheduler:add`** — Add or update a scheduled job. Triggers on "schedule X every day at Y", "add a cron for Z", "remind me daily to...". Parses intent into a job spec, writes `jobs.json` atomically. The running server file-watches and reloads timers; no restart needed.

**`/scheduler:list`** — Read-only inspection. Triggers on "what's scheduled", "show my crons", "list jobs". Renders a markdown table with cron, next-fire, model, MCPs, enabled state, and the last 3 runs per job from the log dir.

**`/scheduler:remove`** — Remove a job by name. Triggers on "stop the daily budget job", "unschedule X". Confirms before writing. Preserves the log dir for forensics. Refuses to act on channel-driven requests (prompt-injection guard).

**`/scheduler:run`** — Fire a job immediately, bypassing the cron schedule. Triggers on "test the budget job", "run X now". Spawns `bun server.ts --fire-now <name>` synchronously, captures the result, surfaces the summary. Real tokens and real side effects — confirms first.

## State files

Everything lives under `~/.claude/channels/scheduler/` (or `$SCHEDULER_STATE_DIR`):

```
~/.claude/channels/scheduler/
├── jobs.json                    # schedule (durable, file-watched via chokidar)
├── .env                         # optional, chmod 0600; injected into subprocesses
├── logs/<job-name>/<ts>.json    # captured subprocess output per fire
└── locks/<job-name>             # in-flight markers (prevents overlapping runs)
```

`jobs.json` is reloaded on every change. Corrupt or schema-invalid files are renamed to `jobs.json.corrupt-<ts>` and the scheduler starts with an empty schedule rather than crashing.

## Cost reality

Each fire spawns a fresh `claude -p` subprocess with a cold cache. Even trivial jobs cost roughly $0.10. The default `max_budget_usd` of $0.50 is enough for most short jobs but you should tune it per job — a daily Lunch Money + Telegram chain typically lands around $0.04-$0.10, but a `sonnet` run with several MCP tool calls can easily exceed $0.30. Set the budget high enough that legitimate runs complete, low enough that a misbehaving prompt doesn't burn the day's allowance.

If a subprocess hits the cap it exits with `error_max_budget_usd` and the channel event reports `status="error"`.

## Test job: "scheduler ping"

Drop this into `~/.claude/channels/scheduler/jobs.json` to verify end-to-end delivery:

```json
{
  "jobs": [
    {
      "name": "scheduler-ping",
      "cron": "*/2 * * * *",
      "recurring": false,
      "prompt": "Say 'scheduler ping' and nothing else.",
      "model": "haiku",
      "max_budget_usd": 0.20
    }
  ]
}
```

Within 2 minutes you should see a `<channel source="scheduler" job="scheduler-ping" status="ok">` block in your session. Because `recurring: false`, the job auto-removes itself after firing.

## Troubleshooting

**"I added a job but it never fires."** Confirm with `/scheduler:run <name>` that the job exists and the subprocess works. Then check `/mcp` lists `scheduler` as connected — if not, the session wasn't started with the channel attached. Past fires are logged at `~/.claude/channels/scheduler/logs/<name>/`.

**"Subprocess fails with `error_max_budget_usd`."** Cold-cache costs run ~$0.10+ even for trivial prompts. Bump `max_budget_usd` to 0.30 or higher.

**"Got `--dangerously-load-development-channels: unknown option`."** That flag appears in some channels documentation but is not implemented in Claude Code 2.1.141. Use `--plugin-dir <path>` to load local plugin sources instead.

**"Channel events don't appear in `claude --print` output."** Known limitation in 2.1.141 — channel notifications are not flushed to `--print` stdout. Verify with an interactive session.

**"`jobs.json` got renamed to `jobs.json.corrupt-<ts>`."** Schema validation failed (bad cron expression, duplicate name, invalid enum, missing required field). Inspect the `.corrupt-<ts>` file to see what the server rejected and fix before renaming back.

**"A job stays locked."** Stale `~/.claude/channels/scheduler/locks/<name>` from a crashed run. `trash` the lock file to clear.

## Development

```sh
bun test                                        # 53 unit + contract tests
SCHEDULER_REAL_CLAUDE=1 bun test tests/integration.test.ts   # ~$0.02/run, gated
SCHEDULER_CLAUDE_BIN=/bin/sh SCHEDULER_CLAUDE_ARGV_MODE=shell bun server.ts
```

The last form runs the server with `/bin/sh -c <prompt>` instead of `claude -p` — useful for local testing without spending tokens. It also enables the `test/fire` JSON-RPC notification hook used by `tests/channel-contract.test.ts`.

Test-only env vars:
- `SCHEDULER_STATE_DIR` — override the state directory.
- `SCHEDULER_CLAUDE_BIN` — override the spawned binary.
- `SCHEDULER_CLAUDE_ARGV_MODE=shell` — swap `-p <prompt>` for `-c <prompt>`.

## Architecture

```
[claude session]
      ↑ notifications/claude/channel
[server.ts — MCP stdio server, child of the session]
      ↑ croner fires at job.cron
[Bun.spawn: claude -p <prompt> --model ... --max-budget-usd ...]
      ↓ subprocess runs end-to-end (Telegram MCP, Lunch Money MCP, ...)
[stdout JSON → deriveContent() → channel notification]
```

`server.ts` registers no tools and no permission relay — this is a one-way channel. Replies happen inside the spawned subprocess via whichever MCPs the job loads (typically the Telegram channel for delivery). Job changes in `jobs.json` are picked up by chokidar and re-applied without restart. SIGTERM/SIGINT/SIGHUP and parent-process death all trigger graceful shutdown with a 5s grace window for in-flight runs.

Full design notes: `/Users/davide/.claude/plans/crispy-chasing-sonnet.md`.

## License

Apache-2.0
