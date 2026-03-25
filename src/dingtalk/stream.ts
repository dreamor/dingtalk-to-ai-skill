/**
 * DingTalk Stream Service - Enhanced Version
 * Features:
 * 1. Immediate ACK to DingTalk server to prevent timeout/retry
 * 2. Async message processing without blocking
 * 3. Enhanced logging and monitoring
 * 4. Auto-reconnect with exponential backoff
 * 5. Connection health monitoring
 */
import { DWClient, TOPIC_ROBOT, DWClientDownStream } from 'dingtalk-stream';
import { config } from '../config';
import axios from 'axios';
import { updateAdminSessionWebhook, getAdminConversationId, notifyError, isAlertEnabled } from '../utils/alert';

export interface MessageHandler {
  (
    userId: string,
    userName: string,
    content: string,
    conversationId: string,
    sessionWebhook: string
  ): Promise<void>;
}

const DEFAULT_SUBSCRIPTIONS = [{ type: 'CALLBACK', topic: TOPIC_ROBOT }];

interface SessionInfo {
  conversationId: string;
  sessionWebhook: string;
  timestamp: number;
  lastUsedAt: number; // 最后使用时间
  healthStatus: 'healthy' | 'unknown' | 'failed'; // 健康状态
  failureCount: number; // 连续失败计数
}

export class DingtalkStreamService {
  private client: DWClient | null = null;
  private messageHandler: MessageHandler | null = null;
  private isConnected: boolean = false;
  private connectionStartTime: number = 0;
  private lastHeartbeatTime: number = 0;
  private lastMessageTime: number = 0;
  private pendingMessages: Map<string, SessionInfo> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private heartbeatMonitorTimer: NodeJS.Timeout | null = null;
  private readonly messageTTL: number = 30 * 60 * 1000;
  private readonly heartbeatTimeout: number = 120 * 1000;
  
  // 重连相关
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isManualDisconnect: boolean = false;

  constructor() {
    this.maxReconnectAttempts = config.stream.maxReconnectAttempts;
    console.log('[Stream] Service initialized (enhanced version)');
    console.log('  - Topics:', DEFAULT_SUBSCRIPTIONS.map(s => s.topic).join(', '));
    console.log('  - KeepAlive enabled');
    console.log('  - Key fix: Immediate ACK mechanism');
    console.log('  - Heartbeat timeout: 120s');
    console.log(`  - Auto-reconnect: enabled (max ${this.maxReconnectAttempts} attempts)`);
    console.log(`  - Reconnect delay: ${config.stream.reconnectBaseDelay || 1000}ms - ${config.stream.reconnectMaxDelay || 60000}ms`);

    this.cleanupTimer = setInterval(
      () => {
        this.cleanupExpiredMessages();
      },
      5 * 60 * 1000
    );

    this.startHeartbeatMonitor();
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    // 重置重连状态
    this.isManualDisconnect = false;
    this.reconnectAttempts = 0;
    
    const { appKey, appSecret } = config.dingtalk;

    if (!appKey || !appSecret) {
      throw new Error('Missing DINGTALK_APP_KEY or DINGTALK_APP_SECRET');
    }

    console.log('[Stream] Initializing client...');
    console.log(`  - clientId: ${appKey}`);

    this.client = new DWClient({
      clientId: appKey,
      clientSecret: appSecret,
      keepAlive: true,
      debug: true,
    });

    // 安全设置 subscriptions（兼容测试环境）
    if (this.client.config) {
      this.client.config.subscriptions = DEFAULT_SUBSCRIPTIONS;
    }

    this.client.on('ready', () => {
      this.connectionStartTime = Date.now();
      this.isConnected = true;
      this.lastHeartbeatTime = Date.now();
      this.reconnectAttempts = 0; // 重置重连计数
      console.log('[Stream] ✅ Connection established');
      console.log(`  - Connected at: ${new Date().toISOString()}`);
      console.log(`  - Reconnect attempts reset to 0`);
    });

    this.client.on('close', () => {
      this.isConnected = false;
      const duration = this.connectionStartTime
        ? Math.round((Date.now() - this.connectionStartTime) / 1000)
        : 0;
      console.log(`[Stream] ⚠️ Connection closed (duration: ${duration}s)`);
      
      // 如果不是手动断开，尝试重新连接
      if (!this.isManualDisconnect) {
        this.handleDisconnect();
      }
    });

    this.client.on('error', (error: Error) => {
      this.isConnected = false;
      console.error('[Stream] ❌ Connection error:', error.message);
      
      // 如果不是手动断开，尝试重新连接
      if (!this.isManualDisconnect) {
        this.handleDisconnect();
      }
    });

    this.client.registerCallbackListener(TOPIC_ROBOT, async (msg: DWClientDownStream) => {
      console.log('========================================');
      console.log('[Stream] Received callback');
      console.log('  - Message ID:', msg.headers.messageId);
      console.log('  - Topic:', msg.headers.topic);
      console.log('========================================');

      await this.handleMessage(msg).catch(error => {
        console.error('[Stream] Failed to handle message:', error);
      });
    });

    try {
      console.log('[Stream] Connecting to DingTalk Stream...');
      await this.client.connect();
      console.log('[Stream] Connected, waiting for messages...');
    } catch (error) {
      console.error(
        '[Stream] Connection failed:',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  private startHeartbeatMonitor(): void {
    this.heartbeatMonitorTimer = setInterval(() => {
      if (this.isConnected && this.lastHeartbeatTime > 0) {
        const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeatTime;
        if (timeSinceLastHeartbeat > this.heartbeatTimeout) {
          console.warn(
            `[Stream] Heartbeat timeout (${Math.round(timeSinceLastHeartbeat / 1000)}s), connection may be lost`
          );
        }
      }

      if (this.lastMessageTime > 0) {
        const timeSinceLastMessage = Date.now() - this.lastMessageTime;
        console.log(
          `[Stream] Status: connected=${this.isConnected}, ` +
            `lastMsg=${Math.round(timeSinceLastMessage / 1000)}s ago, ` +
            `pending=${this.pendingMessages.size}`
        );
      }
    }, 60 * 1000);
  }

  updateHeartbeat(time?: number): void {
    this.lastHeartbeatTime = time ?? Date.now();
  }

  /**
   * 处理断开连接事件 - 自动重连
   */
  private handleDisconnect(): void {
    if (this.isManualDisconnect) {
      return;
    }
    
    this.reconnectAttempts++;
    
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(`[Stream] ❌ 重连次数超过限制 (${this.maxReconnectAttempts}次)，停止重连`);
      console.error('[Stream] 请检查网络连接或钉钉配置，然后手动重启服务');
      
      // 发送告警
      if (isAlertEnabled()) {
        notifyError('钉钉 Stream 连接失败', `已重连 ${this.reconnectAttempts} 次，均失败`).catch(() => {});
      }
      return;
    }
    
    // 计算指数退避延迟
    const baseDelay = config.stream.reconnectBaseDelay || 1000;
    const maxDelay = config.stream.reconnectMaxDelay || 60000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts - 1), maxDelay);
    
    console.log(`[Stream] 🔄 准备重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    console.log(`[Stream] ⏳ 等待 ${delay / 1000} 秒后重试...`);
    
    // 清除之前的重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    // 设置重连定时器
    this.reconnectTimer = setTimeout(async () => {
      console.log(`[Stream] 🔄 执行重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      
      try {
        await this.start();
        console.log(`[Stream] ✅ 重连成功！`);
      } catch (error) {
        console.error(`[Stream] ❌ 重连失败:`, error instanceof Error ? error.message : error);
        // handleDisconnect 会通过 close 事件被再次调用
      }
    }, delay);
  }

  async stop(): Promise<void> {
    console.log('[Stream] Stopping service...');
    
    // 标记为手动断开，不进行重连
    this.isManualDisconnect = true;
    
    // 清除重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.heartbeatMonitorTimer) {
      clearInterval(this.heartbeatMonitorTimer);
      this.heartbeatMonitorTimer = null;
    }

    if (this.client) {
      try {
        this.client.disconnect();
      } catch (error) {
        console.error('Error disconnecting:', error);
      }
      this.client = null;
    }

    this.isConnected = false;
    this.pendingMessages.clear();
    this.reconnectAttempts = 0;
    console.log('[Stream] Service stopped');
  }

  /**
   * 清理定时器（用于测试）
   */
  clearTimers(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.heartbeatMonitorTimer) {
      clearInterval(this.heartbeatMonitorTimer);
      this.heartbeatMonitorTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * KEY FIX: Handle received message
   * 1. ACK DingTalk server immediately (first line calls socketCallBackResponse)
   * 2. Async message processing without blocking
   * 3. Support multiple message types
   */
  private async handleMessage(msg: DWClientDownStream): Promise<void> {
    const messageId = msg.headers.messageId;

    // KEY FIX: ACK to DingTalk immediately to prevent timeout
    this.client?.socketCallBackResponse(messageId, { received: true });
    console.log(`[Stream] [${messageId}] ACK sent to DingTalk`);

    try {
      const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;

      this.lastMessageTime = Date.now();
      this.updateHeartbeat();

      console.log(`[Stream] [${messageId}] Message data:`, {
        type: data.msgtype,
        hasText: !!data.text?.content,
        hasContent: !!data.content,
        hasConversationId: !!data.conversationId,
        hasSessionWebhook: !!data.sessionWebhook,
      });

      const { senderId, senderNick, text, msgtype, conversationId, sessionWebhook, content } = data;

      const userId = senderId || 'unknown';
      const userName = senderNick || 'Unknown';

      // Extract message content (support multiple types)
      let messageContent: string | undefined;

      // Handle non-text message types with friendly response
      const supportedMsgTypes = ['text'];
      if (msgtype && !supportedMsgTypes.includes(msgtype)) {
        console.log(`[Stream] [${messageId}] Received unsupported message type: ${msgtype}`);

        // Send friendly response for unsupported types
        if (sessionWebhook) {
          const unsupportedMsg = this.getUnsupportedMessageResponse(msgtype);
          await this.sendTextMessage(conversationId!, unsupportedMsg);
        }
        return; // Skip further processing
      }

      if (msgtype === 'text' && text?.content) {
        messageContent = text.content;
      } else if (typeof content === 'string' && content) {
        messageContent = content;
      } else if (text && typeof text === 'string') {
        messageContent = text;
      }

      // Save session info for replies
      if (conversationId && sessionWebhook) {
        this.pendingMessages.set(conversationId, {
          conversationId,
          sessionWebhook,
          timestamp: Date.now(),
          lastUsedAt: Date.now(),
          healthStatus: 'unknown' as const,
          failureCount: 0,
        });

        console.log(`[Stream] [${messageId}] Session saved: ${conversationId.substring(0, 30)}...`);

        const adminUserId = getAdminConversationId();
        if (adminUserId && userId === adminUserId) {
          console.log(`[Stream] [${messageId}] Admin message detected`);
          updateAdminSessionWebhook(conversationId, sessionWebhook);
        }
      }

      // Process messages with content
      if (messageContent && messageContent.trim() !== '') {
        console.log(
          `[Stream] [${messageId}] From ${userName}(${userId}): ` +
            `${messageContent.substring(0, 80)}${messageContent.length > 80 ? '...' : ''}`
        );
        console.log(`[Stream] [${messageId}] sessionWebhook: ${sessionWebhook ? 'yes' : 'no'}`);

        // Call message handler (async, don't wait)
        if (this.messageHandler && sessionWebhook) {
          console.log(`[Stream] [${messageId}] Starting async processing...`);

          // Async processing without blocking
          // 使用 void 明确表明我们不等待这个 Promise
          void this.messageHandler(userId, userName, messageContent, conversationId, sessionWebhook)
            .then(() => {
              // 只在 debug 模式下输出完成日志，避免测试污染
              if (process.env.NODE_ENV !== 'test') {
                console.log(`[Stream] [${messageId}] Async processing completed`);
              }
            })
            .catch(error => {
              // 错误总是输出
              console.error(`[Stream] [${messageId}] Async processing failed:`, error.message);
            });
        } else {
          if (!this.messageHandler) {
            console.warn(`[Stream] [${messageId}] Message handler not set`);
          }
          if (!sessionWebhook) {
            console.warn(`[Stream] [${messageId}] No sessionWebhook, cannot reply`);
          }
        }
      } else {
        console.log(`[Stream] [${messageId}] Skipping empty message (type=${msgtype})`);
      }
    } catch (error) {
      console.error(
        `[Stream] [${messageId}] Failed to parse message:`,
        error instanceof Error ? error.message : error
      );
      // Already ACKed at function start
    }
  }

  async sendTextMessage(
    conversationId: string,
    content: string,
    mentionList?: string[]
  ): Promise<boolean> {
    try {
      if (!this.client) {
        throw new Error('Stream client not connected');
      }

      const sessionInfo = this.pendingMessages.get(conversationId);

      if (!sessionInfo?.sessionWebhook) {
        throw new Error(`sessionWebhook not found for ${conversationId}`);
      }

      // 更新最后使用时间
      sessionInfo.lastUsedAt = Date.now();

      console.log(`[Stream] Sending text: ${content.substring(0, 50)}...`);

      const messageBody = {
        msgtype: 'text',
        text: {
          content,
          at: {
            atUserIds: mentionList || [],
            isAtAll: mentionList?.includes('ALL') || false,
          },
        },
      };

      await axios.post(sessionInfo.sessionWebhook, messageBody, {
        timeout: 10000,
      });

      // 发送成功，更新健康状态
      sessionInfo.healthStatus = 'healthy';
      sessionInfo.failureCount = 0;

      console.log('[Stream] Text message sent successfully');
      return true;
    } catch (error: any) {
      console.error('[Stream] Failed to send text:', error.message);

      // 更新失败计数
      const sessionInfo = this.pendingMessages.get(conversationId);
      if (sessionInfo) {
        sessionInfo.failureCount++;
        sessionInfo.healthStatus = 'failed';

        if (sessionInfo.failureCount >= 3) {
          console.warn(`[Stream] Webhook 连续失败 3 次，标记为不可用：${conversationId}`);
        }
      }

      if (error.response?.data) {
        console.error('[Stream] Response:', JSON.stringify(error.response.data));
      }
      return false;
    }
  }

  async sendMarkdownMessage(conversationId: string, title: string, text: string): Promise<boolean> {
    try {
      if (!this.client) {
        throw new Error('Stream client not connected');
      }

      const sessionInfo = this.pendingMessages.get(conversationId);

      if (!sessionInfo?.sessionWebhook) {
        throw new Error(`sessionWebhook not found for ${conversationId}`);
      }

      // 更新最后使用时间
      sessionInfo.lastUsedAt = Date.now();

      console.log(`[Stream] Sending markdown: ${title}`);

      const messageBody = {
        msgtype: 'markdown',
        markdown: {
          title,
          text,
        },
      };

      await axios.post(sessionInfo.sessionWebhook, messageBody, {
        timeout: 10000,
      });

      // 发送成功，更新健康状态
      sessionInfo.healthStatus = 'healthy';
      sessionInfo.failureCount = 0;

      console.log('[Stream] Markdown message sent successfully');
      return true;
    } catch (error: any) {
      console.error('[Stream] Failed to send markdown:', error.message);

      // 更新失败计数
      const sessionInfo = this.pendingMessages.get(conversationId);
      if (sessionInfo) {
        sessionInfo.failureCount++;
        sessionInfo.healthStatus = 'failed';

        if (sessionInfo.failureCount >= 3) {
          console.warn(`[Stream] Webhook 连续失败 3 次，标记为不可用：${conversationId}`);
        }
      }

      if (error.response?.data) {
        console.error('[Stream] Response:', JSON.stringify(error.response.data));
      }
      return false;
    }
  }

  private cleanupExpiredMessages(): void {
    const now = Date.now();
    let cleanedCount = 0;
    let staleCount = 0;

    for (const [conversationId, sessionInfo] of this.pendingMessages.entries()) {
      // 清理过期会话
      if (now - sessionInfo.timestamp > this.messageTTL) {
        this.pendingMessages.delete(conversationId);
        cleanedCount++;
        continue;
      }

      // 清理连续失败 3 次以上的会话（提前失效）
      if (sessionInfo.failureCount >= 3 && now - sessionInfo.lastUsedAt > 5 * 60 * 1000) {
        this.pendingMessages.delete(conversationId);
        staleCount++;
        console.log(
          `[Stream] Cleaned stale webhook (${sessionInfo.failureCount} failures): ${conversationId.substring(0, 30)}...`
        );
      }
    }

    if (cleanedCount > 0) {
      console.log(`[Stream] Cleaned ${cleanedCount} expired sessions`);
    }
    if (staleCount > 0) {
      console.log(`[Stream] Cleaned ${staleCount} stale sessions`);
    }
  }

  /**
   * 获取健康会话数量
   */
  getHealthySessionCount(): number {
    let count = 0;
    for (const sessionInfo of this.pendingMessages.values()) {
      if (sessionInfo.healthStatus === 'healthy' || sessionInfo.healthStatus === 'unknown') {
        count++;
      }
    }
    return count;
  }

  /**
   * 获取失败会话数量
   */
  getFailedSessionCount(): number {
    let count = 0;
    for (const sessionInfo of this.pendingMessages.values()) {
      if (sessionInfo.healthStatus === 'failed') {
        count++;
      }
    }
    return count;
  }

  getStatus() {
    const now = Date.now();
    return {
      connected: this.isConnected,
      uptimeSeconds: this.connectionStartTime
        ? Math.round((now - this.connectionStartTime) / 1000)
        : 0,
      lastHeartbeatSecondsAgo: this.lastHeartbeatTime
        ? Math.round((now - this.lastHeartbeatTime) / 1000)
        : -1,
      lastMessageSecondsAgo: this.lastMessageTime
        ? Math.round((now - this.lastMessageTime) / 1000)
        : -1,
      pendingMessages: this.pendingMessages.size,
      healthySessions: this.getHealthySessionCount(),
      failedSessions: this.getFailedSessionCount(),
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
    };
  }

  /**
   * 获取不支持的消息类型的友好回复
   */
  private getUnsupportedMessageResponse(msgType: string): string {
    const tips: Record<string, string> = {
      image: '📷 抱歉，我目前不支持图片消息。请发送文字消息，我会尽快回复您。',
      file: '📎 抱歉，我目前不支持文件消息。请发送文字消息，我会尽快回复您。',
      voice: '🎤 抱歉，我目前不支持语音消息。请发送文字消息，我会尽快回复您。',
      video: '🎥 抱歉，我目前不支持视频消息。请发送文字消息，我会尽快回复您。',
      richText: '📝 抱歉，我目前不支持富文本消息。请发送文字消息，我会尽快回复您。',
    };
    return tips[msgType] || '📋 抱歉，我暂不支持此类消息。请发送文字消息，我会尽快回复您。';
  }
}
