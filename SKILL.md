---
name: dingtalk-bridge
description: |
  Manage the Dingtalk to AI CLI bridge (OpenCode or Claude Code). Use for: setting up,
  starting, stopping, or diagnosing the bridge; forwarding messages from Dingtalk group chat
  to OpenCode or Claude Code CLI; any phrase like "钉钉桥接", "dingtalk opencode", "dingtalk claude",
  "桥接 opencode", "远程控制 opencode", "启动钉钉", "停止桥接", "诊断", "查看日志", "配置钉钉".
  Subcommands: setup, start, stop, status, logs, doctor, rebuild.
  Do NOT use for: building other Dingtalk integrations, general coding tasks, or unrelated IM platforms.
argument-hint: "setup | start | stop | status | logs [N] | doctor | rebuild"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---

# Dingtalk-to-OpenCode Bridge Skill

You are managing the Dingtalk to OpenCode bridge service.
The project directory is at `$PROJECT_DIR` (current working directory).

## Command parsing

Parse the user's intent from `$ARGUMENTS` into one of these subcommands:

| User says (examples) | Subcommand |
|---|---|
| `setup`, `configure`, `配置`, `配置钉钉`, `设置环境变量` | setup |
| `start`, `启动`, `启动桥接`, `启动钉钉` | start |
| `stop`, `停止`, `停止桥接`, `停止钉钉` | stop |
| `status`, `状态`, `运行状态`, `桥接状态` | status |
| `logs`, `logs 100`, `查看日志`, `查看日志 100` | logs |
| `doctor`, `diagnose`, `诊断`, `出问题了`, `没反应了` | doctor |
| `rebuild`, `重新构建`, `build` | rebuild |

Extract optional numeric argument for `logs` (default 50).

## Config check (applies to all commands except `setup`)

Before running any subcommand other than `setup`, check if `.env` file exists in the project directory:

- **If it does NOT exist:**
  - In Claude Code: tell the user "No configuration found" and automatically start the `setup` wizard using AskUserQuestion.
  - In Codex: tell the user "No configuration found. Please create `.env` based on the example:" then show the contents of `.env.example` and stop.
- **If it exists:** proceed with the requested subcommand.

## Runtime detection

Before executing any subcommand, detect which environment you are running in:

1. **Claude Code** — `AskUserQuestion` tool is available. Use it for interactive setup wizards.
2. **Codex / other** — `AskUserQuestion` is NOT available. Fall back to non-interactive guidance: explain the steps and show `.env.example`.

## Subcommands

### `setup`

Run an interactive setup wizard. This subcommand requires `AskUserQuestion`. If it is not available (Codex environment), instead show the contents of `.env.example` with field-by-field explanations and instruct the user to create the `.env` file manually.

When AskUserQuestion IS available, collect the following credentials **one field at a time**:

**Step 1 — Choose AI Provider**
Ask which AI CLI to use:
- **opencode** (default) — Use OpenCode CLI (MiniMax models, free tier available)
- **claude** — Use Claude Code CLI (Anthropic models)

**Required fields:**
1. **DINGTALK_APP_KEY** — The Dingtalk app key. Tell the user: "Go to https://open.dingtalk.com → your app → Basic Info to find the App Key"
2. **DINGTALK_APP_SECRET** — The Dingtalk app secret. Tell the user: "Find it in the same place as App Key (App Secret)"

**Optional fields (use defaults if skipped):**
- **AI_PROVIDER** (default: opencode) — Choose "opencode" or "claude"
- **GATEWAY_PORT** (default: 3000) — The port for the gateway HTTP server
- **SESSION_TTL** (default: 30 minutes) — Session time-to-live
- **MQ_MAX_CONCURRENT_PER_USER** (default: 3) — Max concurrent requests per user
- **MQ_MAX_CONCURRENT_GLOBAL** (default: 10) — Max global concurrent requests
- **OPENCODE_TIMEOUT** (default: 120000ms) — OpenCode CLI timeout in milliseconds
- **CLAUDE_TIMEOUT** (default: 120000ms) — Claude Code CLI timeout in milliseconds

After each answer, confirm the value back to the user (masking secrets to last 4 chars only) before moving to the next question.

**Step 2 — Write config**

1. Show a final summary table with all settings (secrets masked to last 4 chars)
2. Ask user to confirm before writing
3. Use Write to create `.env` file with all settings in `KEY=VALUE` format
4. Use Bash to set permissions: `chmod 600 .env`
5. On success, tell the user: "Setup complete! Run `/dingtalk-opencode-bridge start` or `npm run dev` to start the bridge."

### `start`

**Pre-check:** Verify `.env` exists (see "Config check" above).

Run: `npm run dev`

Show the output to the user. If it fails, tell the user:
- Run `doctor` to diagnose: `/dingtalk-opencode-bridge doctor`
- Check logs: `/dingtalk-opencode-bridge logs`

The service starts in Stream mode by default (recommended). If Stream mode fails, it falls back to Polling mode.

### `stop`

Find and kill the running Node.js process:
```bash
pkill -f "ts-node src/index.ts" || pkill -f "node dist/index.js"
```

Or use `lsof` to find the process on the gateway port (default 3000) and kill it.

### `status`

Check if the bridge is running:
1. Check for Node.js processes related to the project
2. Check if the gateway port (from .env or default 3000) is listening
3. Report the status to the user

### `logs`

Extract optional line count N from arguments (default 50).

Options:
1. Check `logs/` directory for log files
2. Show output from the running process if available
3. If no logs, tell the user "No logs found. Make sure the bridge is running with `npm run dev`"

### `doctor`

Run diagnostics:
1. Check if `.env` exists and is valid
2. Check if dependencies are installed (`node_modules/`)
3. Check if code is built (`dist/` directory)
4. Check if the Dingtalk credentials are valid by testing the token API
5. Check if the gateway port is available
6. Check for common issues in the logs

Read `src/utils/doctor.ts` to understand the built-in diagnostic tool and run it if available.

Report results and suggest fixes for any failures:
- Dependencies missing → `npm install`
- Code not built → `npm run build`
- Port in use → find and stop the process using that port
- Invalid credentials → run `setup` to reconfigure

### `rebuild`

Run: `npm run build`

Verify the build completes successfully. If it fails, show the error and help the user fix it.

## Configuration reference

Required environment variables:
- `DINGTALK_APP_KEY` — Dingtalk app key
- `DINGTALK_APP_SECRET` — Dingtalk app secret

Optional variables (with defaults):
- `GATEWAY_PORT` (default: 3000)
- `SESSION_TTL` (default: 30 minutes)
- `MQ_MAX_CONCURRENT_PER_USER` (default: 3)
- `MQ_MAX_CONCURRENT_GLOBAL` (default: 10)
- `OPENCODE_TIMEOUT` (default: 120000ms)

## Architecture

The bridge has three message receiving modes:
1. **Stream mode** (recommended) — Uses `dingtalk-stream` SDK, connects to Dingtalk's WebSocket endpoint
2. **Polling mode** — Falls back to polling Dingtalk's API
3. **Gateway HTTP mode** — Provides REST API endpoints (`/api/test`, `/api/status`, `/api/sessions`)

Message flow: Dingtalk群聊 → Stream/Polling → Gateway → OpenCode CLI → Response → Dingtalk

Core modules:
- `src/dingtalk/` — Dingtalk service client, token management, Stream/Polling
- `src/gateway/` — Express server handling message routing, rate limiting
- `src/opencode/` — OpenCode CLI executor wrapper
- `src/session-manager/` — In-memory session storage
- `src/message-queue/` — Message queue with rate limiter

## Notes

- Always mask secrets in output (show only last 4 characters)
- The bridge runs as a foreground process in development (`npm run dev`)
- Config persists in `.env` file
- Use `npm test` to run tests if needed