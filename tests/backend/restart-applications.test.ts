import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncMutex } from '../../src/backend/mutex.js';
import { RestartApplicationsService } from '../../src/backend/restart-applications.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(exitCode = 10) {
  const root = await mkdtemp(path.join(os.tmpdir(), '应用重启-'));
  roots.push(root);
  const executable = path.join(root, '示例 应用.exe');
  await writeFile(executable, 'test');
  const runner = {
    run: vi.fn(async (_spec: unknown) => ({ exitCode, stdout: '', stderr: '' })),
  };
  const service = new RestartApplicationsService(
    path.join(root, 'data', 'restart-applications.json'),
    runner,
    new AsyncMutex(),
  );
  return { service, runner, executable, root };
}

describe('手动应用重启配置', () => {
  it('添加、去重、重新读取并移除中文路径 EXE', async () => {
    const { service, executable, root } = await fixture();
    const first = await service.add(executable);
    const duplicate = await service.add(executable);

    expect(duplicate.id).toBe(first.id);
    expect(await service.list()).toEqual([first]);

    const reloaded = new RestartApplicationsService(
      path.join(root, 'data', 'restart-applications.json'),
      { run: vi.fn() },
      new AsyncMutex(),
    );
    expect(await reloaded.list()).toEqual([first]);
    await expect(reloaded.remove(first.id)).resolves.toEqual({ removed: true });
    await expect(reloaded.remove(first.id)).resolves.toEqual({ removed: false });
    await expect(reloaded.list()).resolves.toEqual([]);
  });

  it('拒绝不存在的路径和非 EXE 文件', async () => {
    const { service, root } = await fixture();
    await expect(service.add(path.join(root, 'missing.exe'))).rejects.toMatchObject({
      code: 'INVALID_EXECUTABLE',
    });
    const textFile = path.join(root, '应用.txt');
    await writeFile(textFile, 'test');
    await expect(service.add(textFile)).rejects.toMatchObject({ code: 'INVALID_EXECUTABLE' });
  });

  it('应用未运行时只返回明确错误，不会尝试启动', async () => {
    const { service, runner, executable } = await fixture(10);
    const application = await service.add(executable);
    await expect(service.restart(application.id)).rejects.toMatchObject({
      code: 'APPLICATION_NOT_RUNNING',
    });
    expect(runner.run).toHaveBeenCalledOnce();
    expect(runner.run.mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: 20_000,
      env: expect.objectContaining({ OPEN_SKILLS_RESTART_TARGET: expect.any(String) }),
    });
  });

  it('批量操作跳过未运行项，并在单项失败后继续处理', async () => {
    const { service, runner, executable, root } = await fixture();
    const secondExecutable = path.join(root, '另一个应用.exe');
    await writeFile(secondExecutable, 'test');
    const first = await service.add(executable);
    const second = await service.add(secondExecutable);
    runner.run
      .mockResolvedValueOnce({ exitCode: 10, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 11, stdout: '', stderr: '' });

    await expect(service.restartRunning()).resolves.toEqual({
      configured: 2,
      restarted: [],
      skipped: [first],
      failed: [{ application: second, message: expect.any(String) }],
    });
    expect(runner.run).toHaveBeenCalledTimes(2);
  });
  it('损坏的独立配置不会影响主状态文件', async () => {
    const { service, root } = await fixture();
    await mkdir(path.join(root, 'data'), { recursive: true });
    await writeFile(path.join(root, 'data', 'restart-applications.json'), '{bad json', 'utf8');
    await expect(service.list()).rejects.toMatchObject({ code: 'RESTART_APPLICATIONS_CORRUPT' });
  });
});
