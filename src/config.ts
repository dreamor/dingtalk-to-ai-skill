/**
 * 配置模块 - 集中管理所有配置项，包含完整的值域验证
 */
import dotenv from 'dotenv';

// 加载环境变量（强制覆盖已有值）
dotenv.config({ override: true });

// ==================== 配置类型定义 ====================

export interface DingtalkConfig {
  appKey: string;
  appSecret: string;
}

export interface GatewayConfig {
  port: number;
  host: string;
  apiToken?: string;
}

export type AIProvider = 'opencode' | 'claude';

export interface AIConfig {
  command: string;
  timeout: number;
  maxRetries: number;
  retryBaseDelay: number;
  retryMaxDelay: number;
  workingDir?: string;
  model: string;
  maxInputLength: number;
}

export interface ClaudeCodeConfig {
  command: string;
  timeout: number;
  maxRetries: number;
  retryBaseDelay: number;
  retryMaxDelay: number;
  workingDir?: string;
  model: string;
  maxInputLength: number;
}

export interface SessionConfig {
  ttl: number;
  maxHistoryMessages: number;
  maxSessions: number;
}

export interface MessageQueueConfig {
  maxConcurrentPerUser: number;
  maxConcurrentGlobal: number;
  rateLimitMaxTokens: number;
  pollInterval: number;
  enablePersistence: boolean;
}

export interface StreamConfig {
  enabled: boolean;
  maxReconnectAttempts: number;
  reconnectBaseDelay: number;
  reconnectMaxDelay: number;
}

export interface StorageConfig {
  dbPath: string;
  enableWAL: boolean;
  cleanupInterval: number;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format: 'json' | 'pretty';
  enableFile: boolean;
  filePath?: string;
}

export interface SchedulerTaskConfig {
  name: string;
  cron: string;
  prompt: string;
  conversationId: string;
  enabled?: boolean;
}

export interface SchedulerConfig {
  enabled: boolean;
  tasks: SchedulerTaskConfig[];
}

export interface MediaConfig {
  enabled: boolean;
  voiceTranscriptionEnabled: boolean;
  imageDescriptionEnabled: boolean;
  maxFileSize: number;
  downloadTimeout: number;
}

export interface RouterProviderConfig {
  name: string;
  type: string;
  command: string;
  args?: string[];
  timeout: number;
  enabled: boolean;
}

export interface RouterRuleConfig {
  name: string;
  enabled: boolean;
  priority: number;
  condition: Record<string, unknown>;
  provider: string;
}

export interface RouterConfig {
  enabled: boolean;
  providers: RouterProviderConfig[];
  rules: RouterRuleConfig[];
}

// ==================== 配置验证错误 ====================

export class ConfigValidationError extends Error {
  constructor(public errors: string[]) {
    super(`配置验证失败:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

// ==================== 环境变量解析 ====================

function parseEnvNumber(key: string, defaultValue: number, min?: number, max?: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    console.warn(`[Config] ${key} 的值 "${value}" 不是有效数字，使用默认值 ${defaultValue}`);
    return defaultValue;
  }

  if (min !== undefined && parsed < min) {
    console.warn(`[Config] ${key} 的值 ${parsed} 小于最小值 ${min}，使用最小值`);
    return min;
  }

  if (max !== undefined && parsed > max) {
    console.warn(`[Config] ${key} 的值 ${parsed} 大于最大值 ${max}，使用最大值`);
    return max;
  }

  return parsed;
}

function parseEnvString(key: string, defaultValue: string, allowedValues?: string[]): string {
  const value = process.env[key];
  if (!value) return defaultValue;

  if (allowedValues && !allowedValues.includes(value)) {
    console.warn(`[Config] ${key} 的值 "${value}" 不在允许列表中，使用默认值 "${defaultValue}"`);
    return defaultValue;
  }

  return value;
}

// ==================== 主要配置对象 ====================

const aiProvider: AIProvider = parseEnvString('AI_PROVIDER', 'opencode', [
  'opencode',
  'claude',
]) as AIProvider;

export const config = {
  // AI Provider 选择
  aiProvider,

  dingtalk: {
    appKey: process.env.DINGTALK_APP_KEY || '',
    appSecret: process.env.DINGTALK_APP_SECRET || '',
  } as DingtalkConfig,

  gateway: {
    port: parseEnvNumber('GATEWAY_PORT', 3000, 1, 65535),
    host: process.env.GATEWAY_HOST || '0.0.0.0',
    apiToken: process.env.GATEWAY_API_TOKEN || undefined,
  } as GatewayConfig,

  ai: {
    command: process.env.OPENCODE_COMMAND || 'opencode',
    timeout: parseEnvNumber('OPENCODE_TIMEOUT', 120000, 1000, 600000),
    maxRetries: parseEnvNumber('OPENCODE_MAX_RETRIES', 3, 0, 10),
    retryBaseDelay: parseEnvNumber('OPENCODE_RETRY_BASE_DELAY', 1000, 100, 30000),
    retryMaxDelay: parseEnvNumber('OPENCODE_RETRY_MAX_DELAY', 10000, 1000, 60000),
    workingDir: process.env.OPENCODE_WORKING_DIR || process.cwd(),
    model: process.env.OPENCODE_MODEL || '',
    maxInputLength: parseEnvNumber('OPENCODE_MAX_INPUT_LENGTH', 10000, 100, 100000),
  } as AIConfig,

  claude: {
    command: process.env.CLAUDE_COMMAND || 'claude',
    timeout: parseEnvNumber('CLAUDE_TIMEOUT', 120000, 1000, 600000),
    maxRetries: parseEnvNumber('CLAUDE_MAX_RETRIES', 3, 0, 10),
    retryBaseDelay: parseEnvNumber('CLAUDE_RETRY_BASE_DELAY', 1000, 100, 30000),
    retryMaxDelay: parseEnvNumber('CLAUDE_RETRY_MAX_DELAY', 10000, 1000, 60000),
    workingDir: process.env.CLAUDE_WORKING_DIR || process.cwd(),
    model: process.env.CLAUDE_MODEL || '',
    maxInputLength: parseEnvNumber('CLAUDE_MAX_INPUT_LENGTH', 10000, 100, 100000),
  } as ClaudeCodeConfig,

  session: {
    ttl: parseEnvNumber('SESSION_TTL', 1800000, 60000, 86400000),
    maxHistoryMessages: parseEnvNumber('SESSION_MAX_HISTORY', 50, 10, 500),
    maxSessions: parseEnvNumber('SESSION_MAX_SESSIONS', 1000, 100, 10000),
  } as SessionConfig,

  messageQueue: {
    maxConcurrentPerUser: parseEnvNumber('MQ_MAX_CONCURRENT_PER_USER', 3, 1, 20),
    maxConcurrentGlobal: parseEnvNumber('MQ_MAX_CONCURRENT_GLOBAL', 10, 1, 100),
    rateLimitMaxTokens: parseEnvNumber('MQ_RATE_LIMIT_TOKENS', 10, 1, 100),
    pollInterval: parseEnvNumber('MQ_POLL_INTERVAL', 100, 10, 5000),
    enablePersistence: process.env.MQ_ENABLE_PERSISTENCE === 'true',
  } as MessageQueueConfig,

  stream: {
    enabled: process.env.STREAM_ENABLED !== 'false',
    maxReconnectAttempts: parseEnvNumber('STREAM_MAX_RECONNECT', 10, 1, 100),
    reconnectBaseDelay: parseEnvNumber('STREAM_RECONNECT_BASE_DELAY', 1000, 100, 30000),
    reconnectMaxDelay: parseEnvNumber('STREAM_RECONNECT_MAX_DELAY', 60000, 1000, 300000),
  } as StreamConfig,

  storage: {
    dbPath: process.env.STORAGE_DB_PATH || '',
    enableWAL: process.env.STORAGE_ENABLE_WAL !== 'false',
    cleanupInterval: parseEnvNumber('STORAGE_CLEANUP_INTERVAL', 3600000, 60000, 86400000),
  } as StorageConfig,

  logging: {
    level: parseEnvString('LOG_LEVEL', 'info', [
      'debug',
      'info',
      'warn',
      'error',
    ]) as LoggingConfig['level'],
    format: parseEnvString('LOG_FORMAT', 'pretty', ['json', 'pretty']) as LoggingConfig['format'],
    enableFile: process.env.LOG_ENABLE_FILE === 'true',
    filePath: process.env.LOG_FILE_PATH,
  } as LoggingConfig,

  scheduler: {
    enabled: process.env.SCHEDULER_ENABLED === 'true',
    tasks: (() => {
      try {
        const tasksJson = process.env.SCHEDULER_TASKS;
        return tasksJson ? JSON.parse(tasksJson) : [];
      } catch {
        return [];
      }
    })(),
  } as SchedulerConfig,

  media: {
    enabled: process.env.MEDIA_ENABLED !== 'false',
    voiceTranscriptionEnabled: process.env.MEDIA_VOICE_TRANSCRIPTION === 'true',
    imageDescriptionEnabled: process.env.MEDIA_IMAGE_DESCRIPTION === 'true',
    maxFileSize: parseEnvNumber('MEDIA_MAX_FILE_SIZE', 10485760, 1048576, 52428800),
    downloadTimeout: parseEnvNumber('MEDIA_DOWNLOAD_TIMEOUT', 30000, 5000, 120000),
  } as MediaConfig,

  router: {
    enabled: process.env.ROUTER_ENABLED === 'true',
    providers: (() => {
      try {
        const providersJson = process.env.ROUTER_PROVIDERS;
        return providersJson ? JSON.parse(providersJson) : [];
      } catch {
        return [];
      }
    })(),
    rules: (() => {
      try {
        const rulesJson = process.env.ROUTER_RULES;
        return rulesJson ? JSON.parse(rulesJson) : [];
      } catch {
        return [];
      }
    })(),
  } as RouterConfig,
};

// ==================== 配置验证 ====================

export function validateConfig(): void {
  const errors: string[] = [];

  // 必填项检查
  if (!config.dingtalk.appKey) {
    errors.push('DINGTALK_APP_KEY 未配置');
  }
  if (!config.dingtalk.appSecret) {
    errors.push('DINGTALK_APP_SECRET 未配置');
  }

  // 值域验证
  if (config.gateway.port < 1 || config.gateway.port > 65535) {
    errors.push('GATEWAY_PORT: 端口号必须在 1-65535 之间');
  }

  if (config.session.ttl < 60000) {
    errors.push('SESSION_TTL: 会话 TTL 不能小于 60 秒');
  }

  if (config.ai.timeout < 1000 || config.claude.timeout < 1000) {
    errors.push('AI 超时时间不能小于 1 秒');
  }

  if (config.messageQueue.maxConcurrentPerUser < 1) {
    errors.push('MQ_MAX_CONCURRENT_PER_USER: 每用户最大并发数不能小于 1');
  }

  if (config.messageQueue.maxConcurrentGlobal < 1) {
    errors.push('MQ_MAX_CONCURRENT_GLOBAL: 全局最大并发数不能小于 1');
  }

  if (config.messageQueue.maxConcurrentGlobal < config.messageQueue.maxConcurrentPerUser) {
    errors.push('MQ_MAX_CONCURRENT_GLOBAL: 全局最大并发数不能小于每用户最大并发数');
  }

  if (config.messageQueue.pollInterval < 10) {
    errors.push('MQ_POLL_INTERVAL: 轮询间隔不能小于 10ms');
  }

  if (aiProvider !== 'opencode' && aiProvider !== 'claude') {
    errors.push('AI_PROVIDER: 必须是 opencode 或 claude');
  }

  const validLogLevels = ['debug', 'info', 'warn', 'error'];
  if (!validLogLevels.includes(config.logging.level)) {
    errors.push('LOG_LEVEL: 必须是 debug/info/warn/error 之一');
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }

  // 打印配置摘要
  const aiProviderName = config.aiProvider === 'claude' ? 'Claude Code' : 'OpenCode';
  console.log('✅ 配置验证通过');
  console.log(`   - AI Provider: ${aiProviderName}`);
  console.log(`   - Gateway: ${config.gateway.host}:${config.gateway.port}`);
  console.log(`   - 会话 TTL: ${config.session.ttl / 1000 / 60} 分钟`);
  console.log(`   - 最大历史消息: ${config.session.maxHistoryMessages}`);
  console.log(`   - 用户最大并发: ${config.messageQueue.maxConcurrentPerUser}`);
  console.log(`   - 全局最大并发: ${config.messageQueue.maxConcurrentGlobal}`);
  console.log(`   - 队列轮询间隔: ${config.messageQueue.pollInterval}ms`);
  console.log(
    `   - AI 超时: ${config.aiProvider === 'claude' ? config.claude.timeout : config.ai.timeout}ms`
  );
  console.log(`   - 持久化存储: ${config.messageQueue.enablePersistence ? '启用' : '禁用'}`);
  console.log(`   - 日志级别: ${config.logging.level}`);
  console.log(`   - 日志格式: ${config.logging.format}`);
  console.log(`   - Stream 模式: 启用 (自动重连: ${config.stream.maxReconnectAttempts} 次)`);
  console.log(`   - 媒体处理: ${config.media.enabled ? '启用' : '禁用'}`);
  console.log(`   - 路由器: ${config.router.enabled ? '启用' : '禁用'}`);
}

// 导出配置验证函数供启动时调用
export const validateConfigImmediately = (): void => {
  validateConfig();
};
