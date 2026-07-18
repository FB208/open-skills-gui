import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncMutex } from '../../src/backend/mutex.js';
import { BackendRouter, validateRequest } from '../../src/backend/router.js';

const validId = '0123456789abcdef0123456789abcdef';

function createRouter() {
  const runtime = {
    getStatus: vi.fn(async () => ({
      ready: false,
      node: { available: false },
      npx: { available: false },
      git: { available: false },
    })),
    install: vi.fn(),
  };
  const skills = {
    scan: vi.fn(),
    adopt: vi.fn(),
    searchRemote: vi.fn(),
    cancelSearch: vi.fn(() => ({ cancelled: false })),
    install: vi.fn(async () => ({ id: validId })),
    enable: vi.fn(),
    disable: vi.fn(),
    remove: vi.fn(),
    saveNote: vi.fn(),
    checkUpdates: vi.fn(async () => []),
    update: vi.fn(async () => []),
  };
  const appUpdate = { check: vi.fn(), install: vi.fn() };
  const logger = { error: vi.fn(async () => undefined) };
  const progress = vi.fn(async () => undefined);
  const router = new BackendRouter(
    runtime as never,
    skills as never,
    appUpdate as never,
    new AsyncMutex(),
    logger as never,
    progress,
  );
  return { router, runtime, skills, appUpdate, logger, progress };
}

describe('后端路由请求校验', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('拒绝带继承原型的请求对象和未知字段', async () => {
    const { router } = createRouter();
    const inherited = Object.assign(Object.create({ polluted: true }), {
      requestId: 'request-1',
      method: 'skills.scan',
    });

    await expect(router.handle(inherited)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    await expect(
      router.handle({
        requestId: 'request-2',
        method: 'skills.scan',
        payload: {},
        unexpected: true,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('拒绝映射中的原型污染键，并且不会调用领域服务', async () => {
    const { router, skills } = createRouter();
    const bindings = JSON.parse('{"__proto__":{"type":"github","locator":"owner/repo"}}') as Record<
      string,
      unknown
    >;
    const response = await router.handle({
      requestId: 'request-adopt',
      method: 'skills.adopt',
      payload: { sourceBindings: bindings },
    });

    expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(skills.adopt).not.toHaveBeenCalled();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('安装目标不能为空、不能重复，且只允许三个固定 Agent 目标', async () => {
    const { router, skills } = createRouter();
    for (const targets of [[], ['universal', 'universal'], ['unsupported']]) {
      const response = await router.handle({
        requestId: `request-${targets.join('-') || 'empty'}`,
        method: 'skills.install',
        payload: { source: 'owner/repo', name: 'skill-a', targets },
      });
      expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(skills.install).not.toHaveBeenCalled();
  });

  it('Skill ID 仅接受稳定 32 位十六进制或 UUID，清单拒绝重复', async () => {
    const { router, skills } = createRouter();
    await expect(
      router.handle({ requestId: 'bad-id', method: 'skills.enable', payload: { id: '../escape' } }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(
      router.handle({
        requestId: 'duplicate',
        method: 'skills.update',
        payload: { ids: [validId, validId] },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(skills.enable).not.toHaveBeenCalled();
    expect(skills.update).not.toHaveBeenCalled();
  });

  it('合法安装请求原样传给领域服务，并发送开始与完成进度', async () => {
    const { router, skills, progress } = createRouter();
    const response = await router.handle({
      requestId: 'valid-install',
      method: 'skills.install',
      payload: { source: 'Owner/Repo', name: '中文-skill', targets: ['universal', 'windsurf'] },
    });

    expect(response).toMatchObject({ requestId: 'valid-install', ok: true, data: { id: validId } });
    expect(skills.install).toHaveBeenCalledWith('Owner/Repo', '中文-skill', [
      'universal',
      'windsurf',
    ]);
    expect(progress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ requestId: 'valid-install', stage: 'starting' }),
    );
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 'valid-install', stage: 'completed' }),
    );
  });

  it('软件更新流式进度使用触发安装的真实 requestId', async () => {
    const { router, appUpdate, progress } = createRouter();
    appUpdate.install.mockImplementation(async (...args: unknown[]) => {
      const reporter = args[1] as (event: {
        stage: 'downloading';
        current: number;
        total: number;
        message: string;
      }) => Promise<void>;
      await reporter({ stage: 'downloading', current: 5, total: 10, message: '正在下载' });
      return { started: true };
    });

    const response = await router.handle({
      requestId: 'update-request-真实编号',
      method: 'app.installUpdate',
      payload: {
        update: {
          available: true,
          currentVersion: '1.0.0',
          latestVersion: '1.1.0',
          releaseNotes: '',
          downloadUrl:
            'https://github.com/FB208/open-skills-gui/releases/download/v1.1.0/OpenSkillsGUI-Setup-x64.exe',
          digest: `sha256:${'a'.repeat(64)}`,
        },
      },
    });

    expect(response).toMatchObject({ requestId: 'update-request-真实编号', ok: true });
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'update-request-真实编号',
        operation: 'app.installUpdate',
        stage: 'downloading',
        current: 5,
      }),
    );
  });

  it('请求外壳不接受空 requestId 或未注册方法', () => {
    expect(() => validateRequest({ requestId: '', method: 'skills.scan' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(() => validateRequest({ requestId: 'x', method: 'system.shell' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
  });
});
