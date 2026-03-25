/**
 * 配置模块 - 集中管理所有配置项
 */
import dotenv from 'dotenv';

// 加载环境变量（强制覆盖已有值）
dotenv.config({ override: true });

// 环境变量类型定义
interface DingtalkConfig {
  appKey: string;
  appSecret: string;
}

interface GatewayConfig {
  port: number;
  host: string;
  apiToken?: string;  // API 访问令牌
}

type AIProvider = 'opencode' | 'claude';

interface AIConfig {
  command: string;
  timeout: number;
  maxRetries: number;
  retryBaseDelay: number;  // 重试基础延迟（毫秒）
  retryMaxDelay: number;   // 重试最大延迟（毫秒）
  workingDir?: string;
  model: string;           // 模型名称
  maxInputLength: number;  // 最大输入长度（字符）
}

interface ClaudeCodeConfig {
  command: string;
  timeout: number;
  maxRetries: number;
  retryBaseDelay: number;
  retryMaxDelay: number;
  workingDir?: string;
  model: string;
  maxInputLength: number;
}

interface SessionConfig {
  ttl: number;
  maxHistoryMessages: number;
}

interface MessageQueueConfig {
  maxConcurrentPerUser: number;
  maxConcurrentGlobal: number;
  rateLimitMaxTokens: number;
}

interface StreamConfig {
  enabled: boolean;
  maxReconnectAttempts: number;
  reconnectBaseDelay: number;
  reconnectMaxDelay: number;
}

interface PollingConfig {
  enabled: boolean;
  interval: number;
}

// 主要配置对象
export const config = {
  // AI Provider 选择
  aiProvider: (process.env.AI_PROVIDER as AIProvider) || 'opencode',

  dingtalk: {
    appKey: process.env.DINGTALK_APP_KEY || '',
    appSecret: process.env.DINGTALK_APP_SECRET || '',
  } as DingtalkConfig,

  gateway: {
    port: parseInt(process.env.GATEWAY_PORT || '3000', 10),
    host: process.env.GATEWAY_HOST || '0.0.0.0',
    apiToken: process.env.GATEWAY_API_TOKEN || undefined,
  } as GatewayConfig,

  ai: {
    command: process.env.OPENCODE_COMMAND || 'opencode',
    timeout: parseInt(process.env.OPENCODE_TIMEOUT || '120000', 10),
    maxRetries: parseInt(process.env.OPENCODE_MAX_RETRIES || '3', 10),
    retryBaseDelay: parseInt(process.env.OPENCODE_RETRY_BASE_DELAY || '1000', 10),
    retryMaxDelay: parseInt(process.env.OPENCODE_RETRY_MAX_DELAY || '10000', 10),
    workingDir: process.env.OPENCODE_WORKING_DIR || process.cwd(),
    model: process.env.OPENCODE_MODEL || '',
    maxInputLength: parseInt(process.env.OPENCODE_MAX_INPUT_LENGTH || '10000', 10),
  } as AIConfig,

  claude: {
    command: process.env.CLAUDE_COMMAND || 'claude',
    timeout: parseInt(process.env.CLAUDE_TIMEOUT || '120000', 10),
    maxRetries: parseInt(process.env.CLAUDE_MAX_RETRIES || '3', 10),
    retryBaseDelay: parseInt(process.env.CLAUDE_RETRY_BASE_DELAY || '1000', 10),
    retryMaxDelay: parseInt(process.env.CLAUDE_RETRY_MAX_DELAY || '10000', 10),
    workingDir: process.env.CLAUDE_WORKING_DIR || process.cwd(),
    model: process.env.CLAUDE_MODEL || '',
    maxInputLength: parseInt(process.env.CLAUDE_MAX_INPUT_LENGTH || '10000', 10),
  } as ClaudeCodeConfig,

  session: {
    ttl: parseInt(process.env.SESSION_TTL || '1800000', 10),
    maxHistoryMessages: parseInt(process.env.SESSION_MAX_HISTORY || '50', 10),
  } as SessionConfig,

  messageQueue: {
    maxConcurrentPerUser: parseInt(process.env.MQ_MAX_CONCURRENT_PER_USER || '3', 10),
    maxConcurrentGlobal: parseInt(process.env.MQ_MAX_CONCURRENT_GLOBAL || '10', 10),
    rateLimitMaxTokens: parseInt(process.env.MQ_RATE_LIMIT_TOKENS || '10', 10),
  } as MessageQueueConfig,

  stream: {
    enabled: process.env.STREAM_ENABLED !== 'false',
    maxReconnectAttempts: parseInt(process.env.STREAM_MAX_RECONNECT || '10', 10),
    reconnectBaseDelay: parseInt(process.env.STREAM_RECONNECT_BASE_DELAY || '1000', 10),
    reconnectMaxDelay: parseInt(process.env.STREAM_RECONNECT_MAX_DELAY || '60000', 10),
  } as StreamConfig,

  // 轮询模式已禁用，仅保留配置接口
  polling: {
    enabled: false,
    interval: 3000,
  } as PollingConfig,
};

// 验证配置完整性
export function validateConfig(): void {
  const missingRequired: string[] = [];

  if (!config.dingtalk.appKey) {
    missingRequired.push('DINGTALK_APP_KEY');
  }
  if (!config.dingtalk.appSecret) {
    missingRequired.push('DINGTALK_APP_SECRET');
  }

  if (missingRequired.length > 0) {
    throw new Error(`缺少必要的环境变量配置: ${missingRequired.join(', ')}`);
  }

  const aiProviderName = config.aiProvider === 'claude' ? 'Claude Code' : 'AI CLI';
  console.log('✅ 配置验证通过');
  console.log(`   - AI Provider: ${aiProviderName}`);
  console.log(`   - 会话 TTL: ${config.session.ttl / 1000 / 60} 分钟`);
  console.log(`   - 最大历史消息：${config.session.maxHistoryMessages}`);
  console.log(`   - 用户最大并发：${config.messageQueue.maxConcurrentPerUser}`);
  console.log(`   - ${aiProviderName} 超时：${config.aiProvider === 'claude' ? config.claude.timeout : config.ai.timeout} / 1000 秒`);
  console.log(`   - Stream 模式：启用 (自动重连: ${config.stream.maxReconnectAttempts} 次)`);
}

// 导出配置验证函数供启动时调用
export const validateConfigImmediately = (): void => {
  validateConfig();
};