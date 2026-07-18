import path from 'node:path';
import { BackendException } from './errors.js';
import type { PathLayout } from './paths.js';
import { windowsExecutable } from './paths.js';
import type { CommandRunner } from './process.js';

export interface LockingProcess {
  pid: number;
  name: string;
}

export interface FileLockManager {
  find(targetPath: string): Promise<LockingProcess[]>;
  terminate(processes: readonly LockingProcess[]): Promise<void>;
}

/** 调用项目唯一的 Restart Manager 脚本查询具体文件占用。 */
export class RestartManagerLocks implements FileLockManager {
  private readonly scriptPath: string;

  constructor(
    layout: PathLayout,
    private readonly runner: CommandRunner,
  ) {
    this.scriptPath = path.join(layout.appRoot, 'scripts', 'restart-manager.ps1');
  }

  /** 用 Restart Manager 查询占用目标目录中文件的进程。 */
  async find(targetPath: string): Promise<LockingProcess[]> {
    const result = await this.runner.run({
      executable: windowsExecutable('powershell'),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.scriptPath,
        '-Path',
        targetPath,
      ],
      timeoutMs: 60_000,
    });
    let envelope: unknown;
    try {
      envelope = JSON.parse(result.stdout.trim());
    } catch (error) {
      throw new BackendException(
        'LOCK_QUERY_FAILED',
        '无法解析文件占用信息',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!envelope || typeof envelope !== 'object' || (envelope as { ok?: unknown }).ok !== true) {
      const message =
        readErrorMessage(envelope) ?? result.stderr.trim() ?? 'Restart Manager 执行失败';
      throw new BackendException('LOCK_QUERY_FAILED', '查询文件占用失败', message);
    }
    const data = (envelope as { data?: unknown }).data;
    const processes =
      data && typeof data === 'object' ? (data as { processes?: unknown }).processes : undefined;
    if (!Array.isArray(processes))
      throw new BackendException('LOCK_QUERY_FAILED', '文件占用结果格式无效');
    const unique = new Map<number, LockingProcess>();
    for (const item of processes) {
      if (!item || typeof item !== 'object') continue;
      const source = item as Record<string, unknown>;
      const pid =
        typeof source.pid === 'number'
          ? source.pid
          : typeof source.Pid === 'number'
            ? source.Pid
            : undefined;
      const name =
        typeof source.name === 'string'
          ? source.name
          : typeof source.Name === 'string'
            ? source.Name
            : undefined;
      if (pid && pid > 0 && pid !== process.pid)
        unique.set(pid, { pid, name: name || `PID ${pid}` });
    }
    return [...unique.values()];
  }

  /** 通过绝对 taskkill 路径终止已确认的进程树。 */
  async terminate(processes: readonly LockingProcess[]): Promise<void> {
    for (const item of processes) {
      if (!Number.isSafeInteger(item.pid) || item.pid <= 0 || item.pid === process.pid) continue;
      const result = await this.runner.run({
        executable: windowsExecutable('taskkill'),
        args: ['/PID', String(item.pid), '/T', '/F'],
        timeoutMs: 30_000,
      });
      if (
        result.exitCode !== 0 &&
        !/not found|no running instance|找不到|没有运行/i.test(`${result.stdout}\n${result.stderr}`)
      ) {
        throw new BackendException(
          'PROCESS_TERMINATE_FAILED',
          `无法终止占用进程 ${item.name}`,
          result.stderr || result.stdout,
        );
      }
    }
  }
}

/** 将文件占用转换为 UI 可二次确认的 FILE_IN_USE。 */
export async function withFileLockHandling<T>(
  targetPath: string,
  force: boolean,
  locks: FileLockManager,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isBusy(error)) throw error;
    const processes = await locks.find(targetPath);
    if (!force)
      throw new BackendException(
        'FILE_IN_USE',
        'Skill 文件正在被其他进程使用',
        JSON.stringify({ path: targetPath, processes }),
      );
    if (processes.length === 0)
      throw new BackendException(
        'FILE_IN_USE',
        'Skill 文件仍被占用，但未找到可终止的进程',
        targetPath,
      );
    await locks.terminate(processes);
    try {
      return await operation();
    } catch (retryError) {
      if (isBusy(retryError))
        throw new BackendException('FILE_IN_USE', '终止占用进程后仍无法操作 Skill', targetPath);
      throw retryError;
    }
  }
}

/** 判断文件系统异常是否代表占用或权限冲突。 */
function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')
  );
}

/** 从 Restart Manager 错误封包中提取消息。 */
function readErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const error = (value as { error?: unknown }).error;
  return error &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : undefined;
}
