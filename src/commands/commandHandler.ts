/**
 * 命令处理器 - 处理解析后的命令并返回响应
 */
import { ParsedCommand, COMMANDS, CommandName } from './commandParser';
import { SessionManager } from '../session-manager';
import { MessageQueue } from '../message-queue/messageQueue';
import { config } from '../config';
import { getAdminConversationId } from '../utils/alert';

export interface CommandDeps {
  sessionManager: SessionManager;
  messageQueue: MessageQueue;
  aiProviderStatus?: { opencode: boolean; claude: boolean };
}

export class CommandHandler {
  private deps: CommandDeps;

  constructor(deps: CommandDeps) {
    this.deps = deps;
  }

  /**
   * 处理命令，返回 markdown 格式的响应
   */
  async handle(
    parsed: ParsedCommand,
    userId: string,
    conversationId: string
  ): Promise<string> {
    const { command, args } = parsed;
    const isAdmin = this.isAdmin(userId);

    if (!this.isValidCommand(command)) {
      return `❌ 未知命令：/${command}\n\n输入 /help 查看可用命令`;
    }

    const cmdDef = COMMANDS[command as CommandName];

    if (cmdDef.adminOnly && !isAdmin) {
      return '⛔ 权限不足，此命令仅管理员可用';
    }

    switch (command) {
      case 'help':
        return this.handleHelp();
      case 'status':
        return this.handleStatus();
      case 'model':
        return this.handleModel(args);
      case 'history':
        return this.handleHistory(conversationId, args);
      case 'queue':
        return this.handleQueue();
      case 'config':
        return this.handleConfig();
      case 'reset':
        return this.handleReset(conversationId);
      case 'remember':
        return this.handleRemember(args);
      default:
        return `❌ 未知命令：/${command}`;
    }
  }

  private isAdmin(userId: string): boolean {
    const adminId = getAdminConversationId();
    return adminId === userId;
  }

  private isValidCommand(command: string): command is CommandName {
    return command in COMMANDS;
  }

  private handleHelp(): string {
    const lines = ['## 📋 可用命令\n'];
    for (const [name, def] of Object.entries(COMMANDS)) {
      const badge = def.adminOnly ? ' 🔒' : '';
      lines.push(`- \`/${name}\` ${def.description}${badge}`);
    }
    lines.push('\n🔒 = 仅管理员可用');
    return lines.join('\n');
  }

  private handleStatus(): string {
    const queueStatus = this.deps.messageQueue.getStatus();
    const provider = config.aiProvider;
    const aiStatus = this.deps.aiProviderStatus
      ? `\n- **OpenCode**: ${this.deps.aiProviderStatus.opencode ? '✅ 可用' : '❌ 不可用'}\n- **Claude Code**: ${this.deps.aiProviderStatus.claude ? '✅ 可用' : '❌ 不可用'}`
      : '';

    return [
      '## 📊 系统状态\n',
      `- **AI Provider**: ${provider}`,
      `- **队列等待**: ${queueStatus.queued}`,
      `- **队列处理中**: ${queueStatus.processing}`,
      `- **高优先级**: ${queueStatus.byPriority.high}`,
      `- **普通优先级**: ${queueStatus.byPriority.normal}`,
      `- **低优先级**: ${queueStatus.byPriority.low}`,
      aiStatus,
    ].join('\n');
  }

  private handleModel(args: string[]): string {
    if (args.length === 0) {
      return `## 🤖 当前模型\n\n- **Provider**: ${config.aiProvider}\n- **Model**: ${config.aiProvider === 'claude' ? config.claude.model : config.ai.model}`;
    }

    const newProvider = args[0].toLowerCase();
    if (newProvider !== 'opencode' && newProvider !== 'claude') {
      return '❌ 不支持的模型，可选：`opencode` 或 `claude`';
    }

    // 注意：运行时切换 provider 需要修改 config
    // 这里仅返回提示信息，实际切换需要重启服务或修改环境变量
    return `⚠️ 模型切换需要修改环境变量 AI_PROVIDER=${newProvider} 并重启服务\n\n当前: ${config.aiProvider}`;
  }

  private async handleHistory(conversationId: string, args: string[]): Promise<string> {
    const limit = args.length > 0 ? parseInt(args[0], 10) || 5 : 5;
    const history = await this.deps.sessionManager.getHistory(conversationId, limit);

    if (history.length === 0) {
      return '📋 暂无对话历史';
    }

    const lines = [`## 📜 最近 ${history.length} 条对话\n`];
    for (const msg of history) {
      const role = msg.type === 'user' ? '👤' : '🤖';
      const content = msg.content.length > 100
        ? msg.content.slice(0, 100) + '...'
        : msg.content;
      lines.push(`${role} ${content}`);
    }
    return lines.join('\n');
  }

  private handleQueue(): string {
    const status = this.deps.messageQueue.getStatus();
    return [
      '## 📬 消息队列\n',
      `- **等待中**: ${status.queued}`,
      `- **处理中**: ${status.processing}`,
      `- **高优先级**: ${status.byPriority.high}`,
      `- **普通优先级**: ${status.byPriority.normal}`,
      `- **低优先级**: ${status.byPriority.low}`,
    ].join('\n');
  }

  private handleConfig(): string {
    // 脱敏配置
    const maskKey = (key: string | undefined): string => {
      if (!key) return '(未设置)';
      if (key.length <= 8) return '****';
      return key.slice(0, 4) + '****' + key.slice(-4);
    };

    return [
      '## ⚙️ 当前配置\n',
      `- **AI Provider**: ${config.aiProvider}`,
      `- **Gateway**: ${config.gateway.host}:${config.gateway.port}`,
      `- **Session TTL**: ${config.session.ttl / 1000}s`,
      `- **Max History**: ${config.session.maxHistoryMessages}`,
      `- **Queue Persistence**: ${config.messageQueue.enablePersistence ? '开启' : '关闭'}`,
      `- **Rate Limit**: ${config.messageQueue.rateLimitMaxTokens} tokens`,
      `- **Dingtalk AppKey**: ${maskKey(config.dingtalk.appKey)}`,
    ].join('\n');
  }

  private async handleReset(conversationId: string): Promise<string> {
    await this.deps.sessionManager.endSession(conversationId);
    return '✅ 会话已重置，下次对话将创建新会话';
  }

  private handleRemember(args: string[]): string {
    if (args.length < 2) {
      return '❌ 用法：/remember <key> <value>\n\n例如：/remember project_dir /path/to/project';
    }
    // 记忆功能由 memory 模块实现，这里仅返回提示
    return '⚠️ 记忆功能需要启用 memory 模块（feature/project-memory）\n\n当前版本暂不支持持久化记忆';
  }
}