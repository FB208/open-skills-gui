import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalLogger } from '../../src/backend/logger.js';
import { sanitizeCommandDetails } from '../../src/backend/process.js';
import { redactUserHomePaths } from '../../src/backend/redaction.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('本地诊断信息脱敏', () => {
  it('用户主目录按 Windows 规则忽略大小写和斜杠形式', () => {
    vi.stubEnv('USERPROFILE', String.raw`C:\Users\Example User`);
    vi.stubEnv('HOME', String.raw`C:\Users\Example User`);

    expect(redactUserHomePaths('c:/users/example user/.agents/skills')).toBe(
      '%USERPROFILE%/.agents/skills',
    );
    expect(sanitizeCommandDetails(String.raw`错误 C:\USERS\EXAMPLE USER\秘密`)).toBe(
      String.raw`错误 %USERPROFILE%\秘密`,
    );
  });

  it('backend.log 被替换为符号链接时拒绝跟随写入', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), '开放技能-日志-'));
    temporaryRoots.push(root);
    const logs = path.join(root, 'logs');
    const outside = path.join(root, '外部.log');
    await mkdir(logs, { recursive: true });
    await writeFile(outside, '不可改写', 'utf8');
    await symlink(outside, path.join(logs, 'backend.log'), 'file');

    await expect(new LocalLogger(logs).info('测试')).rejects.toMatchObject({
      code: 'UNSAFE_LOG_PATH',
    });
    await expect(readFile(outside, 'utf8')).resolves.toBe('不可改写');
  });
});
