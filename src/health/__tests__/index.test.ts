/**
 * 健康检查模块测试
 */
import { getSimpleStatus, getSystemMetrics } from '../index';

jest.mock('../../config', () => ({
  config: {
    aiProvider: 'opencode',
    dingtalk: { appKey: 'key123', appSecret: 'secret123' },
    gateway: { port: 3000 },
    messageQueue: { enablePersistence: false },
    configSource: 'env',
  },
}));

describe('health/index', () => {
  describe('getSimpleStatus', () => {
    it('should return ok status with timestamp', () => {
      const result = getSimpleStatus();
      expect(result.status).toBe('ok');
      expect(result.mode).toBe('stream');
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
    });
  });

  describe('getSystemMetrics', () => {
    it('should return memory and node metrics', () => {
      const metrics = getSystemMetrics();
      expect(metrics.uptime).toBeGreaterThanOrEqual(0);
      expect(metrics.memory).toHaveProperty('heapUsed');
      expect(metrics.memory).toHaveProperty('heapTotal');
      expect(metrics.memory).toHaveProperty('rss');
      expect(metrics.node).toHaveProperty('version');
      expect(metrics.node).toHaveProperty('platform');
      const node = metrics.node as Record<string, unknown>;
      expect(node.platform).toBe(process.platform);
      const cfg = metrics.config as Record<string, unknown>;
      expect(cfg.aiProvider).toBe('opencode');
    });

    it('should report correct config fields', () => {
      const metrics = getSystemMetrics();
      const cfg = metrics.config as Record<string, unknown>;
      expect(cfg.gatewayPort).toBe(3000);
      expect(cfg.persistence).toBe(false);
    });
  });
});
