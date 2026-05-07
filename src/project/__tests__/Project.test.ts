/**
 * Project 单元测试
 */
import { Project } from '../Project';
import type { ProjectConfig } from '../types';
import type { Agent, AgentResult } from '../../agents/types';

// 创建 Mock Agent 工厂函数
const createMockAgent = (overrides?: Partial<Agent>): Agent => ({
  name: 'mock-agent',
  type: 'mock',
  execute: jest.fn().mockResolvedValue({ success: true, output: 'test', executionTime: 100, exitCode: 0 } as AgentResult),
  executeStream: jest.fn().mockResolvedValue({ success: true, output: 'test', executionTime: 100, exitCode: 0 } as AgentResult),
  isAvailable: jest.fn().mockResolvedValue(true),
  getConfig: jest.fn().mockReturnValue({
    command: 'test', timeout: 30000, maxRetries: 3,
    retryBaseDelay: 1000, retryMaxDelay: 10000,
    model: 'test', maxInputLength: 10000,
  }),
  ...overrides,
});

const baseConfig: ProjectConfig = {
  name: 'test-project',
  workDir: '/tmp/test',
  agentType: 'opencode',
  platforms: ['dingtalk'],
  enabled: true,
};

describe('Project', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should create with correct name and config', () => {
    const project = new Project(baseConfig);
    expect(project.name).toBe('test-project');
    expect(project.getConfig().agentType).toBe('opencode');
  });

  test('should start successfully when agent is available', async () => {
    const mockAgent = createMockAgent();
    const project = new Project(baseConfig);
    project.setAgent(mockAgent);
    await project.start();
    const instance = project.getInstance();
    expect(instance.status).toBe('running');
    expect(instance.startedAt).toBeDefined();
  });

  test('should fail to start without agent', async () => {
    const project = new Project(baseConfig);
    await expect(project.start()).rejects.toThrow('没有关联的 Agent');
    expect(project.getInstance().status).toBe('error');
  });

  test('should record activity', () => {
    const project = new Project(baseConfig);
    project.recordActivity();
    const instance = project.getInstance();
    expect(instance.sessionCount).toBe(1);
    expect(instance.lastActivityAt).toBeGreaterThan(0);
  });

  test('should stop and reset', async () => {
    const mockAgent = createMockAgent();
    const project = new Project(baseConfig);
    project.setAgent(mockAgent);
    await project.start();
    project.recordActivity();
    await project.stop();
    expect(project.getInstance().status).toBe('stopped');
    expect(project.getInstance().sessionCount).toBe(0);
  });

  test('should update config', () => {
    const project = new Project(baseConfig);
    project.updateConfig({ agentModel: 'gpt-4' });
    expect(project.getConfig().agentModel).toBe('gpt-4');
  });

  test('should transition to idle when agent is not available', async () => {
    const unavailableAgent = createMockAgent({
      isAvailable: jest.fn().mockResolvedValue(false),
    });
    const project = new Project(baseConfig);
    project.setAgent(unavailableAgent);
    await expect(project.start()).rejects.toThrow('不可用');
    expect(project.getInstance().status).toBe('error');
  });
});
