import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { BackendException } from './errors.js';

/** 计算与遍历顺序、时间戳无关的目录 SHA-256。 */
export async function hashDirectory(root: string): Promise<string> {
  let stat;
  try {
    stat = await lstat(root);
  } catch (error) {
    throw new BackendException('SKILL_NOT_FOUND', 'Skill 目录不存在', root, { cause: error });
  }
  if (!stat.isDirectory()) throw new BackendException('INVALID_SKILL', 'Skill 路径不是目录', root);

  const hash = createHash('sha256');
  await walk(root, '', hash);
  return hash.digest('hex');
}

async function walk(
  root: string,
  relative: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const current = path.join(root, relative);
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const normalized = childRelative.split(path.sep).join('/');
    const fullPath = path.join(root, childRelative);
    if (entry.isDirectory()) {
      hash.update(`D\0${normalized}\0`, 'utf8');
      await walk(root, childRelative, hash);
    } else if (entry.isSymbolicLink()) {
      hash.update(`L\0${normalized}\0${await readlink(fullPath)}\0`, 'utf8');
    } else if (entry.isFile()) {
      const content = await readFile(fullPath);
      hash.update(`F\0${normalized}\0${content.byteLength}\0`, 'utf8');
      hash.update(content);
    }
  }
}

/** 计算 Buffer 的 SHA-256 十六进制摘要。 */
export function hashBuffer(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
