/**
 * 平台注册表 - 管理平台实例的注册和查找
 */
import type { Platform } from './types';

class PlatformRegistry {
  private platforms: Map<string, Platform> = new Map();

  register(platform: Platform): void {
    if (this.platforms.has(platform.name)) {
      console.warn(`[PlatformRegistry] 平台 "${platform.name}" 已注册，将覆盖`);
    }
    this.platforms.set(platform.name, platform);
    console.log(`[PlatformRegistry] 平台 "${platform.name}" 已注册`);
  }

  get(name: string): Platform | undefined {
    return this.platforms.get(name);
  }

  list(): string[] {
    return Array.from(this.platforms.keys());
  }

  getAll(): Platform[] {
    return Array.from(this.platforms.values());
  }

  get size(): number {
    return this.platforms.size;
  }

  unregister(name: string): boolean {
    return this.platforms.delete(name);
  }
}

// 全局单例
export const platformRegistry = new PlatformRegistry();
export { PlatformRegistry };
