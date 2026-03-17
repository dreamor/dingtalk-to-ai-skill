/**
 * 会话管理器
 * 负责创建、管理和维护用户会话
 */
import {
  Session,
  SessionState,
  SessionConfig,
  DEFAULT_SESSION_CONFIG,
  ConversationContext,
  SessionStorage,
} from '../types/session';
import { ConversationMessage } from '../types/message';
import { generateConversationId } from '../utils/messageId';

/**
 * 内存存储实现
 */
class MemorySessionStorage implements SessionStorage {
  private sessions: Map<string, Session> = new Map();

  async create(session: Session): Promise<void> {
    this.sessions.set(session.conversationId, session);
  }

  async get(conversationId: string): Promise<Session | null> {
    return this.sessions.get(conversationId) ?? null;
  }

  async update(session: Session): Promise<void> {
    this.sessions.set(session.conversationId, session);
  }

  async delete(conversationId: string): Promise<void> {
    this.sessions.delete(conversationId);
  }

  async getByUser(userId: string): Promise<Session[]> {
    return Array.from(this.sessions.values()).filter(
      (session) => session.userId === userId
    );
  }

  async getExpired(before: number): Promise<Session[]> {
    return Array.from(this.sessions.values()).filter(
      (session) => session.expiresAt && session.expiresAt < before
    );
  }

  async getAll(): Promise<Session[]> {
    return Array.from(this.sessions.values());
  }
}

/**
 * 会话管理器主类
 */
export class SessionManager {
  private storage: SessionStorage;
  private defaultConfig: SessionConfig;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(options?: {
    storage?: SessionStorage;
    config?: Partial<SessionConfig>;
    autoCleanup?: boolean;
    cleanupInterval?: number;
  }) {
    const {
      storage = new MemorySessionStorage(),
      config = {},
      autoCleanup = true,
      cleanupInterval = 60000,
    } = options ?? {};

    this.storage = storage;
    this.defaultConfig = { ...DEFAULT_SESSION_CONFIG, ...config };

    if (autoCleanup) {
      this.startCleanupService(cleanupInterval);
    }
  }

  /**
   * 创建新会话
   */
  async createSession(
    userId: string,
    config?: Partial<SessionConfig>
  ): Promise<Session> {
    const conversationId = generateConversationId();
    const sessionConfig = { ...this.defaultConfig, ...config };
    const now = Date.now();

    const session: Session = {
      conversationId,
      userId,
      state: SessionState.Active,
      config: sessionConfig,
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
      expiresAt: now + sessionConfig.ttl,
    };

    await this.storage.create(session);
    console.log(`✅ 创建会话：${conversationId} (用户：${userId})`);

    return session;
  }

  /**
   * 获取会话
   */
  async getSession(conversationId: string): Promise<Session | null> {
    const session = await this.storage.get(conversationId);

    if (!session) {
      return null;
    }

    // 检查是否过期
    if (session.state === SessionState.Expired) {
      console.log(`⚠️ 会话已过期：${conversationId}`);
      return null;
    }

    // 检查 TTL
    if (session.expiresAt && Date.now() > session.expiresAt) {
      await this.endSession(conversationId, SessionState.Expired);
      return null;
    }

    return session;
  }

  /**
   * 获取或创建会话
   */
  async getOrCreateSession(userId: string): Promise<Session> {
    // 获取用户最近的活跃会话
    const sessions = await this.storage.getByUser(userId);
    const activeSession = sessions.find(
      (s) => s.state === SessionState.Active && s.expiresAt && s.expiresAt > Date.now()
    );

    if (activeSession) {
      return activeSession;
    }

    // 创建新会话
    return this.createSession(userId);
  }

  /**
   * 更新会话
   */
  async updateSession(session: Session): Promise<void> {
    session.lastActivityAt = Date.now();
    session.expiresAt = session.lastActivityAt + session.config.ttl;

    if (session.state !== SessionState.Terminated) {
      session.state = SessionState.Active;
    }

    await this.storage.update(session);
  }

  /**
   * 结束会话
   */
  async endSession(
    conversationId: string,
    state: SessionState = SessionState.Terminated
  ): Promise<void> {
    const session = await this.storage.get(conversationId);
    if (session) {
      session.state = state;
      await this.storage.update(session);
      console.log(`📋 会话结束：${conversationId} (${state})`);
    }
  }

  /**
   * 添加消息到会话
   */
  async addMessage(
    conversationId: string,
    message: ConversationMessage
  ): Promise<void> {
    const session = await this.getSession(conversationId);
    if (!session) {
      throw new Error(`会话不存在：${conversationId}`);
    }

    // 添加消息
    session.context.messages.push(message);
    session.context.metadata.messageCount++;
    session.context.metadata.lastActivityAt = Date.now();

    // 检查是否需要裁剪
    if (
      session.context.messages.length > session.config.maxHistoryMessages
    ) {
      await this.trimMessages(session);
    }

    await this.updateSession(session);
  }

  /**
   * 裁剪消息历史
   */
  private async trimMessages(session: Session): Promise<void> {
    const { maxHistoryMessages } = session.config;
    const messages = session.context.messages;

    if (messages.length <= maxHistoryMessages) {
      return;
    }

    // 保留最新的消息
    session.context.messages = messages.slice(-maxHistoryMessages);
    console.log(
      `📝 裁剪消息历史：${session.conversationId} (${messages.length} -> ${maxHistoryMessages})`
    );
  }

  /**
   * 获取会话历史
   */
  async getHistory(
    conversationId: string,
    limit: number = 20
  ): Promise<ConversationMessage[]> {
    const session = await this.getSession(conversationId);
    if (!session) {
      return [];
    }

    return session.context.messages.slice(-limit);
  }

  /**
   * 构建上下文
   */
  async buildContext(conversationId: string): Promise<string> {
    const session = await this.getSession(conversationId);
    if (!session) {
      return '';
    }

    const { messages, summary } = session.context;

    // 如果有摘要，使用摘要 + 最新消息
    if (summary && messages.length > session.config.summaryThreshold) {
      const recentMessages = messages.slice(-session.config.summaryThreshold);
      const recentText = recentMessages
        .map((msg) => `${msg.type}: ${msg.content}`)
        .join('\n');

      return `[对话摘要]\n${summary}\n\n[最近对话]\n${recentText}`;
    }

    // 否则使用全部消息
    return messages
      .map((msg) => `${msg.type === 'user' ? '用户' : 'AI'}: ${msg.content}`)
      .join('\n');
  }

  /**
   * 开始清理服务
   */
  private startCleanupService(interval: number): void {
    this.cleanupInterval = setInterval(async () => {
      const now = Date.now();
      const expiredSessions = await this.storage.getExpired(now);

      for (const session of expiredSessions) {
        await this.endSession(session.conversationId, SessionState.Expired);
      }

      if (expiredSessions.length > 0) {
        console.log(`🧹 清理了 ${expiredSessions.length} 个过期会话`);
      }
    }, interval);
  }

  /**
   * 停止清理服务
   */
  stopCleanupService(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  /**
   * 获取会话统计
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    idle: number;
    expired: number;
  }> {
    // 获取所有会话
    const sessions = await this.storage.getAll();

    return {
      total: sessions.length,
      active: sessions.filter((s) => s.state === SessionState.Active).length,
      idle: sessions.filter((s) => s.state === SessionState.Idle).length,
      expired: sessions.filter((s) => s.state === SessionState.Expired).length,
    };
  }
}

/**
 * 创建默认会话管理器
 */
export function createSessionManager(): SessionManager {
  return new SessionManager();
}