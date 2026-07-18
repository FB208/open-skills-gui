import path from 'node:path';
import type { RuntimeComponentStatus, RuntimeStatus } from '../shared/types.js';
import { RUNTIME } from '../shared/constants.js';
import { BackendException } from './errors.js';
import { AsyncMutex } from './mutex.js';
import type { PathLayout } from './paths.js';
import { assertNoLinkedParents, windowsExecutable } from './paths.js';
import type { CommandRunner } from './process.js';
import { assertCommandSuccess } from './process.js';
import type { StateRepository } from './state.js';
import { compareVersions, extractVersion } from './version.js';

export interface RuntimeSelection {
  nodePath: string;
  npxPath: string;
  gitPath: string;
}

/** 检测绑定在同一 Node 安装中的 node 与 npx-cli.js。 */
export class RuntimeService {
  constructor(
    private readonly layout: PathLayout,
    private readonly state: StateRepository,
    private readonly runner: CommandRunner,
    private readonly writes: AsyncMutex = new AsyncMutex(),
  ) {}

  /** 检测私有环境后再检测满足版本要求的系统环境。 */
  async getStatus(): Promise<RuntimeStatus> {
    await assertNoLinkedParents(path.dirname(this.layout.dataRoot), this.layout.runtimeDir);
    const settings = (await this.state.load()).settings;
    const privateNode = path.join(this.layout.runtimeDir, 'node', 'node.exe');
    const privateGit = path.join(this.layout.runtimeDir, 'git', 'cmd', 'git.exe');
    const nodeCandidates = unique([
      settings.selectedNodePath,
      privateNode,
      ...(await this.where('node.exe')),
    ]);
    const pair = await this.detectNodePair(nodeCandidates, privateNode);
    const git = await this.detectExecutable(
      unique([settings.selectedGitPath, privateGit, ...(await this.where('git.exe'))]),
      ['--version'],
      RUNTIME.minGitVersion,
      privateGit,
    );
    const node: RuntimeComponentStatus = pair
      ? { available: true, path: pair.nodePath, version: pair.nodeVersion, source: pair.source }
      : { available: false, reason: `需要 Node.js ${RUNTIME.minNodeVersion} 或更高版本` };
    const npx: RuntimeComponentStatus = pair
      ? { available: true, path: pair.npxPath, version: pair.npxVersion, source: pair.source }
      : { available: false, reason: '未找到与 Node.js 同目录的 npx-cli.js' };
    return { ready: node.available && npx.available && git.available, node, npx, git };
  }

  /** 调用固定清单脚本安装并登记私有运行环境。 */
  async install(): Promise<RuntimeStatus> {
    return await this.writes.runExclusive(async () => {
      const dataParent = path.dirname(this.layout.dataRoot);
      await assertNoLinkedParents(dataParent, this.layout.runtimeDir);
      await assertNoLinkedParents(dataParent, this.layout.updatesDir);
      const script = path.join(this.layout.appRoot, 'scripts', 'runtime-bootstrap.ps1');
      const result = await this.runner.run({
        executable: windowsExecutable('powershell'),
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-Action',
          'Install',
          '-DataRoot',
          this.layout.dataRoot,
        ],
        timeoutMs: 10 * 60_000,
      });
      assertCommandSuccess(result, '安装运行环境');
      const status = await this.getStatus();
      if (!status.ready || !status.node.path || !status.npx.path || !status.git.path) {
        throw new BackendException('RUNTIME_INSTALL_FAILED', '运行环境安装后仍不可用');
      }
      await this.state.update((appState) => {
        appState.settings.selectedNodePath = status.node.path;
        appState.settings.selectedNpxPath = status.npx.path;
        appState.settings.selectedGitPath = status.git.path;
        appState.settings.onboardingCompleted = true;
      });
      return status;
    });
  }

  /** 返回可直接执行的 Node、npx 脚本和 Git 绝对路径。 */
  async requireSelection(): Promise<RuntimeSelection> {
    const status = await this.getStatus();
    if (!status.ready || !status.node.path || !status.npx.path || !status.git.path) {
      throw new BackendException('RUNTIME_NOT_READY', '请先安装或配置运行环境');
    }
    return { nodePath: status.node.path, npxPath: status.npx.path, gitPath: status.git.path };
  }

  /** 在候选 Node 中寻找版本合格且同目录含 npx-cli.js 的组合。 */
  private async detectNodePair(
    candidates: string[],
    privateNode: string,
  ): Promise<
    | {
        nodePath: string;
        npxPath: string;
        nodeVersion: string;
        npxVersion: string;
        source: 'private' | 'system';
      }
    | undefined
  > {
    for (const nodePath of candidates) {
      const npxPath = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
      try {
        const nodeResult = await this.runner.run({
          executable: nodePath,
          args: ['--version'],
          timeoutMs: 15_000,
        });
        const nodeVersion = extractVersion(`${nodeResult.stdout}\n${nodeResult.stderr}`);
        if (
          nodeResult.exitCode !== 0 ||
          !nodeVersion ||
          compareVersions(nodeVersion, RUNTIME.minNodeVersion) < 0
        )
          continue;
        const npxResult = await this.runner.run({
          executable: nodePath,
          args: [npxPath, '--version'],
          timeoutMs: 15_000,
        });
        const npxVersion = extractVersion(`${npxResult.stdout}\n${npxResult.stderr}`);
        if (npxResult.exitCode !== 0 || !npxVersion) continue;
        return {
          nodePath,
          npxPath,
          nodeVersion,
          npxVersion,
          source: samePath(nodePath, privateNode) ? 'private' : 'system',
        };
      } catch {
        // 继续检测下一组 Node 与 npx。
      }
    }
    return undefined;
  }

  /** 检测普通可执行文件的版本与来源。 */
  private async detectExecutable(
    candidates: string[],
    args: string[],
    minimum: string,
    privatePath: string,
  ): Promise<RuntimeComponentStatus> {
    for (const candidate of candidates) {
      try {
        const result = await this.runner.run({ executable: candidate, args, timeoutMs: 15_000 });
        const version = extractVersion(`${result.stdout}\n${result.stderr}`);
        if (result.exitCode === 0 && version && compareVersions(version, minimum) >= 0) {
          return {
            available: true,
            path: candidate,
            version,
            source: samePath(candidate, privatePath) ? 'private' : 'system',
          };
        }
      } catch {
        // 继续检测下一候选路径。
      }
    }
    return { available: false, reason: `需要 Git ${minimum} 或更高版本` };
  }

  /** 用绝对 where.exe 路径查找系统候选。 */
  private async where(name: string): Promise<string[]> {
    try {
      const result = await this.runner.run({
        executable: windowsExecutable('where'),
        args: [name],
        timeoutMs: 5_000,
      });
      return result.exitCode === 0
        ? result.stdout
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(path.isAbsolute)
        : [];
    } catch {
      return [];
    }
  }
}

/** 解析并按 Windows 路径语义去重候选项。 */
function unique(values: Array<string | undefined>): string[] {
  const normalized = values
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
  return [...new Map(normalized.map((value) => [value.toLowerCase(), value])).values()];
}

/** 比较两个 Windows 路径是否等价。 */
function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
