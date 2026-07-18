import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { AgentTarget, AppState, SkillRecord, SkillSource } from '../shared/types.js';
import { BackendException } from './errors.js';
import { hashDirectory } from './hash.js';
import type { PathLayout } from './paths.js';
import { assertDirectChild, canonicalizeExisting, inspectPath, isNodeError } from './paths.js';
import type { StateRepository } from './state.js';
import type { SkillsClient } from './skills-cli.js';
import { normalizeSource, sourceKey } from './skills-cli.js';

export interface LockMetadata {
  source: SkillSource;
}

interface DiscoveredSkill {
  name: string;
  canonicalPath: string;
  observedPaths: string[];
  targets: AgentTarget[];
  localHash?: string;
  lock?: LockMetadata;
}

/** 扫描三个全局目录，并结合 CLI 清单与官方锁来源。 */
export class SkillScanner {
  constructor(
    private readonly layout: PathLayout,
    private readonly repository: StateRepository,
    private readonly cli?: SkillsClient,
  ) {}

  /** 扫描三类全局目录并把发现结果合并到状态。 */
  async scan(): Promise<{ skills: SkillRecord[]; legacyDetected: boolean }> {
    const locks = await readOfficialLock(
      path.join(this.layout.homeDir, '.agents', '.skill-lock.json'),
    );
    const cliNames = await this.readCliNames();
    const discovered = await discoverRoots(this.layout, locks, cliNames);
    return await this.repository.update((state) => {
      mergeDiscovered(state, discovered);
      const skills = visibleSkills(state);
      return {
        skills,
        legacyDetected:
          !state.settings.legacyDecisionMade && skills.some((skill) => !skill.managed),
      };
    });
  }

  /** 读取官方 CLI 视角下的全局 Skill 名称。 */
  private async readCliNames(): Promise<Set<string>> {
    if (!this.cli) return new Set();
    return new Set(
      (await this.cli.list(this.layout.homeDir)).map((skill) => skill.name.toLowerCase()),
    );
  }
}

/** 返回未卸载记录，并按中文名称稳定排序。 */
export function visibleSkills(state: AppState): SkillRecord[] {
  return Object.values(state.skills)
    .filter((skill) => skill.state !== 'uninstalled')
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

/** 遍历支持的根目录并验证实体、联接和 SKILL.md。 */
async function discoverRoots(
  layout: PathLayout,
  locks: Map<string, LockMetadata>,
  cliNames: Set<string>,
): Promise<DiscoveredSkill[]> {
  const grouped = new Map<
    string,
    Array<{ path: string; canonical: string; target: AgentTarget; hash: string }>
  >();
  for (const [target, root] of Object.entries(layout.targetRoots) as Array<[AgentTarget, string]>) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) continue;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const observed = path.join(root, entry.name);
      assertDirectChild(root, observed, entry.name);
      const kind = await inspectPath(observed);
      if (!kind.exists || kind.broken || !kind.directory) continue;
      if (target === 'universal' && kind.link) continue;
      let canonical: string;
      try {
        if (kind.link) {
          const expected = path.join(layout.targetRoots.universal, entry.name);
          assertDirectChild(layout.targetRoots.universal, expected, entry.name);
          const expectedKind = await inspectPath(expected);
          if (!expectedKind.exists || expectedKind.link || !expectedKind.directory) continue;
          const [actualRealPath, expectedRealPath] = await Promise.all([
            canonicalizeExisting(observed),
            canonicalizeExisting(expected),
          ]);
          if (normalizedPath(actualRealPath) !== normalizedPath(expectedRealPath)) continue;
          canonical = expected;
        } else {
          canonical = path.resolve(observed);
        }
        const skillFile = path.join(canonical, 'SKILL.md');
        if (!(await stat(skillFile)).isFile()) continue;
        const hash = await hashDirectory(canonical);
        const candidates = grouped.get(entry.name.toLowerCase()) ?? [];
        candidates.push({ path: observed, canonical, target, hash });
        grouped.set(entry.name.toLowerCase(), candidates);
      } catch {
        // 损坏、无权限或不是有效 Skill 的目录不进入清单。
      }
    }
  }

  return [...grouped.entries()].map(([key, candidates]) => {
    const preferred =
      candidates.find((candidate) => candidate.target === 'universal') ?? candidates[0];
    const targets = [...new Set(candidates.map((candidate) => candidate.target))];
    // 仅对 CLI 同时识别出的条目绑定官方来源，实体目录仍是扫描事实。
    const lock = cliNames.has(key) ? locks.get(key) : undefined;
    return {
      name: path.basename(preferred.path),
      canonicalPath: preferred.canonical,
      observedPaths: [...new Set(candidates.map((candidate) => candidate.path))],
      targets,
      localHash: preferred.hash,
      lock,
    };
  });
}

/** 将本次扫描结果合并进状态，并隐藏已消失的未托管记录。 */
function mergeDiscovered(state: AppState, discovered: DiscoveredSkill[]): void {
  const matched = new Set<string>();
  for (const item of discovered) {
    const source = item.lock?.source ?? { type: 'unknown' as const, locator: '' };
    const existing = findExisting(state, item, source, matched);
    const timestamp = new Date().toISOString();
    if (existing) {
      existing.name = item.name;
      if (!existing.managed && existing.source.type === 'unknown' && item.lock)
        existing.source = item.lock.source;
      existing.state = 'enabled';
      existing.canonicalPath = item.canonicalPath;
      existing.disabledPath = undefined;
      existing.observedPaths = item.observedPaths;
      existing.targets = [...new Set([...existing.targets, ...item.targets])];
      existing.localHash = item.localHash;
      existing.updatedAt = timestamp;
      matched.add(existing.id);
      continue;
    }
    const id = source.type === 'unknown' ? randomUUID() : stableSkillId(source, item.name);
    const recordId =
      state.skills[id] && state.skills[id].state !== 'uninstalled' ? randomUUID() : id;
    const tombstone = state.skills[id]?.state === 'uninstalled' ? state.skills[id] : undefined;
    state.skills[recordId] = {
      id: recordId,
      name: item.name,
      source,
      state: 'enabled',
      managed: false,
      targets: item.targets,
      canonicalPath: item.canonicalPath,
      observedPaths: item.observedPaths,
      localHash: item.localHash,
      updateStatus: 'unchecked',
      note: tombstone?.note ?? '',
      createdAt: tombstone?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    matched.add(recordId);
  }
  for (const record of Object.values(state.skills)) {
    if (record.state === 'enabled' && !record.managed && !matched.has(record.id)) {
      record.state = 'uninstalled';
      record.canonicalPath = undefined;
      record.observedPaths = [];
      record.localHash = undefined;
      record.updatedAt = new Date().toISOString();
    }
  }
}

/** 按路径、稳定身份或旧名称匹配现有记录。 */
function findExisting(
  state: AppState,
  item: DiscoveredSkill,
  source: SkillSource,
  matched: Set<string>,
): SkillRecord | undefined {
  const paths = new Set([item.canonicalPath, ...item.observedPaths].map(normalizedPath));
  return Object.values(state.skills).find((record) => {
    if (matched.has(record.id) || record.state === 'disabled') return false;
    const oldPaths = [record.canonicalPath, ...record.observedPaths]
      .filter((candidate): candidate is string => Boolean(candidate))
      .map(normalizedPath);
    if (oldPaths.some((candidate) => paths.has(candidate))) return true;
    if (source.type !== 'unknown' && record.id === stableSkillId(source, item.name)) return true;
    return !record.managed && record.name.toLowerCase() === item.name.toLowerCase();
  });
}

/** 根据规范化来源生成稳定身份。 */
export function stableSkillId(source: SkillSource, name: string): string {
  return createHash('sha256')
    .update(`${sourceKey(source)}\0${name.toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
}

/** 读取官方锁中的来源；官方文件夹哈希不作为本工具基准。 */
export async function readOfficialLock(filePath: string): Promise<Map<string, LockMetadata>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return new Map();
    const skills = (parsed as { skills?: unknown }).skills;
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return new Map();
    const output = new Map<string, LockMetadata>();
    for (const [key, unknownEntry] of Object.entries(skills)) {
      if (!unknownEntry || typeof unknownEntry !== 'object') continue;
      const entry = unknownEntry as Record<string, unknown>;
      const locator = firstString(entry.sourceUrl, entry.source, entry.repository, entry.repo);
      if (!locator) continue;
      const rawSkillPath = firstString(entry.skillPath, entry.path);
      const skillPath = sourceDirectory(rawSkillPath);
      const ref = firstString(entry.ref, entry.branch);
      const source = normalizeSource(locator, ref, skillPath);
      const name = firstString(entry.name) ?? key;
      output.set(name.toLowerCase(), { source });
    }
    return output;
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || error instanceof SyntaxError) return new Map();
    throw error;
  }
}

/** 严格读取安装后由 skills 1.5.19 写入的 v3 锁来源。 */
export async function readInstalledLockSource(
  filePath: string,
  skillName: string,
): Promise<SkillSource> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new BackendException('LOCK_FILE_INVALID', '官方 Skill 锁文件无法解析', filePath, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 3) {
    throw new BackendException('LOCK_FILE_INVALID', '官方 Skill 锁文件不是受支持的 v3 格式');
  }
  const skills = (parsed as { skills?: unknown }).skills;
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) {
    throw new BackendException('LOCK_FILE_INVALID', '官方 Skill 锁文件缺少 skills 对象');
  }
  const matches = Object.entries(skills).filter(([key, unknownEntry]) => {
    if (!unknownEntry || typeof unknownEntry !== 'object' || Array.isArray(unknownEntry))
      return false;
    const entry = unknownEntry as Record<string, unknown>;
    const name = firstString(entry.name) ?? key;
    return name.toLowerCase() === skillName.toLowerCase();
  });
  if (matches.length !== 1) {
    throw new BackendException(
      'LOCK_FILE_INVALID',
      matches.length === 0 ? '官方 Skill 锁文件未登记新安装项' : '官方 Skill 锁文件存在重复安装项',
      skillName,
    );
  }
  const entry = matches[0][1] as Record<string, unknown>;
  const sourceType = firstString(entry.sourceType);
  const locator = firstString(entry.sourceUrl, entry.source);
  const rawSkillPath = firstString(entry.skillPath);
  if ((sourceType && sourceType.toLowerCase() !== 'github') || !locator || !rawSkillPath) {
    throw new BackendException('LOCK_FILE_INVALID', '官方 Skill 锁记录缺少公开 GitHub 来源信息');
  }
  const source = normalizeSource(
    locator,
    firstString(entry.ref, entry.branch),
    sourceDirectory(rawSkillPath),
  );
  if (source.type !== 'github') {
    throw new BackendException('LOCK_FILE_INVALID', '官方 Skill 锁记录不是公开 GitHub 来源');
  }
  return source;
}

/** 将官方锁中指向 SKILL.md 的路径转换为 Skill 目录。 */
function sourceDirectory(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!/(?:^|\/)SKILL\.md$/i.test(normalized)) return normalized || undefined;
  const directory = path.posix.dirname(normalized);
  return directory === '.' ? undefined : directory;
}

/** 返回首个非空字符串字段。 */
function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

/** 生成用于 Windows 路径等价比较的键。 */
function normalizedPath(value: string): string {
  return path.resolve(value).toLowerCase();
}
