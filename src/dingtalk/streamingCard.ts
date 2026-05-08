/**
 * 流式卡片管理器 - 实现钉钉互动卡片的流式输出
 *
 * 核心流程：
 * 1. 调用 AICardService.createCard() 创建并投放 AI Card
 * 2. 调用 AICardService.streamUpdate() 流式更新卡片内容
 * 3. AI 执行完毕：调用 AICardService.finish() 完成卡片
 * 4. 降级兜底：如果 AI Card 创建失败，回退到 sessionWebhook 发送 markdown
 */
import axios from 'axios';
import { randomUUID } from 'crypto';
import { config } from '../config';
import type { StreamingConfig } from '../config';
import { AICardService, type AICardInstance } from './aiCardService';
import { createSafeLogger } from '../utils/logger';

const logger = createSafeLogger('StreamingCard');

/** 活跃的流式会话 */
interface ActiveStream {
  /** 卡片唯一标识 */
  outTrackId: string;
  /** 钉钉会话 ID */
  conversationId: string;
  /** 回复 webhook（降级时使用） */
  sessionWebhook: string;
  /** AI Card 实例（使用 AI Card 时） */
  card: AICardInstance | null;
  /** 积累的完整文本 */
  fullText: string;
  /** 上次已推送到卡片的文本 */
  lastSentText: string;
  /** 上次推送时间 */
  lastSentAt: number;
  /** 定时刷新器（AI Card 和降级模式共用） */
  updateTimer: NodeJS.Timeout | null;
  /** 是否已降级（使用 sessionWebhook） */
  degraded: boolean;
  /** 连续更新失败次数 */
  failureCount: number;
  /** 是否已完成 */
  finished: boolean;
  /** 发送者类型 */
  senderType: 'user' | 'group';
}

/** 流式卡片句柄 - 返回给调用者用于追加文本 */
export interface StreamCardHandle {
  outTrackId: string;
  /** 追加流式文本 */
  appendChunk(chunk: string): Promise<void>;
  /** 获取已积累的全部文本 */
  getFullText(): string;
  /** 完成流式，发送最终内容 */
  finish(finalText?: string): Promise<void>;
  /** 获取卡片是否已降级 */
  isDegraded(): boolean;
}

export class StreamingCardManager {
  private streams: Map<string, ActiveStream> = new Map();
  private config: StreamingConfig;
  private cardService: AICardService;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private static readonly STREAM_TTL_MS = 10 * 60 * 1000; // 10 分钟未活动的 stream 自动清理
  private static readonly CLEANUP_INTERVAL_MS = 60 * 1000; // 每分钟检查一次

  constructor(streamingConfig?: Partial<StreamingConfig>) {
    this.config = {
      enabled: streamingConfig?.enabled ?? config.streaming.enabled,
      intervalMs: streamingConfig?.intervalMs ?? config.streaming.intervalMs,
      minDeltaChars: streamingConfig?.minDeltaChars ?? config.streaming.minDeltaChars,
      maxChars: streamingConfig?.maxChars ?? config.streaming.maxChars,
      thinkingText: streamingConfig?.thinkingText ?? config.streaming.thinkingText,
      cardTemplateId: streamingConfig?.cardTemplateId ?? config.streaming.cardTemplateId,
    };
    this.cardService = new AICardService();
    this.startCleanupTimer();
  }

  /**
   * 启动定时清理过期 stream
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, stream] of this.streams) {
        if (now - stream.lastSentAt > StreamingCardManager.STREAM_TTL_MS && !stream.finished) {
          logger.warn(
            `清理过期 stream: ${id} (空闲 ${Math.round((now - stream.lastSentAt) / 60000)}min)`
          );
          if (stream.updateTimer) {
            clearInterval(stream.updateTimer);
          }
          stream.finished = true;
          this.streams.delete(id);
        }
      }
    }, StreamingCardManager.CLEANUP_INTERVAL_MS);
  }

  /**
   * 开始流式：创建 AI Card，完成后发送最终结果
   *
   * @param conversationId - 会话 ID
   * @param sessionWebhook - 会话 webhook（降级时使用）
   * @param senderType - 发送者类型（user=单聊，group=群聊）
   * @param sendMarkdownFn - 降级发送 markdown 的函数
   * @param sendTextFn - 降级发送文本的函数
   * @returns 流式句柄
   */
  async startStream(
    conversationId: string,
    sessionWebhook: string,
    senderType: 'user' | 'group' = 'group',
    sendMarkdownFn?: (conversationId: string, title: string, text: string) => Promise<boolean>,
    sendTextFn?: (conversationId: string, text: string) => Promise<boolean>,
    userId: string = ''
  ): Promise<StreamCardHandle> {
    const outTrackId = `stream-${randomUUID()}`;

    // 尝试创建 AI Card（如果启用）
    let card: AICardInstance | null = null;
    let useDegraded = false;

    if (this.config.enabled) {
      try {
        logger.log(`尝试创建 AI Card: ${conversationId.substring(0, 30)}...`);
        card = await this.cardService.createCard(conversationId, senderType, userId);

        if (!card) {
          logger.warn('AI Card 创建失败，使用降级模式');
          useDegraded = true;
        } else {
          logger.log(`AI Card 创建成功：${card.cardInstanceId}`);
        }
      } catch (err) {
        logger.error('AI Card 创建异常，使用降级模式:', err);
        useDegraded = true;
      }
    } else {
      logger.log('流式未启用，使用降级模式');
      useDegraded = true;
    }

    const stream: ActiveStream = {
      outTrackId,
      conversationId,
      sessionWebhook,
      card,
      fullText: '',
      lastSentText: '',
      lastSentAt: 0,
      updateTimer: null,
      degraded: useDegraded,
      failureCount: 0,
      finished: false,
      senderType,
    };

    this.streams.set(outTrackId, stream);

    return this.createHandle(stream, sendMarkdownFn, sendTextFn);
  }

  /**
   * 创建流式句柄
   */
  private createHandle(
    stream: ActiveStream,
    sendMarkdownFn?: (conversationId: string, title: string, text: string) => Promise<boolean>,
    sendTextFn?: (conversationId: string, text: string) => Promise<boolean>
  ): StreamCardHandle {
    return {
      outTrackId: stream.outTrackId,
      // eslint-disable-next-line @typescript-eslint/require-await
      appendChunk: async (chunk: string) => {
        if (stream.finished) return;

        stream.fullText += chunk;

        // 启动定时刷新器（首次收到文本时启动，统一处理 AI Card 和降级模式）
        if (!stream.updateTimer) {
          this.startFlushTimer(stream, sendMarkdownFn);
        }
      },
      getFullText: () => stream.fullText,
      finish: async (finalText?: string) => {
        if (stream.finished) return;
        stream.finished = true;

        if (finalText !== undefined) {
          stream.fullText = finalText;
        }

        // 清除定时器
        if (stream.updateTimer) {
          clearInterval(stream.updateTimer);
          stream.updateTimer = null;
        }

        // 使用 AI Card：先逐步推送打字机效果，再 finish
        if (!stream.degraded && stream.card) {
          try {
            await this.typewriterFlush(stream);
            await this.cardService.finish(stream.card, stream.fullText || '（无内容）');
            logger.log(`AI Card 完成：${stream.outTrackId}`);
          } catch (error) {
            logger.error('AI Card 完成失败，尝试降级:', error);
            await this.sendFallback(stream, sendMarkdownFn, sendTextFn);
          }
        } else {
          await this.sendFallback(stream, sendMarkdownFn, sendTextFn);
        }

        // 清理
        this.streams.delete(stream.outTrackId);
      },
      isDegraded: () => stream.degraded,
    };
  }

  /**
   * 降级发送 - 回退到 sessionWebhook 发送 markdown
   */
  private async sendFallback(
    stream: ActiveStream,
    sendMarkdownFn?: (conversationId: string, title: string, text: string) => Promise<boolean>,
    sendTextFn?: (conversationId: string, text: string) => Promise<boolean>
  ): Promise<void> {
    const title = 'AI 回复';
    const text = stream.fullText || '（无内容）';

    // 优先使用传入的发送函数
    if (sendMarkdownFn) {
      try {
        const sent = await sendMarkdownFn(stream.conversationId, title, text);
        if (sent) {
          logger.log(`降级 markdown 已发送：${stream.outTrackId}`);
          return;
        }
      } catch (error) {
        logger.error('降级 markdown 发送失败:', error);
      }
    }

    // 兜底：直接通过 sessionWebhook 发送
    try {
      await axios.post(
        stream.sessionWebhook,
        {
          msgtype: 'markdown',
          markdown: { title, text },
        },
        { timeout: 10000 }
      );
      logger.log(`降级 markdown 已发送（兜底）: ${stream.outTrackId}`);
    } catch (error) {
      logger.error('兜底发送失败:', error);

      // 最后尝试发文本
      if (sendTextFn) {
        try {
          await sendTextFn(stream.conversationId, text.substring(0, 2000));
        } catch (e) {
          logger.error('文本发送也失败，彻底放弃:', e);
        }
      }
    }
  }

  private static readonly FLUSH_INTERVAL_MS = 300;
  private static readonly TYPEWRITER_CHUNK_SIZE = 20;
  private static readonly TYPEWRITER_DELAY_MS = 150;

  /**
   * 打字机效果刷新 — 将完整文本分步推送到 AI Card
   * 从 lastSentText 位置开始，每次多显示一段文本，间隔 150ms
   */
  private async typewriterFlush(stream: ActiveStream): Promise<void> {
    if (!stream.card || !stream.fullText) return;

    const text = stream.fullText;
    let cursor = stream.lastSentText.length;

    if (cursor >= text.length) return;

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    while (cursor < text.length) {
      cursor = Math.min(cursor + StreamingCardManager.TYPEWRITER_CHUNK_SIZE, text.length);
      const partial = text.slice(0, cursor);

      try {
        await this.cardService.streamUpdate(stream.card, partial, false);
      } catch (error) {
        logger.error('打字机推送失败，跳过:', error);
        break;
      }

      if (cursor < text.length) {
        await sleep(StreamingCardManager.TYPEWRITER_DELAY_MS);
      }
    }

    stream.lastSentText = text;
    stream.lastSentAt = Date.now();
  }

  /**
   * 启动定时刷新器 — 每 300ms 将累积文本推送到 AI Card 或降级通道
   * 改进：每次只推送一小段新文本（打字机效果），而不是全部
   */
  private startFlushTimer(
    stream: ActiveStream,
    sendMarkdownFn?: (conversationId: string, title: string, text: string) => Promise<boolean>
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    stream.updateTimer = setInterval(async () => {
      if (stream.finished) return;

      const currentText = stream.fullText;
      if (currentText.length <= stream.lastSentText.length) return;

      // 打字机效果：每次只推送一小段新文本（20 字符）
      const nextCursor = Math.min(
        stream.lastSentText.length + StreamingCardManager.TYPEWRITER_CHUNK_SIZE,
        currentText.length
      );
      const partialText = currentText.slice(0, nextCursor);

      if (!stream.degraded && stream.card) {
        try {
          await this.cardService.streamUpdate(stream.card, partialText, false);
          stream.lastSentText = partialText;
          stream.lastSentAt = Date.now();
        } catch (error) {
          logger.error('流式更新失败:', error);
          stream.failureCount++;
          if (stream.failureCount >= 3) {
            logger.warn('连续失败 3 次，降级到 sessionWebhook 模式');
            stream.degraded = true;
          }
        }
      } else if (sendMarkdownFn) {
        const sent = await sendMarkdownFn(stream.conversationId, 'AI 回复', partialText);
        if (sent) {
          stream.lastSentText = partialText;
          stream.lastSentAt = Date.now();
        }
      }
    }, StreamingCardManager.FLUSH_INTERVAL_MS);
  }

  /**
   * 清理所有流式会话
   */
  cleanup(): void {
    for (const stream of Array.from(this.streams.values())) {
      if (stream.updateTimer) {
        clearInterval(stream.updateTimer);
      }
    }
    this.streams.clear();
  }

  /**
   * 销毁管理器，释放所有资源
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cleanup();
  }

  /**
   * 获取活跃流数
   */
  getActiveStreamCount(): number {
    return this.streams.size;
  }

  /**
   * 获取配置
   */
  getConfig(): StreamingConfig {
    return { ...this.config };
  }
}
