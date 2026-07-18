import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState, SkillRecord, SkillSource } from '../../src/shared/types.js';
import { BackendException } from '../../src/backend/errors.js';
import { createPathLayout, ensureDataDirectories } from '../../src/backend/paths.js';
import type { SkillScanner } from '../../src/backend/scanner.js';
import { stableSkillId } from '../../src/backend/scanner.js';
import type { SkillsClient } from '../../src/backend/skills-cli.js';
import { SkillsService } from '../../src/backend/skills-service.js';
import { StateRepository } from '../../src/backend/state.js';
import type { FileLockManager } from '../../src/backend/windows-locks.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** 创建隔离的 Skill 服务和状态仓库。 */
async function serviceFixture(client: SkillsClient) {
  const root = await mkdtemp(path.join(os.tmpdir(), '开放技能-服务安全-'));
  temporaryRoots.push(root);
  const layout = createPathLayout({
    appRoot: path.join(root, '应用'),
    dataRoot: path.join(root, '用户数据'),
    homeDir: path.join(root, '用户目录'),
  });
  await mkdir(layout.homeDir, { recursive: true });
  await ensureDataDirectories(layout);
  const repository = new StateRepository(layout.stateFile, layout);
  const locks: FileLockManager = {
    find: vi.fn(async () => []),
    terminate: vi.fn(async () => undefined),
  };
  return {
    layout,
    repository,
    service: new SkillsService(
      layout,
      repository,
      undefined as unknown as SkillScanner,
      client,
      locks,
    ),
  };
}

/** 构造会写入真实 v3 锁结构和安装目录的伪 CLI。 */
function installingClient(source: SkillSource): SkillsClient {
  return {
    list: vi.fn(async () => []),
    find: vi.fn(async () => []),
    add: vi.fn(async (_requested, name, options) => {
      if (!options?.homeDir) throw new Error('测试安装缺少 HOME');
      const skillDirectory = path.join(options.homeDir, '.agents', 'skills', name);
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(path.join(skillDirectory, 'SKILL.md'), `# ${name}\n`, 'utf8');
      await writeFile(
        path.join(options.homeDir, '.agents', '.skill-lock.json'),
        JSON.stringify({
          version: 3,
          skills: {
            [name]: {
              source: source.locator,
              sourceType: 'github',
              sourceUrl: `https://github.com/${source.locator}.git`,
              ref: source.ref,
              skillPath: `${source.skillPath ?? ''}${source.skillPath ? '/' : ''}SKILL.md`,
            },
          },
        }),
        'utf8',
      );
    }),
  };
}

/** 构造状态记录的公共字段。 */
function recordBase(id: string, name: string, source: SkillSource): SkillRecord {
  return {
    id,
    name,
    source,
    state: 'uninstalled',
    managed: true,
    targets: ['universal'],
    observedPaths: [],
    updateStatus: 'unchecked',
    note: '',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
  };
}

describe('官方锁来源与稳定身份', () => {
  it('安装后以 v3 锁的真实 ref 和子路径生成 ID，并继承同身份墓碑的备注和时间', async () => {
    const source: SkillSource = {
      type: 'github',
      locator: 'owner/repo',
      ref: 'Feature/Topic',
      skillPath: 'Skills/真实路径',
    };
    const client = installingClient(source);
    const { repository, service } = await serviceFixture(client);
    const id = stableSkillId(source, '示例-skill');
    const tombstone = recordBase(id, '示例-skill', source);
    tombstone.note = '必须保留的备注';
    const state: AppState = {
      schemaVersion: 1,
      settings: { onboardingCompleted: true, legacyDecisionMade: true },
      skills: { [id]: tombstone },
    };
    await repository.save(state);

    const installed = await service.install('OWNER/REPO', '示例-skill', ['universal']);

    expect(installed).toMatchObject({
      id,
      source,
      note: '必须保留的备注',
      createdAt: tombstone.createdAt,
      state: 'enabled',
      managed: true,
    });
  });

  it('真实来源与请求仓库不一致时回滚目录和事务内官方锁', async () => {
    const client = installingClient({
      type: 'github',
      locator: 'other/repo',
      ref: 'main',
      skillPath: 'skills/目标-skill',
    });
    const { layout, service } = await serviceFixture(client);

    await expect(service.install('owner/repo', '目标-skill', ['universal'])).rejects.toMatchObject({
      code: 'INSTALLED_SOURCE_MISMATCH',
    });
    await expect(
      readFile(path.join(layout.targetRoots.universal, '目标-skill', 'SKILL.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(path.join(layout.homeDir, '.agents', '.skill-lock.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('真实稳定 ID 碰到未卸载记录时拒绝覆盖并恢复官方锁', async () => {
    const source: SkillSource = {
      type: 'github',
      locator: 'owner/repo',
      ref: 'main',
      skillPath: 'skills/目标-skill',
    };
    const client = installingClient(source);
    const { layout, repository, service } = await serviceFixture(client);
    const id = stableSkillId(source, '目标-skill');
    const collision = recordBase(id, '另一-skill', source);
    collision.state = 'enabled';
    collision.canonicalPath = path.join(layout.targetRoots.universal, collision.name);
    collision.observedPaths = [collision.canonicalPath];
    await repository.save({
      schemaVersion: 1,
      settings: { onboardingCompleted: true, legacyDecisionMade: true },
      skills: { [id]: collision },
    });

    await expect(service.install('owner/repo', '目标-skill', ['universal'])).rejects.toMatchObject({
      code: 'SKILL_ID_CONFLICT',
    });
    await expect(
      readFile(path.join(layout.homeDir, '.agents', '.skill-lock.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('受管实体与搜索控制器安全', () => {
  it.each([
    ['启用实体', 'enabled'],
    ['禁用实体', 'disabled'],
  ] as const)('%s被目录联接替换后拒绝生命周期操作', async (_label, stateKind) => {
    const client = installingClient({ type: 'github', locator: 'owner/repo' });
    const { layout, repository, service } = await serviceFixture(client);
    const id = '0123456789abcdef0123456789abcdef';
    const outside = path.join(path.dirname(layout.dataRoot), `外部-${stateKind}`);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'SKILL.md'), '# 外部\n', 'utf8');
    const record = recordBase(id, '联接-skill', { type: 'unknown', locator: '' });
    record.state = stateKind;
    if (stateKind === 'enabled') {
      record.canonicalPath = path.join(layout.targetRoots.universal, record.name);
      record.observedPaths = [record.canonicalPath];
      await mkdir(path.dirname(record.canonicalPath), { recursive: true });
      await symlink(outside, record.canonicalPath, 'junction');
    } else {
      record.disabledPath = path.join(layout.disabledDir, id);
      await symlink(outside, record.disabledPath, 'junction');
    }
    await repository.save({
      schemaVersion: 1,
      settings: { onboardingCompleted: true, legacyDecisionMade: true },
      skills: { [id]: record },
    });

    const operation = stateKind === 'enabled' ? service.disable(id) : service.enable(id);
    await expect(operation).rejects.toMatchObject({ code: 'PATH_CONFLICT' });
  });

  it('同 requestId 的旧搜索结束时不会误删新控制器', async () => {
    const pending: Array<{
      signal: AbortSignal;
      reject: (error: Error) => void;
    }> = [];
    const client: SkillsClient = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => undefined),
      find: vi.fn(
        async (_query, _installed, signal) =>
          await new Promise<never>((_resolve, reject) => {
            if (!signal) throw new Error('测试搜索缺少 AbortSignal');
            pending.push({ signal, reject });
            signal.addEventListener(
              'abort',
              () => reject(new BackendException('CANCELLED', '操作已取消')),
              { once: true },
            );
          }),
      ),
    };
    const { service } = await serviceFixture(client);
    const first = service.searchRemote('first', 'same-request');
    const firstRejection = expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await waitFor(() => pending.length === 1);
    const second = service.searchRemote('second', 'same-request');
    const secondRejection = expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    await waitFor(() => pending.length === 2);
    await firstRejection;

    expect(service.cancelSearch('same-request')).toEqual({ cancelled: true });
    await secondRejection;
    expect(pending[1].signal.aborted).toBe(true);
  });
});

/** 等待异步测试条件成立，并限制轮询次数。 */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('等待异步测试条件超时');
}
