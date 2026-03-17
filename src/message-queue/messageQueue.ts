/**
 * 消息队列
 * 负责消息的入队、出队和批量处理
 */
import { UserMessage } from '../types/message';

export type MessagePriority = 'low' | 'normal' | 'high';

interface QueuedMessage {
  message: UserMessage;
  priority: MessagePriority;
  enqueueTime: number;
  retryCount: number;
  processing: boolean;  // 标记是否正在处理
}

/**
 * 消息队列类
 */
export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private maxRetries: number;

  constructor(options?: { maxRetries?: number }) {
    this.maxRetries = options?.maxRetries ?? 3;
  }

  /**
   * 入队消息
   */
  enqueue(message: UserMessage, priority: MessagePriority = 'normal'): void {
    const queued: QueuedMessage = {
      message,
      priority,
      enqueueTime: Date.now(),
      retryCount: 0,
      processing: false,
    };

    this.queue.push(queued);
    this.sortByPriority();

    console.log(
      `📬 消息入队：${message.id} (优先级：${priority}, 队列长度：${this.queue.length})`
    );
  }

  /**
   * 出队消息
   */
  dequeue(): QueuedMessage | null {
    // 找到第一个未在处理中的消息
    const index = this.queue.findIndex(
      (item) => !item.processing
    );

    if (index === -1) {
      return null;
    }

    const item = this.queue[index];
    item.processing = true;

    return item;
  }

  /**
   * 批量出队
   */
  batchDequeue(count: number): QueuedMessage[] {
    const results: QueuedMessage[] = [];

    for (let i = 0; i < count; i++) {
      const item = this.dequeue();
      if (!item) break;
      results.push(item);
    }

    return results;
  }

  /**
   * 标记消息处理完成
   */
  complete(messageId: string): void {
    const item = this.queue.find((item) => item.message.id === messageId);
    if (item) {
      item.processing = false;
      // 从队列中移除已完成的消息
      const index = this.queue.indexOf(item);
      this.queue.splice(index, 1);
    }
    console.log(`✅ 消息处理完成：${messageId}`);
  }

  /**
   * 消息处理失败，重新入队
   */
  fail(messageId: string): void {
    const index = this.queue.findIndex(
      (item) => item.message.id === messageId && item.processing
    );

    if (index !== -1) {
      const item = this.queue[index];

      if (item.retryCount < this.maxRetries) {
        item.retryCount++;
        item.priority = 'high'; // 失败重试的消息优先级提高
        item.processing = false; // 重置处理状态，重新入队
        this.sortByPriority();
        console.log(`🔄 消息重试：${messageId} (第 ${item.retryCount} 次)`);
      } else {
        // 超过最大重试次数，从队列中移除
        this.queue.splice(index, 1);
        console.log(`❌ 消息处理失败：${messageId} (超过最大重试次数)`);
      }
    }
  }

  /**
   * 按优先级排序
   */
  private sortByPriority(): void {
    const priorityOrder: Record<MessagePriority, number> = {
      high: 0,
      normal: 1,
      low: 2,
    };

    this.queue.sort((a, b) => {
      // 先按优先级排序
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;

      // 同优先级按入队时间排序
      return a.enqueueTime - b.enqueueTime;
    });
  }

  /**
   * 获取队列长度
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * 获取处理中的消息数量
   */
  processingCount(): number {
    return this.queue.filter((item) => item.processing).length;
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * 获取队列状态
   */
  getStatus(): {
    queued: number;
    processing: number;
    byPriority: Record<MessagePriority, number>;
  } {
    const byPriority: Record<MessagePriority, number> = {
      high: 0,
      normal: 0,
      low: 0,
    };
    let processingCount = 0;

    this.queue.forEach((item) => {
      byPriority[item.priority]++;
      if (item.processing) {
        processingCount++;
      }
    });

    return {
      queued: this.queue.length - processingCount,
      processing: processingCount,
      byPriority,
    };
  }
}