import type { AppUpdateInfo, RuntimeStatus } from '../shared/types.js';

export type BackendTimeoutMode = 'runtime-missing' | 'backend-failed';

/** 根据直接环境检查结果区分环境缺失与后台服务启动失败。 */
export function classifyBackendTimeout(runtime: RuntimeStatus): BackendTimeoutMode {
  return runtime.ready ? 'backend-failed' : 'runtime-missing';
}

/** 只有后台和完整运行环境同时可用时才开放 Skill 管理页面。 */
export function canUseSkillPages(
  backendConnected: boolean,
  runtime: RuntimeStatus | null,
): boolean {
  return backendConnected && runtime?.ready === true;
}

/** 启动静默更新检查且不向调用方返回待等待的 Promise。 */
export function startSilentUpdateCheck(
  check: () => Promise<AppUpdateInfo>,
  onAvailable: (update: AppUpdateInfo) => void,
): void {
  void check()
    .then((update) => {
      if (update.available) onAvailable(update);
    })
    .catch(() => undefined);
}
