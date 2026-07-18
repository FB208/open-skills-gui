import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPathLayout, ensureDataDirectories } from '../../src/backend/paths.js';
import { SkillScanner } from '../../src/backend/scanner.js';
import { StateRepository } from '../../src/backend/state.js';
import type { SkillsClient } from '../../src/backend/skills-cli.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scannerFixture(cli?: SkillsClient) {
  const root = await mkdtemp(path.join(os.tmpdir(), '开放技能-扫描-'));
  temporaryRoots.push(root);
  const layout = createPathLayout({
    appRoot: path.join(root, '应用'),
    dataRoot: path.join(root, '数据'),
    homeDir: path.join(root, '用户 目录'),
  });
  await mkdir(layout.homeDir, { recursive: true });
  await ensureDataDirectories(layout);
  const repository = new StateRepository(layout.stateFile, layout);
  return { layout, repository, scanner: new SkillScanner(layout, repository, cli) };
}

function fakeClient(list: SkillsClient['list']): SkillsClient {
  return {
    list,
    find: vi.fn(async () => []),
    add: vi.fn(async () => undefined),
  };
}

describe('本地 Skill 扫描', () => {
  it('只收录包含文件 SKILL.md 的实体目录，并结合 CLI 与官方锁绑定来源', async () => {
    const client = fakeClient(vi.fn(async () => [{ name: '有效-skill' }]));
    const { layout, scanner } = await scannerFixture(client);
    const root = layout.targetRoots.universal;
    const valid = path.join(root, '有效-skill');
    const missing = path.join(root, '没有说明');
    const skillMdDirectory = path.join(root, '错误说明', 'SKILL.md');
    await mkdir(valid, { recursive: true });
    await writeFile(path.join(valid, 'SKILL.md'), '# 有效技能\n', 'utf8');
    await writeFile(path.join(valid, '脚本.ps1'), 'Write-Output "你好"\n', 'utf8');
    await mkdir(missing, { recursive: true });
    await mkdir(skillMdDirectory, { recursive: true });
    await writeFile(
      path.join(layout.homeDir, '.agents', '.skill-lock.json'),
      JSON.stringify({
        version: 3,
        skills: {
          '有效-skill': {
            source: 'Owner/Repository',
            sourceType: 'github',
            sourceUrl: 'https://github.com/Owner/Repository.git',
            ref: 'main',
            skillPath: 'skills/有效-skill/SKILL.md',
            folderHash: '不可信的官方哈希',
          },
        },
      }),
      'utf8',
    );

    const result = await scanner.scan();

    expect(result.legacyDetected).toBe(true);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: '有效-skill',
      managed: false,
      state: 'enabled',
      source: {
        type: 'github',
        locator: 'owner/repository',
        ref: 'main',
        skillPath: 'skills/有效-skill',
      },
      targets: ['universal'],
    });
    expect(result.skills[0].baselineHash).toBeUndefined();
    expect(result.skills[0].localHash).toMatch(/^[a-f\d]{64}$/);
    expect(client.list).toHaveBeenCalledWith(layout.homeDir);
  });

  it('忽略损坏目录联接，不会把联接目标或空壳登记为 Skill', async () => {
    const client = fakeClient(vi.fn(async () => []));
    const { layout, scanner } = await scannerFixture(client);
    const claudeRoot = layout.targetRoots['claude-code'];
    const broken = path.join(claudeRoot, '损坏-skill');
    await mkdir(claudeRoot, { recursive: true });
    await symlink(path.join(layout.homeDir, '不存在的目标'), broken, 'junction');

    await expect(scanner.scan()).resolves.toEqual({ skills: [], legacyDetected: false });
  });

  it('受管 unknown 记录即使出现官方锁也不会被扫描静默改绑', async () => {
    const client = fakeClient(vi.fn(async () => [{ name: '受管-skill' }]));
    const { layout, repository, scanner } = await scannerFixture(client);
    const canonicalPath = path.join(layout.targetRoots.universal, '受管-skill');
    await mkdir(canonicalPath, { recursive: true });
    await writeFile(path.join(canonicalPath, 'SKILL.md'), '# 受管 Skill\n', 'utf8');
    await writeFile(
      path.join(layout.homeDir, '.agents', '.skill-lock.json'),
      JSON.stringify({
        version: 3,
        skills: {
          '受管-skill': {
            source: 'owner/repo',
            sourceType: 'github',
            sourceUrl: 'https://github.com/owner/repo.git',
            skillPath: 'skills/受管-skill/SKILL.md',
          },
        },
      }),
      'utf8',
    );
    const id = '0123456789abcdef0123456789abcdef';
    const now = '2026-07-18T00:00:00.000Z';
    await repository.save({
      schemaVersion: 1,
      settings: { onboardingCompleted: true, legacyDecisionMade: true },
      skills: {
        [id]: {
          id,
          name: '受管-skill',
          source: { type: 'unknown', locator: '' },
          state: 'enabled',
          managed: true,
          targets: ['universal'],
          canonicalPath,
          observedPaths: [canonicalPath],
          updateStatus: 'unavailable',
          note: '',
          createdAt: now,
          updatedAt: now,
        },
      },
    });

    const result = await scanner.scan();

    expect(result.skills[0]).toMatchObject({ id, managed: true, source: { type: 'unknown' } });
  });

  it('CLI 清单读取失败时明确失败，不把来源识别退化为猜测', async () => {
    const failure = new Error('伪造 CLI 失败');
    const client = fakeClient(vi.fn(async () => Promise.reject(failure)));
    const { scanner } = await scannerFixture(client);

    await expect(scanner.scan()).rejects.toBe(failure);
  });
});
