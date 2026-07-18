import path from 'node:path';
import { spawn } from 'node:child_process';
import { BackendException } from './errors.js';
import { windowsExecutable } from './paths.js';
import { redactUserHomePaths } from './redaction.js';

export interface CommandSpec {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  input?: string;
  maxOutputBytes?: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}

/** 仅以绝对可执行路径和参数数组启动外部进程。 */
export class SpawnCommandRunner implements CommandRunner {
  async run(spec: CommandSpec): Promise<CommandResult> {
    if (!path.isAbsolute(spec.executable))
      throw new BackendException('UNSAFE_EXECUTABLE', '外部程序必须使用绝对路径', spec.executable);
    if (spec.cwd && !path.isAbsolute(spec.cwd))
      throw new BackendException('UNSAFE_PATH', '工作目录必须使用绝对路径', spec.cwd);
    const limit = spec.maxOutputBytes ?? 4 * 1024 * 1024;
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(spec.executable, [...(spec.args ?? [])], {
        cwd: spec.cwd,
        env: spec.env,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        spec.signal?.removeEventListener('abort', abort);
      };
      const fail = async (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (child.pid) await terminateTree(child.pid).catch(() => child.kill());
        else child.kill();
        reject(error);
      };
      const append = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > limit) {
          void fail(new BackendException('COMMAND_OUTPUT_LIMIT', '外部程序输出超过安全限制'));
          return;
        }
        target.push(chunk);
      };
      const abort = () => void fail(new BackendException('CANCELLED', '操作已取消'));

      child.once(
        'error',
        (error) =>
          void fail(
            new BackendException('COMMAND_START_FAILED', '无法启动外部程序', error.message, {
              cause: error,
            }),
          ),
      );
      child.stdin.on('error', () => undefined);
      child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      if (spec.input === undefined) child.stdin.end();
      else child.stdin.end(spec.input, 'utf8');

      if (spec.signal?.aborted) abort();
      else {
        spec.signal?.addEventListener('abort', abort, { once: true });
        if (spec.timeoutMs)
          timer = setTimeout(
            () => void fail(new BackendException('COMMAND_TIMEOUT', '外部程序执行超时')),
            spec.timeoutMs,
          );
      }
    });
  }
}

/** 对非零退出码转换为领域错误。 */
export function assertCommandSuccess(result: CommandResult, action: string): void {
  if (result.exitCode !== 0)
    throw new BackendException(
      'COMMAND_FAILED',
      `${action}失败`,
      sanitizeCommandDetails(result.stderr || result.stdout),
    );
}

/** 清理输出中的用户主目录并限制错误长度。 */
export function sanitizeCommandDetails(value: string): string {
  return redactUserHomePaths(value.trim().slice(0, 4000));
}

async function terminateTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  await new Promise<void>((resolve) => {
    const killer = spawn(windowsExecutable('taskkill'), ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}
