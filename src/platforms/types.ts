/**
 * Platform 抽象层类型定义
 * 参考 cc-connect 的 core/interfaces.go 设计
 */

import type { ConversationMessage } from '../types/message';

/** 传入消息 */
export interface IncomingMessage {
  id: string;
  content: string;
  userId: string;
  userName: string;
  conversationId: string;
  sessionWebhook?: string;
  msgType: string;
  raw?: unknown;
}

/** 回复上下文 */
export interface ReplyContext {
  conversationId: string;
  sessionWebhook?: string;
  [key: string]: unknown;
}

/** 图片附件 */
export interface ImageAttachment {
  mediaId?: string;
  downloadUrl?: string;
  downloadCode?: string;
}

/** 文件附件 */
export interface FileAttachment {
  mediaId: string;
  fileName: string;
}

/** 卡片 */
export interface Card {
  title: string;
  content: string;
  buttons?: CardButton[];
  imageUrl?: string;
}

export interface CardButton {
  text: string;
  value: string;
  type?: 'primary' | 'default' | 'danger';
}

/** 消息处理器 - 由核心引擎实现，平台调用 */
export type MessageHandler = (
  platform: Platform,
  message: IncomingMessage
) => Promise<void>;

/** 核心 Platform 接口 - 每个平台必须实现 */
export interface Platform {
  readonly name: string;
  start(handler: MessageHandler): Promise<void>;
  reply(ctx: ReplyContext, content: string): Promise<void>;
  send(ctx: ReplyContext, content: string): Promise<void>;
  stop(): Promise<void>;
}

/** 可选：图片发送 */
export interface ImageSender {
  sendImage(ctx: ReplyContext, image: ImageAttachment): Promise<void>;
}

/** 可选：文件发送 */
export interface FileSender {
  sendFile(ctx: ReplyContext, file: FileAttachment): Promise<void>;
}

/** 可选：消息原地更新（用于流式输出） */
export interface MessageUpdater {
  updateMessage(ctx: ReplyContext, handle: string, content: string): Promise<boolean>;
}

/** 可选：正在输入指示 */
export interface TypingIndicator {
  startTyping(ctx: ReplyContext): () => void; // 返回 stop 函数
}

/** 可选：卡片发送 */
export interface CardSender {
  sendCard(ctx: ReplyContext, card: Card): Promise<boolean>;
  replyCard(ctx: ReplyContext, card: Card): Promise<boolean>;
}

/** 可选：流式卡片更新 */
export interface StreamingCardUpdater {
  sendStreamingCard(ctx: ReplyContext, cardId: string, content: string): Promise<boolean>;
  updateStreamingCard(ctx: ReplyContext, cardId: string, content: string): Promise<boolean>;
}
