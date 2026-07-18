import path from 'node:path';
import { appendFile, lstat, mkdir, truncate } from 'node:fs/promises';
import { BackendException } from './errors.js';
import { AsyncMutex } from './mutex.js';
import { isNodeError } from './paths.js';
import { redactUserHomePaths } from './redaction.js';

/** 仅写本地文件，并隐藏用户主目录和常见令牌字段。 */
export class LocalLogger {
  private readonly filePath: string;

  constructor(
    logsDir: string,
    private readonly mutex: AsyncMutex = new AsyncMutex(),
  ) {
    this.filePath = path.join(logsDir, 'backend.log');
  }

  async info(message: string, details?: unknown): Promise<void> {
    await this.write('INFO', message, details);
  }

  async error(message: string, details?: unknown): Promise<void> {
    await this.write('ERROR', message, details);
  }

  private async write(level: 'INFO' | 'ERROR', message: string, details?: unknown): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      try {
        const info = await lstat(this.filePath);
        if (info.isSymbolicLink() || !info.isFile())
          throw new BackendException(
            'UNSAFE_LOG_PATH',
            '日志文件已被重解析点或非文件对象替换',
            this.filePath,
          );
        if (info.size > 2 * 1024 * 1024) await truncate(this.filePath, 0);
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
      const suffix = details === undefined ? '' : ` ${redact(safeStringify(details))}`;
      await appendFile(
        this.filePath,
        `${new Date().toISOString()} ${level} ${redact(message)}${suffix}\n`,
        'utf8',
      );
    });
  }
}

function redact(value: string): string {
  return redactUserHomePaths(value)
    .replace(/("?(?:token|accessToken|nlToken|nlConnectToken)"?\s*[:=]\s*")([^"]+)(")/gi, '$1***$3')
    .slice(0, 8000);
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
