/**
 * 沙箱安全模块 - OS 用户隔离
 *
 * 允许 AI Agent 在受限用户下执行命令，降低安全风险。
 * 通过 child_process 的 uid/gid 选项或 sudo -u 方式实现。
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface SandboxConfig {
  /** 是否启用沙箱 */
  enabled: boolean;
  /** 运行用户名 */
  runAsUser?: string;
  /** 审计超时（秒） */
  auditTimeout?: number;
}

export interface SandboxAuditResult {
  /** 是否通过安全审计 */
  passed: boolean;
  /** 审计项列表 */
  checks: SandboxAuditCheck[];
  /** 错误消息 */
  errors: string[];
}

export interface SandboxAuditCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

/** 默认沙箱配置 */
const DEFAULT_CONFIG: SandboxConfig = {
  enabled: false,
};

/**
 * 沙箱管理器
 */
export class SandboxManager {
  private config: SandboxConfig;

  constructor(config?: Partial<SandboxConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 检查沙箱是否启用 */
  isEnabled(): boolean {
    return this.config.enabled && !!this.config.runAsUser;
  }

  /** 获取运行用户 */
  getRunAsUser(): string | undefined {
    return this.config.runAsUser;
  }

  /**
   * 执行安全审计
   */
  async audit(): Promise<SandboxAuditResult> {
    const checks: SandboxAuditCheck[] = [];
    const errors: string[] = [];

    // 检查 1: sudo 是否可用
    try {
      await execAsync('which sudo', { timeout: 5000 });
      checks.push({ name: 'sudo 可用', status: 'pass', message: 'sudo 命令已安装' });
    } catch {
      checks.push({ name: 'sudo 可用', status: 'warn', message: 'sudo 未安装，OS 用户隔离不可用' });
    }

    // 检查 2: 运行用户是否存在
    if (this.config.runAsUser) {
      try {
        await execAsync(`id -u ${this.config.runAsUser}`, { timeout: 5000 });
        checks.push({
          name: '运行用户存在',
          status: 'pass',
          message: `用户 "${this.config.runAsUser}" 已创建`,
        });
      } catch {
        const msg = `用户 "${this.config.runAsUser}" 不存在，需要先创建`;
        checks.push({ name: '运行用户存在', status: 'fail', message: msg });
        errors.push(msg);
      }
    } else {
      checks.push({ name: '运行用户', status: 'warn', message: '未配置运行用户' });
    }

    // 检查 3: 当前用户是否有 sudo 免密权限
    if (this.config.runAsUser) {
      try {
        const { stdout } = await execAsync(`sudo -n -u ${this.config.runAsUser} echo ok`, {
          timeout: 10000,
        });
        if (stdout.trim() === 'ok') {
          checks.push({
            name: 'sudo 免密',
            status: 'pass',
            message: `当前用户可以免密 sudo -u ${this.config.runAsUser}`,
          });
        } else {
          checks.push({ name: 'sudo 免密', status: 'warn', message: 'sudo 需要密码，可能影响自动化' });
        }
      } catch {
        checks.push({
          name: 'sudo 免密',
          status: 'warn',
          message: '当前用户需要密码才能 sudo，建议配置 NOPASSWD',
        });
      }
    }

    const hasFailure = checks.some(c => c.status === 'fail');
    return {
      passed: !hasFailure,
      checks,
      errors,
    };
  }

  /**
   * 为 spawn 选项构建沙箱参数
   */
  getSpawnOptions(): { commandPrefix?: string; uid?: number; gid?: number } {
    if (!this.isEnabled()) {
      return {};
    }

    return {
      commandPrefix: `sudo -n -u ${this.config.runAsUser}`,
    };
  }

  /**
   * 包装命令以在沙箱中执行
   */
  wrapCommand(command: string): string {
    const options = this.getSpawnOptions();
    if (options.commandPrefix) {
      return `${options.commandPrefix} ${command}`;
    }
    return command;
  }

  /** 获取配置 */
  getConfig(): SandboxConfig {
    return { ...this.config };
  }
}

/**
 * 创建沙箱管理器
 */
export function createSandboxManager(config?: Partial<SandboxConfig>): SandboxManager {
  return new SandboxManager(config);
}
