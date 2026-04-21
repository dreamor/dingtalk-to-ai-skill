/**
 * 会话管理模块
 * 负责管理用户对话会话，支持会话持久化和历史管理
 */
import { Session, SessionState, SessionConfig, DEFAULT_SESSION_CONFIG } from '../types/session';
import { ConversationMessage, UserMessage, AIMessage } from '../types/message';
import { config } from '../config';
import { generateConversationId } from '../utils/messageId';

/**
 * 内存中的会话存储
 */
interface SessionStore {
  [conversationId: string]: Session;
}

/**
 * 会话管理器选项
 */
export interface SessionManagerOptions {
  config?: Partial<SessionConfig>;
  autoCleanup?: boolean;
  cleanupInterval?: number;
}

/**
 * 会话统计信息
 */
export interface SessionStats {
  total: number;
  active: number;
  idle: number;
  expired: number;
  terminated: number;
}

/**
 * 会话管理器
 */
export class SessionManager {
  private sessions: SessionStore = {};
  private sessionConfig: SessionConfig;
  private autoCleanup: boolean;
  private cleanupInterval: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: SessionManagerOptions = {}) {
    this.sessionConfig = {
      ...DEFAULT_SESSION_CONFIG,
      ttl: config.session.ttl,
      maxHistoryMessages: config.session.maxHistoryMessages,
      ...options.config,
    };
    this.autoCleanup = options.autoCleanup ?? true;
    this.cleanupInterval = options.cleanupInterval ?? 60000;

    if (this.autoCleanup) {
      this.startCleanupService();
    }
  }

  /**
   * 创建新会话
   */
  async createSession(userId: string): Promise<Session> {
    const conversationId = generateConversationId();
    const now = Date.now();

    const session: Session = {
      conversationId,
      userId,
      state: SessionState.Active,
      config: this.sessionConfig,
      context: {
        conversationId,
        messages: [],
        metadata: {
          createdAt: now,
          lastActivityAt: now,
          messageCount: 0,
        },
      },
      createdAt: now,
      lastActivityAt: now,
    };

    this.sessions[conversationId] = session;
    console.log(`✅ 创建会话：${conversationId} (用户：${userId})`);

    return session;
  }

  /**
   * 获取会话
   */
  async getSession(conversationId: string): Promise<Session | null> {
    return this.sessions[conversationId] || null;
  }

  /**
   * 获取或创建会话
   */
  async getOrCreateSession(userId: string): Promise<Session> {
    // 查找用户的活跃会话
    const activeSession = Object.values(this.sessions).find(
      (s) => s.userId === userId && s.state === SessionState.Active
    );

    if (activeSession) {
      // 检查是否过期
      if (Date.now() - activeSession.lastActivityAt < this.sessionConfig.ttl) {
        return activeSession;
      }
      // 标记为过期
      activeSession.state = SessionState.Expired;
    }

    // 创建新会话
    return this.createSession(userId);
  }

  /**
   * 更新会话
   */
  async updateSession(session: Session): Promise<void> {
    session.lastActivityAt = Date.now();
    session.context.metadata.lastActivityAt = Date.now();
    this.sessions[session.conversationId] = session;
  }

  /**
   * 添加消息到会话历史
   */
  async addMessage(conversationId: string, message: ConversationMessage): Promise<void> {
    const session = await this.getSession(conversationId);
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`);
    }

    session.context.messages.push(message);
    session.context.metadata.messageCount = session.context.messages.length;

    // 裁剪历史消息
    if (session.context.messages.length > this.sessionConfig.maxHistoryMessages) {
      this.trimMessages(session);
    }

    await this.updateSession(session);
  }

  /**
   * 获取会话历史
   */
  async getHistory(conversationId: string, limit?: number): Promise<ConversationMessage[]> {
    const session = await this.getSession(conversationId);
    if (!session) {
      return [];
    }

    const messages = session.context.messages;
    if (limit && messages.length > limit) {
      return messages.slice(-limit);
    }

    return messages;
  }

  /**
   *结束会话
   */
  async endSession(conversationId: string, state: SessionState = SessionState.Terminated): Promise<void> {
    const session = await this.getSession(conversationId);
    if (session) {
      session.state = state;
      console.log(`📋 会话结束：${conversationId} (${state})`);
    }
  }

  /**
   * 裁剪消息历史
   */
  private trimMessages(session: Session): void {
    const maxMessages = this.sessionConfig.maxHistoryMessages;
    if (session.context.messages.length > maxMessages) {
      const removed = session.context.messages.length - maxMessages;
      session.context.messages = session.context.messages.slice(-maxMessages);
      console.log(`📝 裁剪消息历史：${session.conversationId} (${removed} 条)`);
    }
  }

  /**
   * 构建上下文
   */
  async buildContext(conversationId: string): Promise<string> {
    const session = await this.getSession(conversationId);
    if (!session) {
      return '';
    }

    const { messages } = session.context;
    const recentMessages = messages.slice(-this.sessionConfig.maxHistoryMessages);
    
    return recentMessages
      .map((msg) => `${msg.type === 'user' ? '用户' : 'AI'}: ${msg.content}`)
      .join('\n');
  }

  /**
   * 开始清理服务
   */
  private startCleanupService(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, this.cleanupInterval);

    console.log(`🔄 会话清理服务已启动 (间隔：${this.cleanupInterval / 1000}秒)`);
  }

  /**
   * 停止清理服务
   */
  stopCleanupService(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * 清理过期会话
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const ttl = this.sessionConfig.ttl;
    let cleanedCount = 0;

    for (const [conversationId, session] of Object.entries(this.sessions)) {
      if (session.state === SessionState.Active && now - session.lastActivityAt > ttl) {
        session.state = SessionState.Expired;
        cleanedCount++;
      }

      // 删除终止和过期超过 1 小时的会话
      if (
        (session.state === SessionState.Terminated || session.state === SessionState.Expired) &&
        now - session.lastActivityAt > ttl * 2
      ) {
        delete this.sessions[conversationId];
      }
    }

    if (cleanedCount > 0) {
      console.log(`🧹 清理了 ${cleanedCount} 个过期会话`);
    }
  }

  /**
   * 获取统计信息
   */
  async getStats(): Promise<SessionStats> {
    const stats: SessionStats = {
      total: Object.keys(this.sessions).length,
      active: 0,
      idle: 0,
      expired: 0,
      terminated: 0,
    };

    for (const session of Object.values(this.sessions)) {
      switch (session.state) {
        case SessionState.Active:
          stats.active++;
          break;
        case SessionState.Idle:
          stats.idle++;
          break;
        case SessionState.Expired:
          stats.expired++;
          break;
        case SessionState.Terminated:
          stats.terminated++;
          break;
      }
    }

    return stats;
  }

  /**
   * 获取所有会话
   */
  async getAllSessions(): Promise<Session[]> {
    return Object.values(this.sessions);
  }

  /**
   * 清空所有会话
   */
  async clearAllSessions(): Promise<void> {
    this.sessions = {};
    console.log('🧹 已清空所有会话');
  }
}
