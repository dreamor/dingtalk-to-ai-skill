/**
 * Claude Code CLI 执行器
 * 负责调用 Claude Code CLI 处理各种任务
 * 通过 claude CLI 的 -p (prompt) 选项传递消息
 */
import { spawn, ChildProcess } from 'child_process';
import { config } from '../config';
import { withRetry } from '../utils/retry';

export interface ClaudeCodeResult {
  success: boolean;
  output: string;
  error?: string;
  executionTime: number;
  exitCode: number;
}

export interface ClaudeCodeConfig {
  command: string;
  timeout: number;
  maxRetries: number;
  retryBaseDelay?: number;
  retryMaxDelay?: number;
  workingDir?: string;
  model: string;
  maxInputLength: number;
}

export interface MessageContext {
  userId: string;
  userName?: string;
  conversationId?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// 输入验证错误
export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputValidationError';
  }
}

/**
 * Claude Code CLI 执行器类
 */
export class ClaudeCodeExecutor {
  private config: ClaudeCodeConfig;

  constructor(options?: Partial<ClaudeCodeConfig>) {
    this.config = {
      command: config.claude.command,
      timeout: config.claude.timeout,
      maxRetries: config.claude.maxRetries,
      workingDir: config.claude.workingDir,
      model: config.claude.model,
      maxInputLength: config.claude.maxInputLength,
      ...options,
    };
  }

  /**
   * 执行 Claude Code 命令 - 主要入口
   * 使用 claude -p "prompt" 方式调用
   */
  async execute(prompt: string, context?: MessageContext): Promise<ClaudeCodeResult> {
    const startTime = Date.now();

    console.log(`📝 执行 Claude Code: ${prompt.substring(0, 50)}...`);
    if (context?.userId) {
      console.log(`   用户: ${context.userName || context.userId}`);
    }

    try {
      // 构建完整的输入（包含上下文）
      const fullPrompt = this.buildPromptWithContext(prompt, context);

      // 验证输入长度
      this.validateInput(fullPrompt);

      // 构建命令参数（prompt 通过 stdin 传递）
      const args = this.buildCommandArgs();

      // 使用重试机制处理临时性故障
      const result = await withRetry(
        () => this.runCommand(args, fullPrompt),
        {
          maxRetries: this.config.maxRetries,
          baseDelay: this.config.retryBaseDelay || 1000,
          maxDelay: this.config.retryMaxDelay || 10000,
          exponential: true,
          onRetry: (attempt, error, delay) => {
            console.warn(
              `[Claude Code] 执行失败，正在重试 (第 ${attempt}/${this.config.maxRetries} 次，延迟 ${delay}ms): ${error.message}`
            );
          },
        }
      );

      // 解析输出
      const parsedOutput = this.parseOutput(result.output);

      return {
        ...result,
        output: parsedOutput,
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      console.error('[Claude Code] 执行失败:', error);

      if (error instanceof InputValidationError) {
        return {
          success: false,
          output: '',
          error: error.message,
          executionTime: Date.now() - startTime,
          exitCode: -1,
        };
      }

      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : '未知错误',
        executionTime: Date.now() - startTime,
        exitCode: -1,
      };
    }
  }

  /**
   * 验证输入长度
   */
  private validateInput(input: string): void {
    if (input.length > this.config.maxInputLength) {
      throw new InputValidationError(
        `输入内容过长 (${input.length} 字符)，最大允许 ${this.config.maxInputLength} 字符`
      );
    }
  }

  /**
   * 解析 Claude Code 的输出
   */
  private parseOutput(output: string): string {
    // 移除 ANSI 颜色代码
    const cleaned = output.replace(/\x1b\[[0-9;]*m/g, '');
    
    // 尝试解析 JSON 格式
    try {
      const json = JSON.parse(cleaned);
      if (json.result) {
        return json.result;
      }
      if (json.text) {
        return json.text;
      }
    } catch {
      // 不是 JSON，保持原有逻辑
    }
    
    // 兼容非 JSON 输出
    const lines = cleaned.split('\n').filter(line => {
      const trimmed = line.trim();
      return trimmed && 
             !trimmed.startsWith('>') && 
             !trimmed.startsWith('⚠') && 
             !trimmed.startsWith('请') &&
             trimmed.length > 0;
    });

    return lines.join('\n').trim() || cleaned.trim();
  }

  /**
   * 过滤警告消息
   */
  private filterWarnings(text: string): string {
    if (!text) return text;
    
    let result = text;
    
    // 移除所有 Claude Code 的启动警告和提示
    const warningPatterns = [
      /我已注意到您使用了.*?标志.*?请问您需要我完成什么任务？\n?/gi,
      /I have noticed you are using.*?This is a destructive operation.*?sandboxing\.\n?/gi,
      /我已收到您使用.*?标志启动.*?无需逐一确认\n?/gi,
      /I have received.*?--dangerously-skip-permissions.*?without you needing to confirm\n?/gi,
      /You have granted.*?full permission.*?execute operations without confirmation\n?/gi,
      /This is a special session.*?skip permission checks\n?/gi,
      /dangerously-skip-permissions.*?完全权限\n?/gi,
      /这是一个破坏性操作.*?沙盒安全保护\n?/gi,
      /Please confirm.*?do you want to continue in this mode\n?/gi,
      /通常只有在以下情况才需要:\n?/gi,
      /●.*?运行需要更高权限的系统命令\n?/gi,
      /●.*?执行受信任的内部工具\n?/gi,
      /●.*?处理已知安全的脚本\n?/gi,
      /如果您只是想进行常规的代码编辑.*?不需要使用此标志\n?/gi,
      /请告诉我您想要做什么.*?\n?/gi,
      /钉钉.*?自动化项目.*?可以帮助您进行各种开发任务\n?/gi,
      /●.*?修改和调试代码\n?/gi,
      /●.*?添加新功能\n?/gi,
      /●.*?运行测试\n?/gi,
      /●.*?执行 git 操作\n?/gi,
      /请问您今天需要我帮您处理什么任务\n?/gi,
    ];
    
    for (const pattern of warningPatterns) {
      result = result.replace(pattern, '');
    }

    // 移除空行
    result = result.replace(/\n{3,}/g, '\n\n');
    
    return result.trim();
  }

  /**
   * 构建包含上下文的完整提示
   */
  private buildPromptWithContext(prompt: string, context?: MessageContext): string {
    let fullPrompt = `你是一个友好的AI助手，正在与用户在钉钉群聊中直接对话。请直接回答用户的问题，不要询问项目、代码或任务相关的话题。\n\n`;

    if (context?.history && context.history.length > 0) {
      // 如果有历史消息，构建对话上下文
      const historyText = context.history
        .slice(-10) // 最多保留最近 10 条
        .map(msg => `${msg.role === 'user' ? '用户' : '助手'}: ${msg.content}`)
        .join('\n\n');

      fullPrompt += `对话历史:\n${historyText}\n\n`;
    }

    fullPrompt += `用户说: ${prompt}\n\n请直接回复:`;

    return fullPrompt;
  }

  /**
   * 构建命令参数
   * Claude Code CLI 调用方式: claude -p --dangerously-skip-permissions
   * prompt 通过 stdin 传递
   * 使用 JSON 格式输出以便正确解析
   */
  private buildCommandArgs(): string[] {
    const args = ['-p', '--dangerously-skip-permissions', '--output-format', 'json'];
    if (this.config.model) {
      args.push('--model', this.config.model);
    }
    return args;
  }

  /**
   * 执行命令
   */
  private runCommand(args: string[], stdinInput: string): Promise<ClaudeCodeResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let processInstance: ChildProcess | null = null;
      let resolved = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      // 日志中隐藏敏感参数
      console.log(`[Claude Code] 执行命令: ${this.config.command} -p <stdin>`);

      // 启动 Claude Code CLI 进程
      processInstance = spawn(this.config.command, args, {
        cwd: this.config.workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LANG: 'zh_CN.UTF-8',
        },
      });

      // 通过 stdin 写入 prompt
      if (processInstance.stdin) {
        processInstance.stdin.write(stdinInput);
        processInstance.stdin.end();
      }

      // 捕获标准输出
      processInstance.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      // 捕获错误输出
      processInstance.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // 进程结束
      processInstance.on('close', (code) => {
        if (resolved) return;
        resolved = true;

        // 清理超时定时器
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        console.log(`[Claude Code] 进程结束，退出码: ${code}`);

        // 先过滤输出中的警告
        const filteredOutput = this.filterWarnings(stdout.trim());
        const filteredError = stderr.trim() ? this.filterWarnings(stderr.trim()) : '';
        
        resolve({
          success: code === 0,
          output: filteredOutput,
          error: filteredError || undefined,
          exitCode: code || 0,
          executionTime: 0,
        });
      });

      // 错误处理
      processInstance.on('error', (error) => {
        if (resolved) return;
        resolved = true;

        // 清理超时定时器
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        console.error('[Claude Code] 进程错误:', error);

        // 如果是命令未找到
        if ('code' in error && error.code === 'ENOENT') {
          resolve({
            success: false,
            output: '',
            error: `Claude Code CLI 未安装或找不到命令: ${this.config.command}`,
            exitCode: -1,
            executionTime: 0,
          });
        } else {
          resolve({
            success: false,
            output: '',
            error: error.message,
            exitCode: -1,
            executionTime: 0,
          });
        }
      });

      // 超时处理
      timeoutId = setTimeout(() => {
        if (processInstance && !processInstance.killed && !resolved) {
          console.log(`[Claude Code] 执行超时 (${this.config.timeout / 1000}秒)，终止进程`);
          resolved = true;
          processInstance.kill('SIGTERM');

          // 如果 SIGTERM 不生效，强制杀死
          setTimeout(() => {
            if (processInstance && !processInstance.killed) {
              processInstance.kill('SIGKILL');
            }
          }, 5000);

          resolve({
            success: false,
            output: stdout.trim(),
            error: `命令执行超时 (${this.config.timeout / 1000}秒)`,
            exitCode: -1,
            executionTime: this.config.timeout,
          });
        }
      }, this.config.timeout);
    });
  }

  /**
   * 流式执行（实时输出）
   */
  async executeStream(
    prompt: string,
    onChunk: (chunk: string) => void,
    context?: MessageContext
  ): Promise<ClaudeCodeResult> {
    const startTime = Date.now();

    console.log(`📝 流式执行 Claude Code: ${prompt.substring(0, 50)}...`);

    try {
      const fullPrompt = this.buildPromptWithContext(prompt, context);
      this.validateInput(fullPrompt);

      const args = this.buildCommandArgs();
      return await this.runCommandStream(args, fullPrompt, onChunk, startTime);
    } catch (error) {
      if (error instanceof InputValidationError) {
        return {
          success: false,
          output: '',
          error: error.message,
          executionTime: Date.now() - startTime,
          exitCode: -1,
        };
      }

      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : '未知错误',
        executionTime: Date.now() - startTime,
        exitCode: -1,
      };
    }
  }

  /**
   * 流式执行命令
   */
  private runCommandStream(
    args: string[],
    stdinInput: string,
    onChunk: (chunk: string) => void,
    startTime: number
  ): Promise<ClaudeCodeResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let processInstance: ChildProcess | null = null;
      let resolved = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      // 启动 Claude Code CLI 进程
      processInstance = spawn(this.config.command, args, {
        cwd: this.config.workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LANG: 'zh_CN.UTF-8',
        },
      });

      // 通过 stdin 写入 prompt
      if (processInstance.stdin) {
        processInstance.stdin.write(stdinInput);
        processInstance.stdin.end();
      }

      // 流式输出
      processInstance.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        onChunk(chunk);
      });

      processInstance.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        if (!chunk.includes('warning') && !chunk.includes('Warning')) {
          onChunk(chunk);
        }
      });

      processInstance.on('close', (code) => {
        if (resolved) return;
        resolved = true;

        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        const parsedOutput = this.parseOutput(stdout.trim());

        resolve({
          success: code === 0,
          output: parsedOutput,
          error: stderr.trim() || undefined,
          exitCode: code || 0,
          executionTime: Date.now() - startTime,
        });
      });

      processInstance.on('error', (error) => {
        if (resolved) return;
        resolved = true;

        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        resolve({
          success: false,
          output: '',
          error: error.message,
          exitCode: -1,
          executionTime: Date.now() - startTime,
        });
      });

      // 超时处理
      timeoutId = setTimeout(() => {
        if (processInstance && !processInstance.killed && !resolved) {
          resolved = true;
          processInstance.kill('SIGTERM');

          resolve({
            success: false,
            output: stdout.trim(),
            error: `命令执行超时 (${this.config.timeout / 1000}秒)`,
            exitCode: -1,
            executionTime: this.config.timeout,
          });
        }
      }, this.config.timeout);
    });
  }

  /**
   * 检查 Claude Code CLI 是否可用
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(this.config.command, ['--version'], {
        stdio: 'ignore',
      });

      proc.on('close', (code) => {
        resolve(code === 0);
      });

      proc.on('error', () => {
        resolve(false);
      });

      // 快速超时
      setTimeout(() => {
        proc.kill();
        resolve(false);
      }, 5000);
    });
  }

  /**
   * 获取当前配置
   */
  getConfig(): ClaudeCodeConfig {
    return { ...this.config };
  }
}

/**
 * 创建 Claude Code 执行器实例
 */
export function createClaudeCodeExecutor(
  options?: Partial<ClaudeCodeConfig>
): ClaudeCodeExecutor {
  return new ClaudeCodeExecutor(options);
}