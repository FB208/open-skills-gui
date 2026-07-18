import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import type {
  RestartApplication,
  RestartApplicationResult,
  RestartApplicationsBatchResult,
} from '../shared/types.js';
import { BackendException } from './errors.js';
import type { AsyncMutex } from './mutex.js';
import { isNodeError, windowsExecutable } from './paths.js';
import type { CommandRunner } from './process.js';

interface RestartApplicationFile {
  schemaVersion: 1;
  applications: RestartApplication[];
}

const EMPTY_FILE: RestartApplicationFile = { schemaVersion: 1, applications: [] };
const CLOSE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:OPEN_SKILLS_RESTART_TARGET)
$items = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($_.ExecutablePath), $target)
})
if ($items.Count -eq 0) { exit 10 }
$requested = 0
foreach ($item in $items) {
  try {
    $process = [Diagnostics.Process]::GetProcessById([int]$item.ProcessId)
    if ($process.MainWindowHandle -ne [IntPtr]::Zero -and $process.CloseMainWindow()) { $requested++ }
  } catch { }
}
if ($requested -eq 0) { exit 11 }
$deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
  $remaining = @($items | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
  if ($remaining.Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
exit 12
`;

/** 管理可由用户手动重启的 Windows 桌面应用。 */
export class RestartApplicationsService {
  private readonly backupPath: string;

  constructor(
    private readonly filePath: string,
    private readonly runner: CommandRunner,
    private readonly writes: AsyncMutex,
  ) {
    this.backupPath = `${filePath}.backup`;
  }

  /** 返回按添加时间排序的应用配置。 */
  async list(): Promise<RestartApplication[]> {
    return (await this.load()).applications;
  }

  /** 校验并添加一个本地 EXE，重复路径不会产生第二条记录。 */
  async add(executablePath: string): Promise<RestartApplication> {
    return await this.writes.runExclusive(async () => {
      const canonical = await validateExecutable(executablePath);
      const file = await this.load();
      const duplicate = file.applications.find(
        (item) => item.executablePath.toLowerCase() === canonical.toLowerCase(),
      );
      if (duplicate) return duplicate;
      const application: RestartApplication = {
        id: randomUUID(),
        name: path.basename(canonical, path.extname(canonical)),
        executablePath: canonical,
        createdAt: new Date().toISOString(),
      };
      file.applications.push(application);
      await this.save(file);
      return application;
    });
  }

  /** 删除指定应用配置，不会结束或删除对应程序。 */
  async remove(id: string): Promise<{ removed: boolean }> {
    return await this.writes.runExclusive(async () => {
      const file = await this.load();
      const next = file.applications.filter((item) => item.id !== id);
      if (next.length === file.applications.length) return { removed: false };
      file.applications = next;
      await this.save(file);
      return { removed: true };
    });
  }

  /** 请求指定应用正常退出，确认退出后再从原路径启动。 */
  async restart(id: string): Promise<RestartApplicationResult> {
    return await this.writes.runExclusive(async () => {
      const application = (await this.load()).applications.find((item) => item.id === id);
      if (!application) throw new BackendException('APPLICATION_NOT_FOUND', '应用配置不存在');
      return await this.restartApplication(application);
    });
  }

  /** 依次重启所有已配置且正在运行的应用，未运行项直接跳过。 */
  async restartRunning(): Promise<RestartApplicationsBatchResult> {
    return await this.writes.runExclusive(async () => {
      const applications = (await this.load()).applications;
      const result: RestartApplicationsBatchResult = {
        configured: applications.length,
        restarted: [],
        skipped: [],
        failed: [],
      };
      for (const application of applications) {
        try {
          result.restarted.push(await this.restartApplication(application));
        } catch (error) {
          if (error instanceof BackendException && error.code === 'APPLICATION_NOT_RUNNING') {
            result.skipped.push(application);
            continue;
          }
          result.failed.push({
            application,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result;
    });
  }

  /** 执行单个应用的安全关闭与重新启动，调用方负责持有写入互斥锁。 */
  private async restartApplication(
    application: RestartApplication,
  ): Promise<RestartApplicationResult> {
    await validateExecutable(application.executablePath);
    const encoded = Buffer.from(CLOSE_SCRIPT, 'utf16le').toString('base64');
    const result = await this.runner.run({
      executable: windowsExecutable('powershell'),
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      env: { ...process.env, OPEN_SKILLS_RESTART_TARGET: application.executablePath },
      timeoutMs: 20_000,
    });
    if (result.exitCode === 10)
      throw new BackendException('APPLICATION_NOT_RUNNING', '该应用当前没有运行');
    if (result.exitCode === 11)
      throw new BackendException(
        'APPLICATION_CANNOT_CLOSE',
        '该应用没有可正常关闭的主窗口，请在应用内退出后手动重新打开',
      );
    if (result.exitCode === 12)
      throw new BackendException('APPLICATION_CLOSE_TIMEOUT', '应用未在 12 秒内退出，已取消重启');
    if (result.exitCode !== 0)
      throw new BackendException('APPLICATION_CLOSE_FAILED', '无法关闭应用', result.stderr.trim());

    const child = spawn(application.executablePath, [], {
      cwd: path.dirname(application.executablePath),
      detached: true,
      shell: false,
      windowsHide: false,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) =>
        reject(new BackendException('APPLICATION_START_FAILED', '应用重新启动失败', error.message)),
      );
    });
    child.unref();
    return { application, restarted: true, processId: child.pid };
  }
  /** 读取并严格校验独立的应用配置文件。 */
  private async load(): Promise<RestartApplicationFile> {
    try {
      const file = validateFile(JSON.parse(await readFile(this.filePath, 'utf8')));
      await rm(this.backupPath, { force: true }).catch(() => undefined);
      return file;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        if (error instanceof SyntaxError)
          throw new BackendException('RESTART_APPLICATIONS_CORRUPT', '应用重启配置文件已损坏');
        throw error;
      }
    }
    try {
      const recovered = validateFile(JSON.parse(await readFile(this.backupPath, 'utf8')));
      await rename(this.backupPath, this.filePath);
      return recovered;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return structuredClone(EMPTY_FILE);
      if (error instanceof SyntaxError)
        throw new BackendException('RESTART_APPLICATIONS_CORRUPT', '应用重启配置备份已损坏');
      throw error;
    }
  }

  /** 使用同目录临时文件和备份完成原子替换。 */
  private async save(file: RestartApplicationFile): Promise<void> {
    validateFile(file);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.incoming`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    let movedCurrent = false;
    let installedNew = false;
    try {
      await rm(this.backupPath, { force: true });
      try {
        await rename(this.filePath, this.backupPath);
        movedCurrent = true;
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
      await rename(temporary, this.filePath);
      installedNew = true;
      await rm(this.backupPath, { force: true }).catch(() => undefined);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (movedCurrent && !installedNew)
        await rename(this.backupPath, this.filePath).catch(() => undefined);
      throw new BackendException(
        'RESTART_APPLICATIONS_WRITE_FAILED',
        '保存应用重启配置失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/** 确保路径指向真实存在的 Windows EXE 文件。 */
async function validateExecutable(candidate: string): Promise<string> {
  if (!path.isAbsolute(candidate) || path.extname(candidate).toLowerCase() !== '.exe')
    throw new BackendException('INVALID_EXECUTABLE', '请选择有效的 EXE 程序');
  let canonical: string;
  try {
    canonical = await realpath(candidate);
    if (!(await stat(canonical)).isFile()) throw new Error('不是文件');
  } catch (error) {
    throw new BackendException(
      'INVALID_EXECUTABLE',
      '所选 EXE 不存在或无法访问',
      error instanceof Error ? error.message : String(error),
    );
  }
  return canonical;
}

/** 拒绝未知字段、重复路径和损坏的持久化记录。 */
function validateFile(value: unknown): RestartApplicationFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return corrupt();
  const file = value as Record<string, unknown>;
  if (Object.keys(file).some((key) => !['schemaVersion', 'applications'].includes(key)))
    return corrupt();
  if (file.schemaVersion !== 1 || !Array.isArray(file.applications)) return corrupt();
  const paths = new Set<string>();
  for (const item of file.applications) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return corrupt();
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => !['id', 'name', 'executablePath', 'createdAt'].includes(key),
      ) ||
      typeof record.id !== 'string' ||
      typeof record.name !== 'string' ||
      typeof record.executablePath !== 'string' ||
      !path.isAbsolute(record.executablePath) ||
      path.extname(record.executablePath).toLowerCase() !== '.exe' ||
      typeof record.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(record.createdAt))
    )
      return corrupt();
    const normalized = path.resolve(record.executablePath).toLowerCase();
    if (paths.has(normalized)) return corrupt();
    paths.add(normalized);
  }
  return value as RestartApplicationFile;
}

function corrupt(): never {
  throw new BackendException('RESTART_APPLICATIONS_CORRUPT', '应用重启配置格式无效');
}
