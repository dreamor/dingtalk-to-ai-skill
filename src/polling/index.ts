/**
 * 轮询服务模块
 * 负责主动拉取钉钉消息，实现无需内网穿透的消息接收
 */
export { PollingService } from './pollingService';
export { CursorManager } from './cursorManager';
export { IntervalManager } from './intervalManager';
export type { PollingStatus, CursorState } from './types';