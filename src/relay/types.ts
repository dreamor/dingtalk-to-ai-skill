/**
 * Bot 间对话（Relay）类型定义
 * 支持多个 AI Agent 之间的消息转发和协作
 */

/** Relay 消息 */
export interface RelayMessage {
  id: string;
  fromProject: string;
  toProject: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** Relay 配置 */
export interface RelayConfig {
  /** 是否启用 Relay */
  enabled: boolean;
  /** 最大转发次数（防止循环） */
  maxHops: number;
  /** 转发超时（毫秒） */
  timeout: number;
}

/** Relay 结果 */
export interface RelayResult {
  success: boolean;
  response: string;
  hopCount: number;
  executionTime: number;
  error?: string;
}
