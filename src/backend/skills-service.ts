import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type {
  AgentTarget,
  AppState,
  RemoteSkillResult,
  SkillRecord,
  SkillSource,
} from '../shared/types.js';
import { BackendException } from './errors.js';
import { hashDirectory } from './hash.js';
import { AsyncMutex } from './mutex.js';
import type { PathLayout } from './paths.js';
import {
  assertDirectChild,
  assertNoLinkedParents,
  assertOwnedJunction,
  assertSkillName,
  canonicalizeExisting,
  inspectPath,
  isNodeError,
} from './paths.js';
import type { SkillScanner } from './scanner.js';
import { readInstalledLockSource, stableSkillId, visibleSkills } from './scanner.js';
import type { SkillsClient } from './skills-cli.js';
import { normalizeSource } from './skills-cli.js';
import type { StateRepository } from './state.js';
import { FileTransaction } from './transaction.js';
import type { FileLockManager } from './windows-locks.js';

export interface AdoptPayload {
  ids?: string[];
  decline?: boolean;
  sourceBindings?: Record<string, SkillSource>;
  conflictWinners?: Record<string, string>;
}

interface StagedSkill {
  homeDir: string;
  skillPath: string;
  hash: string;
}

/** 实现 Skill 搜索、接管、生命周期与隔离更新。 */
export class SkillsService {
  private readonly searches = new Map<string, AbortController>();

  constructor(
    private readonly layout: PathLayout,
    private readonly repository: StateRepository,
    private readonly scanner: SkillScanner,
    private readonly cli: SkillsClient,
    private readonly locks: FileLockManager,
    private readonly writes: AsyncMutex = new AsyncMutex(),
  ) {}

  /** 串行扫描本机全局 Skill 并合并状态。 */
  async scan(): Promise<{ skills: SkillRecord[]; legacyDetected: boolean }> {
    return await this.writes.runExclusive(async () => {
      await this.assertSafeRoots();
      return await this.scanner.scan();
    });
  }

  /** 执行可取消的远端模糊搜索。 */
  async searchRemote(query: string, requestId: string): Promise<RemoteSkillResult[]> {
    const controller = new AbortController();
    this.searches.get(requestId)?.abort();
    this.searches.set(requestId, controller);
    try {
      const installed = new Set(
        Object.values((await this.repository.load()).skills)
          .filter((skill) => skill.state !== 'uninstalled')
          .map((skill) => skill.name.toLowerCase()),
      );
      return await this.cli.find(query, installed, controller.signal);
    } finally {
      if (this.searches.get(requestId) === controller) this.searches.delete(requestId);
    }
  }

  /** 取消指定搜索，未指定编号时取消全部搜索。 */
  cancelSearch(requestId?: string): { cancelled: boolean } {
    if (requestId) {
      const controller = this.searches.get(requestId);
      controller?.abort();
      this.searches.delete(requestId);
      return { cancelled: Boolean(controller) };
    }
    const cancelled = this.searches.size > 0;
    for (const controller of this.searches.values()) controller.abort();
    this.searches.clear();
    return { cancelled };
  }

  /** 事务化接管旧 Skill，或记录用户拒绝接管。 */
  async adopt(payload: AdoptPayload = {}): Promise<SkillRecord[]> {
    return await this.writes.runExclusive(async () => {
      await this.assertSafeRoots();
      if (payload.decline) {
        return await this.repository.update((state) => {
          state.settings.legacyDecisionMade = true;
          return visibleSkills(state);
        });
      }
      const before = await this.repository.load();
      const selected = selectRecords(before, payload.ids).filter(
        (record) => record.state !== 'uninstalled' && !record.managed,
      );
      const next = structuredClone(before);
      const transaction = await FileTransaction.begin(
        this.layout,
        this.repository,
        this.locks,
        before,
      );
      try {
        for (const original of selected) {
          const record = structuredClone(requireRecord(next, original.id));
          if (payload.sourceBindings?.[record.id])
            record.source = normalizeBoundSource(payload.sourceBindings[record.id]);
          const adopted = await this.adoptOne(
            record,
            transaction,
            payload.conflictWinners?.[record.id],
          );
          const newId =
            record.source.type === 'unknown'
              ? record.id
              : stableSkillId(record.source, record.name);
          if (newId !== record.id) {
            const oldId = record.id;
            const collision = next.skills[newId];
            if (collision && collision.state !== 'uninstalled')
              throw new BackendException('SKILL_ID_CONFLICT', '已存在相同来源的 Skill');
            record.note ||= collision?.note ?? '';
            delete next.skills[oldId];
            record.id = newId;
          }
          Object.assign(record, adopted, {
            managed: true,
            updateStatus: record.source.type === 'github' ? 'unchecked' : 'unavailable',
            updatedAt: timestamp(),
          });
          next.skills[record.id] = record;
        }
        next.settings.legacyDecisionMade = true;
        await transaction.commit(next);
        return visibleSkills(next);
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      }
    });
  }

  /** 通过官方 CLI 安装并登记新的受管 Skill。 */
  async install(sourceInput: string, name: string, targets: AgentTarget[]): Promise<SkillRecord> {
    return await this.writes.runExclusive(async () => {
      await this.assertSafeRoots();
      assertSkillName(name);
      const source = normalizeSource(sourceInput);
      if (source.type !== 'github')
        throw new BackendException('UPDATE_UNAVAILABLE', '仅支持公开 GitHub Skill 来源');
      const before = await this.repository.load();
      if (
        Object.values(before.skills).some(
          (skill) =>
            skill.state !== 'uninstalled' && skill.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        throw new BackendException('SKILL_ALREADY_INSTALLED', `Skill「${name}」已安装`);
      }
      const destination = this.canonicalPath(name);
      if ((await inspectPath(destination)).exists)
        throw new BackendException('PATH_CONFLICT', '通用目录已经存在同名 Skill', destination);
      const transaction = await FileTransaction.begin(
        this.layout,
        this.repository,
        this.locks,
        before,
      );
      try {
        await transaction.trackCreatedDirectory(destination);
        await this.cli.add(source, name, { homeDir: this.layout.homeDir, targets });
        const installedSource = await readInstalledLockSource(officialLockPath(this.layout), name);
        assertInstalledSourceMatches(source, installedSource);
        await assertEntityDirectory(destination);
        const localHash = await validateSkillDirectory(destination);
        const normalizedTargets = uniqueTargets(['universal', ...targets]);
        const observedPaths = await this.createMissingLinks(
          name,
          normalizedTargets,
          destination,
          transaction,
        );
        const id = stableSkillId(installedSource, name);
        const old = before.skills[id];
        if (old && old.state !== 'uninstalled')
          throw new BackendException('SKILL_ID_CONFLICT', '已存在相同真实来源的 Skill');
        const now = timestamp();
        const record: SkillRecord = {
          id,
          name,
          source: installedSource,
          state: 'enabled',
          managed: true,
          targets: normalizedTargets,
          canonicalPath: destination,
          observedPaths,
          baselineHash: localHash,
          localHash,
          remoteHash: localHash,
          updateStatus: 'latest',
          note: old?.note ?? '',
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
        };
        const next = structuredClone(before);
        next.skills[id] = record;
        await transaction.commit(next);
        return record;
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      }
    });
  }

  /** 将禁用工作区副本事务化恢复到通用目录。 */
  async enable(id: string, force = false): Promise<SkillRecord> {
    return await this.writes.runExclusive(async () => {
      await this.assertSafeRoots();
      const before = await this.repository.load();
      const record = structuredClone(requireRecord(before, id));
      requireManaged(record);
      if (record.state === 'enabled') {
        await this.assertCanonicalEntity(record);
        return record;
      }
      if (record.state !== 'disabled' || !record.disabledPath)
        throw new BackendException('INVALID_STATE', '只有禁用的 Skill 可以启用');
      await this.assertDisabledEntity(record);
      const destination = this.canonicalPath(record.name);
      if ((await inspectPath(destination)).exists)
        throw new BackendException('PATH_CONFLICT', '启用位置已有同名 Skill', destination);
      const transaction = await FileTransaction.begin(
        this.layout,
        this.repository,
        this.locks,
        before,
        force,
      );
      try {
        await transaction.move(record.disabledPath, destination);
        record.state = 'enabled';
        record.canonicalPath = destination;
        record.disabledPath = undefined;
        record.observedPaths = await this.createMissingLinks(
          record.name,
          record.targets,
          destination,
          transaction,
        );
        record.localHash = await validateSkillDirectory(destination);
        record.updatedAt = timestamp();
        const next = structuredClone(before);
        next.skills[id] = record;
        await transaction.commit(next);
        return record;
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      }
    });
  }

  /** 移除受管联接并把实体事务化移入禁用工作区。 */
  async disable(id: string, force = false): Promise<SkillRecord> {
    return await this.writes.runExclusive(async () => {
      await this.assertSafeRoots();
      const before = await this.repository.load();
      const record = structuredClone(requireRecord(before, id));
      requireManaged(record);
      if (record.state === 'disabled') {
        await this.assertDisabledEntity(record);
        return record;
      }
      if (record.state !== 'enabled' || !record.canonicalPath)
        throw new BackendException('INVALID_STATE', '只有启用的 Skill 可以禁用');
      await this.assertCanonicalEntity(record);
      const disabledPath = path.join(this.layout.disabledDir, record.id);
      assertDirectChild(this.layout.disabledDir, disabledPath);
      if ((await inspectPath(disabledPath)).exists)
        throw new BackendException('PATH_CONFLICT', '禁用工作区已有该 Skill', disabledPath);
      const transaction = await FileTransaction.begin(
        this.layout,
        this.repository,
        this.locks,
        before,
        force,
      );
      try {
        await this.removeManagedLinks(record, transaction);
        await transaction.move(record.canonicalPath, disabledPath);
        record.state = 'disabled';
        record.disabledPath = disabledPath;
        record.canonicalPath = undefined;
        record.observedPaths = [];
        record.localHash = await validateSkillDirectory(disabledPath);
        record.updatedAt = timestamp();
        const next = structuredClone(before);
        next.skills[id] = record;
        await transaction.commit(next);
        return record;
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      }
    });
  }

  /** 卸载启用或禁用 Skill，并保留墓碑与备注。 */
  async remove(id: string, force = false): Promise<SkillRecord> {
    return await this.writes.runExclusive(async () => {
      await this.assertSafeRoots();
      const before = await this.repository.load();
      const record = structuredClone(requireRecord(before, id));
      requireManaged(record);
      if (record.state === 'uninstalled') return record;
      const transaction = await FileTransaction.begin(
        this.layout,
        this.repository,
        this.locks,
        before,
        force,
      );
      try {
        if (record.state === 'enabled' && record.canonicalPath) {
          await this.assertCanonicalEntity(record);
          await this.removeManagedLinks(record, transaction);
          await transaction.removeDirectory(record.canonicalPath);
        } else if (record.state === 'disabled' && record.disabledPath) {
          await this.assertDisabledEntity(record);
          await transaction.removeDirectory(record.disabledPath);
        }
        await removeOfficialLockEntry(this.layout, record.name);
        const tombstone = toTombstone(record);
        tombstone.managed = true;
        const next = structuredClone(before);
        next.skills[id] = tombstone;
        await transaction.commit(next);
        return tombstone;
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      }
    });
  }

  /** 保存 Skill 备注而不改变其生命周期状态。 */
  async saveNote(id: string, note: string): Promise<SkillRecord> {
    if (note.length > 4000) throw new BackendException('INVALID_INPUT', '备注不能超过 4000 个字符');
    return await this.writes.runExclusive(() =>
      this.repository.update((state) => {
        const record = requireRecord(state, id);
        record.note = note;
        record.updatedAt = timestamp();
        return structuredClone(record);
      }),
    );
  }

  /** 在隔离目录检查指定或全部 Skill 的远端状态。 */
  async checkUpdates(ids?: string[]): Promise<SkillRecord[]> {
    return await this.writes.runExclusive(async () => {
      await this.assertSafeRoots();
      const state = await this.repository.load();
      const results = await this.checkUpdatesUnlocked(state, ids);
      await this.repository.save(state);
      return results;
    });
  }

  /** 逐项更新允许更新的 Skill，并为每项保留独立结果。 */
  async update(ids: string[], overwriteConflicts: string[] = []): Promise<SkillRecord[]> {
    return await this.writes.runExclusive(async () => {
      await this.assertSafeRoots();
      let state = await this.repository.load();
      await this.checkUpdatesUnlocked(state, ids);
      await this.repository.save(state);
      const results: SkillRecord[] = [];
      for (const id of ids) {
        let record = structuredClone(requireRecord(state, id));
        const allowed =
          record.updateStatus === 'available' ||
          (record.updateStatus === 'conflict' && overwriteConflicts.includes(id));
        if (!allowed) {
          results.push(record);
          continue;
        }
        let staged: StagedSkill | undefined;
        let transaction: FileTransaction | undefined;
        try {
          staged = await this.stageOne(record);
          if (record.remoteHash !== staged.hash)
            throw new BackendException('REMOTE_CHANGED', '远端 Skill 在检查后发生变化，请重新检查');
          transaction = await FileTransaction.begin(
            this.layout,
            this.repository,
            this.locks,
            state,
          );
          if (record.state === 'disabled' && record.disabledPath) {
            await this.assertDisabledEntity(record);
            const backup = path.join(this.layout.stagingDir, `backup-${randomUUID()}`);
            await transaction.markCleanup(backup);
            await transaction.move(record.disabledPath, backup);
            await transaction.move(staged.skillPath, record.disabledPath);
            await mergeOfficialLockFromStage(this.layout, staged.homeDir, record.name);
            record.localHash = await validateSkillDirectory(record.disabledPath);
          } else if (record.state === 'enabled' && record.canonicalPath) {
            await this.assertCanonicalEntity(record);
            const backup = path.join(this.layout.stagingDir, `backup-${randomUUID()}`);
            await transaction.markCleanup(backup);
            await transaction.move(record.canonicalPath, backup);
            await transaction.trackCreatedDirectory(record.canonicalPath);
            await this.cli.add(record.source, record.name, {
              homeDir: this.layout.homeDir,
              targets: record.targets,
            });
            await assertEntityDirectory(record.canonicalPath);
            record.localHash = await validateSkillDirectory(record.canonicalPath);
          } else {
            throw new BackendException('INVALID_STATE', 'Skill 当前状态不能更新');
          }
          if (record.localHash !== staged.hash)
            throw new BackendException(
              'UPDATE_VERIFY_FAILED',
              '更新后的 Skill 与已检查远端内容不一致',
            );
          record.baselineHash = record.localHash;
          record.remoteHash = record.localHash;
          record.updateStatus = 'latest';
          record.updatedAt = timestamp();
          const next = structuredClone(state);
          next.skills[id] = record;
          await transaction.commit(next);
          state = next;
          results.push(record);
        } catch {
          if (transaction) await transaction.rollback().catch(() => undefined);
          state = await this.repository.load();
          record = structuredClone(requireRecord(state, id));
          record.updateStatus = 'failed';
          record.updatedAt = timestamp();
          state.skills[id] = record;
          await this.repository.save(state);
          results.push(record);
        } finally {
          if (staged)
            await rm(staged.homeDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      return results;
    });
  }

  /** 验证所有受管根目录的父链未被目录链接重定向。 */
  private async assertSafeRoots(): Promise<void> {
    for (const root of Object.values(this.layout.targetRoots)) {
      await assertNoLinkedParents(this.layout.homeDir, root);
    }
    const dataParent = path.dirname(this.layout.dataRoot);
    await assertNoLinkedParents(dataParent, this.layout.disabledDir);
    await assertNoLinkedParents(dataParent, this.layout.stagingDir);
  }

  /** 接管单个旧 Skill，并整理实体目录与专用目录联接。 */
  private async adoptOne(
    record: SkillRecord,
    transaction: FileTransaction,
    winner?: string,
  ): Promise<Partial<SkillRecord>> {
    assertSkillName(record.name);
    const candidatePaths = [
      ...new Set(
        [record.canonicalPath, ...record.observedPaths].filter((item): item is string =>
          Boolean(item),
        ),
      ),
    ];
    const candidates: Array<[string, string, string]> = [];
    for (const candidate of candidatePaths) {
      this.assertObservedPath(candidate, record.name);
      candidates.push([candidate, await validateSkillDirectory(candidate), record.id]);
    }
    if (candidates.length === 0)
      throw new BackendException('SKILL_NOT_FOUND', '没有可接管的 Skill 目录');
    if (new Set(candidates.map((item) => item[1])).size > 1 && !winner) {
      throw new BackendException(
        'ADOPTION_CONFLICT',
        `Skill「${record.name}」存在内容不同的副本`,
        JSON.stringify(candidates),
      );
    }
    const selected = winner
      ? candidates.find((item) => normalizedPath(item[0]) === normalizedPath(winner))
      : candidates[0];
    if (!selected) throw new BackendException('INVALID_INPUT', '冲突保留路径不属于该 Skill');
    const [selectedPath, selectedHash] = selected;
    const destination = this.canonicalPath(record.name);
    const destinationKind = await inspectPath(destination);
    const destinationMatches =
      destinationKind.exists &&
      !destinationKind.link &&
      (await validateSkillDirectory(destination)) === selectedHash;
    if (!destinationMatches) {
      const incoming = path.join(this.layout.stagingDir, `incoming-${randomUUID()}`);
      await transaction.markCleanup(incoming);
      await cp(selectedPath, incoming, {
        recursive: true,
        dereference: true,
        force: false,
        errorOnExist: true,
      });
      if ((await validateSkillDirectory(incoming)) !== selectedHash)
        throw new BackendException('COPY_VERIFY_FAILED', '复制 Skill 后校验失败');
      if (destinationKind.exists) await transaction.removeDirectory(destination);
      await transaction.move(incoming, destination);
    }

    const targets = uniqueTargets([
      'universal',
      ...record.targets,
      ...candidatePaths.map((item) => this.targetForPath(item)).filter(isTarget),
    ]);
    for (const candidate of candidatePaths) {
      if (normalizedPath(candidate) === normalizedPath(destination)) continue;
      const target = this.targetForPath(candidate);
      if (!target || target === 'universal') continue;
      const kind = await inspectPath(candidate);
      if (kind.link) {
        const actual = await canonicalizeExisting(candidate);
        if (normalizedPath(actual) !== normalizedPath(destination)) {
          await transaction.removeJunction(candidate, actual);
          await transaction.createJunction(candidate, destination);
        }
      } else {
        await transaction.removeDirectory(candidate);
        await transaction.createJunction(candidate, destination);
      }
    }
    const observedPaths = await this.createMissingLinks(
      record.name,
      targets,
      destination,
      transaction,
    );
    return {
      state: 'enabled',
      targets,
      canonicalPath: destination,
      disabledPath: undefined,
      observedPaths,
      baselineHash: selectedHash,
      localHash: selectedHash,
      remoteHash: undefined,
    };
  }

  /** 在外层写锁内按来源分组并发检查更新。 */
  private async checkUpdatesUnlocked(state: AppState, ids?: string[]): Promise<SkillRecord[]> {
    const records = selectRecords(state, ids).filter((record) => record.state !== 'uninstalled');
    const groups = new Map<string, SkillRecord[]>();
    for (const record of records) {
      if (!record.managed || record.source.type !== 'github' || !record.source.locator) {
        record.updateStatus = 'unavailable';
        record.remoteHash = undefined;
        state.skills[record.id] = record;
        continue;
      }
      const key = `${normalizeSource(record.source.locator, record.source.ref).locator}\0${record.source.ref ?? ''}`;
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }
    const checked = await mapLimit(
      [...groups.values()],
      3,
      async (group) => await this.checkSourceGroup(group),
    );
    for (const result of checked.flat()) state.skills[result.id] = result;
    return records.map((record) => structuredClone(state.skills[record.id]));
  }

  /** 在单一隔离 HOME 中顺序检查同一来源组。 */
  private async checkSourceGroup(records: SkillRecord[]): Promise<SkillRecord[]> {
    const homeDir = path.join(this.layout.stagingDir, `check-${randomUUID()}`);
    await mkdir(homeDir, { recursive: true });
    const results: SkillRecord[] = [];
    try {
      for (const sourceRecord of records) {
        const record = structuredClone(sourceRecord);
        try {
          const currentPath =
            record.state === 'disabled' ? record.disabledPath : record.canonicalPath;
          if (!currentPath) throw new BackendException('SKILL_NOT_FOUND', 'Skill 文件不存在');
          if (record.state === 'disabled') await this.assertDisabledEntity(record);
          else await this.assertCanonicalEntity(record);
          record.localHash = await validateSkillDirectory(currentPath);
          await this.cli.add(record.source, record.name, { homeDir });
          const remotePath = path.join(homeDir, '.agents', 'skills', record.name);
          record.remoteHash = await validateSkillDirectory(remotePath);
          record.updateStatus = classifyUpdate(
            record.baselineHash,
            record.localHash,
            record.remoteHash,
          );
        } catch {
          record.updateStatus = 'failed';
        }
        record.updatedAt = timestamp();
        results.push(record);
      }
      return results;
    } finally {
      await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** 将单个远端 Skill 下载到独立暂存 HOME 并计算哈希。 */
  private async stageOne(record: SkillRecord): Promise<StagedSkill> {
    if (record.source.type !== 'github')
      throw new BackendException('UPDATE_UNAVAILABLE', '该来源无法更新');
    const homeDir = path.join(this.layout.stagingDir, `update-${randomUUID()}`);
    await mkdir(homeDir, { recursive: true });
    try {
      await this.cli.add(record.source, record.name, { homeDir });
      const skillPath = path.join(homeDir, '.agents', 'skills', record.name);
      await assertEntityDirectory(skillPath);
      return { homeDir, skillPath, hash: await validateSkillDirectory(skillPath) };
    } catch (error) {
      await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** 生成并校验通用目录中的规范实体路径。 */
  private canonicalPath(name: string): string {
    assertSkillName(name);
    const candidate = path.join(this.layout.targetRoots.universal, name);
    assertDirectChild(this.layout.targetRoots.universal, candidate, name);
    return candidate;
  }

  /** 校验记录中的启用实体路径。 */
  private assertCanonicalPath(record: SkillRecord): void {
    if (!record.canonicalPath)
      throw new BackendException('SKILL_NOT_FOUND', 'Skill 实体路径不存在');
    assertDirectChild(this.layout.targetRoots.universal, record.canonicalPath, record.name);
  }

  /** 校验记录中的禁用工作区路径。 */
  private assertDisabledPath(record: SkillRecord): void {
    if (!record.disabledPath)
      throw new BackendException('SKILL_NOT_FOUND', '禁用 Skill 路径不存在');
    assertDirectChild(this.layout.disabledDir, record.disabledPath, record.id);
  }

  /** 拒绝被目录联接或符号链接替换的启用实体。 */
  private async assertCanonicalEntity(record: SkillRecord): Promise<void> {
    this.assertCanonicalPath(record);
    await assertEntityDirectory(record.canonicalPath as string);
  }

  /** 拒绝被目录联接或符号链接替换的禁用实体。 */
  private async assertDisabledEntity(record: SkillRecord): Promise<void> {
    this.assertDisabledPath(record);
    await assertEntityDirectory(record.disabledPath as string);
  }

  /** 校验扫描观察路径属于支持的 Agent 根目录。 */
  private assertObservedPath(candidate: string, name: string): void {
    const root = Object.values(this.layout.targetRoots).find(
      (item) =>
        path.dirname(path.resolve(candidate)).toLowerCase() === path.resolve(item).toLowerCase(),
    );
    if (!root)
      throw new BackendException('UNSAFE_PATH', 'Skill 路径不在支持的 Agent 目录内', candidate);
    assertDirectChild(root, candidate, name);
  }

  /** 根据直接父目录识别 Agent 目标。 */
  private targetForPath(candidate: string): AgentTarget | undefined {
    return (Object.entries(this.layout.targetRoots) as Array<[AgentTarget, string]>).find(
      ([, root]) =>
        path.dirname(path.resolve(candidate)).toLowerCase() === path.resolve(root).toLowerCase(),
    )?.[0];
  }

  /** 创建缺少的受管专用目录联接并返回观察路径。 */
  private async createMissingLinks(
    name: string,
    targets: AgentTarget[],
    canonical: string,
    transaction: FileTransaction,
  ): Promise<string[]> {
    const observed = [canonical];
    for (const target of targets) {
      if (target === 'universal') continue;
      const root = this.layout.targetRoots[target];
      await assertNoLinkedParents(this.layout.homeDir, root);
      await mkdir(root, { recursive: true });
      const linkPath = path.join(root, name);
      assertDirectChild(root, linkPath, name);
      const kind = await inspectPath(linkPath);
      if (kind.exists) await assertOwnedJunction(linkPath, canonical);
      else await transaction.createJunction(linkPath, canonical);
      observed.push(linkPath);
    }
    return observed;
  }

  /** 仅删除确认指向当前实体的受管联接。 */
  private async removeManagedLinks(
    record: SkillRecord,
    transaction: FileTransaction,
  ): Promise<void> {
    if (!record.canonicalPath) return;
    for (const observed of record.observedPaths) {
      if (normalizedPath(observed) === normalizedPath(record.canonicalPath)) continue;
      this.assertObservedPath(observed, record.name);
      await transaction.removeJunction(observed, record.canonicalPath);
    }
  }
}

/** 根据三份同算法哈希判断更新状态。 */
export function classifyUpdate(
  baseline: string | undefined,
  local: string,
  remote: string,
): SkillRecord['updateStatus'] {
  if (local === remote) return 'latest';
  if (!baseline) return 'conflict';
  if (local === baseline && remote !== baseline) return 'available';
  if (local !== baseline && remote === baseline) return 'local-modified';
  return 'conflict';
}

/** 拒绝受管实体被外部替换成目录联接、符号链接或普通文件。 */
async function assertEntityDirectory(directory: string): Promise<void> {
  const kind = await inspectPath(directory);
  if (!kind.exists)
    throw new BackendException('SKILL_NOT_FOUND', 'Skill 实体目录不存在', directory);
  if (kind.link)
    throw new BackendException('PATH_CONFLICT', 'Skill 实体目录已被目录链接替换', directory);
  if (!kind.directory)
    throw new BackendException('PATH_CONFLICT', 'Skill 实体路径不是目录', directory);
}

/** 验证 SKILL.md 并计算当前目录哈希。 */
async function validateSkillDirectory(directory: string): Promise<string> {
  try {
    if (!(await stat(path.join(directory, 'SKILL.md'))).isFile())
      throw new Error('SKILL.md 不是文件');
  } catch (error) {
    throw new BackendException('INVALID_SKILL', 'Skill 目录缺少 SKILL.md', directory, {
      cause: error,
    });
  }
  return await hashDirectory(directory);
}

/** 从状态中复制选定记录，未指定时复制全部记录。 */
function selectRecords(state: AppState, ids?: string[]): SkillRecord[] {
  return ids
    ? ids.map((id) => structuredClone(requireRecord(state, id)))
    : Object.values(state.skills).map((record) => structuredClone(record));
}

/** 获取必需记录，不存在时返回中文业务错误。 */
function requireRecord(state: AppState, id: string): SkillRecord {
  const record = state.skills[id];
  if (!record) throw new BackendException('SKILL_NOT_FOUND', '找不到指定的 Skill');
  return record;
}

/** 断言 Skill 已由本工具接管。 */
function requireManaged(record: SkillRecord): void {
  if (!record.managed) throw new BackendException('SKILL_NOT_MANAGED', '请先接管该 Skill');
}

/** 规范化并限制用户绑定为公开 GitHub 来源。 */
function normalizeBoundSource(source: SkillSource): SkillSource {
  const normalized = normalizeSource(source.locator, source.ref, source.skillPath);
  if (normalized.type !== 'github')
    throw new BackendException('INVALID_SOURCE', '只能绑定公开 GitHub Skill 来源');
  return normalized;
}

/** 校验官方锁回读来源没有偏离用户请求的仓库、分支或子路径。 */
function assertInstalledSourceMatches(requested: SkillSource, installed: SkillSource): void {
  const locatorMatches = requested.locator.toLowerCase() === installed.locator.toLowerCase();
  const refMatches = requested.ref === undefined || requested.ref === installed.ref;
  const pathMatches =
    requested.skillPath === undefined || requested.skillPath === installed.skillPath;
  if (!locatorMatches || !refMatches || !pathMatches) {
    throw new BackendException(
      'INSTALLED_SOURCE_MISMATCH',
      '官方命令安装结果与请求来源不一致',
      JSON.stringify({ requested, installed }),
    );
  }
}

/** 把记录转换为保留备注和来源的卸载墓碑。 */
function toTombstone(record: SkillRecord): SkillRecord {
  return {
    ...structuredClone(record),
    state: 'uninstalled',
    canonicalPath: undefined,
    disabledPath: undefined,
    observedPaths: [],
    localHash: undefined,
    remoteHash: undefined,
    updateStatus: 'unchecked',
    updatedAt: timestamp(),
  };
}

/** 按首次出现顺序去重 Agent 目标。 */
function uniqueTargets(targets: AgentTarget[]): AgentTarget[] {
  return [...new Set(targets)];
}

/** 为过滤后的 Agent 目标提供类型收窄。 */
function isTarget(value: AgentTarget | undefined): value is AgentTarget {
  return value !== undefined;
}

/** 生成统一的 UTC ISO 时间戳。 */
function timestamp(): string {
  return new Date().toISOString();
}

/** 生成 Windows 路径比较键。 */
function normalizedPath(value: string): string {
  return path.resolve(value).toLowerCase();
}

/** 以固定并发上限处理数组，并保持结果顺序。 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        output[index] = await mapper(items[index]);
      }
    }),
  );
  return output;
}

/** 返回官方全局 Skill 锁文件路径。 */
function officialLockPath(layout: PathLayout): string {
  return path.join(layout.homeDir, '.agents', '.skill-lock.json');
}

/** 从官方锁中移除指定 Skill 条目。 */
async function removeOfficialLockEntry(layout: PathLayout, name: string): Promise<void> {
  const file = officialLockPath(layout);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw new BackendException('LOCK_FILE_INVALID', '官方 Skill 锁文件无法解析');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !(parsed as { skills?: unknown }).skills ||
    typeof (parsed as { skills: unknown }).skills !== 'object'
  )
    return;
  const skills = (parsed as { skills: Record<string, unknown> }).skills;
  for (const [key, value] of Object.entries(skills)) {
    const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const entryName =
      typeof entry.name === 'string' ? entry.name : path.basename(String(entry.skillPath ?? key));
    if (entryName.toLowerCase() === name.toLowerCase() || key.toLowerCase() === name.toLowerCase())
      delete skills[key];
  }
  await writeBufferAtomically(file, Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8'));
}

/** 将隔离更新产生的单条官方锁记录合并回用户锁。 */
async function mergeOfficialLockFromStage(
  layout: PathLayout,
  stageHome: string,
  name: string,
): Promise<void> {
  const stagedPath = path.join(stageHome, '.agents', '.skill-lock.json');
  const staged = JSON.parse(await readFile(stagedPath, 'utf8')) as {
    skills?: Record<string, unknown>;
  };
  const match = Object.entries(staged.skills ?? {}).find(([key, value]) => {
    const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return (
      key.toLowerCase() === name.toLowerCase() ||
      String(entry.name ?? '').toLowerCase() === name.toLowerCase()
    );
  });
  if (!match) throw new BackendException('LOCK_FILE_INVALID', '隔离更新未生成 Skill 锁记录');
  const file = officialLockPath(layout);
  let current: { version?: unknown; skills: Record<string, unknown> } = { version: 3, skills: {} };
  try {
    current = JSON.parse(await readFile(file, 'utf8')) as typeof current;
    if (!current.skills || typeof current.skills !== 'object') current.skills = {};
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  for (const key of Object.keys(current.skills)) {
    if (key.toLowerCase() === name.toLowerCase()) delete current.skills[key];
  }
  current.skills[match[0]] = match[1];
  await writeBufferAtomically(file, Buffer.from(`${JSON.stringify(current, null, 2)}\n`, 'utf8'));
}

/** 用同目录临时文件原子替换二进制内容。 */
async function writeBufferAtomically(file: string, content: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const incoming = `${file}.${randomUUID()}.incoming`;
  const backup = `${file}.${randomUUID()}.backup`;
  await writeFile(incoming, content);
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
