/**
 * 命令解析器 - 解析钉钉群聊中的 / 命令
 */
export interface ParsedCommand {
  command: string;
  args: string[];
}

const COMMAND_PREFIX = '/';

/**
 * 解析消息是否为命令
 * 支持格式：/command arg1 arg2
 * 不区分大小写：/STATUS 和 /status 等价
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) {
    return null;
  }

  const parts = trimmed.slice(1).trim().split(/\s+/);
  if (parts.length === 0 || parts[0].length === 0) {
    return null;
  }

  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  return { command, args };
}

/** 所有支持的命令 */
export const COMMANDS = {
  help: { description: '显示所有可用命令', adminOnly: false },
  status: { description: '显示系统状态', adminOnly: false },
  model: { description: '查看/切换 AI 模型', adminOnly: true },
  history: { description: '显示最近对话历史', adminOnly: false },
  queue: { description: '显示消息队列状态', adminOnly: false },
  config: { description: '显示当前配置（脱敏）', adminOnly: true },
  reset: { description: '重置当前会话', adminOnly: true },
  remember: { description: '保存记忆（/remember key value）', adminOnly: true },
} as const;

export type CommandName = keyof typeof COMMANDS;