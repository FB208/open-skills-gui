import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPathLayout } from '../../src/backend/paths.js';
import type { CommandRunner } from '../../src/backend/process.js';
import {
  RestartManagerLocks,
  type FileLockManager,
  withFileLockHandling,
} from '../../src/backend/windows-locks.js';

/** 创建带 Windows 文件占用错误码的伪异常。 */
function busyError(code = 'EBUSY'): NodeJS.ErrnoException {
  return Object.assign(new Error('文件被占用'), { code });
}

describe('Windows 文件占用处理', () => {
  it('force=false 时返回可展示的进程名和 PID，且不终止进程', async () => {
    const operation = vi.fn(async () => Promise.reject(busyError()));
    const locks: FileLockManager = {
      find: vi.fn(async () => [{ pid: 4321, name: '正在运行的脚本.exe' }]),
      terminate: vi.fn(async () => undefined),
    };

    const error = await withFileLockHandling('C:\\技能\\示例', false, locks, operation).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: 'FILE_IN_USE' });
    expect(JSON.parse((error as { details: string }).details)).toEqual({
      path: 'C:\\技能\\示例',
      processes: [{ pid: 4321, name: '正在运行的脚本.exe' }],
    });
    expect(locks.terminate).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('force=true 时终止确认的进程树并重试原操作', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(busyError('EPERM'))
      .mockResolvedValueOnce('完成');
    const processes = [{ pid: 9876, name: 'node.exe' }];
    const locks: FileLockManager = {
      find: vi.fn(async () => processes),
      terminate: vi.fn(async () => undefined),
    };

    await expect(withFileLockHandling('C:\\技能\\示例', true, locks, operation)).resolves.toBe(
      '完成',
    );
    expect(locks.terminate).toHaveBeenCalledWith(processes);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('taskkill 因权限不足失败时明确返回终止失败，不绕过 Windows 权限', async () => {
    const calls: Array<{ executable: string; args?: readonly string[] }> = [];
    const runner: CommandRunner = {
      run: vi.fn(async (spec) => {
        calls.push({ executable: spec.executable, args: spec.args });
        return { exitCode: 5, stdout: '', stderr: 'ERROR: Access is denied.' };
      }),
    };
    const layout = createPathLayout({
      appRoot: 'C:\\程序\\OpenSkillsGUI',
      dataRoot: 'C:\\用户数据\\OpenSkillsGUI',
      homeDir: 'C:\\用户',
    });
    const locks = new RestartManagerLocks(layout, runner);

    await expect(locks.terminate([{ pid: 2468, name: '高权限进程.exe' }])).rejects.toMatchObject({
      code: 'PROCESS_TERMINATE_FAILED',
    });
    expect(path.isAbsolute(calls[0].executable)).toBe(true);
    expect(calls[0].executable.toLowerCase()).toMatch(/taskkill\.exe$/);
    expect(calls[0].args).toEqual(['/PID', '2468', '/T', '/F']);
  });
});
