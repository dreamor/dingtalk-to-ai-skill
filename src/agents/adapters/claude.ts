/**
 * Claude Code Agent 适配器 - 将 ClaudeCodeExecutor 适配为 Agent 接口
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { Agent, AgentResult, AgentConfig } from '../types';
import type { MessageContext } from '../../types/message';
import { ClaudeCodeExecutor } from '../../claude/executor';

export class ClaudeCodeAgent implements Agent {
  readonly name = 'claude';
  readonly type = 'claude';
  private executor: ClaudeCodeExecutor;

  constructor(options?: Record<string, unknown>) {
    this.executor = new ClaudeCodeExecutor(options as any);
  }

  async execute(prompt: string, context?: MessageContext): Promise<AgentResult> {
    const result = await this.executor.execute(prompt, context);
    return {
      success: result.success,
      output: result.output,
      error: result.error,
      executionTime: result.executionTime,
      exitCode: result.exitCode,
    };
  }

  async executeStream(
    prompt: string,
    onChunk: (chunk: string) => void,
    context?: MessageContext
  ): Promise<AgentResult> {
    const result = await this.executor.executeStream(prompt, onChunk, context);
    return {
      success: result.success,
      output: result.output,
      error: result.error,
      executionTime: result.executionTime,
      exitCode: result.exitCode,
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.executor.isAvailable();
  }

  getConfig(): AgentConfig {
    const cfg = this.executor.getConfig();
    return {
      command: cfg.command,
      timeout: cfg.timeout,
      maxRetries: cfg.maxRetries,
      retryBaseDelay: cfg.retryBaseDelay || 1000,
      retryMaxDelay: cfg.retryMaxDelay || 10000,
      workingDir: cfg.workingDir,
      model: cfg.model,
      maxInputLength: cfg.maxInputLength,
    };
  }

  /** 获取底层执行器（兼容用途） */
  getExecutor(): ClaudeCodeExecutor {
    return this.executor;
  }
}
