/**
 * AI Provider 注册表 - 管理多个 AI 提供者
 */
import { randomUUID } from 'crypto';

export interface AIProvider {
  name: string;
  type: 'opencode' | 'claude' | 'custom';
  command: string;
  args?: string[];
  timeout: number;
  enabled: boolean;
}

export class ProviderRegistry {
  private providers: Map<string, AIProvider> = new Map();
  private defaultName: string = 'default';

  register(provider: AIProvider): void {
    this.providers.set(provider.name, provider);
    console.log(`[Router] 注册 AI Provider: ${provider.name} (${provider.type})`);
  }

  unregister(name: string): boolean {
    const deleted = this.providers.delete(name);
    if (deleted) {
      console.log(`[Router] 注销 AI Provider: ${name}`);
    }
    return deleted;
  }

  get(name: string): AIProvider | undefined {
    return this.providers.get(name);
  }

  list(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  getDefault(): AIProvider {
    const provider = this.providers.get(this.defaultName);
    if (!provider) {
      const first = this.providers.values().next().value;
      if (first) return first;
      throw new Error('No AI providers registered');
    }
    return provider;
  }

  setDefault(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider "${name}" not found`);
    }
    this.defaultName = name;
    console.log(`[Router] 默认 Provider 设置为: ${name}`);
  }

  getDefaultName(): string {
    return this.defaultName;
  }

  size(): number {
    return this.providers.size;
  }
}