/**
 * 多项目架构类型定义
 * 支持单进程运行多个项目，每个项目独立 Agent + 平台
 */

/** 单个项目配置 */
export interface ProjectConfig {
  /** 项目名称（唯一标识） */
  name: string;
  /** 工作目录 */
  workDir: string;
  /** Agent 类型 */
  agentType: 'opencode' | 'claude';
  /** Agent 模型（可选） */
  agentModel?: string;
  /** 权限模式 */
  permissionMode?: 'default' | 'plan' | 'auto-edit' | 'full-auto';
  /** 关联的平台名称列表 */
  platforms: string[];
  /** 额外配置 */
  options?: Record<string, unknown>;
  /** 是否启用 */
  enabled: boolean;
  /** 空闲重置时间（分钟），0 = 不重置 */
  resetOnIdleMins?: number;
}

/** 项目运行时实例 */
export interface ProjectInstance {
  /** 项目配置 */
  config: ProjectConfig;
  /** 项目状态 */
  status: 'starting' | 'running' | 'idle' | 'stopped' | 'error';
  /** 最后活动时间 */
  lastActivityAt: number;
  /** 会话数量 */
  sessionCount: number;
  /** 错误信息 */
  lastError?: string;
  /** 启动时间 */
  startedAt?: number;
}
