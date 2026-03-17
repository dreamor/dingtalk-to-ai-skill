/**
 * 会话类型定义
 * 用于管理用户对话会话
 */

import { ConversationMessage } from './message';

/**
 * 会话状态枚举
 */
export enum SessionState {
  /** 活跃状态 - 正在交互 */
  Active = 'active',
  /** 空闲状态 - 等待用户响应 */
  Idle = 'idle',
  /** 过期状态 - 超过 TTL 未活动 */
  Expired = 'expired',
  /** 终止状态 - 用户主动结束 */
  Terminated = 'terminated',
}

/**
 * 会话配置
 */
export interface SessionConfig {
  /** 会话 TTL (毫秒) */
  ttl: number;
  /** 最大历史消息数 */
  maxHistoryMessages: number;
  /** 最大上下文 token 数 */
  maxContextTokens: number;
  /** 是否启用自动摘要 */
  enableAutoSummary: boolean;
  /** 摘要触发阈值 (消息数) */
  summaryThreshold: number;
}

/**
 * 会话上下文
 */
export interface ConversationContext {
  conversationId: string;
  messages: ConversationMessage[];
  summary?: string;
  metadata: {
    createdAt: number;
    lastActivityAt: number;
    messageCount: number;
  };
}

/**
 * 会话对象
 */
export interface Session {
  conversationId: string;
  userId: string;
  state: SessionState;
  config: SessionConfig;
  context: ConversationContext;
  createdAt: number;
  lastActivityAt: number;
  expiresAt?: number;
}

/**
 * 会话存储接口
 */
export interface SessionStorage {
  /** 创建会话 */
  create(session: Session): Promise<void>;
  /** 获取会话 */
  get(conversationId: string): Promise<Session | null>;
  /** 更新会话 */
  update(session: Session): Promise<void>;
  /** 删除会话 */
  delete(conversationId: string): Promise<void>;
  /** 获取用户的所有会话 */
  getByUser(userId: string): Promise<Session[]>;
  /** 获取所有过期会话 */
  getExpired(before: number): Promise<Session[]>;
  /** 获取所有会话 */
  getAll(): Promise<Session[]>;
}

/**
 * 消息历史管理接口
 */
export interface HistoryManager {
  /** 添加消息到历史 */
  addMessage(conversationId: string, message: ConversationMessage): Promise<void>;
  /** 获取历史消息 */
  getHistory(conversationId: string, limit?: number): Promise<ConversationMessage[]>;
  /** 搜索历史消息 */
  searchHistory(conversationId: string, query: string): Promise<ConversationMessage[]>;
  /** 清理历史消息 */
  clearHistory(conversationId: string): Promise<void>;
  /** 获取消息数量 */
  getCount(conversationId: string): Promise<number>;
}

/**
 * 上下文构建器接口
 */
export interface ContextBuilder {
  /** 聚合消息为上下文 */
  aggregateMessages(messages: ConversationMessage[]): string;
  /** 裁剪上下文以适应 token 限制 */
  trimContext(messages: ConversationMessage[], maxTokens: number): ConversationMessage[];
  /** 生成历史摘要 */
  summarizeHistory(messages: ConversationMessage[]): Promise<string>;
}

/**
 * 默认会话配置
 */
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  ttl: 30 * 60 * 1000, // 30 分钟
  maxHistoryMessages: 50,
  maxContextTokens: 4000,
  enableAutoSummary: true,
  summaryThreshold: 20,
};