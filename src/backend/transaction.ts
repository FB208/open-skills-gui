import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, open, readFile, rename, rm, symlink } from 'node:fs/promises';
import type { AppState } from '../shared/types.js';
import { BackendException } from './errors.js';
import type { PathLayout } from './paths.js';
import {
  assertDirectChild,
  assertNoLinkedParents,
  assertOwnedJunction,
  inspectPath,
  isNodeError,
  isWithin,
} from './paths.js';
import type { StateRepository } from './state.js';
import { validateState } from './state.js';
import type { FileLockManager } from './windows-locks.js';
import { withFileLockHandling } from './windows-locks.js';

type UndoAction =
  | { kind: 'move'; from: string; to: string }
  | { kind: 'remove-link'; path: string; target: string }
  | { kind: 'create-link'; path: string; target: string }
  | { kind: 'remove-directory'; path: string };

interface FileSnapshot {
  exists: boolean;
  contentBase64?: string;
}

interface OperationJournal {
  schemaVersion: 1;
  phase: 'applying' | 'committed';
  stateBefore: AppState;
  officialLockBefore: FileSnapshot;
  actions: UndoAction[];
  cleanup: string[];
}

const MAX_LOCK_SNAPSHOT_BYTES = 16 * 1024 * 1024;

/** 记录文件反向操作，使领域事务在失败或重启后可恢复。 */
export class FileTransaction {
  private journal: OperationJournal;

  private constructor(
    private readonly layout: PathLayout,
    private readonly repository: StateRepository,
    private readonly locks: FileLockManager,
    private readonly force: boolean,
    stateBefore: AppState,
    officialLockBefore: FileSnapshot,
  ) {
    this.journal = {
      schemaVersion: 1,
      phase: 'applying',
      stateBefore: structuredClone(stateBefore),
      officialLockBefore,
      actions: [],
      cleanup: [],
    };
  }

  static async begin(
    layout: PathLayout,
    repository: StateRepository,
    locks: FileLockManager,
    stateBefore: AppState,
    force = false,
  ): Promise<FileTransaction> {
    await assertTransactionRoots(layout);
    if ((await inspectPath(layout.journalFile)).exists)
      throw new BackendException('TRANSACTION_ACTIVE', '存在尚未恢复的文件事务');
    const officialLockBefore = await captureOfficialLock(layout);
    const transaction = new FileTransaction(
      layout,
      repository,
      locks,
      force,
      stateBefore,
      officialLockBefore,
    );
    await transaction.persistJournal();
    return transaction;
  }

  /** 移动目录，并预先登记反向移动。 */
  async move(source: string, destination: string): Promise<void> {
    assertAllowedEntityPath(this.layout, source);
    assertAllowedEntityPath(this.layout, destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await this.append({ kind: 'move', from: destination, to: source });
    await withFileLockHandling(source, this.force, this.locks, () => rename(source, destination));
  }

  /** 登记随后由受信任 CLI 创建的目录。 */
  async trackCreatedDirectory(candidate: string): Promise<void> {
    assertAllowedEntityPath(this.layout, candidate);
    if ((await inspectPath(candidate)).exists)
      throw new BackendException('PATH_CONFLICT', '待创建目录已经存在', candidate);
    await this.append({ kind: 'remove-directory', path: candidate });
  }

  /** 将待删除实体移到事务垃圾区，提交后再清理。 */
  async removeDirectory(source: string): Promise<void> {
    const trash = path.join(this.layout.stagingDir, `trash-${randomUUID()}`);
    await this.markCleanup(trash);
    await this.move(source, trash);
  }

  /** 创建本工具管理的目录联接。 */
  async createJunction(linkPath: string, target: string): Promise<void> {
    assertAllowedLink(this.layout, linkPath, target);
    await mkdir(path.dirname(linkPath), { recursive: true });
    await this.append({ kind: 'remove-link', path: linkPath, target });
    await symlink(target, linkPath, 'junction');
  }

  /** 删除确认指向预期实体的目录联接。 */
  async removeJunction(linkPath: string, target: string): Promise<void> {
    assertAllowedLink(this.layout, linkPath, target);
    const kind = await inspectPath(linkPath);
    if (!kind.exists) return;
    await assertOwnedJunction(linkPath, target);
    await this.append({ kind: 'create-link', path: linkPath, target });
    await withFileLockHandling(linkPath, this.force, this.locks, () =>
      rm(linkPath, { recursive: true, force: true }),
    );
  }

  /** 标记仅在事务提交后清理的 staging 路径。 */
  async markCleanup(candidate: string): Promise<void> {
    if (!isWithin(this.layout.stagingDir, candidate))
      throw new BackendException('UNSAFE_PATH', '事务清理路径不在 staging 内', candidate);
    this.journal.cleanup.push(path.resolve(candidate));
    await this.persistJournal();
  }

  /** 保存新状态并提交，然后清理事务备份。 */
  async commit(stateAfter: AppState): Promise<void> {
    await this.repository.save(stateAfter);
    this.journal.phase = 'committed';
    await this.persistJournal();
    await this.cleanup();
    await removeJournalFiles(this.layout);
  }

  /** 回滚文件和状态。 */
  async rollback(): Promise<void> {
    await rollbackActions(this.layout, this.journal.actions);
    await restoreOfficialLock(this.layout, this.journal.officialLockBefore);
    await this.repository.save(this.journal.stateBefore);
    await this.cleanup();
    await removeJournalFiles(this.layout);
  }

  /** 校验并持久化一条反向操作。 */
  private async append(action: UndoAction): Promise<void> {
    validateAction(this.layout, action);
    this.journal.actions.push(action);
    await this.persistJournal();
  }

  /** 用已同步临时文件和备份原子替换事务日志。 */
  private async persistJournal(): Promise<void> {
    await mkdir(path.dirname(this.layout.journalFile), { recursive: true });
    const incoming = `${this.layout.journalFile}.incoming`;
    const backup = `${this.layout.journalFile}.backup`;
    const handle = await open(incoming, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(this.journal, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rm(backup, { force: true });
    try {
      await rename(this.layout.journalFile, backup);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    try {
      await rename(incoming, this.layout.journalFile);
    } catch (error) {
      await rename(backup, this.layout.journalFile).catch(() => undefined);
      throw error;
    }
    await rm(backup, { force: true }).catch(() => undefined);
  }

  /** 清理仅在事务结束后可删除的暂存路径。 */
  private async cleanup(): Promise<void> {
    await Promise.all(
      this.journal.cleanup.map((candidate) =>
        rm(candidate, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  }
}

/** 启动时恢复未提交事务，并清理 staging 残留。 */
export async function recoverFileTransaction(
  layout: PathLayout,
  repository: StateRepository,
): Promise<void> {
  await assertTransactionRoots(layout);
  const journal = await loadJournal(layout);
  if (journal) {
    if (journal.phase === 'applying') {
      await rollbackActions(layout, journal.actions);
      await restoreOfficialLock(layout, journal.officialLockBefore);
      await repository.save(journal.stateBefore);
    }
    await Promise.all(
      journal.cleanup.map((candidate) =>
        rm(candidate, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
    await removeJournalFiles(layout);
  }
  await rm(layout.stagingDir, { recursive: true, force: true });
  await mkdir(layout.stagingDir, { recursive: true });
}

/** 从主文件、备份或传入文件中读取首份有效事务日志。 */
async function loadJournal(layout: PathLayout): Promise<OperationJournal | undefined> {
  const candidates = [
    layout.journalFile,
    `${layout.journalFile}.backup`,
    `${layout.journalFile}.incoming`,
  ];
  let invalid: unknown;
  let existing = false;
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf8');
      existing = true;
      return parseJournal(JSON.parse(raw), layout);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) continue;
      existing = true;
      invalid ??= error;
    }
  }
  if (existing) {
    throw new BackendException(
      'TRANSACTION_JOURNAL_CORRUPT',
      '操作日志已损坏，无法安全恢复',
      invalid instanceof Error ? invalid.message : String(invalid),
    );
  }
  return undefined;
}

/** 逆序执行已登记的文件反向操作。 */
async function rollbackActions(layout: PathLayout, actions: UndoAction[]): Promise<void> {
  for (const action of [...actions].reverse()) {
    validateAction(layout, action);
    if (action.kind === 'move') {
      const source = await inspectPath(action.from);
      const destination = await inspectPath(action.to);
      if (source.exists && destination.exists)
        throw new BackendException(
          'TRANSACTION_RECOVERY_CONFLICT',
          '事务恢复路径同时存在',
          action.to,
        );
      if (source.exists) {
        await mkdir(path.dirname(action.to), { recursive: true });
        await rename(action.from, action.to);
      } else if (!destination.exists) {
        throw new BackendException(
          'TRANSACTION_RECOVERY_CONFLICT',
          '事务恢复所需目录已经丢失',
          action.to,
        );
      }
    } else if (action.kind === 'remove-link') {
      const kind = await inspectPath(action.path);
      if (kind.exists) {
        await assertOwnedJunction(action.path, action.target);
        await rm(action.path, { recursive: true, force: true });
      }
    } else if (action.kind === 'create-link') {
      if ((await inspectPath(action.path)).exists) {
        await assertOwnedJunction(action.path, action.target);
      } else {
        await mkdir(path.dirname(action.path), { recursive: true });
        await symlink(action.target, action.path, 'junction');
      }
    } else if ((await inspectPath(action.path)).exists) {
      await rm(action.path, { recursive: true, force: true });
    }
  }
}

/** 严格解析版本 1 事务日志。 */
function parseJournal(value: unknown, layout: PathLayout): OperationJournal {
  if (!value || typeof value !== 'object')
    throw new BackendException('TRANSACTION_JOURNAL_CORRUPT', '操作日志格式无效');
  const journal = value as Partial<OperationJournal>;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'schemaVersion',
          'phase',
          'stateBefore',
          'officialLockBefore',
          'actions',
          'cleanup',
        ].includes(key),
    ) ||
    journal.schemaVersion !== 1 ||
    !['applying', 'committed'].includes(journal.phase ?? '') ||
    !Array.isArray(journal.actions) ||
    !Array.isArray(journal.cleanup)
  ) {
    throw new BackendException('TRANSACTION_JOURNAL_CORRUPT', '操作日志格式无效');
  }
  const stateBefore = validateState(journal.stateBefore, layout);
  const officialLockBefore = parseFileSnapshot(journal.officialLockBefore);
  for (const action of journal.actions) validateAction(layout, action);
  for (const candidate of journal.cleanup) {
    if (typeof candidate !== 'string' || !isWithin(layout.stagingDir, candidate))
      throw new BackendException('TRANSACTION_JOURNAL_CORRUPT', '操作日志清理路径无效');
  }
  return { ...journal, stateBefore, officialLockBefore } as OperationJournal;
}

/** 严格校验官方锁快照的字段、Base64 规范形式和大小。 */
function parseFileSnapshot(value: unknown): FileSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BackendException('TRANSACTION_JOURNAL_CORRUPT', '官方锁快照格式无效');
  const snapshot = value as Record<string, unknown>;
  if (snapshot.exists === false && exactKeys(snapshot, ['exists'])) return { exists: false };
  if (
    snapshot.exists !== true ||
    !exactKeys(snapshot, ['exists', 'contentBase64']) ||
    typeof snapshot.contentBase64 !== 'string'
  ) {
    throw new BackendException('TRANSACTION_JOURNAL_CORRUPT', '官方锁快照格式无效');
  }
  const bytes = Buffer.from(snapshot.contentBase64, 'base64');
  if (
    bytes.byteLength > MAX_LOCK_SNAPSHOT_BYTES ||
    bytes.toString('base64') !== snapshot.contentBase64
  ) {
    throw new BackendException('TRANSACTION_JOURNAL_CORRUPT', '官方锁快照内容无效');
  }
  return { exists: true, contentBase64: snapshot.contentBase64 };
}

/** 严格校验动作字段和全部路径边界。 */
function validateAction(layout: PathLayout, action: unknown): asserts action is UndoAction {
  if (
    !action ||
    typeof action !== 'object' ||
    typeof (action as { kind?: unknown }).kind !== 'string'
  )
    throw new BackendException('TRANSACTION_JOURNAL_CORRUPT', '操作日志动作无效');
  const item = action as Record<string, unknown>;
  if (
    item.kind === 'move' &&
    exactKeys(item, ['kind', 'from', 'to']) &&
    typeof item.from === 'string' &&
    typeof item.to === 'string'
  ) {
    assertAllowedEntityPath(layout, item.from);
    assertAllowedEntityPath(layout, item.to);
    return;
  }
  if (
    (item.kind === 'remove-link' || item.kind === 'create-link') &&
    exactKeys(item, ['kind', 'path', 'target']) &&
    typeof item.path === 'string' &&
    typeof item.target === 'string'
  ) {
    assertAllowedLink(layout, item.path, item.target);
    return;
  }
  if (
    item.kind === 'remove-directory' &&
    exactKeys(item, ['kind', 'path']) &&
    typeof item.path === 'string'
  ) {
    assertAllowedEntityPath(layout, item.path);
    return;
  }
  throw new BackendException('TRANSACTION_JOURNAL_CORRUPT', '操作日志动作无效');
}

/** 判断对象是否恰好包含指定字段。 */
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

/** 验证恢复涉及的全部根目录未被目录链接重定向。 */
async function assertTransactionRoots(layout: PathLayout): Promise<void> {
  for (const root of Object.values(layout.targetRoots))
    await assertNoLinkedParents(layout.homeDir, root);
  const dataParent = path.dirname(layout.dataRoot);
  await assertNoLinkedParents(dataParent, layout.disabledDir);
  await assertNoLinkedParents(dataParent, layout.stagingDir);
}

/** 校验事务实体路径属于暂存区、禁用区或 Agent 直接子项。 */
function assertAllowedEntityPath(layout: PathLayout, candidate: string): void {
  if (isWithin(layout.stagingDir, candidate)) return;
  if (
    path.dirname(path.resolve(candidate)).toLowerCase() ===
    path.resolve(layout.disabledDir).toLowerCase()
  ) {
    assertDirectChild(layout.disabledDir, candidate);
    return;
  }
  for (const root of Object.values(layout.targetRoots)) {
    if (path.dirname(path.resolve(candidate)).toLowerCase() === path.resolve(root).toLowerCase()) {
      assertDirectChild(root, candidate);
      return;
    }
  }
  throw new BackendException('UNSAFE_PATH', '事务路径不在允许目录中', candidate);
}

/** 校验受管联接位于专用目录且指向通用实体。 */
function assertAllowedLink(layout: PathLayout, linkPath: string, target: string): void {
  const linkRoot = Object.values(layout.targetRoots).find(
    (root) =>
      path.dirname(path.resolve(linkPath)).toLowerCase() === path.resolve(root).toLowerCase(),
  );
  if (!linkRoot || linkRoot.toLowerCase() === layout.targetRoots.universal.toLowerCase())
    throw new BackendException('UNSAFE_PATH', '目录联接位置无效', linkPath);
  assertDirectChild(linkRoot, linkPath);
  assertDirectChild(layout.targetRoots.universal, target);
}

/** 返回 skills 1.5.19 的官方全局锁路径。 */
function officialLockPath(layout: PathLayout): string {
  return path.join(layout.homeDir, '.agents', '.skill-lock.json');
}

/** 在事务首条动作前捕获官方锁的原始字节。 */
async function captureOfficialLock(layout: PathLayout): Promise<FileSnapshot> {
  const file = officialLockPath(layout);
  await assertNoLinkedParents(layout.homeDir, path.dirname(file));
  const kind = await inspectPath(file);
  if (!kind.exists) return { exists: false };
  if (kind.link || kind.directory)
    throw new BackendException('LOCK_FILE_INVALID', '官方 Skill 锁路径不是普通文件', file);
  const bytes = await readFile(file);
  if (bytes.byteLength > MAX_LOCK_SNAPSHOT_BYTES)
    throw new BackendException('LOCK_FILE_INVALID', '官方 Skill 锁文件超过安全大小上限');
  return { exists: true, contentBase64: bytes.toString('base64') };
}

/** 根据日志快照原子恢复官方锁，或恢复为事务前不存在的状态。 */
async function restoreOfficialLock(layout: PathLayout, snapshot: FileSnapshot): Promise<void> {
  const file = officialLockPath(layout);
  await assertNoLinkedParents(layout.homeDir, path.dirname(file));
  const current = await inspectPath(file);
  if (current.exists && (current.link || current.directory))
    throw new BackendException('LOCK_FILE_INVALID', '官方 Skill 锁路径不是普通文件', file);
  if (!snapshot.exists) {
    await rm(file, { force: true });
    return;
  }
  const bytes = Buffer.from(snapshot.contentBase64 as string, 'base64');
  await writeFileAtomically(file, bytes);
}

/** 用同目录同步临时文件原子替换官方锁内容。 */
async function writeFileAtomically(file: string, content: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const incoming = `${file}.${randomUUID()}.incoming`;
  const backup = `${file}.${randomUUID()}.backup`;
  const handle = await open(incoming, 'wx');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  let moved = false;
  try {
    try {
      await rename(file, backup);
      moved = true;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    await rename(incoming, file);
    await rm(backup, { force: true }).catch(() => undefined);
  } catch (error) {
    await rm(incoming, { force: true }).catch(() => undefined);
    if (moved) await rename(backup, file).catch(() => undefined);
    throw error;
  }
}

/** 删除事务日志的所有原子替换候选文件。 */
async function removeJournalFiles(layout: PathLayout): Promise<void> {
  await Promise.all(
    [layout.journalFile, `${layout.journalFile}.backup`, `${layout.journalFile}.incoming`].map(
      (candidate) => rm(candidate, { force: true }).catch(() => undefined),
    ),
  );
}
