/**
 * 动态间隔管理器
 * 根据消息频率动态调整轮询间隔，优化资源消耗
 */
import { type PollingConfig } from './types';

export class IntervalManager {
  private config: PollingConfig;
  private currentInterval: number;
  private consecutiveEmptyPulls: number;
  private idleMode: boolean;
  private lastMessageTime: number;
  private readonly increaseFactor: number = 1.5;
  private readonly decreaseFactor: number = 0.8;

  constructor(config?: Partial<PollingConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      interval: config?.interval ?? 3000,
      timeout: config?.timeout ?? 5000,
      minInterval: config?.minInterval ?? 1000,
      maxInterval: config?.maxInterval ?? 10000,
      idleThreshold: config?.idleThreshold ?? 3,
    };
    this.currentInterval = this.config.interval;
    this.consecutiveEmptyPulls = 0;
    this.idleMode = false;
    this.lastMessageTime = Date.now();
  }

  /**
   * 获取当前配置的间隔
   */
  getInterval(): number {
    return this.currentInterval;
  }

  /**
   * 获取当前是否为空闲模式
   */
  isIdleMode(): boolean {
    return this.idleMode;
  }

  /**
   * 获取连续空拉取次数
   */
  getConsecutiveEmptyPulls(): number {
    return this.consecutiveEmptyPulls;
  }

  /**
   * 记录一次成功的消息拉取
   * 调用此方法后，间隔会调整为最小间隔
   */
  recordMessagePulled(): void {
    // 有消息时，立即恢复为最小间隔
    if (this.idleMode || this.currentInterval > this.config.minInterval) {
      console.log(`[IntervalManager] 检测到新消息，间隔从 ${this.currentInterval}ms 调整为 ${this.config.minInterval}ms`);
    }
    this.currentInterval = this.config.minInterval;
    this.consecutiveEmptyPulls = 0;
    this.idleMode = false;
    this.lastMessageTime = Date.now();
  }

  /**
   * 记录一次空拉取（无新消息）
   * 连续空拉取达到阈值后，开始延长间隔
   */
  recordEmptyPull(): void {
    this.consecutiveEmptyPulls++;

    // 达到空闲阈值后，逐步延长间隔
    if (this.consecutiveEmptyPulls >= this.config.idleThreshold) {
      this.enterIdleMode();
    }
  }

  /**
   * 进入空闲模式，逐步延长间隔
   */
  private enterIdleMode(): void {
    if (this.idleMode) {
      // 已经处于空闲模式，进一步延长间隔
      this.currentInterval = Math.min(
        this.currentInterval * this.increaseFactor,
        this.config.maxInterval
      );
    } else {
      // 首次进入空闲模式
      this.idleMode = true;
      this.currentInterval = Math.min(
        this.config.interval * this.increaseFactor,
        this.config.maxInterval
      );
    }

    console.log(
      `[IntervalManager] 进入空闲模式，间隔调整为 ${this.currentInterval}ms ` +
      `(连续空拉取: ${this.consecutiveEmptyPulls})`
    );
  }

  /**
   * 手动重置间隔到配置的默认值
   */
  resetInterval(): void {
    this.currentInterval = this.config.interval;
    this.consecutiveEmptyPulls = 0;
    this.idleMode = false;
    console.log(`[IntervalManager] 间隔已重置为 ${this.currentInterval}ms`);
  }

  /**
   * 更新配置并重新验证
   */
  updateConfig(newConfig: Partial<PollingConfig>): void {
    const oldMaxInterval = this.config.maxInterval;
    const oldMinInterval = this.config.minInterval;

    this.config = {
      ...this.config,
      ...newConfig,
    };

    // 验证并调整当前间隔
    if (this.config.maxInterval < oldMaxInterval && this.currentInterval > this.config.maxInterval) {
      this.currentInterval = this.config.maxInterval;
    }
    if (this.config.minInterval > oldMinInterval && this.currentInterval < this.config.minInterval) {
      this.currentInterval = this.config.minInterval;
    }

    console.log(
      `[IntervalManager] 配置已更新: ` +
      `interval=${this.config.interval}, ` +
      `minInterval=${this.config.minInterval}, ` +
      `maxInterval=${this.config.maxInterval}`
    );
  }

  /**
   * 获取当前状态快照
   */
  getSnapshot(): Record<string, unknown> {
    return {
      currentInterval: this.currentInterval,
      minInterval: this.config.minInterval,
      maxInterval: this.config.maxInterval,
      consecutiveEmptyPulls: this.consecutiveEmptyPulls,
      idleMode: this.idleMode,
      lastMessageTime: this.lastMessageTime,
      idleThreshold: this.config.idleThreshold,
    };
  }

  /**
   * 获取完整的配置信息
   */
  getConfig(): PollingConfig {
    return { ...this.config };
  }
}