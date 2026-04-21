/**
 * AI CLI 不可用时的优雅降级处理
 */

import { config } from '../config';

export interface DegradationResult {
  available: boolean;
  message: string;
  suggestion?: string;
}

/**
 * AI CLI 可用性状态
 */
let availabilityCache: Map<string, { available: boolean; lastChecked: number }> = new Map();
const CACHE_TTL = 60000; // 60秒缓存

/**
 * 检查 AI CLI 是否可用（带缓存）
 */
export async function checkAICLIAvailability(): Promise<DegradationResult> {
  const provider = config.aiProvider;
  const command = provider === 'claude' ? config.claude.command : config.ai.command;
  
  // 检查缓存
  const cached = availabilityCache.get(provider);
  if (cached && Date.now() - cached.lastChecked < CACHE_TTL) {
    if (!cached.available) {
      return {
        available: false,
        message: `${provider === 'claude' ? 'Claude Code' : 'OpenCode'} CLI 当前不可用`,
        suggestion: getInstallSuggestion(provider),
      };
    }
    return { available: true, message: 'CLI 可用' };
  }

  // 执行检查
  const { spawn } = await import('child_process');
  
  return new Promise((resolve) => {
    const proc = spawn(command, ['--version'], { stdio: 'ignore' });
    let available = false;

    proc.on('close', (code) => {
      available = code === 0;
      availabilityCache.set(provider, { available, lastChecked: Date.now() });
      
      if (available) {
        resolve({ available: true, message: 'CLI 可用' });
      } else {
        resolve({
          available: false,
          message: `${provider === 'claude' ? 'Claude Code' : 'OpenCode'} CLI 未安装或不可用`,
          suggestion: getInstallSuggestion(provider),
        });
      }
    });

    proc.on('error', () => {
      availabilityCache.set(provider, { available: false, lastChecked: Date.now() });
      resolve({
        available: false,
        message: `${provider === 'claude' ? 'Claude Code' : 'OpenCode'} CLI 未找到`,
        suggestion: getInstallSuggestion(provider),
      });
    });

    // 超时处理
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill();
        resolve({
          available: false,
          message: 'CLI 检查超时',
          suggestion: getInstallSuggestion(provider),
        });
      }
    }, 5000);
  });
}

/**
 * 生成降级响应消息
 */
export function generateDegradationResponse(result: DegradationResult): string {
  const blocks: string[] = [];
  
  blocks.push('## ⚠️ AI 服务暂时不可用');
  blocks.push('');
  blocks.push(result.message);
  
  if (result.suggestion) {
    blocks.push('');
    blocks.push('### 安装指南');
    blocks.push('```bash');
    blocks.push(result.suggestion);
    blocks.push('```');
  }
  
  blocks.push('');
  blocks.push('---');
  blocks.push('💡 *您的消息已记录，服务恢复后将自动处理*');
  
  return blocks.join('\n');
}

/**
 * 获取安装建议
 */
function getInstallSuggestion(provider: string): string {
  if (provider === 'claude') {
    return 'brew install anthropic/claude/claude';
  }
  return 'npm install -g opencode';
}

/**
 * 清除可用性缓存
 */
export function clearAvailabilityCache(): void {
  availabilityCache.clear();
}

/**
 * 获取当前可用性状态
 */
export function getAvailabilityStatus(): Record<string, { available: boolean; lastChecked: number }> {
  return Object.fromEntries(availabilityCache);
}
