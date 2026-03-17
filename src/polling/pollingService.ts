/**
 * 轮询服务
 * 主动拉取钉钉消息，实现无需内网穿透的消息接收
 */
import { DingtalkService, type FetchMessagesParams, type FetchMessagesResult } from '../dingtalk/dingtalk';
import { type MessageHandler, type PollingStatus } from './types';
import { CursorManager } from './cursorManager';
import { IntervalManager } from './intervalManager';
import { config } from '../config';

export class PollingService {
  private dingtalkService: DingtalkService;
  private cursorManager: CursorManager;
  private intervalManager: IntervalManager;
  private messageHandler: MessageHandler | null = null;
  private isRunning: boolean = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private messagesPulled: number = 0;
  private lastPullTime: number | null = null;
  private readonly maxRetries: number = 3;
  private readonly retryDelay: number = 1000;
  private readonly messageLimit: number = 20;

  constructor(dingtalkService: DingtalkService) {
    this.dingtalkService = dingtalkService;
    this.cursorManager = new CursorManager('dingtalk_polling_cursor');
    this.intervalManager = new IntervalManager({
      enabled: config.polling.enabled,
      interval: config.polling.interval,
      timeout: 5000,
      minInterval: 1000,
      maxInterval: 10000,
      idleThreshold: 3,
    });
  }

  /**
   * 设置消息处理回调
   */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * 启动轮询服务
   */
  async start(): Promise<void> {
    if (!config.polling.enabled) {
      console.log('[PollingService] 轮询模式未启用，跳过启动');
      return;
    }

    if (this.isRunning) {
      console.log('[PollingService] 服务已在运行中');
      return;
    }

    // 等待游标初始化
    await this.cursorManager.initialize();

    this.isRunning = true;
    console.log('[PollingService] 轮询服务已启动');

    // 开始首次拉取
    this.scheduleNextPull(0);
  }

  /**
   * 停止轮询服务
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    console.log('[PollingService] 轮询服务已停止');
  }

  /**
   * 调度下一次拉取
   */
  private scheduleNextPull(delay: number): void {
    if (!this.isRunning) {
      return;
    }

    this.timer = setTimeout(async () => {
      await this.pullMessages();
    }, delay);
  }

  /**
   * 执行消息拉取
   */
  async pullMessages(): Promise<void> {
    if (!config.polling.enabled) {
      return;
    }

    try {
      this.lastPullTime = Date.now();

      // 构建拉取参数
      const cursor = this.cursorManager.getCursor();
      const lastMessageTime = this.cursorManager.getLastMessageTime();

      const params: FetchMessagesParams = {
        cursor,
        timeCursor: cursor ? undefined : (lastMessageTime > 0 ? lastMessageTime : undefined),
        limit: this.messageLimit,
        timeout: 5000, // 5秒超时
      };

      // 执行拉取
      let result: FetchMessagesResult;
      try {
        result = await this.dingtalkService.fetchMessages(params);
      } catch (error) {
        // API 调用失败，尝试使用降级方案
        console.error('[PollingService] 主拉取方式失败，尝试降级方案:', error);
        result = await this.tryFallbackPull(params);
      }

      await this.handlePullResult(result);
    } catch (error) {
      console.error('[PollingService] 拉取消息失败:', error);
      this.handleError(error);
    } finally {
      if (this.isRunning) {
        // 根据当前状态调度下一次拉取
        const nextInterval = this.intervalManager.getInterval();
        this.scheduleNextPull(nextInterval);
      }
    }
  }

  /**
   * 处理拉取结果
   */
  private async handlePullResult(result: FetchMessagesResult): Promise<void> {
    const { messages, hasMore, nextCursor } = result;

    if (messages.length > 0) {
      // 更新消息计数
      this.messagesPulled += messages.length;

      // 更新游标
      const lastMessage = messages[messages.length - 1];
      const lastMessageTime = lastMessage.createTime;
      const lastMessageId = lastMessage.msgUid;

      if (nextCursor) {
        await this.cursorManager.updateCursor(nextCursor, lastMessageId, lastMessageTime);
      } else if (lastMessageTime) {
        await this.cursorManager.updateTimeCursor(lastMessageTime, lastMessageId);
      }

      // 记录消息拉取状态
      this.intervalManager.recordMessagePulled();

      // 调用消息处理回调
      if (this.messageHandler) {
        try {
          await this.messageHandler({
            messages,
            cursor: nextCursor || null,
          });
        } catch (error) {
          console.error('[PollingService] 消息处理回调失败:', error);
        }
      }

      console.log(
        `[PollingService] 拉取到 ${messages.length} 条消息，` +
        `累计: ${this.messagesPulled} 条，` +
        `游标: ${nextCursor || '时间戳模式'}`
      );
    } else {
      // 无新消息
      this.intervalManager.recordEmptyPull();
      console.log(
        `[PollingService] 无新消息，间隔: ${this.intervalManager.getInterval()}ms，` +
        `连续空拉取: ${this.intervalManager.getConsecutiveEmptyPulls()}`
      );
    }

    // 如果还有更多消息，立即触发下一次拉取
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    hasMore && this.scheduleNextPull(0);
  }

  /**
   * 降级拉取方案
   */
  private async tryFallbackPull(params: FetchMessagesParams): Promise<FetchMessagesResult> {
    // 尝试使用时间戳方式拉取
    if (params.timeCursor) {
      try {
        const messages = await this.dingtalkService.fetchGroupMessages(
          params.timeCursor,
          params.limit
        );
        return {
          hasMore: messages.length >= (params.limit || 20),
          nextCursor: undefined,
          messages,
        };
      } catch (error) {
        console.error('[PollingService] 降级方案也失败:', error);
        throw error;
      }
    }

    // 返回空结果
    return {
      hasMore: false,
      messages: [],
    };
  }

  /**
   * 处理错误
   */
  private handleError(error: unknown): void {
    // 记录错误后，按照间隔管理器设置的间隔进行重试
    console.error('[PollingService] 拉取错误:', error instanceof Error ? error.message : '未知错误');

    // 连续失败会增加间隔
    this.intervalManager.recordEmptyPull();
  }

  /**
   * 重试拉取
   */
  private async retryWithBackoff(attempt: number): Promise<void> {
    if (attempt >= this.maxRetries) {
      console.error('[PollingService] 重试次数已达上限，放弃本次拉取');
      return;
    }

    const delay = this.retryDelay * Math.pow(2, attempt);
    console.log(`[PollingService] ${delay}ms 后进行第 ${attempt + 1} 次重试`);

    await new Promise(resolve => setTimeout(resolve, delay));
    await this.pullMessages();
  }

  /**
   * 获取当前状态
   */
  getStatus(): PollingStatus {
    return {
      enabled: config.polling.enabled,
      running: this.isRunning,
      interval: this.intervalManager.getInterval(),
      messagesPulled: this.messagesPulled,
      lastPullTime: this.lastPullTime,
      lastMessageTime: this.cursorManager.getLastMessageTime(),
      consecutiveEmptyPulls: this.intervalManager.getConsecutiveEmptyPulls(),
      idleMode: this.intervalManager.isIdleMode(),
    };
  }

  /**
   * 获取游标状态
   */
  getCursorState(): Record<string, unknown> {
    return this.cursorManager.getSnapshot();
  }

  /**
   * 获取间隔管理器状态
   */
  getIntervalState(): Record<string, unknown> {
    return this.intervalManager.getSnapshot();
  }

  /**
   * 手动触发一次消息拉取（用于测试）
   */
  async triggerManualPull(): Promise<void> {
    if (!this.isRunning) {
      console.log('[PollingService] 服务未运行，无法触发手动拉取');
      return;
    }
    await this.pullMessages();
  }

  /**
   * 重置轮询状态
   */
  async reset(): Promise<void> {
    await this.cursorManager.reset();
    this.intervalManager.resetInterval();
    this.messagesPulled = 0;
    this.lastPullTime = null;
    console.log('[PollingService] 状态已重置');
  }
}