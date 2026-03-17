/**
 * 日志工具 - 支持敏感信息脱敏
 */

/**
 * 敏感信息模式
 */
const SENSITIVE_PATTERNS = [
  // 钉钉凭证
  { pattern: /([Aa]pp[Ss]ecret)[=:]\s*["']?([a-zA-Z0-9_-]+)["']?/g, replace: '$1=****' },
  { pattern: /([Tt]oken)[=:]\s*["']?([a-zA-Z0-9_-]{10,})["']?/g, replace: '$1=****' },
  // sessionWebhook
  { pattern: /(sessionWebhook)[=:]\s*["']?(https?:\/\/[^&"']+)["']?/g, replace: '$1=****' },
  // 管理员 webhook
  { pattern: /(adminSessionWebhook)[=:]\s*["']?(https?:\/\/[^&"']+)["']?/g, replace: '$1=****' },
  // OpenCode 模型参数
  { pattern: /(-m\s+)([a-zA-Z0-9_\/-]+)/g, replace: '$1****' },
  // Authorization 头
  { pattern: /(Authorization)[=:]\s*["']?([Bb]earer\s+)?([a-zA-Z0-9_-]+)["']?/gi, replace: '$1=****' },
];

/**
 * 脱敏日志输出
 */
export function sanitizeLog(message: string): string {
  let sanitized = message;

  for (const { pattern, replace } of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replace);
  }

  return sanitized;
}

/**
 * 创建安全的日志函数
 */
export function createSafeLogger(tag: string) {
  return {
    log: (...args: unknown[]) => {
      const sanitized = args.map(arg =>
        typeof arg === 'string' ? sanitizeLog(arg) : arg
      );
      console.log(`[${tag}]`, ...sanitized);
    },
    warn: (...args: unknown[]) => {
      const sanitized = args.map(arg =>
        typeof arg === 'string' ? sanitizeLog(arg) : arg
      );
      console.warn(`[${tag}]`, ...sanitized);
    },
    error: (...args: unknown[]) => {
      const sanitized = args.map(arg =>
        typeof arg === 'string' ? sanitizeLog(arg) : arg
      );
      console.error(`[${tag}]`, ...sanitized);
    },
  };
}

/**
 * 脱敏配置对象（用于日志输出）
 */
export function sanitizeConfig(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['appSecret', 'token', 'sessionWebhook', 'accessToken', 'secret'];

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.some(k => key.toLowerCase().includes(k.toLowerCase()))) {
      result[key] = '****';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeConfig(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}