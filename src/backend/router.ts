import type { AppUpdateService } from './app-update.js';
import { BackendException, toBackendError } from './errors.js';
import type { LocalLogger } from './logger.js';
import type { AsyncMutex } from './mutex.js';
import type { RuntimeService } from './runtime.js';
import type { RestartApplicationsService } from './restart-applications.js';
import type { SkillsService } from './skills-service.js';
import type {
  AgentTarget,
  AppUpdateInfo,
  BackendMethod,
  BackendRequest,
  BackendResponse,
  OperationProgress,
  SkillSource,
} from '../shared/types.js';

export type ProgressEmitter = (progress: OperationProgress) => void | Promise<void>;

/** 校验 IPC 请求并路由到领域服务。 */
export class BackendRouter {
  constructor(
    private readonly runtime: RuntimeService,
    private readonly skills: SkillsService,
    private readonly appUpdate: AppUpdateService,
    private readonly writes: AsyncMutex,
    private readonly logger: LocalLogger,
    private readonly emitProgress: ProgressEmitter = () => undefined,
    private readonly restartApplications?: RestartApplicationsService,
  ) {}

  /** 处理单个未知输入，并始终返回统一响应结构。 */
  async handle(input: unknown): Promise<BackendResponse> {
    let requestId = 'unknown';
    let request: BackendRequest | undefined;
    try {
      request = validateRequest(input);
      requestId = request.requestId;
      await this.progress(request, 'starting', '正在处理请求');
      const data = await this.dispatch(request);
      await this.progress(request, 'completed', '操作完成');
      return { requestId, ok: true, data };
    } catch (error) {
      const normalized = toBackendError(error);
      if (request) {
        await this.progress(request, 'failed', '操作失败').catch(() => undefined);
      }
      await this.logger
        .error(normalized.message, {
          requestId,
          code: normalized.code,
          details: normalized.details,
        })
        .catch(() => undefined);
      return { requestId, ok: false, error: normalized };
    }
  }

  /** 将已校验请求分派给对应领域服务。 */
  private async dispatch(request: BackendRequest): Promise<unknown> {
    switch (request.method) {
      case 'runtime.status':
        assertNoPayload(request.payload);
        return await this.runtime.getStatus();
      case 'runtime.install':
        assertNoPayload(request.payload);
        return await this.runtime.install();
      case 'skills.scan':
        assertNoPayload(request.payload);
        return await this.skills.scan();
      case 'skills.adopt':
        return await this.skills.adopt(parseAdopt(request.payload));
      case 'skills.searchRemote': {
        const payload = objectPayload(request.payload, ['query']);
        return await this.skills.searchRemote(
          requiredString(payload.query, 'query', 200),
          request.requestId,
        );
      }
      case 'skills.cancelSearch': {
        if (request.payload === undefined) return this.skills.cancelSearch();
        const payload = objectPayload(request.payload, ['requestId']);
        return this.skills.cancelSearch(optionalString(payload.requestId, 'requestId', 128));
      }
      case 'skills.install': {
        const payload = objectPayload(request.payload, ['source', 'name', 'targets']);
        return await this.skills.install(
          requiredString(payload.source, 'source', 1000),
          requiredString(payload.name, 'name', 128),
          targets(payload.targets),
        );
      }
      case 'skills.enable': {
        const payload = singlePayload(request.payload);
        return await this.skills.enable(payload.id, payload.force);
      }
      case 'skills.disable': {
        const payload = singlePayload(request.payload);
        return await this.skills.disable(payload.id, payload.force);
      }
      case 'skills.remove': {
        const payload = singlePayload(request.payload);
        return await this.skills.remove(payload.id, payload.force);
      }
      case 'skills.saveNote': {
        const payload = objectPayload(request.payload, ['id', 'note']);
        return await this.skills.saveNote(
          recordId(payload.id, 'id'),
          requiredString(payload.note, 'note', 4000, true),
        );
      }
      case 'skills.checkUpdates': {
        const payload = objectPayload(request.payload, ['ids']);
        const selectedIds = optionalIds(payload.ids);
        const total = selectedIds?.length ?? 0;
        await this.progress(request, 'processing', '正在检查 Skill 更新', 0, total);
        const result = await this.skills.checkUpdates(selectedIds);
        await this.progress(
          request,
          'processing',
          'Skill 更新检查完成',
          result.length,
          total || result.length,
        );
        return result;
      }
      case 'skills.update': {
        const payload = objectPayload(request.payload, ['ids', 'overwriteConflicts']);
        const selectedIds = ids(payload.ids);
        await this.progress(request, 'processing', '正在更新 Skill', 0, selectedIds.length);
        const result = await this.skills.update(
          selectedIds,
          optionalIds(payload.overwriteConflicts) ?? [],
        );
        await this.progress(
          request,
          'processing',
          'Skill 批量更新完成',
          result.length,
          selectedIds.length,
        );
        return result;
      }
      case 'restartApplications.list':
        assertNoPayload(request.payload);
        return await this.requireRestartApplications().list();
      case 'restartApplications.add': {
        const payload = objectPayload(request.payload, ['executablePath']);
        return await this.requireRestartApplications().add(
          requiredString(payload.executablePath, 'executablePath', 32_767),
        );
      }
      case 'restartApplications.remove': {
        const payload = objectPayload(request.payload, ['id']);
        return await this.requireRestartApplications().remove(applicationId(payload.id));
      }
      case 'restartApplications.restart': {
        const payload = objectPayload(request.payload, ['id']);
        return await this.requireRestartApplications().restart(applicationId(payload.id));
      }
      case 'restartApplications.restartRunning':
        assertNoPayload(request.payload);
        return await this.requireRestartApplications().restartRunning();
      case 'app.checkUpdate': {
        const payload = objectPayload(request.payload, ['manual']);
        requiredBoolean(payload.manual, 'manual');
        return await this.appUpdate.check();
      }
      case 'app.installUpdate': {
        const payload = objectPayload(request.payload, ['update']);
        const update = appUpdateInfo(payload.update);
        return await this.writes.runExclusive(() =>
          this.appUpdate.install(update, async (progress) => {
            await this.emitProgress({
              requestId: request.requestId,
              operation: request.method,
              ...progress,
            });
          }),
        );
      }
      default:
        throw new BackendException('METHOD_NOT_FOUND', '不支持的后端方法');
    }
  }

  /** 取得已配置的应用重启服务。 */
  private requireRestartApplications(): RestartApplicationsService {
    if (!this.restartApplications)
      throw new BackendException('SERVICE_UNAVAILABLE', '应用重启服务不可用');
    return this.restartApplications;
  }

  /** 推送与请求编号关联的操作进度。 */
  private async progress(
    request: BackendRequest,
    stage: string,
    message: string,
    current?: number,
    total?: number,
  ): Promise<void> {
    await this.emitProgress({
      requestId: request.requestId,
      operation: request.method,
      stage,
      message,
      current,
      total,
    });
  }
}

/** 严格校验请求外壳。 */
export function validateRequest(input: unknown): BackendRequest {
  const value = objectPayload(input, ['requestId', 'method', 'payload']);
  const requestId = requiredString(value.requestId, 'requestId', 128);
  if (!METHODS.has(value.method as BackendMethod))
    throw new BackendException('INVALID_REQUEST', '后端方法无效');
  return { requestId, method: value.method as BackendMethod, payload: value.payload };
}

/** 校验并转换接管请求参数。 */
function parseAdopt(input: unknown): {
  ids?: string[];
  decline?: boolean;
  sourceBindings?: Record<string, SkillSource>;
  conflictWinners?: Record<string, string>;
} {
  if (input === undefined) return {};
  const value = objectPayload(input, ['ids', 'decline', 'sourceBindings', 'conflictWinners']);
  const result: ReturnType<typeof parseAdopt> = {
    ids: optionalIds(value.ids),
    decline: optionalBoolean(value.decline, 'decline'),
    sourceBindings: recordMap(value.sourceBindings, skillSource),
    conflictWinners: recordMap(value.conflictWinners, (item) =>
      requiredString(item, 'conflictWinner', 32_767),
    ),
  };
  if (result.decline && (result.ids || result.sourceBindings || result.conflictWinners)) {
    throw new BackendException('INVALID_INPUT', '拒绝接管时不能同时提交接管选项');
  }
  return result;
}

/** 解析启停或卸载使用的单记录参数。 */
function singlePayload(input: unknown): { id: string; force: boolean } {
  const value = objectPayload(input, ['id', 'force']);
  return { id: recordId(value.id, 'id'), force: optionalBoolean(value.force, 'force') ?? false };
}

/** 严格解析来源绑定对象。 */
function skillSource(input: unknown): SkillSource {
  const value = objectPayload(input, ['type', 'locator', 'ref', 'skillPath']);
  if (!['github', 'git', 'local', 'unknown'].includes(String(value.type)))
    throw new BackendException('INVALID_INPUT', 'Skill 来源类型无效');
  return {
    type: value.type as SkillSource['type'],
    locator: requiredString(value.locator, 'locator', 2000, true),
    ref: optionalString(value.ref, 'ref', 500),
    skillPath: optionalString(value.skillPath, 'skillPath', 2000),
  };
}

/** 严格解析界面回传的软件更新信息。 */
function appUpdateInfo(input: unknown): AppUpdateInfo {
  const value = objectPayload(input, [
    'available',
    'currentVersion',
    'latestVersion',
    'releaseNotes',
    'publishedAt',
    'downloadUrl',
    'digest',
  ]);
  return {
    available: requiredBoolean(value.available, 'available'),
    currentVersion: requiredString(value.currentVersion, 'currentVersion', 100),
    latestVersion: optionalString(value.latestVersion, 'latestVersion', 100),
    releaseNotes: optionalString(value.releaseNotes, 'releaseNotes', 100_000, true),
    publishedAt: optionalString(value.publishedAt, 'publishedAt', 100),
    downloadUrl: optionalString(value.downloadUrl, 'downloadUrl', 4000),
    digest: optionalString(value.digest, 'digest', 100),
  };
}

/** 断言普通参数对象，并拒绝未知字段和异常原型。 */
function objectPayload(input: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BackendException('INVALID_INPUT', '请求参数必须是对象');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new BackendException('INVALID_INPUT', '请求参数对象类型无效');
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unknown) throw new BackendException('INVALID_INPUT', `请求包含未知字段：${unknown}`);
  return value;
}

/** 断言方法没有携带实际参数。 */
function assertNoPayload(input: unknown): void {
  if (
    input !== undefined &&
    (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 0)
  ) {
    throw new BackendException('INVALID_INPUT', '该方法不接受参数');
  }
}

/** 读取长度受限的必填字符串。 */
function requiredString(input: unknown, field: string, max: number, allowEmpty = false): string {
  if (
    typeof input !== 'string' ||
    input.length > max ||
    (!allowEmpty && input.trim().length === 0)
  ) {
    throw new BackendException('INVALID_INPUT', `字段 ${field} 无效`);
  }
  return input;
}

/** 读取长度受限的可选字符串。 */
function optionalString(
  input: unknown,
  field: string,
  max: number,
  allowEmpty = false,
): string | undefined {
  return input === undefined ? undefined : requiredString(input, field, max, allowEmpty);
}

/** 读取必填布尔值。 */
function requiredBoolean(input: unknown, field: string): boolean {
  if (typeof input !== 'boolean') throw new BackendException('INVALID_INPUT', `字段 ${field} 无效`);
  return input;
}

/** 读取可选布尔值。 */
function optionalBoolean(input: unknown, field: string): boolean | undefined {
  return input === undefined ? undefined : requiredBoolean(input, field);
}

/** 校验非空、不重复的 Skill 编号数组。 */
function ids(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    !input.every((item) => typeof item === 'string' && isRecordId(item))
  ) {
    throw new BackendException('INVALID_INPUT', 'Skill ID 清单无效');
  }
  if (new Set(input).size !== input.length)
    throw new BackendException('INVALID_INPUT', 'Skill ID 不能重复');
  return input;
}

/** 校验可选 Skill 编号数组。 */
function optionalIds(input: unknown): string[] | undefined {
  return input === undefined ? undefined : ids(input);
}

/** 校验非空、不重复的 Agent 目标数组。 */
function targets(input: unknown): AgentTarget[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    !input.every((item) => TARGETS.has(item as AgentTarget))
  ) {
    throw new BackendException('INVALID_INPUT', 'Agent 目标清单无效');
  }
  if (new Set(input).size !== input.length)
    throw new BackendException('INVALID_INPUT', 'Agent 目标不能重复');
  return input as AgentTarget[];
}

/** 解析以合法 Skill 编号为键的无原型映射。 */
function recordMap<T>(input: unknown, parser: (item: unknown) => T): Record<string, T> | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BackendException('INVALID_INPUT', '映射参数必须是对象');
  const keys = Object.keys(input);
  if (keys.length > 500) throw new BackendException('INVALID_INPUT', '映射条目过多');
  const source = objectPayload(input, keys);
  const output = Object.create(null) as Record<string, T>;
  for (const [key, value] of Object.entries(source)) {
    if (!isRecordId(key) || DANGEROUS_KEYS.has(key))
      throw new BackendException('INVALID_INPUT', '映射键无效');
    output[key] = parser(value);
  }
  return output;
}

/** 读取并校验单个 Skill 编号。 */
function applicationId(input: unknown): string {
  const value = requiredString(input, 'id', 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))
    throw new BackendException('INVALID_INPUT', '应用编号无效');
  return value;
}

function recordId(input: unknown, field: string): string {
  const value = requiredString(input, field, 36);
  if (!isRecordId(value))
    throw new BackendException('INVALID_INPUT', `字段 ${field} 不是有效的 Skill ID`);
  return value;
}

/** 判断编号是否为 UUID 或稳定的十六进制编号。 */
function isRecordId(value: string): boolean {
  return (
    /^[a-f0-9]{32}$/i.test(value) ||
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  );
}

const METHODS = new Set<BackendMethod>([
  'runtime.status',
  'runtime.install',
  'skills.scan',
  'skills.adopt',
  'skills.searchRemote',
  'skills.cancelSearch',
  'skills.install',
  'skills.enable',
  'skills.disable',
  'skills.remove',
  'skills.saveNote',
  'skills.checkUpdates',
  'skills.update',
  'app.checkUpdate',
  'app.installUpdate',
  'restartApplications.list',
  'restartApplications.add',
  'restartApplications.remove',
  'restartApplications.restart',
  'restartApplications.restartRunning',
]);
const TARGETS = new Set<AgentTarget>(['universal', 'claude-code', 'windsurf']);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
