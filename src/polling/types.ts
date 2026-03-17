/**
 * 轮询服务类型定义
 */
import { DingtalkMessage } from '../dingtalk/dingtalk';

/**
 * 轮询状态信息
 */
export interface PollingStatus {
  enabled: boolean;
  running: boolean;
  interval: number;
  messagesPulled: number;
  lastPullTime: number | null;
  lastMessageTime: number | null;
  consecutiveEmptyPulls: number;
  idleMode: boolean;
}

/**
 * 消息拉取结果
 */
export interface PullResult {
  success: boolean;
  messages: DingtalkMessage[];
  cursor?: string;
  error?: string;
}

/**
 * 游标状态
 */
export interface CursorState {
  cursor: string | null;
  lastMessageTime: number;
  lastMessageId: string | null;
  updatedAt: number;
}

/**
 * 轮询配置
 */
export interface PollingConfig {
  enabled: boolean;
  interval: number;
  timeout: number;
  minInterval: number;
  maxInterval: number;
  idleThreshold: number;
}

/**
 * 消息处理回调参数
 */
export interface MessageHandlerParams {
  messages: DingtalkMessage[];
  cursor: string | null;
}

/**
 * 消息处理回调函数类型
 */
export type MessageHandler = (params: MessageHandlerParams) => Promise<void>;