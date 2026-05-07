/**
 * 钉钉平台实现 - 适配 Platform 接口
 */
import type {
  Platform,
  MessageHandler,
  IncomingMessage,
  ReplyContext,
  Card,
  CardSender,
  TypingIndicator,
} from '../types';
import type { StreamingCardUpdater } from '../types';
import { DingtalkService } from '../../dingtalk/dingtalk';
import { DingtalkStreamService } from '../../dingtalk/stream';
import { CardBuilder } from '../../dingtalk/cards';
import { config } from '../../config';
import { renderMarkdown } from '../../utils/markdown';
import type { CommandHandler } from '../../commands/commandHandler';
import type { MediaProcessor } from '../../media/mediaProcessor';

export class DingtalkPlatform implements Platform, CardSender, TypingIndicator {
  readonly name = 'dingtalk';
  private dingtalkService: DingtalkService;
  private streamService: DingtalkStreamService;
  private messageHandler: MessageHandler | null = null;

  constructor(dingtalkService: DingtalkService, streamService: DingtalkStreamService) {
    this.dingtalkService = dingtalkService;
    this.streamService = streamService;
  }

  async start(handler: MessageHandler): Promise<void> {
    this.messageHandler = handler;

    // 设置 Stream 消息处理器
    this.streamService.setMessageHandler(
      async (userId, userName, content, conversationId, sessionWebhook) => {
        if (this.messageHandler) {
          const msg: IncomingMessage = {
            id: `dt-${Date.now()}`,
            content,
            userId,
            userName,
            conversationId,
            sessionWebhook,
            msgType: 'text',
          };
          await this.messageHandler(this, msg);
        }
      }
    );

    await this.streamService.start();
  }

  async reply(ctx: ReplyContext, content: string): Promise<void> {
    const title = config.aiProvider === 'claude' ? 'Claude Code 回复' : 'AI 回复';
    const markdownText = renderMarkdown(content);
    await this.streamService.sendMarkdownMessage(ctx.conversationId, title, markdownText);
  }

  async send(ctx: ReplyContext, content: string): Promise<void> {
    await this.streamService.sendTextMessage(ctx.conversationId, content);
  }

  async stop(): Promise<void> {
    await this.streamService.stop();
  }

  // CardSender implementation
  async sendCard(ctx: ReplyContext, card: Card): Promise<boolean> {
    const cardData = CardBuilder.createMarkdownCard(card);
    return this.streamService.sendCardMessage(ctx.conversationId, cardData);
  }

  async replyCard(ctx: ReplyContext, card: Card): Promise<boolean> {
    return this.sendCard(ctx, card);
  }

  // TypingIndicator implementation
  startTyping(ctx: ReplyContext): () => void {
    // 钉钉没有原生 typing indicator，发送临时提示消息
    this.streamService.sendTextMessage(ctx.conversationId, '⏳ AI 正在思考...').catch(() => {});

    return () => {
      // stop 函数 - 目前无操作，消息发送后无法撤回
    };
  }

  // Expose underlying services for compatibility
  getDingtalkService(): DingtalkService {
    return this.dingtalkService;
  }

  getStreamService(): DingtalkStreamService {
    return this.streamService;
  }

  setCommandHandler(handler: CommandHandler): void {
    this.streamService.setCommandHandler(handler);
  }

  setMediaProcessor(processor: MediaProcessor): void {
    this.streamService.setMediaProcessor(processor);
  }
}
