import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateInfo } from '../../src/shared/types.js';
import type { PathLayout } from '../../src/backend/paths.js';
import {
  AppUpdateService,
  DetachedUpdateLauncher,
  type AppUpdateProgress,
  type UpdateLauncher,
  type UpdateProcessSpawner,
} from '../../src/backend/app-update.js';

const DOWNLOAD_URL =
  'https://github.com/FB208/open-skills-gui/releases/download/v1.2.0/OpenSkillsGUI-Setup-x64.exe';
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe('AppUpdateService.check', () => {
  it('只请求固定仓库并缓存带摘要的正式新版', async () => {
    const fixture = await createFixture();
    const digest = `sha256:${'a'.repeat(64)}`;
    const fetchMock = createFetchMock([jsonResponse(releasePayload({ digest }))]);
    const service = new AppUpdateService(fixture.layout, fetchMock.fetchImpl);

    const result = await service.check();

    expect(result).toEqual({
      available: true,
      currentVersion: '1.0.0',
      latestVersion: '1.2.0',
      releaseNotes: '正式版说明',
      publishedAt: '2026-07-18T00:00:00Z',
      downloadUrl: DOWNLOAD_URL,
      digest,
    });
    expect(fetchMock.mock).toHaveBeenCalledWith(
      'https://api.github.com/repos/FB208/open-skills-gui/releases/latest',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
        redirect: 'follow',
      }),
    );
  });

  it.each([
    ['缺少正式版标记', { tag_name: 'v1.2.0', assets: [] }],
    ['草稿', releasePayload({ draft: true })],
    ['预发布', releasePayload({ prerelease: true })],
    ['缺少补丁号', releasePayload({ tag_name: 'v1.2' })],
    ['前导零版本', releasePayload({ tag_name: 'v01.2.0' })],
    ['SemVer 预发布版本', releasePayload({ tag_name: 'v1.2.0-beta.1' })],
    ['大写 V 前缀', releasePayload({ tag_name: 'V1.2.0' })],
  ])('拒绝%s', async (_name, payload) => {
    const fixture = await createFixture();
    const fetchMock = createFetchMock([jsonResponse(payload)]);
    const service = new AppUpdateService(fixture.layout, fetchMock.fetchImpl);

    await expect(service.check()).rejects.toMatchObject({
      code: 'APP_UPDATE_INVALID_RELEASE',
      message: expect.stringMatching(/[\u4e00-\u9fff]/),
    });
  });

  it.each(['v1.0.0', 'v0.9.9'])('相同或更旧版本 %s 不会成为可安装缓存', async (tagName) => {
    const fixture = await createFixture();
    const fetchMock = createFetchMock([
      jsonResponse(releasePayload({ tag_name: tagName, assets: [] })),
    ]);
    const launcher = createLauncher();
    const service = new AppUpdateService(fixture.layout, fetchMock.fetchImpl, launcher.value);

    const result = await service.check();

    expect(result.available).toBe(false);
    expect(result.latestVersion).toBe(tagName.slice(1));
    await expect(service.install(result)).rejects.toMatchObject({ code: 'APP_UPDATE_NOT_CHECKED' });
    expect(launcher.mock).not.toHaveBeenCalled();
  });

  it.each([
    ['缺少摘要', releasePayload({ digest: undefined })],
    ['摘要算法错误', releasePayload({ digest: `sha512:${'a'.repeat(64)}` })],
    [
      '错误仓库地址',
      releasePayload({
        browser_download_url:
          'https://github.com/other/open-skills-gui/releases/download/v1.2.0/OpenSkillsGUI-Setup-x64.exe',
      }),
    ],
    [
      '错误安装包名称',
      releasePayload({
        name: 'OpenSkillsGUI-portable.exe',
        browser_download_url:
          'https://github.com/FB208/open-skills-gui/releases/download/v1.2.0/OpenSkillsGUI-portable.exe',
      }),
    ],
  ])('拒绝%s', async (_name, payload) => {
    const fixture = await createFixture();
    const fetchMock = createFetchMock([jsonResponse(payload)]);
    const service = new AppUpdateService(fixture.layout, fetchMock.fetchImpl);

    await expect(service.check()).rejects.toMatchObject({ code: 'APP_UPDATE_INVALID_RELEASE' });
  });

  it('HTTP 与 JSON 错误均转换为中文领域错误', async () => {
    const fixture = await createFixture();
    const httpFetch = createFetchMock([new Response('', { status: 503 })]);
    const jsonFetch = createFetchMock([new Response('{', { status: 200 })]);

    await expect(
      new AppUpdateService(fixture.layout, httpFetch.fetchImpl).check(),
    ).rejects.toMatchObject({
      code: 'APP_UPDATE_CHECK_FAILED',
      message: '检查软件更新失败',
    });
    await expect(
      new AppUpdateService(fixture.layout, jsonFetch.fetchImpl).check(),
    ).rejects.toMatchObject({
      code: 'APP_UPDATE_INVALID_RELEASE',
      message: 'GitHub Release 数据无效',
    });
  });
  it('Release 请求超过硬超时后中止并返回明确错误', async () => {
    const fixture = await createFixture();
    const hangingFetch = vi.fn(async () => await new Promise<Response>(() => undefined));
    const service = new AppUpdateService(
      fixture.layout,
      hangingFetch as unknown as typeof fetch,
      undefined,
      undefined,
      { releaseRequestMs: 20 },
    );

    await expect(service.check()).rejects.toMatchObject({ code: 'APP_UPDATE_CHECK_TIMEOUT' });
  });
});

describe('AppUpdateService.install', () => {
  it('没有本实例检查缓存时拒绝安装，不访问网络', async () => {
    const fixture = await createFixture();
    const fetchMock = createFetchMock([]);
    const service = new AppUpdateService(fixture.layout, fetchMock.fetchImpl);

    await expect(service.install(untrustedUpdate())).rejects.toMatchObject({
      code: 'APP_UPDATE_NOT_CHECKED',
    });
    expect(fetchMock.mock).not.toHaveBeenCalled();
  });

  it('拒绝任何被篡改的前端回传字段', async () => {
    const fixture = await createFixture();
    const digest = `sha256:${'b'.repeat(64)}`;
    const fetchMock = createFetchMock([jsonResponse(releasePayload({ digest }))]);
    const launcher = createLauncher();
    const service = new AppUpdateService(fixture.layout, fetchMock.fetchImpl, launcher.value);
    const checked = await service.check();

    await expect(
      service.install({ ...checked, digest: `sha256:${'c'.repeat(64)}` }),
    ).rejects.toMatchObject({
      code: 'APP_UPDATE_STALE',
    });
    expect(fetchMock.mock).toHaveBeenCalledTimes(1);
    expect(launcher.mock).not.toHaveBeenCalled();
  });

  it('流式下载、增量上报、校验后原子落盘并调用既有脚本', async () => {
    const fixture = await createFixture(true);
    const chunks = [Buffer.from('OpenSkillsGUI-'), Buffer.from('installer-content')];
    const bytes = Buffer.concat(chunks);
    const digestHex = sha256(bytes);
    const fetchMock = createFetchMock([
      jsonResponse(releasePayload({ digest: `sha256:${digestHex}` })),
      streamResponse(chunks, { 'content-length': String(bytes.byteLength) }),
    ]);
    const launcher = createLauncher();
    const progress: AppUpdateProgress[] = [];
    const service = new AppUpdateService(
      fixture.layout,
      fetchMock.fetchImpl,
      launcher.value,
      (event) => {
        progress.push(event);
      },
    );
    const checked = await service.check();

    await expect(service.install(checked)).resolves.toEqual({ started: true });

    const installerPath = path.join(fixture.layout.updatesDir, 'OpenSkillsGUI-Setup-x64.exe');
    await expect(readFile(installerPath)).resolves.toEqual(bytes);
    expect(
      (await readdir(fixture.layout.updatesDir)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
    expect(fetchMock.mock).toHaveBeenNthCalledWith(
      2,
      DOWNLOAD_URL,
      expect.objectContaining({ redirect: 'follow' }),
    );
    expect(launcher.mock).toHaveBeenCalledWith(
      path.join(fixture.root, 'scripts', 'software-update.ps1'),
      [
        '-InstallerPath',
        installerPath,
        '-ExpectedSha256',
        digestHex,
        '-ParentProcessId',
        String(process.ppid),
      ],
    );
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'downloading',
          current: chunks[0].byteLength,
          total: bytes.byteLength,
        }),
        expect.objectContaining({
          stage: 'downloading',
          current: bytes.byteLength,
          total: bytes.byteLength,
        }),
        expect.objectContaining({ stage: 'verifying' }),
        expect.objectContaining({ stage: 'launching' }),
      ]),
    );
  });

  it('摘要不一致时清理临时文件且不启动脚本', async () => {
    const fixture = await createFixture(true);
    const bytes = Buffer.from('tampered installer');
    const fetchMock = createFetchMock([
      jsonResponse(releasePayload({ digest: `sha256:${'d'.repeat(64)}` })),
      streamResponse([bytes], { 'content-length': String(bytes.byteLength) }),
    ]);
    const launcher = createLauncher();
    const service = new AppUpdateService(fixture.layout, fetchMock.fetchImpl, launcher.value);
    const checked = await service.check();

    await expect(service.install(checked)).rejects.toMatchObject({
      code: 'APP_UPDATE_DIGEST_MISMATCH',
    });
    expect(await readdir(fixture.layout.updatesDir)).toEqual([]);
    expect(launcher.mock).not.toHaveBeenCalled();
  });

  it('根据 Content-Length 在读取前拒绝超过 512 MiB 的安装包', async () => {
    const fixture = await createFixture(true);
    const digest = `sha256:${'e'.repeat(64)}`;
    const fetchMock = createFetchMock([
      jsonResponse(releasePayload({ digest })),
      streamResponse([Buffer.from('x')], { 'content-length': String(512 * 1024 * 1024 + 1) }),
    ]);
    const launcher = createLauncher();
    const service = new AppUpdateService(fixture.layout, fetchMock.fetchImpl, launcher.value);
    const checked = await service.check();

    await expect(service.install(checked)).rejects.toMatchObject({ code: 'APP_UPDATE_TOO_LARGE' });
    expect(launcher.mock).not.toHaveBeenCalled();
  });

  it('拒绝被截断的数据流并清理临时文件', async () => {
    const fixture = await createFixture(true);
    const bytes = Buffer.from('short');
    const fetchMock = createFetchMock([
      jsonResponse(releasePayload({ digest: `sha256:${sha256(bytes)}` })),
      streamResponse([bytes], { 'content-length': String(bytes.byteLength + 1) }),
    ]);
    const launcher = createLauncher();
    const service = new AppUpdateService(fixture.layout, fetchMock.fetchImpl, launcher.value);
    const checked = await service.check();

    await expect(service.install(checked)).rejects.toMatchObject({
      code: 'APP_UPDATE_DOWNLOAD_FAILED',
    });
    expect(await readdir(fixture.layout.updatesDir)).toEqual([]);
    expect(launcher.mock).not.toHaveBeenCalled();
  });

  it('缺少仓库内置升级脚本时在下载前失败', async () => {
    const fixture = await createFixture(false);
    const digest = `sha256:${'f'.repeat(64)}`;
    const fetchMock = createFetchMock([jsonResponse(releasePayload({ digest }))]);
    const service = new AppUpdateService(fixture.layout, fetchMock.fetchImpl);
    const checked = await service.check();

    await expect(service.install(checked)).rejects.toMatchObject({
      code: 'APP_UPDATE_HELPER_MISSING',
    });
    expect(fetchMock.mock).toHaveBeenCalledTimes(1);
  });

  it('升级辅助脚本为符号链接时拒绝跟随执行', async () => {
    const fixture = await createFixture(false);
    const scripts = path.join(fixture.root, 'scripts');
    const outside = path.join(fixture.root, '外部-update.ps1');
    await mkdir(scripts, { recursive: true });
    await writeFile(outside, '# 外部脚本\r\n', 'utf8');
    await symlink(outside, path.join(scripts, 'software-update.ps1'), 'file');
    const fetchMock = createFetchMock([jsonResponse(releasePayload())]);
    const service = new AppUpdateService(fixture.layout, fetchMock.fetchImpl);
    const checked = await service.check();

    await expect(service.install(checked)).rejects.toMatchObject({
      code: 'APP_UPDATE_HELPER_MISSING',
    });
    expect(fetchMock.mock).toHaveBeenCalledTimes(1);
  });

  it('下载数据流长期无内容时超时并清理临时文件', async () => {
    const fixture = await createFixture(true);
    const digest = `sha256:${'a'.repeat(64)}`;
    const hangingStream = new ReadableStream<Uint8Array>({ start: () => undefined });
    const fetchMock = createFetchMock([
      jsonResponse(releasePayload({ digest })),
      new Response(hangingStream, { status: 200 }),
    ]);
    const service = new AppUpdateService(
      fixture.layout,
      fetchMock.fetchImpl,
      createLauncher().value,
      undefined,
      { streamIdleMs: 20 },
    );
    const checked = await service.check();

    await expect(service.install(checked)).rejects.toMatchObject({
      code: 'APP_UPDATE_DOWNLOAD_TIMEOUT',
    });
    expect(await readdir(fixture.layout.updatesDir)).toEqual([]);
  });

  it('进度回调异常不会中断安全更新流程', async () => {
    const fixture = await createFixture(true);
    const bytes = Buffer.from('valid installer');
    const fetchMock = createFetchMock([
      jsonResponse(releasePayload({ digest: `sha256:${sha256(bytes)}` })),
      streamResponse([bytes], { 'content-length': String(bytes.byteLength) }),
    ]);
    const launcher = createLauncher();
    const service = new AppUpdateService(
      fixture.layout,
      fetchMock.fetchImpl,
      launcher.value,
      () => {
        throw new Error('进度展示层故障');
      },
    );
    const checked = await service.check();

    await expect(service.install(checked)).resolves.toEqual({ started: true });
    expect(launcher.mock).toHaveBeenCalledOnce();
  });
});

describe('DetachedUpdateLauncher', () => {
  it('使用绝对 Windows PowerShell 路径，并等待 spawn 事件后才成功', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    const spawnMock = vi.fn(
      (_command: string, _args: string[], _options: SpawnOptions): ChildProcess =>
        child as unknown as ChildProcess,
    );
    const launcher = new DetachedUpdateLauncher(spawnMock as UpdateProcessSpawner);

    const pending = launcher.launch('D:\\OpenSkillsGUI\\scripts\\software-update.ps1', [
      '-InstallerPath',
      'setup.exe',
    ]);
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(path.win32.isAbsolute(command)).toBe(true);
    expect(command.toLowerCase()).toMatch(/\\windowspowershell\\v1\.0\\powershell\.exe$/);
    expect(args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'D:\\OpenSkillsGUI\\scripts\\software-update.ps1',
      '-InstallerPath',
      'setup.exe',
    ]);
    expect(options).toMatchObject({
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    expect(child.unref).not.toHaveBeenCalled();

    child.emit('spawn');
    await expect(pending).resolves.toBeUndefined();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('spawn 错误会返回中文启动失败错误', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    const spawner = vi.fn(
      () => child as unknown as ChildProcess,
    ) as unknown as UpdateProcessSpawner;
    const launcher = new DetachedUpdateLauncher(spawner);

    const pending = launcher.launch('D:\\OpenSkillsGUI\\scripts\\software-update.ps1', []);
    child.emit('error', new Error('ENOENT'));

    await expect(pending).rejects.toMatchObject({
      code: 'APP_UPDATE_LAUNCH_FAILED',
      message: '启动软件更新失败',
    });
  });
});

/** 创建隔离路径布局，并按需放置脚本夹具。 */
async function createFixture(withHelper = false): Promise<{ root: string; layout: PathLayout }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'open-skills-gui-app-update-'));
  temporaryRoots.push(root);
  const dataRoot = path.join(root, 'data-root');
  const layout: PathLayout = {
    appRoot: root,
    dataRoot,
    dataDir: path.join(dataRoot, 'data'),
    stateFile: path.join(dataRoot, 'data', 'state.json'),
    restartApplicationsFile: path.join(dataRoot, 'data', 'restart-applications.json'),
    journalFile: path.join(dataRoot, 'data', 'operation-journal.json'),
    disabledDir: path.join(dataRoot, 'workspace', 'disabled'),
    logsDir: path.join(dataRoot, 'logs'),
    runtimeDir: path.join(dataRoot, 'runtime'),
    cacheDir: path.join(dataRoot, 'cache'),
    updatesDir: path.join(dataRoot, 'updates'),
    stagingDir: path.join(dataRoot, 'cache', 'staging'),
    homeDir: path.join(root, 'home'),
    targetRoots: {
      universal: path.join(root, 'home', '.agents', 'skills'),
      'claude-code': path.join(root, 'home', '.claude', 'skills'),
      windsurf: path.join(root, 'home', '.codeium', 'windsurf', 'skills'),
    },
  };
  if (withHelper) {
    const scriptsDirectory = path.join(root, 'scripts');
    await mkdir(scriptsDirectory, { recursive: true });
    await writeFile(
      path.join(scriptsDirectory, 'software-update.ps1'),
      '# 测试夹具，不执行\r\n',
      'utf8',
    );
  }
  return { root, layout };
}

/** 构造符合 GitHub API 结构的正式 Release。 */
function releasePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const asset = {
    name: overrides.name ?? 'OpenSkillsGUI-Setup-x64.exe',
    browser_download_url: overrides.browser_download_url ?? DOWNLOAD_URL,
    digest: Object.prototype.hasOwnProperty.call(overrides, 'digest')
      ? overrides.digest
      : `sha256:${'a'.repeat(64)}`,
  };
  return {
    tag_name: overrides.tag_name ?? 'v1.2.0',
    body: '正式版说明',
    published_at: '2026-07-18T00:00:00Z',
    draft: overrides.draft ?? false,
    prerelease: overrides.prerelease ?? false,
    assets: overrides.assets ?? [asset],
  };
}

/** 构造不依赖网络的顺序 fetch。 */
function createFetchMock(responses: Array<Response | Error>): {
  fetchImpl: typeof fetch;
  mock: ReturnType<typeof vi.fn>;
} {
  const queue = [...responses];
  const mock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const next = queue.shift();
      if (!next) throw new Error('测试未配置 fetch 响应');
      if (next instanceof Error) throw next;
      return next;
    },
  );
  return { fetchImpl: mock as unknown as typeof fetch, mock };
}

/** 构造 JSON 响应。 */
function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 构造保留分块边界的下载流。 */
function streamResponse(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

/** 构造可观察但不启动进程的 launcher。 */
function createLauncher(): { value: UpdateLauncher; mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(
    async (_helperPath: string, _args: readonly string[]): Promise<void> => undefined,
  );
  return { value: { launch: mock }, mock };
}

/** 计算测试安装包摘要。 */
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 构造未经本实例检查的伪造更新。 */
function untrustedUpdate(): AppUpdateInfo {
  return {
    available: true,
    currentVersion: '1.0.0',
    latestVersion: '9.9.9',
    releaseNotes: '',
    downloadUrl: DOWNLOAD_URL,
    digest: `sha256:${'f'.repeat(64)}`,
  };
}
