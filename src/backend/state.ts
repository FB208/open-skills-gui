import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import type {
  AgentTarget,
  AppState,
  SkillRecord,
  SkillSource,
  UpdateStatus,
} from '../shared/types.js';
import { BackendException } from './errors.js';
import { AsyncMutex } from './mutex.js';
import type { PathLayout } from './paths.js';
import { assertDirectChild, assertSkillName, isNodeError } from './paths.js';

export const EMPTY_STATE: AppState = {
  schemaVersion: 1,
  settings: { onboardingCompleted: false, legacyDecisionMade: false },
  skills: {},
};

/** 使用备份切换和故障恢复持久化 UTF-8 v1 状态。 */
export class StateRepository {
  private readonly mutex = new AsyncMutex();
  private readonly backupPath: string;

  constructor(
    private readonly filePath: string,
    private readonly layout?: PathLayout,
  ) {
    this.backupPath = `${filePath}.backup`;
  }

  /** 读取并严格校验当前状态，必要时恢复原子替换备份。 */
  async load(): Promise<AppState> {
    return await this.mutex.runExclusive(() => this.loadUnlocked());
  }

  /** 串行、原子地保存完整状态。 */
  async save(state: AppState): Promise<void> {
    await this.mutex.runExclusive(() => this.saveUnlocked(state));
  }

  /** 在仓库互斥锁内读取、修改并保存状态。 */
  async update<T>(operation: (state: AppState) => T | Promise<T>): Promise<T> {
    return await this.mutex.runExclusive(async () => {
      const state = await this.loadUnlocked();
      const result = await operation(state);
      await this.saveUnlocked(state);
      return result;
    });
  }

  /** 在已持锁条件下读取状态或恢复备份。 */
  private async loadUnlocked(): Promise<AppState> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const value = validateState(JSON.parse(await readFile(this.filePath, 'utf8')), this.layout);
      await rm(this.backupPath, { force: true }).catch(() => undefined);
      return value;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        if (error instanceof SyntaxError)
          throw new BackendException('STATE_CORRUPT', '用户数据文件已损坏', error.message);
        throw error;
      }
    }
    try {
      const recovered = validateState(
        JSON.parse(await readFile(this.backupPath, 'utf8')),
        this.layout,
      );
      await rename(this.backupPath, this.filePath);
      return recovered;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return structuredClone(EMPTY_STATE);
      if (error instanceof SyntaxError)
        throw new BackendException('STATE_CORRUPT', '用户数据备份已损坏', error.message);
      throw error;
    }
  }

  /** 在已持锁条件下用临时文件和备份完成原子替换。 */
  private async saveUnlocked(state: AppState): Promise<void> {
    validateState(state, this.layout);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.incoming`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    let movedCurrent = false;
    let newStateInstalled = false;
    try {
      await rm(this.backupPath, { force: true });
      try {
        await rename(this.filePath, this.backupPath);
        movedCurrent = true;
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
      await rename(temporary, this.filePath);
      newStateInstalled = true;
      await rm(this.backupPath, { force: true }).catch(() => undefined);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (movedCurrent && !newStateInstalled)
        await rename(this.backupPath, this.filePath).catch(() => undefined);
      throw new BackendException(
        'STATE_WRITE_FAILED',
        '保存用户数据失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/** 严格校验 schemaVersion=1，不接受旧结构或隐式迁移。 */
export function validateState(value: unknown, layout?: PathLayout): AppState {
  assertObject(value, '用户数据格式无效');
  assertExactKeys(value, ['schemaVersion', 'settings', 'skills'], '用户数据');
  if (value.schemaVersion !== 1)
    throw new BackendException('STATE_VERSION_UNSUPPORTED', '不支持的用户数据版本');
  assertObject(value.settings, '用户设置格式无效');
  assertExactKeys(
    value.settings,
    [
      'onboardingCompleted',
      'legacyDecisionMade',
      'selectedNodePath',
      'selectedNpxPath',
      'selectedGitPath',
    ],
    '用户设置',
  );
  if (
    typeof value.settings.onboardingCompleted !== 'boolean' ||
    typeof value.settings.legacyDecisionMade !== 'boolean'
  ) {
    throw new BackendException('STATE_CORRUPT', '用户设置格式无效');
  }
  for (const key of ['selectedNodePath', 'selectedNpxPath', 'selectedGitPath'] as const) {
    const candidate = value.settings[key];
    if (candidate !== undefined && (typeof candidate !== 'string' || !path.isAbsolute(candidate))) {
      throw new BackendException('STATE_CORRUPT', `运行环境路径 ${key} 无效`);
    }
  }
  assertObject(value.skills, 'Skill 记录集合无效');
  if (Array.isArray(value.skills))
    throw new BackendException('STATE_CORRUPT', 'Skill 记录集合无效');
  for (const [id, record] of Object.entries(value.skills)) validateRecord(id, record, layout);
  return value as unknown as AppState;
}

/** 校验单条 Skill 记录的字段、状态组合和路径。 */
function validateRecord(
  id: string,
  value: unknown,
  layout?: PathLayout,
): asserts value is SkillRecord {
  assertObject(value, `Skill 记录 ${id} 无效`);
  assertExactKeys(
    value,
    [
      'id',
      'name',
      'source',
      'state',
      'managed',
      'targets',
      'canonicalPath',
      'disabledPath',
      'observedPaths',
      'baselineHash',
      'localHash',
      'remoteHash',
      'updateStatus',
      'note',
      'createdAt',
      'updatedAt',
    ],
    `Skill 记录 ${id}`,
  );
  if (
    !isRecordId(id) ||
    value.id !== id ||
    typeof value.name !== 'string' ||
    typeof value.note !== 'string' ||
    value.note.length > 4000
  )
    fail(id);
  assertSkillName(value.name);
  if (
    !['enabled', 'disabled', 'uninstalled'].includes(String(value.state)) ||
    typeof value.managed !== 'boolean'
  )
    fail(id);
  validateSource(value.source, id);
  if (
    !Array.isArray(value.targets) ||
    value.targets.length === 0 ||
    !value.targets.every((target) => TARGETS.has(target as AgentTarget))
  )
    fail(id);
  if (new Set(value.targets).size !== value.targets.length) fail(id);
  if (
    !Array.isArray(value.observedPaths) ||
    !value.observedPaths.every((item) => typeof item === 'string' && path.isAbsolute(item))
  )
    fail(id);
  if (
    new Set(value.observedPaths.map((item) => path.resolve(item).toLowerCase())).size !==
    value.observedPaths.length
  )
    fail(id);
  if (!UPDATE_STATUSES.has(value.updateStatus as UpdateStatus)) fail(id);
  for (const key of ['baselineHash', 'localHash', 'remoteHash'] as const) {
    const hash = value[key];
    if (hash !== undefined && (typeof hash !== 'string' || !/^[a-f\d]{64}$/i.test(hash))) fail(id);
  }
  for (const key of ['createdAt', 'updatedAt'] as const) {
    const time = value[key];
    if (
      typeof time !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time) ||
      !Number.isFinite(Date.parse(time))
    )
      fail(id);
  }
  const canonical = optionalAbsolute(value.canonicalPath, id);
  const disabled = optionalAbsolute(value.disabledPath, id);
  if (value.state === 'enabled' && (!canonical || disabled)) fail(id);
  if (value.state === 'disabled' && (!disabled || canonical || value.observedPaths.length !== 0))
    fail(id);
  if (value.state === 'uninstalled' && (canonical || disabled || value.observedPaths.length !== 0))
    fail(id);
  if (layout) validateRecordPaths(value as unknown as SkillRecord, layout);
}

/** 校验记录路径均落在对应的直接子目录中。 */
function validateRecordPaths(record: SkillRecord, layout: PathLayout): void {
  const canonical = record.canonicalPath;
  if (canonical) {
    const roots = record.managed
      ? [layout.targetRoots.universal]
      : Object.values(layout.targetRoots);
    if (
      !roots.some((root) => isDirectChild(root, canonical)) ||
      path.basename(canonical).toLowerCase() !== record.name.toLowerCase()
    )
      fail(record.id);
  }
  if (record.disabledPath) assertDirectChild(layout.disabledDir, record.disabledPath, record.id);
  for (const observed of record.observedPaths) {
    if (
      !Object.values(layout.targetRoots).some((root) => isDirectChild(root, observed)) ||
      path.basename(observed).toLowerCase() !== record.name.toLowerCase()
    ) {
      fail(record.id);
    }
  }
}

/** 校验 Skill 来源对象的固定结构。 */
function validateSource(value: unknown, id: string): asserts value is SkillSource {
  assertObject(value, `Skill 记录 ${id} 来源无效`);
  assertExactKeys(value, ['type', 'locator', 'ref', 'skillPath'], `Skill 记录 ${id} 来源`);
  if (
    !['github', 'git', 'local', 'unknown'].includes(String(value.type)) ||
    typeof value.locator !== 'string'
  )
    fail(id);
  if (value.type !== 'unknown' && value.locator.trim().length === 0) fail(id);
  if (value.ref !== undefined && typeof value.ref !== 'string') fail(id);
  if (
    value.skillPath !== undefined &&
    (typeof value.skillPath !== 'string' ||
      path.isAbsolute(value.skillPath) ||
      value.skillPath.split(/[\\/]/).includes('..'))
  )
    fail(id);
}

/** 读取可选绝对路径，非法时按记录损坏处理。 */
function optionalAbsolute(value: unknown, id: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(id);
  return value;
}

/** 判断路径是否为指定根目录的直接子项。 */
function isDirectChild(root: string, candidate: string): boolean {
  return path.dirname(path.resolve(candidate)).toLowerCase() === path.resolve(root).toLowerCase();
}

/** 拒绝状态对象中的未知字段。 */
function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new BackendException('STATE_CORRUPT', `${label}包含未知字段：${unknown}`);
}

/** 判断记录编号是否为 UUID 或稳定的 32 位十六进制编号。 */
function isRecordId(value: string): boolean {
  return (
    /^[a-f0-9]{32}$/i.test(value) ||
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  );
}

/** 断言输入为非数组对象。 */
function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BackendException('STATE_CORRUPT', message);
}

/** 统一抛出单条 Skill 记录损坏错误。 */
function fail(id: string): never {
  throw new BackendException('STATE_CORRUPT', `Skill 记录 ${id} 无效`);
}

const TARGETS = new Set<AgentTarget>(['universal', 'claude-code', 'windsurf']);
const UPDATE_STATUSES = new Set<UpdateStatus>([
  'latest',
  'available',
  'local-modified',
  'conflict',
  'unavailable',
  'failed',
  'unchecked',
]);
