import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { hashDirectory } from '../../src/backend/hash.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** 创建测试目录并记录统一清理。 */
async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `开放技能-哈希-${label}-`));
  temporaryRoots.push(directory);
  return directory;
}

describe('确定性目录哈希', () => {
  it('不受文件创建顺序影响，并按明确的 UTF-16 顺序序列化名称', async () => {
    const first = await temporaryDirectory('正序');
    const second = await temporaryDirectory('逆序');
    const files: Array<[string, Buffer]> = [
      ['Z.md', Buffer.from('大写', 'utf8')],
      ['a.md', Buffer.from([0, 1, 2, 0])],
      ['ä.md', Buffer.from('变音', 'utf8')],
    ];
    for (const [name, content] of files) await writeFile(path.join(first, name), content);
    for (const [name, content] of [...files].reverse())
      await writeFile(path.join(second, name), content);

    const expected = createHash('sha256');
    for (const [name, content] of [...files].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      expected.update(`F\0${name}\0${content.byteLength}\0`, 'utf8');
      expected.update(content);
    }

    await expect(hashDirectory(first)).resolves.toBe(expected.digest('hex'));
    await expect(hashDirectory(second)).resolves.toBe(await hashDirectory(first));
  });

  it('目录层级参与哈希，避免相同文件内容被错误视为同一结构', async () => {
    const flat = await temporaryDirectory('平铺');
    const nested = await temporaryDirectory('嵌套');
    await writeFile(path.join(flat, '脚本.ps1'), 'Write-Output 你好', 'utf8');
    await mkdir(path.join(nested, '子目录'));
    await writeFile(path.join(nested, '子目录', '脚本.ps1'), 'Write-Output 你好', 'utf8');

    expect(await hashDirectory(flat)).not.toBe(await hashDirectory(nested));
  });
});
