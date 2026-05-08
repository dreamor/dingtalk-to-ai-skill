import { config } from '../config';
import type { DisplayMode } from '../config';

export interface DisplayMessage {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
}

export interface FilteredOutput {
  shouldSend: boolean;
  content: string;
}

export class DisplayFilter {
  private mode: DisplayMode;
  private quietBuffer: string = '';

  constructor(mode?: DisplayMode) {
    this.mode = mode ?? config.display.mode;
  }

  filter(message: DisplayMessage): FilteredOutput {
    switch (this.mode) {
      case 'quiet':
        return this.filterQuiet(message);
      case 'compact':
        return this.filterCompact(message);
      case 'full':
        return this.filterFull(message);
    }
  }

  private filterQuiet(message: DisplayMessage): FilteredOutput {
    if (message.type === 'text') {
      // 缓冲文本，不立即发送
      this.quietBuffer += message.content;
      return { shouldSend: false, content: '' };
    }
    // 其他类型静默
    return { shouldSend: false, content: '' };
  }

  /**
   * 刷新缓冲区，返回累积的文本（用于流式结束时一次性发送）
   */
  flush(): FilteredOutput {
    if (this.mode !== 'quiet') {
      return { shouldSend: false, content: '' };
    }
    const content = this.quietBuffer.trim();
    this.quietBuffer = '';
    if (content) {
      return { shouldSend: true, content: content + '\n\n✅ 完成' };
    }
    return { shouldSend: false, content: '' };
  }

  private filterCompact(message: DisplayMessage): FilteredOutput {
    switch (message.type) {
      case 'text':
        return { shouldSend: true, content: message.content };
      case 'thinking':
        if (!config.display.thinkingMessages) {
          return { shouldSend: false, content: '' };
        }
        return {
          shouldSend: true,
          content: this.truncate(message.content, config.display.thinkingMaxLen, '💭 '),
        };
      case 'tool_use':
        if (!config.display.toolMessages) {
          return { shouldSend: false, content: '' };
        }
        return {
          shouldSend: true,
          content: this.truncate(
            `🔧 ${message.toolName || 'tool'}: ${message.content}`,
            config.display.toolMaxLen
          ),
        };
      case 'tool_result':
        return { shouldSend: false, content: '' };
    }
  }

  private filterFull(message: DisplayMessage): FilteredOutput {
    switch (message.type) {
      case 'text':
        return { shouldSend: true, content: message.content };
      case 'thinking':
        return {
          shouldSend: true,
          content: this.truncate(message.content, config.display.thinkingMaxLen, '💭 '),
        };
      case 'tool_use':
        return {
          shouldSend: true,
          content: this.truncate(
            `🔧 ${message.toolName || 'tool'}: ${message.content}`,
            config.display.toolMaxLen
          ),
        };
      case 'tool_result':
        return {
          shouldSend: true,
          content: this.truncate(message.content, config.display.toolMaxLen, '📋 '),
        };
    }
  }

  private truncate(text: string, maxLen: number, prefix = ''): string {
    const prefixed = prefix + text;
    if (prefixed.length <= maxLen) return prefixed;
    return prefixed.slice(0, Math.max(1, maxLen - 15)) + '...(truncated)';
  }

  setMode(mode: DisplayMode): void {
    this.mode = mode;
  }

  getMode(): DisplayMode {
    return this.mode;
  }
}
