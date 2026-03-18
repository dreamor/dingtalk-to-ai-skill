---
name: dingtalk-bridge
description: |
  Manage and control a Dingtalk-to-AI bridge service that forwards messages from Dingtalk group chats to OpenCode or Claude Code CLI.
  Use this skill whenever the user wants to: set up, start, stop, or diagnose the bridge; control a Dingtalk bot integration;
  configure Dingtalk credentials; view bridge logs or check service status; forward messages between Dingtalk and AI CLI tools.
  Use for all phrases related to "钉钉桥接", "dingtalk opencode", "dingtalk claude", "桥接", "启动钉钉", "停止桥接", "诊断", "查看日志", "配置钉钉".
---

# Dingtalk Bridge Skill

This skill manages a bridge service that forwards messages from Dingtalk group chats to local AI CLI tools (OpenCode or Claude Code), allowing remote AI interaction from mobile devices via Dingtalk.

## Quick Reference

| Command | Description |
|---------|-------------|
| `setup`, `配置` | Interactive configuration wizard |
| `start`, `启动` | Start the bridge service |
| `stop`, `停止` | Stop the bridge service |
| `status`, `状态` | Check if service is running |
| `logs [N]`, `查看日志` | Show last N lines of logs (default: 50) |
| `doctor`, `诊断` | Run diagnostics and troubleshoot issues |
| `rebuild`, `重新构建` | Rebuild the TypeScript project |

## Workflow

### 1. Parse Command

Extract the subcommand from `$ARGUMENTS` based on user input (supports both English and Chinese keywords).

### 2. Configuration Check

For all commands except `setup`:
- Check if `.env` file exists in project root
- If missing: guide user to run `setup` first
- If present: proceed with command

### 3. Environment Detection

Detect which environment Claude is running in:
- **Claude Code**: Full features available including interactive prompts
- **Other/Codex**: Limited features, provide manual instructions instead

### 4. Execute Command

**setup**: Interactive wizard to configure Dingtalk credentials and AI provider preference

**start**: Build the project and start the bridge service via PM2

**stop**: Stop the PM2-managed bridge service

**status**: Report service health and connectivity

**logs**: Display service logs with optional line count

**doctor**: Run comprehensive diagnostics (env, deps, build, Dingtalk API connectivity)

**rebuild**: Compile TypeScript and verify build success

## Important Notes

- Always mask secrets in output (show only last 4 characters)
- The service defaults to Stream mode, falling back to Polling if needed
- Configuration persists in `.env` file with restricted permissions (600)
- Project directory: `$PROJECT_DIR` (current working directory)