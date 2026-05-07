/**
 * ProjectManager 单元测试
 */
import { ProjectManager } from '../ProjectManager';
import type { ProjectConfig } from '../types';

const baseConfig: ProjectConfig = {
  name: 'test-project',
  workDir: '/tmp/test',
  agentType: 'opencode',
  platforms: ['dingtalk'],
  enabled: true,
};

describe('ProjectManager', () => {
  let manager: ProjectManager;

  beforeEach(() => {
    manager = new ProjectManager();
  });

  test('should create and retrieve project', () => {
    const project = manager.createProject(baseConfig);
    expect(project.name).toBe('test-project');
    expect(manager.getProject('test-project')).toBe(project);
  });

  test('should prevent duplicate project names', () => {
    manager.createProject(baseConfig);
    expect(() => manager.createProject(baseConfig)).toThrow('已存在');
  });

  test('should list all projects', () => {
    manager.createProject(baseConfig);
    manager.createProject({ ...baseConfig, name: 'project-2' });
    const list = manager.listProjects();
    expect(list).toHaveLength(2);
  });

  test('should remove project', () => {
    manager.createProject(baseConfig);
    const removed = manager.removeProject('test-project');
    expect(removed).toBe(true);
    expect(manager.getProject('test-project')).toBeUndefined();
  });

  test('should return size', () => {
    manager.createProject(baseConfig);
    expect(manager.size).toBe(1);
  });
});
