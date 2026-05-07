/**
 * 项目管理器 - 管理多个项目实例
 */
import { Project } from './Project';
import type { ProjectConfig, ProjectInstance } from './types';

export class ProjectManager {
  private projects: Map<string, Project> = new Map();

  /** 创建并注册项目 */
  createProject(config: ProjectConfig): Project {
    if (this.projects.has(config.name)) {
      throw new Error(`项目 "${config.name}" 已存在`);
    }

    const project = new Project(config);
    this.projects.set(config.name, project);
    console.log(`[ProjectManager] 项目 "${config.name}" 已创建`);
    return project;
  }

  /** 获取项目 */
  getProject(name: string): Project | undefined {
    return this.projects.get(name);
  }

  /** 列出所有项目 */
  listProjects(): ProjectInstance[] {
    return Array.from(this.projects.values()).map(p => p.getInstance());
  }

  /** 启动所有已启用项目 */
  async startAll(): Promise<void> {
    const startPromises: Promise<void>[] = [];
    Array.from(this.projects.values()).forEach(project => {
      const config = project.getConfig();
      if (config.enabled) {
        startPromises.push(
          project.start().catch(err => {
            console.error(`[ProjectManager] 项目 ${config.name} 启动失败:`, err);
          })
        );
      }
    });
    await Promise.all(startPromises);
  }

  /** 停止所有项目 */
  async stopAll(): Promise<void> {
    const stopPromises: Promise<void>[] = [];
    Array.from(this.projects.values()).forEach(project => {
      stopPromises.push(project.stop());
    });
    await Promise.all(stopPromises);
  }

  /** 删除项目 */
  removeProject(name: string): boolean {
    const project = this.projects.get(name);
    if (project) {
      project.stop();
      return this.projects.delete(name);
    }
    return false;
  }

  /** 获取项目数量 */
  get size(): number {
    return this.projects.size;
  }
}
