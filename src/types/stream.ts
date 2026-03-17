/**
 * 流式类型定义
 * 用于 OpenCode CLI 流式连接
 */

/**
 * 流式连接状态
 */
export type StreamConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

/**
 * 流式连接接口
 */
export interface StreamConnection {
  status: StreamConnectionStatus;
  connectedAt?: number;
  lastActivityAt?: number;
}