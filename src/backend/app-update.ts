import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, mkdir, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { gt, prerelease, valid } from 'semver';
import type { AppUpdateInfo } from '../shared/types.js';
import { APP } from '../shared/constants.js';
import { BackendException } from './errors.js';
import type { PathLayout } from './paths.js';
import { assertNoLinkedParents, assertWithin, inspectPath } from './paths.js';

const RELEASE_API_URL = 'https://api.github.com/repos/FB208/open-skills-gui/releases/latest';
const RELEASE_DOWNLOAD_PREFIX = '/FB208/open-skills-gui/releases/download/';
const INSTALLER_ASSET_NAME = 'OpenSkillsGUI-Setup-x64.exe';
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const DEFAULT_TIMEOUTS: AppUpdateTimeouts = {
  releaseRequestMs: 30_000,
  installerRequestMs: 15 * 60_000,
  streamIdleMs: 30_000,
};
const DEFAULT_POWERSHELL_PATH = path.win32.join(
  resolveWindowsRoot(),
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

interface GitHubAsset {
  name?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  body?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

interface TrustedRelease {
  info: AppUpdateInfo;
  version: string;
  downloadUrl: string;
  digestHex: string;
}

export interface AppUpdateProgress {
  stage: 'downloading' | 'verifying' | 'launching';
  current?: number;
  total?: number;
  message: string;
}

export type AppUpdateProgressReporter = (progress: AppUpdateProgress) => void | Promise<void>;

export interface AppUpdateTimeouts {
  releaseRequestMs: number;
  installerRequestMs: number;
  streamIdleMs: number;
}

export interface UpdateLauncher {
  launch(helperPath: string, args: readonly string[]): Promise<void>;
}

export type UpdateProcessSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

/** 用绝对 PowerShell 路径脱离当前扩展进程启动升级脚本。 */
export class DetachedUpdateLauncher implements UpdateLauncher {
  constructor(
    private readonly spawnImpl: UpdateProcessSpawner = spawn as UpdateProcessSpawner,
    private readonly powershellPath: string = DEFAULT_POWERSHELL_PATH,
  ) {}

  /** 等到子进程确实创建后再报告启动成功。 */
  async launch(helperPath: string, args: readonly string[]): Promise<void> {
    if (!path.win32.isAbsolute(this.powershellPath)) {
      throw new BackendException(
        'APP_UPDATE_LAUNCH_FAILED',
        '启动软件更新失败',
        'Windows PowerShell 路径不是绝对路径',
      );
    }

    let child: ChildProcess;
    try {
      child = this.spawnImpl(
        this.powershellPath,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          helperPath,
          ...args,
        ],
        {
          detached: true,
          windowsHide: true,
          shell: false,
          stdio: 'ignore',
        },
      );
    } catch (error) {
      throw launchError(error);
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn);
        reject(launchError(error));
      };
      const onSpawn = (): void => {
        try {
          child.unref();
          resolve();
        } catch (error) {
          reject(launchError(error));
        }
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
  }
}

/** 检查正式 GitHub Release，并从本次可信检查结果安装更新。 */
export class AppUpdateService {
  private trustedRelease?: TrustedRelease;
  private checkGeneration = 0;
  private installing = false;
  private activeProgressReporter?: AppUpdateProgressReporter;
  private readonly timeouts: AppUpdateTimeouts;

  constructor(
    private readonly layout: PathLayout,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly launcher: UpdateLauncher = new DetachedUpdateLauncher(),
    private readonly progressReporter: AppUpdateProgressReporter = () => undefined,
    timeouts: Partial<AppUpdateTimeouts> = {},
  ) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    if (!Object.values(this.timeouts).every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new BackendException('APP_UPDATE_CONFIGURATION_INVALID', '软件更新超时配置无效');
    }
  }

  /** 获取并缓存最新正式版本；任何新检查都会使旧缓存失效。 */
  async check(): Promise<AppUpdateInfo> {
    const generation = ++this.checkGeneration;
    this.trustedRelease = undefined;
    const response = await this.fetchRelease();
    const release = await this.readRelease(response);
    const currentVersion = parseCurrentVersion();
    const latestVersion = parseFormalReleaseVersion(release);

    if (!gt(latestVersion, currentVersion)) {
      return { available: false, currentVersion, latestVersion };
    }

    const parsed = parseTrustedRelease(release, currentVersion, latestVersion);
    if (generation === this.checkGeneration) this.trustedRelease = parsed;
    return { ...parsed.info };
  }

  /** 流式下载并校验缓存中的安装包，然后启动仓库内置升级脚本。 */
  async install(
    update: AppUpdateInfo,
    progressReporter?: AppUpdateProgressReporter,
  ): Promise<{ started: boolean }> {
    await assertNoLinkedParents(path.dirname(this.layout.dataRoot), this.layout.updatesDir);
    if (this.installing) {
      throw new BackendException('APP_UPDATE_IN_PROGRESS', '软件更新正在处理中，请勿重复操作');
    }

    const trusted = this.requireTrustedRelease(update);
    if (!gt(trusted.version, parseCurrentVersion())) {
      throw new BackendException(
        'APP_UPDATE_DOWNGRADE_BLOCKED',
        '拒绝安装当前版本或更旧的软件版本',
      );
    }

    this.installing = true;
    this.activeProgressReporter = progressReporter;
    try {
      const helperPath = await this.requireUpdateHelper();
      const installerPath = await this.downloadInstaller(trusted);
      await this.report({ stage: 'launching', message: '正在启动软件更新程序' });
      await this.launcher.launch(helperPath, [
        '-InstallerPath',
        installerPath,
        '-ExpectedSha256',
        trusted.digestHex,
        '-ParentProcessId',
        String(process.ppid),
      ]);
      if (this.trustedRelease === trusted) this.trustedRelease = undefined;
      return { started: true };
    } catch (error) {
      if (error instanceof BackendException) throw error;
      throw new BackendException(
        'APP_UPDATE_INSTALL_FAILED',
        '安装软件更新失败',
        errorDetails(error),
        { cause: error },
      );
    } finally {
      this.activeProgressReporter = undefined;
      this.installing = false;
    }
  }

  /** 请求固定仓库的最新 Release。 */
  private async fetchRelease(): Promise<Response> {
    let response: Response;
    try {
      const controller = new AbortController();
      response = await withTimeout(
        this.fetchImpl(RELEASE_API_URL, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': `${APP.name}/${APP.version}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          redirect: 'follow',
          signal: controller.signal,
        }),
        this.timeouts.releaseRequestMs,
        () => controller.abort(),
        () => new BackendException('APP_UPDATE_CHECK_TIMEOUT', '检查软件更新超时'),
      );
    } catch (error) {
      if (error instanceof BackendException) throw error;
      throw new BackendException(
        'APP_UPDATE_CHECK_FAILED',
        '检查软件更新失败',
        errorDetails(error),
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new BackendException(
        'APP_UPDATE_CHECK_FAILED',
        '检查软件更新失败',
        `GitHub 返回 HTTP ${response.status}`,
      );
    }
    return response;
  }

  /** 读取 GitHub JSON，并把解析错误转换为稳定中文错误。 */
  private async readRelease(response: Response): Promise<GitHubRelease> {
    try {
      const value: unknown = await withTimeout(
        response.json(),
        this.timeouts.releaseRequestMs,
        undefined,
        () => new BackendException('APP_UPDATE_CHECK_TIMEOUT', '读取软件更新信息超时'),
      );
      if (!isRecord(value)) throw new Error('Release 响应不是对象');
      return value;
    } catch (error) {
      if (error instanceof BackendException) throw error;
      throw new BackendException(
        'APP_UPDATE_INVALID_RELEASE',
        'GitHub Release 数据无效',
        errorDetails(error),
        { cause: error },
      );
    }
  }

  /** 仅接受与当前实例可信缓存完全一致的安装确认。 */
  private requireTrustedRelease(update: AppUpdateInfo): TrustedRelease {
    const trusted = this.trustedRelease;
    if (!trusted) {
      throw new BackendException('APP_UPDATE_NOT_CHECKED', '软件更新信息已失效，请重新检查更新');
    }
    if (!matchesCachedUpdate(update, trusted.info)) {
      throw new BackendException(
        'APP_UPDATE_STALE',
        '软件更新信息与本次检查结果不一致，请重新检查更新',
      );
    }
    return trusted;
  }

  /** 确认只调用随应用发布的既有升级脚本。 */
  private async requireUpdateHelper(): Promise<string> {
    const helperPath = path.resolve(this.layout.appRoot, 'scripts', 'software-update.ps1');
    assertWithin(this.layout.appRoot, helperPath);
    try {
      const appRootKind = await inspectPath(this.layout.appRoot);
      if (!appRootKind.exists || appRootKind.link || !appRootKind.directory)
        throw new Error('应用目录是重解析点或不是目录');
      await assertNoLinkedParents(this.layout.appRoot, path.dirname(helperPath));
      const helperStat = await lstat(helperPath);
      if (helperStat.isSymbolicLink() || !helperStat.isFile())
        throw new Error('升级脚本是重解析点或不是普通文件');
    } catch (error) {
      throw new BackendException('APP_UPDATE_HELPER_MISSING', '找不到软件更新脚本', helperPath, {
        cause: error,
      });
    }
    return helperPath;
  }

  /** 下载到同目录临时文件，摘要通过后再原子改名。 */
  private async downloadInstaller(trusted: TrustedRelease): Promise<string> {
    await this.report({ stage: 'downloading', current: 0, message: '正在下载安装包' });
    const response = await this.fetchInstaller(trusted.downloadUrl);
    const announcedSize = parseContentLength(response.headers.get('content-length'));
    if (announcedSize !== undefined && announcedSize > MAX_INSTALLER_BYTES) {
      throw new BackendException('APP_UPDATE_TOO_LARGE', '软件更新安装包超过允许的大小上限');
    }
    if (!response.body) {
      throw new BackendException(
        'APP_UPDATE_DOWNLOAD_FAILED',
        '下载安装包失败',
        '下载响应没有可读取的数据流',
      );
    }

    await mkdir(this.layout.updatesDir, { recursive: true }).catch((error: unknown) => {
      throw new BackendException(
        'APP_UPDATE_DOWNLOAD_FAILED',
        '无法创建软件更新目录',
        errorDetails(error),
        { cause: error },
      );
    });
    const installerPath = path.join(this.layout.updatesDir, INSTALLER_ASSET_NAME);
    const temporaryPath = path.join(
      this.layout.updatesDir,
      `.${INSTALLER_ASSET_NAME}.${randomUUID()}.tmp`,
    );
    assertWithin(this.layout.updatesDir, installerPath);
    assertWithin(this.layout.updatesDir, temporaryPath);

    try {
      const actualDigest = await this.streamToFile(response, temporaryPath, announcedSize);
      await this.report({
        stage: 'verifying',
        current: announcedSize,
        total: announcedSize,
        message: '正在校验安装包',
      });
      if (actualDigest !== trusted.digestHex) {
        throw new BackendException(
          'APP_UPDATE_DIGEST_MISMATCH',
          '软件更新安装包的 SHA-256 校验失败',
          `期望 ${trusted.digestHex}，实际 ${actualDigest}`,
        );
      }
      await rm(installerPath, { force: true });
      await rename(temporaryPath, installerPath);
      return installerPath;
    } catch (error) {
      if (error instanceof BackendException) throw error;
      throw new BackendException(
        'APP_UPDATE_DOWNLOAD_FAILED',
        '下载安装包失败',
        errorDetails(error),
        { cause: error },
      );
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  /** 请求缓存中经过校验的 GitHub 安装包地址。 */
  private async fetchInstaller(downloadUrl: string): Promise<Response> {
    let response: Response;
    try {
      const controller = new AbortController();
      response = await withTimeout(
        this.fetchImpl(downloadUrl, {
          headers: { 'User-Agent': `${APP.name}/${APP.version}` },
          redirect: 'follow',
          signal: controller.signal,
        }),
        this.timeouts.installerRequestMs,
        () => controller.abort(),
        () => new BackendException('APP_UPDATE_DOWNLOAD_TIMEOUT', '下载安装包超时'),
      );
    } catch (error) {
      if (error instanceof BackendException) throw error;
      throw new BackendException(
        'APP_UPDATE_DOWNLOAD_FAILED',
        '下载安装包失败',
        errorDetails(error),
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new BackendException(
        'APP_UPDATE_DOWNLOAD_FAILED',
        '下载安装包失败',
        `GitHub 返回 HTTP ${response.status}`,
      );
    }
    return response;
  }

  /** 逐块限制大小、累计 SHA-256 并写入临时文件。 */
  private async streamToFile(
    response: Response,
    temporaryPath: string,
    announcedSize?: number,
  ): Promise<string> {
    const body = response.body;
    if (!body)
      throw new BackendException(
        'APP_UPDATE_DOWNLOAD_FAILED',
        '下载安装包失败',
        '下载响应没有数据流',
      );
    const reader = body.getReader();
    const file = await open(temporaryPath, 'wx');
    const hash = createHash('sha256');
    let received = 0;

    try {
      while (true) {
        const chunk = await withTimeout(
          reader.read(),
          this.timeouts.streamIdleMs,
          () => void reader.cancel().catch(() => undefined),
          () =>
            new BackendException(
              'APP_UPDATE_DOWNLOAD_TIMEOUT',
              '下载安装包超时',
              '数据流长时间没有返回内容',
            ),
        );
        if (chunk.done) break;
        if (chunk.value.byteLength === 0) continue;
        received += chunk.value.byteLength;
        if (received > MAX_INSTALLER_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new BackendException('APP_UPDATE_TOO_LARGE', '软件更新安装包超过允许的大小上限');
        }
        hash.update(chunk.value);
        await writeFully(file, chunk.value);
        await this.report({
          stage: 'downloading',
          current: received,
          total: announcedSize,
          message: '正在下载安装包',
        });
      }
      if (received === 0) {
        throw new BackendException(
          'APP_UPDATE_DOWNLOAD_FAILED',
          '下载安装包失败',
          '下载到的安装包为空',
        );
      }
      if (announcedSize !== undefined && received !== announcedSize) {
        throw new BackendException(
          'APP_UPDATE_DOWNLOAD_FAILED',
          '下载安装包失败',
          `响应声明 ${announcedSize} 字节，实际收到 ${received} 字节`,
        );
      }
      await file.sync();
      return hash.digest('hex');
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // 超时取消时可能仍有一个待读取操作，锁会在取消完成后释放。
      }
      await file.close();
    }
  }

  /** 上报进度；展示层异常不得破坏更新事务。 */
  private async report(progress: AppUpdateProgress): Promise<void> {
    try {
      await (this.activeProgressReporter ?? this.progressReporter)(progress);
    } catch {
      // 进度通知不是安全流程的一部分，失败时继续执行更新。
    }
  }
}

/** 为网络与流读取施加硬超时，并在超时时执行取消动作。 */
async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: (() => void) | undefined,
  timeoutError: () => BackendException,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError());
      try {
        onTimeout?.();
      } catch {
        // 超时结果已经固定，取消动作异常不覆盖领域超时错误。
      }
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 从 GitHub 正式 Release 提取可缓存的可信更新。 */
function parseTrustedRelease(
  release: GitHubRelease,
  currentVersion: string,
  version: string,
): TrustedRelease {
  if (!Array.isArray(release.assets)) {
    throw new BackendException('APP_UPDATE_INVALID_RELEASE', 'GitHub Release 缺少安装包列表');
  }
  const assets = release.assets.filter(
    (asset): asset is GitHubAsset => isRecord(asset) && asset.name === INSTALLER_ASSET_NAME,
  );
  if (assets.length !== 1) {
    throw new BackendException(
      'APP_UPDATE_INVALID_RELEASE',
      `GitHub Release 必须且只能包含一个 ${INSTALLER_ASSET_NAME}`,
    );
  }
  const asset = assets[0];
  if (typeof asset.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
    throw new BackendException(
      'APP_UPDATE_INVALID_RELEASE',
      'GitHub Release 未提供有效的 SHA-256 摘要',
    );
  }
  if (typeof asset.browser_download_url !== 'string') {
    throw new BackendException(
      'APP_UPDATE_INVALID_RELEASE',
      'GitHub Release 未提供有效的安装包下载地址',
    );
  }
  assertOfficialDownloadUrl(asset.browser_download_url, release.tag_name as string);

  const digest = asset.digest.toLowerCase();
  const info: AppUpdateInfo = {
    available: true,
    currentVersion,
    latestVersion: version,
    releaseNotes: typeof release.body === 'string' ? release.body : '',
    publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined,
    downloadUrl: asset.browser_download_url,
    digest,
  };
  return {
    info,
    version,
    downloadUrl: asset.browser_download_url,
    digestHex: digest.slice('sha256:'.length),
  };
}

/** 校验正式 Release 标志并解析严格稳定版版本号。 */
function parseFormalReleaseVersion(release: GitHubRelease): string {
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.tag_name !== 'string'
  ) {
    throw new BackendException('APP_UPDATE_INVALID_RELEASE', 'GitHub 返回的不是有效正式 Release');
  }
  const version = parseStableVersion(release.tag_name);
  if (!version) {
    throw new BackendException(
      'APP_UPDATE_INVALID_RELEASE',
      'GitHub Release 版本号不是严格的稳定版 SemVer',
    );
  }
  return version;
}

/** 解析应用自身的严格稳定版 SemVer。 */
function parseCurrentVersion(): string {
  const version = parseStableVersion(APP.version, false);
  if (!version) {
    throw new BackendException(
      'APP_UPDATE_CONFIGURATION_INVALID',
      '当前软件版本号不是严格的稳定版 SemVer',
    );
  }
  return version;
}

/** 只接受严格 SemVer，Release 标签可带一个小写 v 前缀。 */
function parseStableVersion(value: string, allowV = true): string | undefined {
  const candidate = allowV && value.startsWith('v') ? value.slice(1) : value;
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      candidate,
    )
  ) {
    return undefined;
  }
  const normalized = valid(candidate);
  if (!normalized || normalized !== candidate || prerelease(normalized) !== null) return undefined;
  return normalized;
}

/** 将下载地址限制为固定仓库、固定标签与固定安装包。 */
function assertOfficialDownloadUrl(rawUrl: string, tagName: string): void {
  try {
    const url = new URL(rawUrl);
    const remainder = url.pathname.startsWith(RELEASE_DOWNLOAD_PREFIX)
      ? url.pathname.slice(RELEASE_DOWNLOAD_PREFIX.length)
      : '';
    const segments = remainder.split('/');
    const tag = segments.length === 2 ? decodeURIComponent(segments[0]) : '';
    const asset = segments.length === 2 ? decodeURIComponent(segments[1]) : '';
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      tag !== tagName ||
      asset !== INSTALLER_ASSET_NAME
    ) {
      throw new Error('地址与固定仓库发布规则不一致');
    }
  } catch (error) {
    throw new BackendException(
      'APP_UPDATE_INVALID_RELEASE',
      'GitHub Release 安装包下载地址无效',
      errorDetails(error),
      {
        cause: error,
      },
    );
  }
}

/** 确认前端回传内容仍对应缓存中的同一次检查。 */
function matchesCachedUpdate(update: AppUpdateInfo, cached: AppUpdateInfo): boolean {
  if (!isRecord(update)) return false;
  return (
    update.available === true &&
    update.currentVersion === cached.currentVersion &&
    update.latestVersion === cached.latestVersion &&
    update.releaseNotes === cached.releaseNotes &&
    update.publishedAt === cached.publishedAt &&
    update.downloadUrl === cached.downloadUrl &&
    update.digest === cached.digest
  );
}

/** 严格读取可选 Content-Length。 */
function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  if (!/^(0|[1-9]\d*)$/.test(normalized)) {
    throw new BackendException(
      'APP_UPDATE_DOWNLOAD_FAILED',
      '下载安装包失败',
      '响应中的 Content-Length 无效',
    );
  }
  const size = Number(normalized);
  if (!Number.isSafeInteger(size)) {
    throw new BackendException(
      'APP_UPDATE_DOWNLOAD_FAILED',
      '下载安装包失败',
      '响应中的 Content-Length 超出安全范围',
    );
  }
  return size;
}

/** 处理文件句柄可能出现的短写。 */
async function writeFully(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten <= 0) throw new Error('写入安装包时未产生有效数据');
    offset += result.bytesWritten;
  }
}

/** 取得可信的绝对 Windows 根目录。 */
function resolveWindowsRoot(): string {
  const configured = process.env.SystemRoot?.trim();
  return configured && path.win32.isAbsolute(configured) ? configured : String.raw`C:\Windows`;
}

/** 构造统一的启动失败错误。 */
function launchError(error: unknown): BackendException {
  return new BackendException('APP_UPDATE_LAUNCH_FAILED', '启动软件更新失败', errorDetails(error), {
    cause: error,
  });
}

/** 提取异常的安全诊断文本。 */
function errorDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 判断未知 JSON 是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
