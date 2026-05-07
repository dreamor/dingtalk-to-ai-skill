/**
 * Relay 管理器 - 管理 Bot 间对话
 *
 * 允许用户消息在一个 Agent 处理后自动转发给另一个 Agent 补充，
 * 实现多 Agent 协作。
 */
import { randomUUID } from 'crypto';
import type { RelayMessage, RelayConfig, RelayResult } from './types';
import { agentRegistry } from '../agents';
import type { MessageContext } from '../types/message';

export class RelayManager {
  private config: RelayConfig;
  private history: Map<string, RelayMessage[]> = new Map();

  constructor(config?: Partial<RelayConfig>) {
    this.config = {
      enabled: config?.enabled ?? false,
      maxHops: config?.maxHops ?? 3,
      timeout: config?.timeout ?? 120000,
    };
  }

  /** 是否启用 */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 发送消息到目标项目（Agent）
   */
  async sendTo(
    sourceAgent: string,
    targetAgent: string,
    message: string,
    context?: MessageContext,
  ): Promise<RelayResult> {
    if (!this.config.enabled) {
      return {
        success: false,
        response: '',
        hopCount: 0,
        executionTime: 0,
        error: 'Relay 功能未启用',
      };
    }

    const startTime = Date.now();
    const agent = agentRegistry.get(targetAgent);

    if (!agent) {
      return {
        success: false,
        response: '',
        hopCount: 0,
        executionTime: Date.now() - startTime,
        error: `Agent "${targetAgent}" 不存在`,
      };
    }

    // 记录 Relay 消息
    const relayMessage: RelayMessage = {
      id: `relay-${randomUUID()}`,
      fromProject: sourceAgent,
      toProject: targetAgent,
      content: message,
      timestamp: Date.now(),
    };

    const historyKey = `${sourceAgent}->${targetAgent}`;
    if (!this.history.has(historyKey)) {
      this.history.set(historyKey, []);
    }
    this.history.get(historyKey)!.push(relayMessage);

    try {
      const result = await agent.execute(message, context);

      return {
        success: result.success,
        response: result.output,
        hopCount: 1,
        executionTime: Date.now() - startTime,
        error: result.error,
      };
    } catch (error) {
      return {
        success: false,
        response: '',
        hopCount: 1,
        executionTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 链式转发 - 按顺序经过多个 Agent
   */
  async chainRelay(
    agents: string[],
    message: string,
    context?: MessageContext,
  ): Promise<RelayResult> {
    if (agents.length === 0) {
      return {
        success: false,
        response: '',
        hopCount: 0,
        executionTime: 0,
        error: 'Agent 链为空',
      };
    }

    if (agents.length > this.config.maxHops) {
      return {
        success: false,
        response: '',
        hopCount: 0,
        executionTime: 0,
        error: `转发链超过最大长度 (${this.config.maxHops})`,
      };
    }

    const startTime = Date.now();
    let currentMessage = message;
    let lastSource = '';

    for (const agentName of agents) {
      const result = await this.sendTo(lastSource || 'user', agentName, currentMessage, context);

      if (!result.success) {
        return {
          ...result,
          hopCount: agents.indexOf(agentName) + 1,
          executionTime: Date.now() - startTime,
        };
      }

      currentMessage = result.response;
      lastSource = agentName;
    }

    return {
      success: true,
      response: currentMessage,
      hopCount: agents.length,
      executionTime: Date.now() - startTime,
    };
  }

  /** 获取转发历史 */
  getHistory(source?: string, target?: string): RelayMessage[] {
    if (source && target) {
      return this.history.get(`${source}->${target}`) || [];
    }
    const all: RelayMessage[] = [];
    this.history.forEach(messages => {
      all.push(...messages);
    });
    return all;
  }

  /** 清理历史 */
  clearHistory(): void {
    this.history.clear();
  }

  /** 获取配置 */
  getConfig(): RelayConfig {
    return { ...this.config };
  }
}
