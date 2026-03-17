/**
 * 消息游标管理器
 * 负责记录和管理消息拉取位置，支持序列化/反序列化
 */
import { type CursorState } from './types';

/**
 * Cursor Manager 类
 * 管理消息拉取的游标位置，避免重复处理消息
 */
export class CursorManager {
  private state: CursorState;
  private readonly storageKey: string;
  private loading: Promise<void> | null = null;

  constructor(storageKey: string = 'dingtalk_polling_cursor') {
    this.storageKey = storageKey;
    this.state = {
      cursor: null,
      lastMessageTime: 0,
      lastMessageId: null,
      updatedAt: Date.now(),
    };
    // 启动时尝试从存储加载
    this.loading = this.loadFromStorage();
  }

  /**
   * 等待初始化完成
   */
  async initialize(): Promise<void> {
    if (this.loading) {
      await this.loading;
    }
  }

  /**
   * 获取当前游标状态
   */
  getState(): CursorState {
    return { ...this.state };
  }

  /**
   * 获取当前游标值
   */
  getCursor(): string | null {
    return this.state.cursor;
  }

  /**
   * 获取上次消息时间
   */
  getLastMessageTime(): number {
    return this.state.lastMessageTime;
  }

  /**
   * 更新游标位置
   */
  async updateCursor(cursor: string, messageId?: string, messageTime?: number): Promise<void> {
    const previousCursor = this.state.cursor;
    this.state = {
      cursor,
      lastMessageId: messageId || this.state.lastMessageId,
      lastMessageTime: messageTime || this.state.lastMessageTime,
      updatedAt: Date.now(),
    };

    // 游标有变化时保存到存储
    if (cursor !== previousCursor) {
      await this.saveToStorage();
      console.log(`[CursorManager] 游标已更新: ${previousCursor || 'null'} -> ${cursor}`);
    }
  }

  /**
   * 更新时间戳游标（用于时间范围拉取）
   */
  async updateTimeCursor(messageTime: number, messageId?: string): Promise<void> {
    if (messageTime > this.state.lastMessageTime) {
      this.state = {
        cursor: null, // 时间戳模式不使用游标
        lastMessageId: messageId || this.state.lastMessageId,
        lastMessageTime: messageTime,
        updatedAt: Date.now(),
      };
      await this.saveToStorage();
      console.log(`[CursorManager] 时间戳已更新: ${new Date(this.state.lastMessageTime).toISOString()}`);
    }
  }

  /**
   * 重置游标到初始状态
   */
  async reset(): Promise<void> {
    this.state = {
      cursor: null,
      lastMessageTime: 0,
      lastMessageId: null,
      updatedAt: Date.now(),
    };
    await this.saveToStorage();
    console.log('[CursorManager] 游标已重置');
  }

  /**
   * 保存游标状态到存储
   */
  private async saveToStorage(): Promise<void> {
    try {
      // 始终使用 Node.js 文件存储
      await this.writeStorageFile();
    } catch (error) {
      console.error('[CursorManager] 保存游标失败:', error);
    }
  }

  /**
   * 从存储加载游标状态
   */
  private async loadFromStorage(): Promise<void> {
    try {
      // 使用 Node.js 文件存储
      await this.readStorageFile();
    } catch (error) {
      console.error('[CursorManager] 加载游标失败:', error);
    }
  }

  /**
   * Node.js 环境下的存储文件路径
   */
  private getStorageFilePath(): string {
    return `/tmp/${this.storageKey}.json`;
  }

  /**
   * 写入存储文件
   */
  private async writeStorageFile(): Promise<void> {
    try {
      const fs = await import('fs');
      const filePath = this.getStorageFilePath();
      await fs.promises.writeFile(filePath, JSON.stringify(this.state), 'utf8');
    } catch (error) {
      console.error('[CursorManager] 写入存储文件失败:', error);
    }
  }

  /**
   * 读取存储文件
   */
  private async readStorageFile(): Promise<void> {
    try {
      const fs = await import('fs');
      const filePath = this.getStorageFilePath();
      const content = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(content);
      this.state = {
        cursor: parsed.cursor || null,
        lastMessageTime: parsed.lastMessageTime || 0,
        lastMessageId: parsed.lastMessageId || null,
        updatedAt: parsed.updatedAt || Date.now(),
      };
      console.log(`[CursorManager] 已从文件加载游标: ${this.state.cursor || 'null'}`);
    } catch (_error) {
      // 文件不存在或其他错误，忽略使用初始值
      console.log('[CursorManager] 未找到存储文件，使用初始游标');
    }
  }

  /**
   * 获取状态快照（用于监控）
   */
  getSnapshot(): Record<string, unknown> {
    return {
      cursor: this.state.cursor,
      lastMessageTime: this.state.lastMessageTime,
      lastMessageId: this.state.lastMessageId,
      updatedAt: this.state.updatedAt,
    };
  }
}