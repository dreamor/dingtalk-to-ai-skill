/**
 * 钉钉 Channel 实现
 * 基于 Stream 模式实现消息收发，无需 Webhook 回调
 */
import axios, { AxiosInstance } from 'axios';
import { config } from '../config';

// 钉钉消息类型定义
export interface DingtalkMessage {
  msgUid?: string;
  conversationId?: string;
  senderId?: string;
  senderNick?: string;
  text?: {
    content: string;
  };
  msgType: string;
  createTime: number;
}

/**
 * 消息拉取参数
 */
export interface FetchMessagesParams {
  cursor?: string | null;
  timeCursor?: number;
  limit?: number;
  timeout?: number;
}

/**
 * 消息拉取结果
 */
export interface FetchMessagesResult {
  hasMore: boolean;
  nextCursor?: string;
  messages: DingtalkMessage[];
}

/**
 * 钉钉 API 响应基础结构
 */
interface DingtalkApiResponse {
  errcode: number;
  errmsg: string;
}

/**
 * 获取 access_token 的响应
 */
interface GetAccessTokenResponse extends DingtalkApiResponse {
  access_token: string;
  expire: number;
}

export interface DingtalkResponse {
  msgType: string;
  content: {
    text: string;
  } | {
    markdown: {
      title: string;
      text: string;
    };
  };
}

export class DingtalkService {
  private httpClient: AxiosInstance;
  private tokenCache: Map<string, { token: string; expireTime: number }>;

  constructor() {
    this.tokenCache = new Map();
    this.httpClient = axios.create({
      baseURL: 'https://oapi.dingtalk.com',
      timeout: 10000,
    });
  }

  /**
   * 验证配置完整性
   */
  validateConfig(): void {
    const required = ['appKey', 'appSecret'];
    const missing = required.filter(key => !config.dingtalk[key as keyof typeof config.dingtalk]);

    if (missing.length > 0) {
      throw new Error(`缺少钉钉配置: ${missing.join(', ')}`);
    }
  }

  /**
   * 获取 access_token (带缓存)
   */
  async getAccessToken(): Promise<string> {
    const cacheKey = 'access_token';
    const cached = this.tokenCache.get(cacheKey);

    if (cached && Date.now() < cached.expireTime) {
      return cached.token;
    }

    try {
      const response = await this.httpClient.get<GetAccessTokenResponse>('/gettoken', {
        params: {
          appkey: config.dingtalk.appKey,
          appsecret: config.dingtalk.appSecret,
        },
      });

      if (response.data.errcode !== 0) {
        throw new Error(`获取 access_token 失败: ${response.data.errmsg}`);
      }

      const token = response.data.access_token;
      // 缓存 7200 秒，提前5分钟刷新
      this.tokenCache.set(cacheKey, {
        token,
        expireTime: Date.now() + (7200 - 300) * 1000,
      });

      return token;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`获取 access_token 异常: ${errorMessage}`);
    }
  }

  /**
   * 解析用户身份
   */
  parseUserIdentity(message: DingtalkMessage): { userId: string; userName: string } {
    return {
      userId: message.senderId || 'unknown',
      userName: message.senderNick || '未知用户',
    };
  }

  /**
   * 发送 Markdown 格式消息
   */
  async sendMarkdownMessage(accessToken: string, title: string, text: string): Promise<void> {
    await this.httpClient.post('/robot/send', {
      msgtype: 'markdown',
      markdown: {
        title,
        text,
      },
      access_token: accessToken,
    });
  }

  /**
   * 发送文本消息
   */
  async sendTextMessage(accessToken: string, content: string, mentionList?: string[]): Promise<void> {
    await this.httpClient.post('/robot/send', {
      msgtype: 'text',
      text: {
        content,
      },
      at: {
        atUserIds: mentionList || [],
        isAtAll: false,
      },
      access_token: accessToken,
    });
  }

  /**
   * 拉取消息列表 (用于轮询模式)
   * 使用钉钉 Long Polling API，无需配置回调 URL
   * API 文档：https://open.dingtalk.com/document/orgapp-server/server-api-overview
   */
  async fetchMessages(params: FetchMessagesParams): Promise<FetchMessagesResult> {
    const {
      cursor,
      limit = 20,
      timeout = 30000, // Long Polling 需要较长超时
    } = params;
  
    try {
      const accessToken = await this.getAccessToken();
  
      // 构建请求体
      const requestBody: Record<string, unknown> = {
        limit,
      };
  
      if (cursor) {
        requestBody['cursor'] = cursor;
      }
  
      // 使用钉钉 Long Polling API
      // 这是钉钉官方提供的免回调 URL 方案，适合轮询模式
      // 文档：https://open.dingtalk.com/document/orgapp-server/obtain-llm-pushes
      const response = await this.httpClient.post(
        '/v1.0/contact/messages/get',
        requestBody,
        {
          params: {
            access_token: accessToken,
          },
          timeout,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
  
      if (response.data.code !== 'ok' && !response.data.success) {
        throw new Error(`拉取消息失败：${response.data.message || response.data.errmsg || '未知错误'}`);
      }
  
      const data = response.data || {};
      const messages: DingtalkMessage[] = (data.result?.items || []).map((msg: Record<string, unknown>) => ({
        msgUid: msg.msgUuid as string || String(msg.bizId || ''),
        conversationId: msg.conversationId as string,
        senderId: msg.senderId as string,
        senderNick: msg.senderNick as string || '未知',
        text: msg.text ? { content: String(msg.text) } : undefined,
        msgType: msg.msgType as string || 'text',
        createTime: Number(msg.createTime || msg.sendTime || Date.now()),
      }));
  
      return {
        hasMore: data.hasMore === true,
        nextCursor: data.nextCursor as string | undefined,
        messages,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      throw new Error(`拉取消息异常：${message}`);
    }
  }

  /**
   * 拉取群消息 (使用群机器人接口)
   */
  async fetchGroupMessages(sinceTimestamp?: number, limit: number = 20): Promise<DingtalkMessage[]> {
    try {
      const accessToken = await this.getAccessToken();

      // 群机器人不支持历史消息拉取，这里返回空数组
      // 在实际使用时，需要结合钉钉企业自建应用或其他方式
      console.log('[DingtalkService] 群机器人不支持历史消息拉取，返回空数组');

      // 如果有时间戳参数，尝试获取该时间点之后的消息
      if (sinceTimestamp) {
        // 这里需要企业自建应用权限
        // 使用企业自建应用的会话消息拉取接口
        const timestamp = sinceTimestamp;
        const response = await this.httpClient.get('/topapi/im/v1/messages', {
          params: {
            access_token: accessToken,
            start_time: timestamp,
            limit,
          },
          timeout: 5000,
        });

        if (response.data.errcode === 0) {
          const data = response.data.result || {};
          return (data.messages || []).map((msg: Record<string, unknown>) => ({
            msgUid: msg.msgUid as string,
            conversationId: msg.conversationId as string,
            senderId: msg.senderId as string,
            senderNick: msg.senderNick as string,
            text: msg.content ? { content: String(msg.content) } : undefined,
            msgType: msg.msgType as string,
            createTime: Number(msg.createTime) || Date.now(),
          }));
        }
      }

      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      console.error(`[DingtalkService] 拉取群消息失败: ${message}`);
      throw error;
    }
  }
}