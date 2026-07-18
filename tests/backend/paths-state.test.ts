import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppState, SkillRecord } from '../../src/shared/types.js';
import { BackendException } from '../../src/backend/errors.js';
import {
  assertDirectChild,
  assertNoLinkedParents,
  assertSkillName,
  assertWithin,
  createPathLayout,
  ensureDataDirectories,
  isWithin,
} from '../../src/backend/paths.js';
import { StateRepository, validateState } from '../../src/backend/state.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryLayout() {
  const root = await mkdtemp(path.join(os.tmpdir(), '开放技能-状态-'));
  temporaryRoots.push(root);
  const layout = createPathLayout({
    appRoot: path.join(root, '应用程序'),
    dataRoot: path.join(root, '本地 数据', 'OpenSkillsGUI'),
    homeDir: path.join(root, '用户 家目录'),
  });
  await mkdir(layout.homeDir, { recursive: true });
  await ensureDataDirectories(layout);
  return layout;
}

function enabledRecord(layout: ReturnType<typeof createPathLayout>): SkillRecord {
  const now = '2026-07-18T01:02:03.000Z';
  const canonicalPath = path.join(layout.targetRoots.universal, '中文-skill');
  return {
    id: '0123456789abcdef0123456789abcdef',
    name: '中文-skill',
    source: {
      type: 'github',
      locator: 'owner/repository',
      ref: 'main',
      skillPath: 'skills/中文-skill',
    },
    state: 'enabled',
    managed: true,
    targets: ['universal'],
    canonicalPath,
    observedPaths: [canonicalPath],
    baselineHash: 'a'.repeat(64),
    localHash: 'a'.repeat(64),
    updateStatus: 'latest',
    note: '中文备注',
    createdAt: now,
    updatedAt: now,
  };
}

function validState(layout: ReturnType<typeof createPathLayout>): AppState {
  const record = enabledRecord(layout);
  return {
    schemaVersion: 1,
    settings: { onboardingCompleted: true, legacyDecisionMade: true },
    skills: { [record.id]: record },
  };
}

function expectBackendCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error('预期操作失败');
  } catch (error) {
    expect(error).toBeInstanceOf(BackendException);
    expect(error).toMatchObject({ code });
  }
}

describe('Windows Skill 路径边界', () => {
  it('接受中文单段名称，拒绝穿越、保留名和 Windows 非法尾缀', () => {
    expect(() => assertSkillName('中文-skill_01')).not.toThrow();
    for (const name of ['', '.', '..', '../escape', 'a\\b', 'CON', 'Lpt9.txt', '结尾.', '结尾 ']) {
      expectBackendCode(() => assertSkillName(name), 'INVALID_SKILL_NAME');
    }
  });

  it('不会把根目录本身、同名前缀目录或孙级目录当成直接子项', async () => {
    const layout = await temporaryLayout();
    const root = layout.targetRoots.universal;
    const child = path.join(root, 'skill-a');
    const grandchild = path.join(child, 'nested');
    const siblingPrefix = `${root}-escaped`;

    expect(isWithin(root, child)).toBe(true);
    expect(isWithin(root, root)).toBe(false);
    expect(isWithin(root, siblingPrefix)).toBe(false);
    expect(() => assertWithin(root, siblingPrefix)).toThrowError(BackendException);
    expect(() => assertDirectChild(root, child, 'skill-a')).not.toThrow();
    expect(() => assertDirectChild(root, grandchild)).toThrowError(BackendException);
  });

  it('父链出现目录联接时拒绝继续访问', async () => {
    const layout = await temporaryLayout();
    const outside = path.join(path.dirname(layout.homeDir), '联接目标');
    const linkedParent = path.join(layout.homeDir, '.agents');
    await mkdir(outside, { recursive: true });
    await symlink(outside, linkedParent, 'junction');

    await expect(
      assertNoLinkedParents(layout.homeDir, path.join(linkedParent, 'skills')),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });
});

describe('schemaVersion 1 状态仓库', () => {
  it('严格拒绝未知版本、未知字段和状态/路径不一致', async () => {
    const layout = await temporaryLayout();
    const state = validState(layout);

    expectBackendCode(
      () => validateState({ ...state, schemaVersion: 2 }, layout),
      'STATE_VERSION_UNSUPPORTED',
    );
    expectBackendCode(() => validateState({ ...state, unexpected: true }, layout), 'STATE_CORRUPT');

    const invalid = structuredClone(state);
    const record = invalid.skills['0123456789abcdef0123456789abcdef'];
    record.state = 'disabled';
    expectBackendCode(() => validateState(invalid, layout), 'STATE_CORRUPT');
  });

  it('主文件缺失时从原子替换备份恢复，并清理备份', async () => {
    const layout = await temporaryLayout();
    const repository = new StateRepository(layout.stateFile, layout);
    const state = validState(layout);
    await repository.save(state);
    await rename(layout.stateFile, `${layout.stateFile}.backup`);

    await expect(repository.load()).resolves.toEqual(state);
    expect(JSON.parse(await readFile(layout.stateFile, 'utf8'))).toEqual(state);
    await expect(readFile(`${layout.stateFile}.backup`, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('损坏 JSON 和路径越界记录不会被静默迁移', async () => {
    const layout = await temporaryLayout();
    const repository = new StateRepository(layout.stateFile, layout);
    await writeFile(layout.stateFile, '{损坏', 'utf8');
    await expect(repository.load()).rejects.toMatchObject({ code: 'STATE_CORRUPT' });

    const state = validState(layout);
    state.skills['0123456789abcdef0123456789abcdef'].canonicalPath = path.join(
      layout.dataRoot,
      '越界-skill',
    );
    expectBackendCode(() => validateState(state, layout), 'STATE_CORRUPT');
  });
});
