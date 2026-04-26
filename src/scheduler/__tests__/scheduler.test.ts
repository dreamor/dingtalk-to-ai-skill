import { Scheduler } from '../scheduler';

describe('Scheduler', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    scheduler = new Scheduler({ enabled: false });
  });

  afterEach(() => {
    scheduler.stop();
  });

  test('adds a task', () => {
    const task = scheduler.addTask({
      name: 'Test Task',
      cron: '0 9 * * 1-5',
      prompt: 'Good morning!',
      conversationId: 'conv-123',
    });

    expect(task.name).toBe('Test Task');
    expect(task.cron).toBe('0 9 * * 1-5');
    expect(task.enabled).toBe(true);

    const tasks = scheduler.listTasks();
    expect(tasks).toHaveLength(1);
  });

  test('removes a task', () => {
    const task = scheduler.addTask({
      name: 'Removable',
      cron: '0 * * * *',
      prompt: 'test',
      conversationId: 'conv-1',
    });

    expect(scheduler.removeTask(task.id)).toBe(true);
    expect(scheduler.listTasks()).toHaveLength(0);
  });

  test('toggles a task', () => {
    const task = scheduler.addTask({
      name: 'Toggleable',
      cron: '0 * * * *',
      prompt: 'test',
      conversationId: 'conv-1',
    });

    const toggled = scheduler.toggleTask(task.id);
    expect(toggled?.enabled).toBe(false);

    const toggledBack = scheduler.toggleTask(task.id);
    expect(toggledBack?.enabled).toBe(true);
  });

  test('returns null for non-existent task', () => {
    expect(scheduler.getTask('non-existent')).toBeNull();
    expect(scheduler.removeTask('non-existent')).toBe(false);
    expect(scheduler.toggleTask('non-existent')).toBeNull();
  });

  test('getStatus returns correct info', () => {
    scheduler.addTask({
      name: 'Task 1',
      cron: '0 9 * * *',
      prompt: 'test',
      conversationId: 'conv-1',
    });

    const status = scheduler.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.totalTasks).toBe(1);
    expect(status.activeTasks).toBe(0);
  });

  test('validates cron expression', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const task = scheduler.addTask({
      name: 'Invalid Cron',
      cron: 'invalid',
      prompt: 'test',
      conversationId: 'conv-1',
      enabled: false,
    });

    // Task should be added but not scheduled
    expect(scheduler.listTasks()).toHaveLength(1);
    consoleSpy.mockRestore();
  });
});