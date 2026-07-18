import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/shared/types.js';
import { createPathLayout, ensureDataDirectories } from '../../src/backend/paths.js';
import type { SkillScanner } from '../../src/backend/scanner.js';
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

describe('旧 Skill 接管', () => {
  it('通用目录中的目录联接即使内容相同，也会被替换为本工具管理的实体副本', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), '开放技能-接管联接-'));
    temporaryRoots.push(root);
    const layout = createPathLayout({
      appRoot: path.join(root, '应用'),
      dataRoot: path.join(root, '用户数据'),
      homeDir: path.join(root, '用户目录'),
    });
    await mkdir(layout.homeDir, { recursive: true });
    await ensureDataDirectories(layout);

    const dedicated = path.join(layout.targetRoots['claude-code'], '示例-skill');
    await mkdir(dedicated, { recursive: true });
    await writeFile(path.join(dedicated, 'SKILL.md'), '# 示例 Skill\n', 'utf8');
    await writeFile(path.join(dedicated, '脚本.ps1'), 'Write-Output "你好"\n', 'utf8');
    const destination = path.join(layout.targetRoots.universal, '示例-skill');
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(dedicated, destination, 'junction');

    const id = randomUUID();
    const now = new Date().toISOString();
    const state: AppState = {
      schemaVersion: 1,
      settings: { onboardingCompleted: true, legacyDecisionMade: false },
      skills: {
        [id]: {
          id,
          name: '示例-skill',
          source: { type: 'unknown', locator: '' },
          state: 'enabled',
          managed: false,
          targets: ['claude-code'],
          canonicalPath: dedicated,
          observedPaths: [dedicated],
          updateStatus: 'unavailable',
          note: '保留备注',
          createdAt: now,
          updatedAt: now,
        },
      },
    };
    const repository = new StateRepository(layout.stateFile, layout);
    await repository.save(state);
    const cli: SkillsClient = {
      list: vi.fn(async () => []),
      find: vi.fn(async () => []),
      add: vi.fn(async () => undefined),
    };
    const locks: FileLockManager = {
      find: vi.fn(async () => []),
      terminate: vi.fn(async () => undefined),
    };
    const service = new SkillsService(
      layout,
      repository,
      undefined as unknown as SkillScanner,
      cli,
      locks,
    );

    const result = await service.adopt({ ids: [id] });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id,
      managed: true,
      state: 'enabled',
      note: '保留备注',
      targets: ['universal', 'claude-code'],
    });
    expect((await lstat(destination)).isSymbolicLink()).toBe(false);
    await expect(readFile(path.join(destination, 'SKILL.md'), 'utf8')).resolves.toBe(
      '# 示例 Skill\n',
    );
    expect((await lstat(dedicated)).isSymbolicLink()).toBe(true);
    await expect(readFile(path.join(dedicated, 'SKILL.md'), 'utf8')).resolves.toBe(
      '# 示例 Skill\n',
    );
  });
});
