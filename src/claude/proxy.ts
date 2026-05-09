/**
 * Claude CLI Proxy - 独立运行的代理进程
 *
 * 功能：
 * - 管理 Claude CLI 子进程的生命周期
 * - 通过 Unix Socket (Linux/macOS) 或 Named Pipe (Windows) 暴露 IPC 接口
 * - Bot 重启时只需重连 Socket，不影响 Claude CLI 进程
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const VALID_NAME_RE = /^[a-zA-Z0-9_-]+$/;

const processName = process.argv[2] || 'default';
const sessionId = process.argv[3] || 'default-session';

// 校验输入参数，防止命令注入
if (!VALID_NAME_RE.test(processName)) {
  process.stderr.write(`Invalid processName: "${processName}". Only [a-zA-Z0-9_-] allowed.\n`);
  process.exit(1);
}
if (!VALID_NAME_RE.test(sessionId)) {
  process.stderr.write(`Invalid sessionId: "${sessionId}". Only [a-zA-Z0-9_-] allowed.\n`);
  process.exit(1);
}

const isWindows = os.platform() === 'win32';

const pipePath = isWindows
  ? `\\\\.\\pipe\\claude-bot-${processName}`
  : path.join(os.tmpdir(), `claude-bot-${processName}.sock`);

const pidFile = path.join(os.tmpdir(), `claude-proxy-${processName}.pid`);
const logFile = path.join(os.tmpdir(), `claude-proxy-${processName}.log`);

// 使用 writeStream 替代 appendFileSync，避免阻塞事件循环
let logStream: fs.WriteStream | null = null;

function getLogStream(): fs.WriteStream {
  if (!logStream) {
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  }
  return logStream;
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [proxy:${processName}] ${msg}\n`;
  try {
    getLogStream().write(line);
  } catch {
    // ignore write errors
  }
  process.stdout.write(line);
}

let claude: ChildProcess | null = null;
let currentClient: net.Socket | null = null;
let shuttingDown = false;

// 重启退避机制
const MAX_RESTART_RETRIES = 5;
const BASE_RESTART_DELAY = 3000;
let restartCount = 0;
let lastSuccessTime = 0;

function sessionFileExists(): boolean {
  const homeDir = os.homedir();
  const cwd = process.cwd().replace(/[:\\/]/g, '-');
  const sessionFile = path.join(homeDir, '.claude', 'projects', cwd, `${sessionId}.jsonl`);
  const exists = fs.existsSync(sessionFile);
  log(
    `Session file check: ${sessionFile} → ${exists ? 'EXISTS (will use --resume)' : 'NOT FOUND (will use --session-id)'}`
  );
  return exists;
}

function startClaude(): void {
  if (shuttingDown) return;

  if (restartCount >= MAX_RESTART_RETRIES) {
    log(`Claude CLI failed ${MAX_RESTART_RETRIES} times consecutively, stopping auto-restart.`);
    return;
  }

  const useResume = sessionFileExists();
  const sessionArgs = useResume ? ['--resume', sessionId] : ['--session-id', sessionId];

  const claudeArgs = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    ...sessionArgs,
  ];

  log(
    `Starting Claude CLI: session=${sessionId} (attempt ${restartCount + 1}/${MAX_RESTART_RETRIES})`
  );

  if (isWindows) {
    const bashPath = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
    if (fs.existsSync(bashPath)) {
      claude = spawn(bashPath, ['-c', `claude ${claudeArgs.join(' ')}`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } else {
      claude = spawn('claude', claudeArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
      });
    }
  } else {
    claude = spawn('claude', claudeArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  log(`Claude CLI started: PID=${claude.pid}`);

  claude.stdout?.on('data', (data: Buffer) => {
    if (currentClient && !currentClient.destroyed) {
      try {
        currentClient.write(data);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        log(`Failed to write to client: ${message}`);
      }
    }
  });

  claude.stderr?.on('data', (data: Buffer) => {
    const content = data.toString();
    log(`stderr: ${content.substring(0, 500)}`);
  });

  claude.on('error', err => {
    log(`Claude CLI error: ${err.message}`);
  });

  claude.on('exit', (code, signal) => {
    log(`Claude CLI exited: code=${code}, signal=${signal}`);

    if (currentClient && !currentClient.destroyed) {
      const errorEvent = JSON.stringify({
        type: 'error',
        content: `Claude CLI process exited with code ${code}`,
      });
      try {
        currentClient.write(errorEvent + '\n');
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        log(`Failed to send exit event to client: ${message}`);
      }
    }

    claude = null;

    if (!shuttingDown) {
      const now = Date.now();
      if (lastSuccessTime > 0 && now - lastSuccessTime > 60000) {
        restartCount = 0;
      }

      restartCount++;
      const delay = BASE_RESTART_DELAY * Math.pow(2, restartCount - 1);
      log(
        `Restarting Claude CLI in ${delay / 1000}s (retry ${restartCount}/${MAX_RESTART_RETRIES})...`
      );
      setTimeout(() => startClaude(), delay);
    }
  });

  const initWatcher = (data: Buffer) => {
    const text = data.toString();
    if (text.includes('"type":"system"') || text.includes('"subtype":"init"')) {
      lastSuccessTime = Date.now();
      restartCount = 0;
      log('Claude CLI initialized successfully, reset restart counter');
    }
  };
  claude.stdout?.on('data', initWatcher);
}

if (!isWindows && fs.existsSync(pipePath)) {
  try {
    fs.unlinkSync(pipePath);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log(`Failed to remove stale socket: ${message}`);
  }
}

const server = net.createServer(socket => {
  log('Client connected');

  if (currentClient && !currentClient.destroyed) {
    log('Closing previous client connection');
    currentClient.destroy();
  }
  currentClient = socket;

  socket.on('data', (data: Buffer) => {
    if (claude?.stdin && !claude.stdin.destroyed) {
      try {
        claude.stdin.write(data);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        log(`Failed to write to Claude CLI stdin: ${message}`);
      }
    } else {
      log('Claude CLI stdin not available, dropping data');
    }
  });

  socket.on('close', () => {
    log('Client disconnected');
    if (currentClient === socket) {
      currentClient = null;
    }
  });

  socket.on('error', err => {
    log(`Client socket error: ${err.message}`);
    if (currentClient === socket) {
      currentClient = null;
    }
  });
});

server.on('error', err => {
  log(`Server error: ${err.message}`);
});

server.listen(pipePath, () => {
  log(`Proxy listening on: ${pipePath}`);
  try {
    fs.writeFileSync(pidFile, process.pid.toString());
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log(`Failed to write PID file: ${message}`);
  }
});

startClaude();

function cleanup(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Proxy shutting down...');

  server.close();

  if (currentClient && !currentClient.destroyed) {
    currentClient.destroy();
  }

  if (claude && claude.pid) {
    if (isWindows) {
      try {
        execSync(`taskkill /PID ${claude.pid} /T /F`, { timeout: 5000 });
        log(`Killed Claude CLI process tree: PID=${claude.pid}`);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        log(`taskkill failed: ${message}`);
      }
    } else {
      claude.kill('SIGTERM');
      setTimeout(() => {
        if (claude) {
          claude.kill('SIGKILL');
        }
      }, 3000);
    }
  }

  try {
    fs.unlinkSync(pidFile);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log(`Failed to remove PID file: ${message}`);
  }
  if (!isWindows) {
    try {
      fs.unlinkSync(pipePath);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log(`Failed to remove socket: ${message}`);
    }
  }

  // 关闭日志流
  if (logStream) {
    logStream.end();
    logStream = null;
  }

  setTimeout(() => process.exit(0), 4000);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

log(`Proxy started: PID=${process.pid}, processName=${processName}, sessionId=${sessionId}`);
