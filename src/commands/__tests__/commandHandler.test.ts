import { CommandHandler, type CommandDeps } from '../commandHandler';
import { SessionManager } from '../../session-manager';
import { MessageQueue } from '../../message-queue/messageQueue';
import { parseCommand } from '../commandParser';

// Mock dependencies
const mockSessionManager = {
  getHistory: jest.fn().mockResolvedValue([]),
  endSession: jest.fn().mockResolvedValue(undefined),
} as unknown as SessionManager;

const mockMessageQueue = {
  getStatus: jest.fn().mockReturnValue({
    queued: 0,
    processing: 0,
    byPriority: { high: 0, normal: 0, low: 0 },
  }),
} as unknown as MessageQueue;

const deps: CommandDeps = {
  sessionManager: mockSessionManager,
  messageQueue: mockMessageQueue,
};

describe('CommandHandler', () => {
  let handler: CommandHandler;

  beforeEach(() => {
    handler = new CommandHandler(deps);
    jest.clearAllMocks();
  });

  test('handles /help command', async () => {
    const parsed = parseCommand('/help')!;
    const result = await handler.handle(parsed, 'user1', 'conv1');
    expect(result).toContain('可用命令');
    expect(result).toContain('/help');
    expect(result).toContain('/status');
  });

  test('handles /status command', async () => {
    const parsed = parseCommand('/status')!;
    const result = await handler.handle(parsed, 'user1', 'conv1');
    expect(result).toContain('系统状态');
    expect(result).toContain('AI Provider');
  });

  test('handles /queue command', async () => {
    const parsed = parseCommand('/queue')!;
    const result = await handler.handle(parsed, 'user1', 'conv1');
    expect(result).toContain('消息队列');
  });

  test('handles /history with no messages', async () => {
    const parsed = parseCommand('/history')!;
    const result = await handler.handle(parsed, 'user1', 'conv1');
    expect(result).toContain('暂无对话历史');
  });

  test('returns error for unknown command', async () => {
    const parsed = parseCommand('/unknown')!;
    const result = await handler.handle(parsed, 'user1', 'conv1');
    expect(result).toContain('未知命令');
  });

  test('returns permission denied for admin commands by non-admin', async () => {
    const parsed = parseCommand('/config')!;
    const result = await handler.handle(parsed, 'non-admin-user', 'conv1');
    expect(result).toContain('权限不足');
  });

  test('/model with no args shows current model', async () => {
    const parsed = parseCommand('/model')!;
    const result = await handler.handle(parsed, 'admin-id', 'conv1');
    expect(result).toContain('当前模型');
  });
});