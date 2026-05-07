/**
 * 项目实例 - 绑定 Agent + 平台 + 会话
 */
import type { ProjectConfig, ProjectInstance } from './types';
import type { Agent } from '../agents/types';

export class Project {
  readonly name: string;
  private config: ProjectConfig;
  private status: ProjectInstance['status'] = 'stopped';
  private lastActivityAt: number = Date.now();
  private sessionCount: number = 0;
  private lastError?: string;
  private startedAt?: number;
  private agent: Agent | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(config: ProjectConfig) {
    this.name = config.name;
    this.config = config;
  }

  /** 绑定 Agent */
  setAgent(agent: Agent): void {
    this.agent = agent;
  }

  /** 获取 Agent */
  getAgent(): Agent | null {
    return this.agent;
  }

  /** 启动项目 */
  async start(): Promise<void> {
    if (this.status === 'running') {
      console.log(`[Project:${this.name}] 已在运行中`);
      return;
    }

    this.status = 'starting';
    try {
      // 验证 Agent
      if (!this.agent) {
        throw new Error(`项目 ${this.name} 没有关联的 Agent`);
      }

      const available = await this.agent.isAvailable();
      if (!available) {
        throw new Error(`项目 ${this.name} 的 Agent (${this.agent.name}) 不可用`);
      }

      this.status = 'running';
      this.startedAt = Date.now();
      this.lastActivityAt = Date.now();
      console.log(`[Project:${this.name}] 已启动 (agent: ${this.agent.name})`);

      // 如果配置了空闲重置
      this.setupIdleTimer();
    } catch (error) {
      this.status = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error(`[Project:${this.name}] 启动失败:`, this.lastError);
      throw error;
    }
  }

  /** 停止项目 */
  async stop(): Promise<void> {
    this.clearIdleTimer();
    this.status = 'stopped';
    this.sessionCount = 0;
    console.log(`[Project:${this.name}] 已停止`);
  }

  /** 记录活动 */
  recordActivity(): void {
    this.lastActivityAt = Date.now();
    this.sessionCount++;
    if (this.status === 'idle') {
      this.status = 'running';
    }
  }

  /** 获取项目实例信息 */
  getInstance(): ProjectInstance {
    return {
      config: this.config,
      status: this.status,
      lastActivityAt: this.lastActivityAt,
      sessionCount: this.sessionCount,
      lastError: this.lastError,
      startedAt: this.startedAt,
    };
  }

  /** 获取项目配置 */
  getConfig(): ProjectConfig {
    return { ...this.config };
  }

  /** 更新项目配置 */
  updateConfig(updates: Partial<ProjectConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /** 空闲定时器 */
  private setupIdleTimer(): void {
    this.clearIdleTimer();
    const idleMins = this.config.resetOnIdleMins;
    if (!idleMins || idleMins <= 0) return;

    const checkInterval = Math.min(idleMins * 60 * 1000, 60000); // 最多每分钟检查一次
    this.idleTimer = setInterval(() => {
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs >= idleMins * 60 * 1000 && this.status === 'running') {
        this.status = 'idle';
        console.log(`[Project:${this.name}] 空闲超时 (${idleMins}分钟)，进入空闲状态`);
      }
    }, checkInterval);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
