import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, readlink, realpath, stat } from 'node:fs/promises';
import type { AgentTarget } from '../shared/types.js';
import { BackendException } from './errors.js';

export interface PathLayout {
  appRoot: string;
  dataRoot: string;
  dataDir: string;
  stateFile: string;
  journalFile: string;
  disabledDir: string;
  logsDir: string;
  runtimeDir: string;
  cacheDir: string;
  updatesDir: string;
  stagingDir: string;
  homeDir: string;
  targetRoots: Record<AgentTarget, string>;
}

/** 构建 Windows 当前用户下的固定路径布局。 */
export function createPathLayout(
  options: { appRoot?: string; dataRoot?: string; homeDir?: string } = {},
): PathLayout {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const localAppData = process.env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local');
  const dataRoot = path.resolve(options.dataRoot ?? path.join(localAppData, 'OpenSkillsGUI'));
  return {
    appRoot: path.resolve(options.appRoot ?? process.cwd()),
    dataRoot,
    dataDir: path.join(dataRoot, 'data'),
    stateFile: path.join(dataRoot, 'data', 'state.json'),
    journalFile: path.join(dataRoot, 'data', 'operation-journal.json'),
    disabledDir: path.join(dataRoot, 'workspace', 'disabled'),
    logsDir: path.join(dataRoot, 'logs'),
    runtimeDir: path.join(dataRoot, 'runtime'),
    cacheDir: path.join(dataRoot, 'cache'),
    updatesDir: path.join(dataRoot, 'updates'),
    stagingDir: path.join(dataRoot, 'cache', 'staging'),
    homeDir,
    targetRoots: {
      universal: path.join(homeDir, '.agents', 'skills'),
      'claude-code': path.join(homeDir, '.claude', 'skills'),
      windsurf: path.join(homeDir, '.codeium', 'windsurf', 'skills'),
    },
  };
}

/** 创建后端数据目录，不主动创建 Agent 技能目录。 */
export async function ensureDataDirectories(layout: PathLayout): Promise<void> {
  const directories = [
    layout.dataDir,
    layout.disabledDir,
    layout.logsDir,
    layout.runtimeDir,
    layout.cacheDir,
    layout.updatesDir,
    layout.stagingDir,
  ];
  const trustedParent = path.dirname(layout.dataRoot);
  for (const directory of directories) await assertNoLinkedParents(trustedParent, directory);
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));
}

/** 校验 Skill 名称是安全的 Windows 单段目录名。 */
export function assertSkillName(name: string): void {
  const trimmed = name.trim();
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (
    trimmed !== name ||
    name.length === 0 ||
    name.length > 128 ||
    name === '.' ||
    name === '..' ||
    /[\\/:*?"<>|\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    reserved.test(name)
  ) {
    throw new BackendException('INVALID_SKILL_NAME', 'Skill 名称不是安全的 Windows 目录名', name);
  }
}

/** 判断候选路径是否严格位于根目录内。 */
export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** 校验候选路径位于根目录内。 */
export function assertWithin(root: string, candidate: string): void {
  if (!isWithin(root, candidate))
    throw new BackendException('UNSAFE_PATH', '拒绝操作允许目录之外的路径', candidate);
}

/** 校验候选路径是根目录的直接子项。 */
export function assertDirectChild(root: string, candidate: string, expectedName?: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (path.dirname(resolvedCandidate).toLowerCase() !== resolvedRoot.toLowerCase()) {
    throw new BackendException('UNSAFE_PATH', 'Skill 路径必须是允许目录的直接子项', candidate);
  }
  const name = path.basename(resolvedCandidate);
  assertSkillName(name);
  if (expectedName !== undefined && name.toLowerCase() !== expectedName.toLowerCase()) {
    throw new BackendException('UNSAFE_PATH', 'Skill 路径名称与记录不一致', candidate);
  }
}

/** 拒绝可信根目录以下的父级目录链接，防止路径穿越。 */
export async function assertNoLinkedParents(trustedRoot: string, directory: string): Promise<void> {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(directory);
  if (root.toLowerCase() !== target.toLowerCase() && !isWithin(root, target)) {
    throw new BackendException('UNSAFE_PATH', '目录不在可信根目录内', directory);
  }
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new BackendException('UNSAFE_PATH', '父级目录不能是目录链接', current);
      if (!info.isDirectory())
        throw new BackendException('UNSAFE_PATH', '父级路径不是目录', current);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return;
      throw error;
    }
  }
}

export interface PathKind {
  exists: boolean;
  link: boolean;
  directory: boolean;
  broken: boolean;
  target?: string;
}

/** 使用 lstat 识别实体目录、目录链接和损坏链接。 */
export async function inspectPath(candidate: string): Promise<PathKind> {
  try {
    const info = await lstat(candidate);
    if (!info.isSymbolicLink())
      return { exists: true, link: false, directory: info.isDirectory(), broken: false };
    const target = await readlink(candidate);
    try {
      const followed = await stat(candidate);
      return { exists: true, link: true, directory: followed.isDirectory(), broken: false, target };
    } catch (error) {
      if (isNodeError(error, 'ENOENT'))
        return { exists: true, link: true, directory: false, broken: true, target };
      throw error;
    }
  } catch (error) {
    if (isNodeError(error, 'ENOENT'))
      return { exists: false, link: false, directory: false, broken: false };
    throw error;
  }
}

/** 取得存在路径的规范真实路径。 */
export async function canonicalizeExisting(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (isNodeError(error, 'ENOENT'))
      throw new BackendException('PATH_NOT_FOUND', '路径不存在或目录链接已损坏', candidate);
    throw error;
  }
}

/** 验证目录链接由本工具拥有且指向预期实体。 */
export async function assertOwnedJunction(linkPath: string, expectedTarget: string): Promise<void> {
  const kind = await inspectPath(linkPath);
  if (!kind.exists) return;
  if (!kind.link || kind.broken)
    throw new BackendException('PATH_CONFLICT', '预期的目录联接已被替换或损坏', linkPath);
  const actual = await canonicalizeExisting(linkPath);
  const expected = await canonicalizeExisting(expectedTarget);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new BackendException('PATH_CONFLICT', '目录联接不再指向本工具管理的 Skill', linkPath);
  }
}

/** 返回 Windows 系统可执行文件的绝对路径。 */
export function windowsExecutable(name: 'powershell' | 'where' | 'taskkill'): string {
  const windows = path.resolve(process.env.SystemRoot ?? 'C:\\Windows');
  if (name === 'powershell')
    return path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return path.join(windows, 'System32', `${name}.exe`);
}

export function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (code === undefined || (error as NodeJS.ErrnoException).code === code)
  );
}
