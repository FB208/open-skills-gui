import { app as neutralinoApp, extensions, os } from '@neutralinojs/lib';
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { APP, BACKEND_EXTENSION_ID } from '@shared/constants';
import type {
  AgentTarget,
  AppUpdateInfo,
  BackendMethod,
  OperationProgress,
  RemoteSkillResult,
  RuntimeComponentStatus,
  RuntimeStatus,
  SkillRecord,
  SkillSource,
  UpdateStatus,
} from '@shared/types';

import { backend, BackendCallError } from './backend';
import { Button, EmptyState, Icon, Modal, ToastRegion, type ToastMessage } from './components';
import { buildRuntimeBootstrapCommand, type RuntimeBootstrapAction } from './runtime-bootstrap';
import { fuzzyMatch, mergeSkills, normalizeText, summarizeUpdateResults } from './skill-utils';
import { canUseSkillPages, classifyBackendTimeout, startSilentUpdateCheck } from './startup-policy';

type Page = 'installed' | 'search' | 'settings';
type SkillMutationMethod = 'skills.enable' | 'skills.disable' | 'skills.remove';

interface ConfirmState {
  title: string;
  body: string;
  details?: string;
  confirmLabel: string;
  danger?: boolean;
}

interface ErrorState {
  code?: string;
  title: string;
  message: string;
  details?: string;
}

interface InstallState {
  result: RemoteSkillResult;
  targets: AgentTarget[];
}

interface SourceBindingState {
  skill: SkillRecord;
  candidates: RemoteSkillResult[];
}

interface AdoptionConflictState {
  skill: SkillRecord;
  candidates: Array<{ path: string; hash?: string }>;
  source?: SkillSource;
}

interface BootstrapEnvelope {
  ok: boolean;
  data?: RuntimeStatus;
  error?: { code: string; message: string };
}

const TARGET_OPTIONS: Array<{ value: AgentTarget; label: string; hint: string }> = [
  { value: 'universal', label: '通用目录', hint: '固定唯一实体，Codex、Cursor、Gemini CLI 等共用' },
  { value: 'claude-code', label: 'Claude Code', hint: '链接到 .claude\\skills' },
  { value: 'windsurf', label: 'Windsurf', hint: '链接到 Windsurf skills' },
];

const UPDATE_META: Record<UpdateStatus, { label: string; tone: string }> = {
  latest: { label: '已是最新', tone: 'success' },
  available: { label: '有可用更新', tone: 'accent' },
  'local-modified': { label: '本地已修改', tone: 'warning' },
  conflict: { label: '更新冲突', tone: 'danger' },
  unavailable: { label: '无法更新', tone: 'neutral' },
  failed: { label: '检查失败', tone: 'danger' },
  unchecked: { label: '尚未检查', tone: 'neutral' },
};

/** 将目标目录标识转换为中文名称。 */
function targetLabel(target: AgentTarget): string {
  return TARGET_OPTIONS.find((item) => item.value === target)?.label ?? target;
}

/** 将来源信息压缩为用户可识别的文字。 */
function sourceLabel(source: SkillSource): string {
  if (!source.locator || source.type === 'unknown') return '来源未知';
  return source.locator;
}

/** 将安装量格式化为紧凑数字。 */
function formatInstalls(value?: number): string {
  if (value === undefined) return '安装量未知';
  return `${new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(value)} 次安装`;
}

/** 将任意异常转换为适合展示的错误信息。 */
function errorDetails(error: unknown): ErrorState {
  if (error instanceof BackendCallError) {
    return { title: '操作失败', message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { title: '操作失败', message: error.message };
  }
  return { title: '操作失败', message: String(error) };
}

/** 将文件占用 JSON 格式化为进程名和 PID 列表。 */
function formatFileUseDetails(details?: string): string | undefined {
  if (!details) return undefined;
  try {
    const parsed = JSON.parse(details) as {
      path?: string;
      processes?: Array<{ pid?: number; name?: string }>;
    };
    const lines = [
      parsed.path ? `占用路径：${parsed.path}` : '',
      ...(parsed.processes ?? []).map(
        (process) => `${process.name || '未知进程'}（PID ${process.pid ?? '未知'}）`,
      ),
    ].filter(Boolean);
    return lines.length ? lines.join('\n') : details;
  } catch {
    return details;
  }
}

/** 从接管冲突详情中提取可保留的实体路径。 */
function parseAdoptionCandidates(
  skill: SkillRecord,
  details?: string,
): Array<{ path: string; hash?: string }> {
  const candidates: Array<{ path: string; hash?: string }> = [];
  try {
    const parsed = JSON.parse(details ?? '') as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (Array.isArray(item) && typeof item[0] === 'string') {
          candidates.push({
            path: item[0],
            hash: typeof item[1] === 'string' ? item[1] : undefined,
          });
        }
      }
    }
  } catch {
    // 纯路径详情会在下方与扫描路径一起处理。
  }

  const paths = [
    ...candidates.map((item) => item.path),
    skill.canonicalPath,
    ...skill.observedPaths,
    details && !details.trim().startsWith('[') ? details : undefined,
  ].filter((item): item is string => Boolean(item));
  return [...new Set(paths)].map(
    (path) => candidates.find((item) => item.path === path) ?? { path },
  );
}

/** 判断 Skill 是否已有可信的远端来源。 */
function hasKnownSource(skill: SkillRecord): boolean {
  return skill.source.type !== 'unknown' && Boolean(skill.source.locator);
}

/** 调用受信任的 PowerShell 脚本检查或安装私有运行环境。 */
async function invokeRuntimeBootstrap(action: RuntimeBootstrapAction): Promise<RuntimeStatus> {
  const applicationPath = (globalThis as typeof globalThis & { NL_PATH?: string }).NL_PATH;
  const command = buildRuntimeBootstrapCommand(applicationPath, action);
  const result = await os.execCommand(command);
  const line = result.stdOut.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error(result.stdErr.trim() || '运行环境脚本没有返回结果。');

  let envelope: BootstrapEnvelope;
  try {
    envelope = JSON.parse(line) as BootstrapEnvelope;
  } catch {
    throw new Error('运行环境脚本返回了无法识别的数据。');
  }

  if (!envelope.ok || !envelope.data) {
    throw new Error(envelope.error?.message ?? result.stdErr.trim() ?? '运行环境处理失败。');
  }
  return envelope.data;
}

/** 等待后台扩展连接，并通过连接统计补偿就绪事件竞态。 */
async function waitForBackend(timeout: number): Promise<boolean> {
  let timer = 0;
  let unsubscribe = (): void => undefined;
  const ready = new Promise<boolean>((resolve) => {
    unsubscribe = backend.onReady(() => {
      window.clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
    timer = window.setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeout);
  });

  await backend.initialize();
  const stats = await extensions.getStats().catch(() => null);
  if (stats?.connected.includes(BACKEND_EXTENSION_ID)) {
    window.clearTimeout(timer);
    unsubscribe();
    return true;
  }
  return ready;
}

/** 渲染运行组件的可用性和版本。 */
function RuntimeRow({
  name,
  status,
}: {
  name: string;
  status: RuntimeComponentStatus;
}): JSX.Element {
  return (
    <div className="runtime-row">
      <span className={`runtime-row__dot ${status.available ? 'is-ready' : ''}`} />
      <div className="runtime-row__copy">
        <strong>{name}</strong>
        <span>
          {status.available
            ? `${status.version ?? '可用'} · ${status.source === 'private' ? '应用私有' : '系统环境'}`
            : (status.reason ?? '未安装')}
        </span>
      </div>
      <span className={`pill pill--${status.available ? 'success' : 'warning'}`}>
        {status.available ? '可用' : '缺失'}
      </span>
    </div>
  );
}

/** 渲染 Open Skills GUI 主界面。 */
export function App(): JSX.Element {
  const [page, setPage] = useState<Page>('installed');
  const [initializing, setInitializing] = useState(true);
  const [backendConnected, setBackendConnected] = useState(false);
  const [bootstrapOnly, setBootstrapOnly] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [installedQuery, setInstalledQuery] = useState('');
  const [remoteQuery, setRemoteQuery] = useState('');
  const [remoteResults, setRemoteResults] = useState<RemoteSkillResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [error, setError] = useState<ErrorState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [runtimePrompt, setRuntimePrompt] = useState(false);
  const [legacyPrompt, setLegacyPrompt] = useState(false);
  const [noteSkill, setNoteSkill] = useState<SkillRecord | null>(null);
  const [noteValue, setNoteValue] = useState('');
  const [installState, setInstallState] = useState<InstallState | null>(null);
  const [sourceBinding, setSourceBinding] = useState<SourceBindingState | null>(null);
  const [adoptionConflict, setAdoptionConflict] = useState<AdoptionConflictState | null>(null);
  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null);
  const confirmResolver = useRef<((value: boolean) => void) | null>(null);
  const toastId = useRef(0);
  const searchSequence = useRef(0);
  const activeSearch = useRef<string | null>(null);
  const skillPagesEnabled = canUseSkillPages(backendConnected, runtime);
  const displayedPage: Page = skillPagesEnabled || page === 'settings' ? page : 'settings';

  const visibleSkills = useMemo(
    () =>
      skills.filter(
        (skill) =>
          skill.state !== 'uninstalled' &&
          (fuzzyMatch(skill.name, installedQuery) ||
            fuzzyMatch(sourceLabel(skill.source), installedQuery) ||
            fuzzyMatch(skill.note, installedQuery)),
      ),
    [installedQuery, skills],
  );

  const managedSkills = useMemo(
    () => skills.filter((skill) => skill.state !== 'uninstalled' && skill.managed),
    [skills],
  );

  const selectedManaged = useMemo(
    () => managedSkills.filter((skill) => selectedIds.has(skill.id)),
    [managedSkills, selectedIds],
  );

  /** 标记或解除某个操作的忙碌状态。 */
  const markBusy = (key: string, value: boolean): void => {
    setBusy((current) => {
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  /** 展示自动消失的非阻塞反馈。 */
  const notify = (text: string, tone: ToastMessage['tone'] = 'success'): void => {
    const id = ++toastId.current;
    setToasts((current) => [...current, { id, text, tone }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((item) => item.id !== id)),
      4_200,
    );
  };

  /** 打开可等待结果的确认对话框。 */
  const askConfirm = (state: ConfirmState): Promise<boolean> => {
    confirmResolver.current?.(false);
    setConfirm(state);
    return new Promise<boolean>((resolve) => {
      confirmResolver.current = resolve;
    });
  };

  /** 关闭确认对话框并返回用户选择。 */
  const answerConfirm = (accepted: boolean): void => {
    const resolve = confirmResolver.current;
    confirmResolver.current = null;
    setConfirm(null);
    resolve?.(accepted);
  };

  /** 执行常规异步操作并统一处理错误和忙碌态。 */
  const runBusy = async <T,>(key: string, task: () => Promise<T>): Promise<T | undefined> => {
    markBusy(key, true);
    try {
      return await task();
    } catch (caught) {
      setError(errorDetails(caught));
      return undefined;
    } finally {
      markBusy(key, false);
      window.setTimeout(() => setProgress(null), 700);
    }
  };

  /** 合并一个或多个后端 Skill 结果。 */
  const applySkillResult = (result: SkillRecord | SkillRecord[]): void => {
    const incoming = Array.isArray(result) ? result : [result];
    setSkills((current) => mergeSkills(current, incoming));
  };

  /** 扫描本机 Skill，并按需提示处理旧目录。 */
  const scanSkills = async (): Promise<void> => {
    const result = await backend.call('skills.scan');
    setSkills(result.skills);
    setLegacyPrompt(result.legacyDetected);
  };

  /** 启动时区分环境缺失与后台失败，并让软件更新检查完全异步。 */
  useEffect(() => {
    let active = true;
    let backendSession: Promise<void> | null = null;
    let automaticUpdateStarted = false;
    const removeProgress = backend.onProgress((event) => {
      if (active) setProgress(event);
    });

    /** 仅启动一次静默的软件更新检查，不阻塞运行环境检测或扫描。 */
    const startAutomaticUpdateCheck = (): void => {
      if (automaticUpdateStarted) return;
      automaticUpdateStarted = true;
      startSilentUpdateCheck(
        () => backend.call('app.checkUpdate', { manual: false }),
        (result) => {
          if (active) setAppUpdate(result);
        },
      );
    };

    /** 在后台真正就绪后只执行一次运行环境检测和 Skill 扫描。 */
    const initializeBackendSession = (): Promise<void> => {
      if (backendSession) return backendSession;

      backendSession = (async () => {
        if (!active) return;
        setBackendConnected(true);
        setBootstrapOnly(false);
        setError((current) => (current?.code === 'BACKEND_START_FAILED' ? null : current));
        startAutomaticUpdateCheck();

        const runtimeStatus = await backend.call('runtime.status');
        if (!active) return;
        setRuntime(runtimeStatus);

        if (!runtimeStatus.ready) {
          setPage('settings');
          setRuntimePrompt(true);
          return;
        }

        setRuntimePrompt(false);
        const scan = await backend.call('skills.scan');
        if (!active) return;
        setSkills(scan.skills);
        setLegacyPrompt(scan.legacyDetected);
      })()
        .catch((caught: unknown) => {
          if (!active) return;
          setPage('settings');
          setError({
            ...errorDetails(caught),
            code: 'BACKEND_START_FAILED',
            title: '后台服务启动失败',
          });
        })
        .finally(() => {
          if (active) setInitializing(false);
        });

      return backendSession;
    };

    const removeReady = backend.onReady(() => {
      void initializeBackendSession();
    });

    /** 依次执行首次连接、引导状态检查与后台延迟连接宽限。 */
    const start = async (): Promise<void> => {
      try {
        if (await waitForBackend(4_500)) {
          await initializeBackendSession();
          return;
        }
        if (!active) return;

        const directStatus = await invokeRuntimeBootstrap('Status');
        if (!active) return;
        if (backendSession) {
          await backendSession;
          return;
        }

        setRuntime(directStatus);
        if (classifyBackendTimeout(directStatus) === 'runtime-missing') {
          setBackendConnected(false);
          setBootstrapOnly(true);
          setPage('settings');
          setRuntimePrompt(true);
          setInitializing(false);
          return;
        }

        if (await waitForBackend(8_000)) {
          await initializeBackendSession();
          return;
        }
        if (!active) return;
        if (backendSession) {
          await backendSession;
          return;
        }

        setBackendConnected(false);
        setBootstrapOnly(false);
        setPage('settings');
        setError({
          code: 'BACKEND_START_FAILED',
          title: '后台服务启动失败',
          message:
            '运行环境已经就绪，但后台服务未能连接。请关闭并重新打开应用；若问题持续，请查看本地日志。',
        });
        setInitializing(false);
      } catch (caught) {
        if (!active) return;
        setPage('settings');
        setError({ ...errorDetails(caught), title: '启动失败' });
        setInitializing(false);
      }
    };

    void start();
    return () => {
      active = false;
      removeReady();
      removeProgress();
    };
  }, []);

  /** 对远端查询防抖，并始终携带原请求编号取消过期搜索。 */
  useEffect(() => {
    const query = remoteQuery.trim();
    const sequence = ++searchSequence.current;

    /** 取消当前搜索并立即清除活动请求标记。 */
    const cancelActiveSearch = (): void => {
      const requestId = activeSearch.current;
      if (!requestId) return;
      activeSearch.current = null;
      void backend.call('skills.cancelSearch', { requestId }).catch(() => undefined);
    };

    cancelActiveSearch();
    setSearching(false);

    if (displayedPage !== 'search' || !query || !backendConnected || !runtime?.ready) {
      setRemoteResults([]);
      setSearchError('');
      return;
    }

    let requestId: string | null = null;
    const timer = window.setTimeout(() => {
      setSearching(true);
      setSearchError('');
      const operation = backend.begin('skills.searchRemote', { query });
      requestId = operation.requestId;
      activeSearch.current = operation.requestId;
      void operation.promise
        .then((results) => {
          if (searchSequence.current === sequence) setRemoteResults(results);
        })
        .catch((caught: unknown) => {
          if (searchSequence.current !== sequence) return;
          if (caught instanceof BackendCallError && caught.code === 'SEARCH_CANCELLED') return;
          setRemoteResults([]);
          setSearchError(caught instanceof Error ? caught.message : '搜索失败，请稍后重试。');
        })
        .finally(() => {
          if (searchSequence.current === sequence && activeSearch.current === operation.requestId) {
            setSearching(false);
            activeSearch.current = null;
          }
        });
    }, 420);

    return () => {
      window.clearTimeout(timer);
      if (requestId && activeSearch.current === requestId) cancelActiveSearch();
    };
  }, [backendConnected, displayedPage, remoteQuery, runtime?.ready]);

  /** 安装缺失的私有运行环境，并在需要时重启应用。 */
  const installRuntime = async (): Promise<void> => {
    const accepted = await askConfirm({
      title: '安装运行环境',
      body: '将从官方地址下载并校验 Node.js 与 MinGit，文件仅保存在 Open Skills GUI 的私有目录，不修改系统 PATH。',
      confirmLabel: '下载并安装',
    });
    if (!accepted) return;

    const result = await runBusy('runtime-install', async () => {
      if (bootstrapOnly) return invokeRuntimeBootstrap('Install');
      return backend.call('runtime.install');
    });
    if (!result) return;
    setRuntime(result);
    if (!result.ready) return;

    if (bootstrapOnly) {
      notify('运行环境已就绪，正在重启应用。');
      await neutralinoApp.restartProcess();
      return;
    }
    setRuntimePrompt(false);
    await runBusy('scan', scanSkills);
  };

  /** 在无后端模式下重启应用以加载扩展。 */
  const restartForBackend = async (): Promise<void> => {
    await neutralinoApp.restartProcess();
  };

  /** 暂缓环境处理并打开设置页。 */
  const deferRuntimeInstall = (): void => {
    setRuntimePrompt(false);
    setPage('settings');
    notify('Skill 管理功能将在运行环境就绪后可用。', 'info');
  };

  /** 重新扫描并刷新已安装列表。 */
  const refreshSkills = async (): Promise<void> => {
    const result = await runBusy('scan', scanSkills);
    if (result !== undefined) notify('已刷新本机 Skill。');
  };

  /** 执行一次接管，并把路径冲突转为用户可选择的界面状态。 */
  const adoptSkill = async (
    skill: SkillRecord,
    source?: SkillSource,
    conflictWinner?: string,
    showSuccess = true,
  ): Promise<boolean> => {
    const key = `adopt-${skill.id}`;
    markBusy(key, true);
    try {
      const result = await backend.call('skills.adopt', {
        ids: [skill.id],
        sourceBindings: source ? { [skill.id]: source } : undefined,
        conflictWinners: conflictWinner ? { [skill.id]: conflictWinner } : undefined,
      });
      const normalized = result.map((item) =>
        item.source.type === 'unknown' ? { ...item, updateStatus: 'unavailable' as const } : item,
      );
      applySkillResult(normalized);
      if (showSuccess) notify('Skill 已接管。');
      return true;
    } catch (caught) {
      if (caught instanceof BackendCallError && caught.code === 'ADOPTION_CONFLICT') {
        setAdoptionConflict({
          skill,
          source,
          candidates: parseAdoptionCandidates(skill, caught.details),
        });
        return false;
      }
      setError(errorDetails(caught));
      return false;
    } finally {
      markBusy(key, false);
    }
  };

  /** 接管所有来源明确的旧 Skill，未知来源留待逐项确认。 */
  const adoptLegacySkills = async (): Promise<void> => {
    const known = skills.filter((skill) => !skill.managed && hasKnownSource(skill));
    const unknownCount = skills.filter((skill) => !skill.managed && !hasKnownSource(skill)).length;
    setLegacyPrompt(false);
    markBusy('adopt-all', true);
    let adopted = 0;
    try {
      if (!known.length) {
        const retained = await backend.call('skills.adopt', { decline: true });
        applySkillResult(retained);
      }
      for (const skill of known) {
        const completed = await adoptSkill(skill, undefined, undefined, false);
        if (!completed) break;
        adopted += 1;
      }
      if (adopted) {
        notify(
          unknownCount
            ? `已接管 ${adopted} 个 Skill；另有 ${unknownCount} 项需逐项确认来源。`
            : `已接管 ${adopted} 个 Skill。`,
          unknownCount ? 'info' : 'success',
        );
      } else if (unknownCount) {
        notify(`有 ${unknownCount} 项来源未知，请在列表中逐项确认或按未知来源接管。`, 'info');
      }
    } finally {
      markBusy('adopt-all', false);
    }
  };

  /** 记录拒绝接管决定并继续以未托管方式展示。 */
  const declineLegacySkills = async (): Promise<void> => {
    const result = await runBusy('decline-adopt', () =>
      backend.call('skills.adopt', { decline: true }),
    );
    if (!result) return;
    applySkillResult(result);
    setLegacyPrompt(false);
  };

  /** 对来源未知的 Skill 搜索候选，否则直接确认接管。 */
  const beginAdoption = async (skill: SkillRecord): Promise<void> => {
    if (!hasKnownSource(skill)) {
      const candidates = await runBusy(`source-${skill.id}`, () =>
        backend.call('skills.searchRemote', { query: skill.name }),
      );
      if (!candidates) return;
      const exact = candidates.filter(
        (item) => normalizeText(item.name) === normalizeText(skill.name),
      );

      if (!exact.length) {
        const accepted = await askConfirm({
          title: '未找到可确认的公开来源',
          body: '仍可接管此 Skill，但它会保持“来源未知”和“无法更新”状态。之后仍可启用、禁用、备注或卸载。',
          confirmLabel: '仍然接管',
        });
        if (accepted) await adoptSkill(skill);
        return;
      }
      setSourceBinding({ skill, candidates: exact });
      return;
    }

    const accepted = await askConfirm({
      title: `接管 ${skill.name}`,
      body: '接管后可由本工具执行启停、更新和卸载。接管过程不会覆盖内容不同的同名 Skill。',
      confirmLabel: '确认接管',
    });
    if (accepted) await adoptSkill(skill);
  };

  /** 绑定用户确认的远端来源并完成接管。 */
  const adoptWithSource = async (candidate: RemoteSkillResult): Promise<void> => {
    if (!sourceBinding) return;
    const { skill } = sourceBinding;
    const source: SkillSource = { type: 'github', locator: candidate.source };
    setSourceBinding(null);
    const completed = await adoptSkill(skill, source);
    if (completed) notify('来源已确认，Skill 已接管。');
  };

  /** 使用用户选择的实体路径重试冲突接管。 */
  const resolveAdoptionConflict = async (path: string): Promise<void> => {
    if (!adoptionConflict) return;
    const completed = await adoptSkill(
      adoptionConflict.skill,
      adoptionConflict.source,
      path,
      false,
    );
    if (completed) {
      setAdoptionConflict(null);
      notify('已保留所选副本并完成接管。');
    }
  };

  /** 执行启用、禁用或卸载，并处理文件占用确认。 */
  const mutateSkill = async (
    skill: SkillRecord,
    method: SkillMutationMethod,
    force = false,
  ): Promise<void> => {
    const key = `${method}-${skill.id}`;
    markBusy(key, true);
    try {
      const result = await backend.call(method, { id: skill.id, force });
      applySkillResult(result);
      notify(
        method === 'skills.enable'
          ? 'Skill 已启用。'
          : method === 'skills.disable'
            ? 'Skill 已禁用。'
            : 'Skill 已卸载，备注仍会保留。',
      );
    } catch (caught) {
      if (!force && caught instanceof BackendCallError && caught.code === 'FILE_IN_USE') {
        markBusy(key, false);
        const accepted = await askConfirm({
          title: '文件正在被占用',
          body: '需要终止以下占用进程及其子进程才能继续。未保存的数据可能丢失。',
          details: formatFileUseDetails(caught.details),
          confirmLabel: '终止进程并重试',
          danger: true,
        });
        if (accepted) await mutateSkill(skill, method, true);
        return;
      }
      setError(errorDetails(caught));
    } finally {
      markBusy(key, false);
      window.setTimeout(() => setProgress(null), 700);
    }
  };

  /** 根据当前状态请求启用或禁用 Skill。 */
  const toggleSkill = async (skill: SkillRecord): Promise<void> => {
    await mutateSkill(skill, skill.state === 'enabled' ? 'skills.disable' : 'skills.enable');
  };

  /** 二次确认后卸载 Skill，同时保留备注记录。 */
  const removeSkill = async (skill: SkillRecord): Promise<void> => {
    const accepted = await askConfirm({
      title: `卸载 ${skill.name}`,
      body:
        skill.state === 'disabled'
          ? '将删除工作区中的禁用副本。备注和来源记录会保留。'
          : '将从已安装目录删除该 Skill。备注和来源记录会保留。',
      confirmLabel: '确认卸载',
      danger: true,
    });
    if (accepted) await mutateSkill(skill, 'skills.remove');
  };

  /** 打开备注编辑器并填入当前内容。 */
  const editNote = (skill: SkillRecord): void => {
    setNoteSkill(skill);
    setNoteValue(skill.note);
  };

  /** 保存 Skill 备注。 */
  const saveNote = async (): Promise<void> => {
    if (!noteSkill) return;
    const result = await runBusy(`note-${noteSkill.id}`, () =>
      backend.call('skills.saveNote', { id: noteSkill.id, note: noteValue.trim() }),
    );
    if (!result) return;
    applySkillResult(result);
    setNoteSkill(null);
    notify('备注已保存。');
  };

  /** 切换列表中的批量选择状态。 */
  const toggleSelected = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 选中或取消当前过滤结果中的全部托管项。 */
  const toggleAllVisible = (): void => {
    const ids = visibleSkills.filter((skill) => skill.managed).map((skill) => skill.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id));
    setSelectedIds((current) => {
      const next = new Set(current);
      ids.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
      return next;
    });
  };

  /** 检查指定 Skill，未选择时检查全部托管项。 */
  const checkUpdates = async (skill?: SkillRecord): Promise<void> => {
    const ids = skill
      ? [skill.id]
      : selectedManaged.length
        ? selectedManaged.map((item) => item.id)
        : undefined;
    const result = await runBusy('check-updates', () =>
      backend.call('skills.checkUpdates', { ids }),
    );
    if (result) {
      applySkillResult(result);
      notify('更新检查已完成。');
    }
  };

  /** 更新单个 Skill，并对冲突覆盖进行二次确认。 */
  const updateOne = async (skill: SkillRecord): Promise<void> => {
    let overwriteConflicts: string[] | undefined;
    if (skill.updateStatus === 'conflict') {
      const accepted = await askConfirm({
        title: `覆盖 ${skill.name} 的本地修改`,
        body: '本地内容和远端内容都发生了变化。继续将用远端版本覆盖本地修改，此操作无法撤销。',
        confirmLabel: '覆盖并更新',
        danger: true,
      });
      if (!accepted) return;
      overwriteConflicts = [skill.id];
    }
    const result = await runBusy(`update-${skill.id}`, () =>
      backend.call('skills.update', { ids: [skill.id], overwriteConflicts }),
    );
    if (!result) return;

    applySkillResult(result);
    const feedback = summarizeUpdateResults(result, [skill.id]);
    if (feedback.updated) notify(`${skill.name} 已更新至最新版本。`);
    else if (feedback.failed) notify(`${skill.name} 更新失败，请查看状态后重试。`, 'error');
    else notify(`${skill.name} 未更新，已按当前状态跳过。`, 'info');
  };

  /** 批量更新所选的安全可更新项，并自动跳过冲突。 */
  const updateSelected = async (): Promise<void> => {
    const ids = selectedManaged
      .filter((skill) => skill.updateStatus === 'available')
      .map((skill) => skill.id);
    if (!ids.length) {
      notify('所选 Skill 中没有可安全更新的项目。', 'info');
      return;
    }
    const result = await runBusy('batch-update', () => backend.call('skills.update', { ids }));
    if (!result) return;

    applySkillResult(result);
    const feedback = summarizeUpdateResults(
      result,
      selectedManaged.map((skill) => skill.id),
    );
    notify(`批量更新完成：${feedback.text}。`, feedback.tone);
  };

  /** 打开安装目标选择对话框。 */
  const chooseInstallTargets = (result: RemoteSkillResult): void => {
    setInstallState({ result, targets: ['universal'] });
  };

  /** 切换远端 Skill 的安装目标。 */
  const toggleInstallTarget = (target: AgentTarget): void => {
    if (target === 'universal') return;
    setInstallState((current) => {
      if (!current) return null;
      const targets = current.targets.includes(target)
        ? current.targets.filter((item) => item !== target)
        : [...current.targets, target];
      return { ...current, targets };
    });
  };

  /** 安装当前选中的远端 Skill。 */
  const installRemoteSkill = async (): Promise<void> => {
    if (!installState) return;
    const remote = installState.result;
    const targets = [...new Set<AgentTarget>(['universal', ...installState.targets])];
    const installed = await runBusy(`install-${remote.name}`, () =>
      backend.call('skills.install', {
        source: remote.source,
        name: remote.name,
        targets,
      }),
    );
    if (!installed) return;
    applySkillResult(installed);
    setInstallState(null);
    setRemoteResults((current) =>
      current.map((item) =>
        item.name === remote.name && item.source === remote.source
          ? { ...item, installed: true }
          : item,
      ),
    );
    notify('Skill 安装完成。');
  };

  /** 手动检查应用更新并展示明确结果。 */
  const checkAppUpdate = async (): Promise<void> => {
    if (!backendConnected) {
      notify('后台服务未连接，暂时无法检查软件更新。', 'info');
      return;
    }
    const result = await runBusy('app-update-check', () =>
      backend.call('app.checkUpdate', { manual: true }),
    );
    if (!result) return;
    if (result.available) setAppUpdate(result);
    else notify('当前已是最新版本。', 'info');
  };

  /** 下载并启动经过摘要校验的安装程序。 */
  const installAppUpdate = async (): Promise<void> => {
    if (!appUpdate || !backendConnected) return;
    const result = await runBusy('app-update-install', () =>
      backend.call('app.installUpdate', { update: appUpdate }),
    );
    if (result?.started) {
      notify('安装程序已启动，应用即将退出。', 'info');
      await neutralinoApp.exit();
    }
  };

  /** 渲染左侧主导航。 */
  const renderNavigation = (): JSX.Element => (
    <aside className="sidebar">
      <div className="brand" aria-label="Open Skills GUI">
        <span className="brand__mark">
          <span />
          <span />
          <span />
        </span>
        <span>
          <strong>Open Skills</strong>
          <small>GUI</small>
        </span>
      </div>
      <nav className="nav" aria-label="主要导航">
        {(
          [
            ['installed', 'apps', '已安装'],
            ['search', 'search', '搜索'],
            ['settings', 'settings', '设置'],
          ] as const
        ).map(([value, icon, label]) => {
          const disabled = value !== 'settings' && !skillPagesEnabled;
          return (
            <button
              key={value}
              id={`tab-${value}`}
              className={`nav__item ${displayedPage === value ? 'is-active' : ''}`}
              aria-current={displayedPage === value ? 'page' : undefined}
              disabled={disabled}
              onClick={() => {
                if (!disabled) setPage(value);
              }}
            >
              <Icon name={icon} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar__footer">
        <span className={`connection-dot ${backendConnected ? 'is-online' : ''}`} />
        <span>
          {backendConnected ? '后台服务已连接' : bootstrapOnly ? '环境引导模式' : '后台服务未连接'}
        </span>
      </div>
    </aside>
  );

  /** 渲染已安装 Skill 管理页。 */
  const renderInstalledPage = (): JSX.Element => {
    const allVisibleSelected =
      visibleSkills.filter((skill) => skill.managed).length > 0 &&
      visibleSkills.filter((skill) => skill.managed).every((skill) => selectedIds.has(skill.id));
    return (
      <section id="panel-installed" className="page-panel">
        <header className="page-header">
          <div>
            <p className="eyebrow">SKILL LIBRARY</p>
            <h1>已安装</h1>
            <p>管理本机所有全局 Skill、状态和更新。</p>
          </div>
          <Button onClick={() => void refreshSkills()} busy={busy.has('scan')}>
            <Icon name="refresh" />
            刷新
          </Button>
        </header>
        <div className="summary-grid">
          <div className="summary-card">
            <span>已启用</span>
            <strong>{skills.filter((item) => item.state === 'enabled').length}</strong>
          </div>
          <div className="summary-card">
            <span>已禁用</span>
            <strong>{skills.filter((item) => item.state === 'disabled').length}</strong>
          </div>
          <div className="summary-card">
            <span>可更新</span>
            <strong>{skills.filter((item) => item.updateStatus === 'available').length}</strong>
          </div>
          <div className="summary-card">
            <span>未托管</span>
            <strong>
              {skills.filter((item) => item.state !== 'uninstalled' && !item.managed).length}
            </strong>
          </div>
        </div>
        <div className="toolbar">
          <label className="search-field" htmlFor="installed-search">
            <Icon name="search" />
            <span className="sr-only">筛选已安装 Skill</span>
            <input
              id="installed-search"
              value={installedQuery}
              onInput={(event) => setInstalledQuery(event.currentTarget.value)}
              placeholder="按名称、来源或备注筛选"
            />
          </label>
          <div className="toolbar__actions">
            <Button size="small" onClick={toggleAllVisible}>
              {allVisibleSelected ? '取消全选' : '全选'}
            </Button>
            <Button
              size="small"
              onClick={() => void checkUpdates()}
              busy={busy.has('check-updates')}
            >
              <Icon name="refresh" size={15} />
              {selectedManaged.length ? `检查所选 (${selectedManaged.length})` : '检查全部'}
            </Button>
            <Button
              size="small"
              variant="primary"
              onClick={() => void updateSelected()}
              busy={busy.has('batch-update')}
              disabled={!selectedManaged.some((item) => item.updateStatus === 'available')}
            >
              <Icon name="download" size={15} />
              更新所选
            </Button>
          </div>
        </div>
        {visibleSkills.length ? (
          <div className="skill-list">
            {visibleSkills.map((skill) => {
              const update = UPDATE_META[skill.updateStatus];
              const actionBusy =
                busy.has(`skills.enable-${skill.id}`) ||
                busy.has(`skills.disable-${skill.id}`) ||
                busy.has(`skills.remove-${skill.id}`);
              return (
                <article
                  className={`skill-card ${!skill.managed ? 'skill-card--unmanaged' : ''}`}
                  key={skill.id}
                >
                  <div className="skill-card__select">
                    {skill.managed ? (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(skill.id)}
                        onChange={() => toggleSelected(skill.id)}
                        aria-label={`选择 ${skill.name}`}
                      />
                    ) : (
                      <span className="unmanaged-mark">
                        <Icon name="link" size={16} />
                      </span>
                    )}
                  </div>
                  <div className="skill-card__body">
                    <div className="skill-card__headline">
                      <h2>{skill.name}</h2>
                      <span
                        className={`pill pill--${skill.state === 'enabled' ? 'success' : skill.state === 'disabled' ? 'warning' : 'neutral'}`}
                      >
                        {skill.managed
                          ? skill.state === 'enabled'
                            ? '已启用'
                            : '已禁用'
                          : '未托管'}
                      </span>
                      {skill.managed ? (
                        <span className={`pill pill--${update.tone}`}>{update.label}</span>
                      ) : null}
                    </div>
                    <p className="skill-card__source" title={sourceLabel(skill.source)}>
                      <Icon name="link" size={14} />
                      {sourceLabel(skill.source)}
                    </p>
                    <div className="tag-row">
                      {skill.targets.map((target) => (
                        <span className="tag" key={target}>
                          {targetLabel(target)}
                        </span>
                      ))}
                    </div>
                    {skill.note ? <p className="skill-card__note">备注：{skill.note}</p> : null}
                  </div>
                  <div className="skill-card__actions">
                    {!skill.managed ? (
                      <>
                        <Button
                          variant="primary"
                          size="small"
                          onClick={() => void beginAdoption(skill)}
                          busy={busy.has(`source-${skill.id}`) || busy.has(`adopt-${skill.id}`)}
                        >
                          接管
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`编辑 ${skill.name} 的备注`}
                          onClick={() => editNote(skill)}
                        >
                          <Icon name="edit" size={16} />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="small"
                          onClick={() => void checkUpdates(skill)}
                          busy={busy.has('check-updates')}
                        >
                          检查
                        </Button>
                        {skill.updateStatus === 'available' || skill.updateStatus === 'conflict' ? (
                          <Button
                            variant="primary"
                            size="small"
                            onClick={() => void updateOne(skill)}
                            busy={busy.has(`update-${skill.id}`)}
                          >
                            更新
                          </Button>
                        ) : null}
                        <Button
                          size="small"
                          onClick={() => void toggleSkill(skill)}
                          busy={actionBusy}
                        >
                          {skill.state === 'enabled' ? (
                            <>
                              <Icon name="pause" size={14} />
                              禁用
                            </>
                          ) : (
                            <>
                              <Icon name="play" size={14} />
                              启用
                            </>
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`编辑 ${skill.name} 的备注`}
                          onClick={() => editNote(skill)}
                        >
                          <Icon name="edit" size={16} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`卸载 ${skill.name}`}
                          onClick={() => void removeSkill(skill)}
                        >
                          <Icon name="trash" size={16} />
                        </Button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon="apps"
            title={installedQuery ? '没有匹配结果' : '尚未发现 Skill'}
            body={
              installedQuery
                ? '尝试缩短关键词，或搜索备注和来源。'
                : '前往搜索页查找并安装公开 Skill。'
            }
            action={
              !installedQuery ? (
                <Button variant="primary" onClick={() => setPage('search')}>
                  搜索 Skill
                </Button>
              ) : undefined
            }
          />
        )}
      </section>
    );
  };

  /** 渲染远端 Skill 搜索页。 */
  const renderSearchPage = (): JSX.Element => (
    <section id="panel-search" className="page-panel">
      <header className="page-header">
        <div>
          <p className="eyebrow">DISCOVER</p>
          <h1>搜索 Skill</h1>
          <p>从公开技能库中查找并安装 Skill。</p>
        </div>
      </header>
      <div className="remote-search">
        <label htmlFor="remote-search">搜索公开 Skill</label>
        <div className="remote-search__input">
          <Icon name="search" />
          <input
            id="remote-search"
            autoFocus
            value={remoteQuery}
            onInput={(event) => setRemoteQuery(event.currentTarget.value)}
            placeholder="输入 Skill 名称或关键词"
            autoComplete="off"
          />
          {searching ? <span className="spinner" aria-label="正在搜索" /> : null}
        </div>
        <p>最多显示命令返回的 6 项结果。</p>
      </div>
      <div aria-live="polite">
        {searchError ? (
          <div className="inline-alert inline-alert--error">
            <Icon name="warning" />
            {searchError}
          </div>
        ) : null}
      </div>
      {!remoteQuery.trim() ? (
        <EmptyState icon="search" title="开始搜索" body="例如：PDF、前端设计、数据分析。" />
      ) : searching && !remoteResults.length ? (
        <div className="skeleton-list" aria-label="正在加载搜索结果">
          {[1, 2, 3].map((item) => (
            <div className="skeleton" key={item} />
          ))}
        </div>
      ) : remoteResults.length ? (
        <div className="result-grid">
          {remoteResults.map((result) => (
            <article className="result-card" key={`${result.source}-${result.name}`}>
              <span className="result-card__icon">
                <Icon name="terminal" size={22} />
              </span>
              <div className="result-card__body">
                <h2>{result.name}</h2>
                <p title={result.source}>{result.source}</p>
                <span>{formatInstalls(result.installs)}</span>
              </div>
              <Button
                variant={result.installed ? 'secondary' : 'primary'}
                disabled={result.installed}
                onClick={() => chooseInstallTargets(result)}
              >
                {result.installed ? (
                  <>
                    <Icon name="check" />
                    已安装
                  </>
                ) : (
                  <>
                    <Icon name="download" />
                    安装
                  </>
                )}
              </Button>
            </article>
          ))}
        </div>
      ) : !searchError ? (
        <EmptyState icon="search" title="没有找到结果" body="尝试使用更短或不同的关键词。" />
      ) : null}
    </section>
  );

  /** 渲染运行环境、软件更新与隐私设置页。 */
  const renderSettingsPage = (): JSX.Element => (
    <section id="panel-settings" className="page-panel">
      <header className="page-header">
        <div>
          <p className="eyebrow">PREFERENCES</p>
          <h1>设置</h1>
          <p>检查运行环境、软件版本和本地数据策略。</p>
        </div>
      </header>
      <div className="settings-grid">
        <section className="settings-card settings-card--wide">
          <div className="settings-card__header">
            <span className="settings-card__icon">
              <Icon name="terminal" />
            </span>
            <div>
              <h2>运行环境</h2>
              <p>仅用于执行官方 skills 命令。</p>
            </div>
            {runtime?.ready ? (
              <span className="pill pill--success">环境正常</span>
            ) : (
              <span className="pill pill--warning">需要处理</span>
            )}
          </div>
          <div className="runtime-list">
            {runtime ? (
              <>
                <RuntimeRow name="Node.js" status={runtime.node} />
                <RuntimeRow name="npx" status={runtime.npx} />
                <RuntimeRow name="Git" status={runtime.git} />
              </>
            ) : (
              <p className="muted">正在读取环境状态…</p>
            )}
          </div>
          {!runtime?.ready ? (
            <div className="settings-card__footer">
              <Button
                variant="primary"
                onClick={() => void installRuntime()}
                busy={busy.has('runtime-install')}
              >
                安装所需环境
              </Button>
            </div>
          ) : null}
        </section>
        <section className="settings-card">
          <div className="settings-card__header">
            <span className="settings-card__icon">
              <Icon name="refresh" />
            </span>
            <div>
              <h2>软件更新</h2>
              <p>当前版本 {APP.version}</p>
            </div>
          </div>
          <p className="settings-card__copy" id="app-update-status">
            {backendConnected
              ? '每次启动都会异步检查 GitHub 正式版，发现更新后由你确认再安装。'
              : '后台服务未连接，当前无法检查或安装软件更新。'}
          </p>
          <Button
            onClick={() => void checkAppUpdate()}
            busy={busy.has('app-update-check')}
            disabled={!backendConnected}
            aria-describedby="app-update-status"
            title={backendConnected ? undefined : '需要先连接后台服务'}
          >
            检查更新
          </Button>
        </section>
        <section className="settings-card">
          <div className="settings-card__header">
            <span className="settings-card__icon">
              <Icon name="shield" />
            </span>
            <div>
              <h2>隐私与数据</h2>
              <p>不主动上报数据</p>
            </div>
          </div>
          <p className="settings-card__copy">
            无分析、遥测或崩溃上报。搜索、安装和更新仅在执行对应功能时联网。
          </p>
          <span className="data-path">%LOCALAPPDATA%\OpenSkillsGUI</span>
        </section>
        <section className="settings-card settings-card--wide">
          <div className="settings-card__header">
            <span className="settings-card__icon">
              <Icon name="info" />
            </span>
            <div>
              <h2>关于</h2>
              <p>{APP.name} · AGPL-3.0</p>
            </div>
          </div>
          <p className="settings-card__copy">
            面向 Windows x64 的轻量级全局 Skill 管理客户端。卸载软件时保留用户数据、Skill
            与目录链接。
          </p>
          <div className="about-line">
            <span>应用标识</span>
            <code>{APP.id}</code>
          </div>
          <div className="about-line">
            <span>发布仓库</span>
            <code>{APP.repository}</code>
          </div>
        </section>
      </div>
    </section>
  );

  if (initializing) {
    return (
      <main className="splash" aria-live="polite">
        <span className="brand__mark brand__mark--large">
          <span />
          <span />
          <span />
        </span>
        <h1>Open Skills GUI</h1>
        <div className="splash__loader">
          <span />
        </div>
        <p>正在连接后台并检查运行环境…</p>
      </main>
    );
  }

  return (
    <div className="app-shell">
      {renderNavigation()}
      <main id="main-content" className="main-content">
        {displayedPage === 'installed'
          ? renderInstalledPage()
          : displayedPage === 'search'
            ? renderSearchPage()
            : renderSettingsPage()}
      </main>

      {progress ? (
        <aside className="progress-panel" aria-live="polite" aria-label="操作进度">
          <div>
            <span className="spinner" />
            <strong>{progress.message}</strong>
            <small>
              {progress.current !== undefined && progress.total
                ? `${progress.current} / ${progress.total}`
                : progress.stage}
            </small>
          </div>
          <progress
            className="progress-native"
            max={progress.total ?? 1}
            value={progress.total && progress.current !== undefined ? progress.current : undefined}
          >
            {progress.current ?? 0}
          </progress>
        </aside>
      ) : null}
      <ToastRegion messages={toasts} />

      {runtimePrompt ? (
        <Modal
          open
          title={runtime?.ready && bootstrapOnly ? '需要重启应用' : '准备运行环境'}
          description={
            runtime?.ready && bootstrapOnly
              ? '运行环境已经可用，重启后即可连接后台服务。'
              : '管理 Skill 需要 Node.js、npx 和 Git。'
          }
          onClose={deferRuntimeInstall}
          footer={
            <>
              <Button onClick={deferRuntimeInstall}>暂不安装</Button>
              {runtime?.ready && bootstrapOnly ? (
                <Button variant="primary" onClick={() => void restartForBackend()}>
                  立即重启
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => void installRuntime()}
                  busy={busy.has('runtime-install')}
                >
                  安装所需环境
                </Button>
              )}
            </>
          }
        >
          <div className="runtime-list runtime-list--dialog">
            {runtime ? (
              <>
                <RuntimeRow name="Node.js" status={runtime.node} />
                <RuntimeRow name="npx" status={runtime.npx} />
                <RuntimeRow name="Git" status={runtime.git} />
              </>
            ) : null}
          </div>
          <div className="inline-alert">
            <Icon name="info" />
            <span>只下载官方便携包并校验 SHA-256，不修改系统 PATH。</span>
          </div>
        </Modal>
      ) : null}

      {legacyPrompt ? (
        <Modal
          open
          title="发现现有 Skill"
          description="是否由 Open Skills GUI 接管这些 Skill？"
          onClose={() => void declineLegacySkills()}
          footer={
            <>
              <Button onClick={() => void declineLegacySkills()} busy={busy.has('decline-adopt')}>
                保持未托管
              </Button>
              <Button
                variant="primary"
                onClick={() => void adoptLegacySkills()}
                busy={busy.has('adopt-all')}
              >
                接管可确认来源的 Skill
              </Button>
            </>
          }
        >
          <p>
            接管会整理实体目录和本工具创建的目录链接。内容不同的同名 Skill
            不会被覆盖，来源未知的项目需要逐项确认。
          </p>
        </Modal>
      ) : null}

      {confirm ? (
        <Modal
          open
          title={confirm.title}
          onClose={() => answerConfirm(false)}
          width="small"
          footer={
            <>
              <Button onClick={() => answerConfirm(false)}>取消</Button>
              <Button
                variant={confirm.danger ? 'danger' : 'primary'}
                onClick={() => answerConfirm(true)}
              >
                {confirm.confirmLabel}
              </Button>
            </>
          }
        >
          <p>{confirm.body}</p>
          {confirm.details ? <pre className="detail-box">{confirm.details}</pre> : null}
        </Modal>
      ) : null}

      {error ? (
        <Modal
          open
          title={error.title}
          onClose={() => setError(null)}
          width="small"
          footer={
            <Button variant="primary" onClick={() => setError(null)}>
              知道了
            </Button>
          }
        >
          <div className="error-message">
            <Icon name="warning" />
            <p>{error.message}</p>
          </div>
          {error.details ? (
            <details>
              <summary>查看错误详情</summary>
              <pre className="detail-box">{error.details}</pre>
            </details>
          ) : null}
        </Modal>
      ) : null}

      {noteSkill ? (
        <Modal
          open
          title={`编辑 ${noteSkill.name} 的备注`}
          onClose={() => setNoteSkill(null)}
          width="small"
          footer={
            <>
              <Button onClick={() => setNoteSkill(null)}>取消</Button>
              <Button
                variant="primary"
                onClick={() => void saveNote()}
                busy={busy.has(`note-${noteSkill.id}`)}
              >
                保存备注
              </Button>
            </>
          }
        >
          <label className="field-label" htmlFor="skill-note">
            备注
          </label>
          <textarea
            id="skill-note"
            value={noteValue}
            onInput={(event) => setNoteValue(event.currentTarget.value)}
            rows={5}
            maxLength={4000}
            autoFocus
            placeholder="记录用途、注意事项或使用场景"
          />
          <div className="field-counter">{noteValue.length} / 4000</div>
        </Modal>
      ) : null}

      {installState ? (
        <Modal
          open
          title={`安装 ${installState.result.name}`}
          description="通用目录是固定唯一实体；Claude Code 和 Windsurf 通过目录链接使用同一份 Skill。"
          onClose={() => setInstallState(null)}
          footer={
            <>
              <Button onClick={() => setInstallState(null)}>取消</Button>
              <Button
                variant="primary"
                onClick={() => void installRemoteSkill()}
                busy={busy.has(`install-${installState.result.name}`)}
              >
                安装
              </Button>
            </>
          }
        >
          <fieldset className="choice-list">
            <legend>安装目标</legend>
            {TARGET_OPTIONS.map((target) => (
              <label className="choice-row" key={target.value}>
                <input
                  type="checkbox"
                  checked={
                    target.value === 'universal' || installState.targets.includes(target.value)
                  }
                  disabled={target.value === 'universal'}
                  onChange={() => toggleInstallTarget(target.value)}
                />
                <span>
                  <strong>{target.label}</strong>
                  <small>{target.hint}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="source-preview">
            <span>来源</span>
            <code>{installState.result.source}</code>
          </div>
        </Modal>
      ) : null}

      {adoptionConflict ? (
        <Modal
          open
          title={`选择要保留的 ${adoptionConflict.skill.name} 副本`}
          description="检测到内容不同的同名 Skill，必须明确选择一个实体，其他副本不会被覆盖。"
          onClose={() => setAdoptionConflict(null)}
          width="wide"
          footer={<Button onClick={() => setAdoptionConflict(null)}>跳过此 Skill</Button>}
        >
          <div className="candidate-list">
            {adoptionConflict.candidates.map((candidate) => (
              <button
                className="candidate"
                key={candidate.path}
                onClick={() => void resolveAdoptionConflict(candidate.path)}
              >
                <span>
                  <strong>保留此副本</strong>
                  <small>{candidate.path}</small>
                </span>
                <span>{candidate.hash ? `哈希 ${candidate.hash.slice(0, 8)}` : '本机路径'}</span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
        </Modal>
      ) : null}

      {sourceBinding ? (
        <Modal
          open
          title={`确认 ${sourceBinding.skill.name} 的来源`}
          description="同名结果不一定是原来源，请核对仓库后再选择。"
          onClose={() => setSourceBinding(null)}
          width="wide"
        >
          <div className="candidate-list">
            {sourceBinding.candidates.map((candidate) => (
              <button
                className="candidate"
                key={candidate.source}
                onClick={() => void adoptWithSource(candidate)}
              >
                <span>
                  <strong>{candidate.name}</strong>
                  <small>{candidate.source}</small>
                </span>
                <span>{formatInstalls(candidate.installs)}</span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
        </Modal>
      ) : null}

      {appUpdate && backendConnected ? (
        <Modal
          open
          title={`发现新版本 ${appUpdate.latestVersion ?? ''}`}
          description={`当前版本 ${appUpdate.currentVersion}`}
          onClose={() => setAppUpdate(null)}
          footer={
            <>
              <Button onClick={() => setAppUpdate(null)}>稍后提醒</Button>
              <Button
                variant="primary"
                onClick={() => void installAppUpdate()}
                busy={busy.has('app-update-install')}
              >
                <Icon name="download" />
                下载并升级
              </Button>
            </>
          }
        >
          <div className="release-notes">
            <h3>更新说明</h3>
            <p>{appUpdate.releaseNotes || '此版本未提供更新说明。'}</p>
          </div>
          <div className="inline-alert">
            <Icon name="shield" />
            <span>安装前会校验 GitHub Release 提供的 SHA-256 摘要。</span>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
