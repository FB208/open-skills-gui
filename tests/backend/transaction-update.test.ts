import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppState } from '../../src/shared/types.js';
import { createPathLayout, ensureDataDirectories } from '../../src/backend/paths.js';
import { classifyUpdate } from '../../src/backend/skills-service.js';
import { StateRepository } from '../../src/backend/state.js';
import { FileTransaction, recoverFileTransaction } from '../../src/backend/transaction.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function transactionFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), '开放技能-事务-'));
  temporaryRoots.push(root);
  const layout = createPathLayout({
    appRoot: path.join(root, '应用'),
    dataRoot: path.join(root, '数据 目录'),
    homeDir: path.join(root, '用户 目录'),
  });
  await mkdir(layout.homeDir, { recursive: true });
  await ensureDataDirectories(layout);
  return { layout, repository: new StateRepository(layout.stateFile, layout) };
}

const stateBefore: AppState = {
  schemaVersion: 1,
  settings: { onboardingCompleted: false, legacyDecisionMade: false },
  skills: {},
};

describe('三哈希更新分类', () => {
  const baseline = 'a'.repeat(64);
  const local = 'b'.repeat(64);
  const remote = 'c'.repeat(64);

  it.each([
    ['相同内容优先判定最新', baseline, local, local, 'latest'],
    ['本地未改且远端变化', baseline, baseline, remote, 'available'],
    ['本地变化且远端未变', baseline, local, baseline, 'local-modified'],
    ['本地和远端都变化', baseline, local, remote, 'conflict'],
    ['缺少安装基准且内容不同', undefined, local, remote, 'conflict'],
  ] as const)('%s', (_label, installed, current, latest, expected) => {
    expect(classifyUpdate(installed, current, latest)).toBe(expected);
  });
});

describe('文件事务启动恢复', () => {
  it('应用中断后逆序恢复移动、旧状态和中文路径，并清空 staging', async () => {
    const { layout, repository } = await transactionFixture();
    const original = path.join(layout.disabledDir, '中文-skill');
    const trash = path.join(layout.stagingDir, 'trash-recovery');
    await mkdir(original, { recursive: true });
    await writeFile(path.join(original, 'SKILL.md'), '# 待恢复\n', 'utf8');
    await rename(original, trash);
    await repository.save({
      schemaVersion: 1,
      settings: { onboardingCompleted: true, legacyDecisionMade: true },
      skills: {},
    });
    await writeFile(
      layout.journalFile,
      JSON.stringify({
        schemaVersion: 1,
        phase: 'applying',
        stateBefore,
        officialLockBefore: { exists: false },
        actions: [{ kind: 'move', from: trash, to: original }],
        cleanup: [trash],
      }),
      'utf8',
    );

    await recoverFileTransaction(layout, repository);

    expect(await readFile(path.join(original, 'SKILL.md'), 'utf8')).toBe('# 待恢复\n');
    expect(await repository.load()).toEqual(stateBefore);
    await expect(readFile(layout.journalFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(path.join(layout.stagingDir, 'trash-recovery', 'SKILL.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('事务开始即持久化官方锁原始快照，启动恢复时原子还原', async () => {
    const { layout, repository } = await transactionFixture();
    const lockFile = path.join(layout.homeDir, '.agents', '.skill-lock.json');
    const original = Buffer.from('{"version":3,"skills":{"旧项":{}}}\n', 'utf8');
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(lockFile, original);
    await FileTransaction.begin(
      layout,
      repository,
      {
        find: async () => [],
        terminate: async () => undefined,
      },
      stateBefore,
    );

    const journal = JSON.parse(await readFile(layout.journalFile, 'utf8')) as {
      officialLockBefore: { exists: boolean; contentBase64?: string };
    };
    expect(journal.officialLockBefore).toEqual({
      exists: true,
      contentBase64: original.toString('base64'),
    });
    await writeFile(lockFile, '{"version":3,"skills":{"新项":{}}}\n', 'utf8');

    await recoverFileTransaction(layout, repository);

    await expect(readFile(lockFile)).resolves.toEqual(original);
  });

  it('损坏日志不能被静默忽略或顺带清空 staging', async () => {
    const { layout, repository } = await transactionFixture();
    const marker = path.join(layout.stagingDir, '需要保留');
    await mkdir(marker, { recursive: true });
    await writeFile(path.join(marker, '内容.txt'), '重要数据', 'utf8');
    await writeFile(layout.journalFile, '{损坏日志', 'utf8');

    await expect(recoverFileTransaction(layout, repository)).rejects.toMatchObject({
      code: 'TRANSACTION_JOURNAL_CORRUPT',
    });
    await expect(readFile(path.join(marker, '内容.txt'), 'utf8')).resolves.toBe('重要数据');
  });

  it('日志中的越界动作被拒绝，不执行任意文件操作', async () => {
    const { layout, repository } = await transactionFixture();
    const outside = path.join(path.dirname(layout.dataRoot), '不允许删除');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, '内容.txt'), '仍在', 'utf8');
    await writeFile(
      layout.journalFile,
      JSON.stringify({
        schemaVersion: 1,
        phase: 'applying',
        stateBefore,
        officialLockBefore: { exists: false },
        actions: [{ kind: 'remove-directory', path: outside }],
        cleanup: [],
      }),
      'utf8',
    );

    await expect(recoverFileTransaction(layout, repository)).rejects.toMatchObject({
      code: 'TRANSACTION_JOURNAL_CORRUPT',
    });
    await expect(readFile(path.join(outside, '内容.txt'), 'utf8')).resolves.toBe('仍在');
  });
});
