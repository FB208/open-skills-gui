import { describe, expect, it, vi } from 'vitest';

import type { AppUpdateInfo, RuntimeStatus } from '../../src/shared/types.js';
import {
  canUseSkillPages,
  classifyBackendTimeout,
  startSilentUpdateCheck,
} from '../../src/ui/startup-policy.js';

const READY_RUNTIME: RuntimeStatus = {
  ready: true,
  node: { available: true },
  npx: { available: true },
  git: { available: true },
};

/** 创建最小的软件更新响应。 */
function update(available: boolean): AppUpdateInfo {
  return { available, currentVersion: '1.0.0', latestVersion: available ? '1.1.0' : undefined };
}

describe('启动状态策略', () => {
  it('将环境缺失与环境已就绪但后台失败分开处理', () => {
    expect(classifyBackendTimeout(READY_RUNTIME)).toBe('backend-failed');
    expect(
      classifyBackendTimeout({
        ...READY_RUNTIME,
        ready: false,
        git: { available: false, reason: '未安装' },
      }),
    ).toBe('runtime-missing');
  });

  it('后台或运行环境任一未就绪时都关闭 Skill 页面', () => {
    expect(canUseSkillPages(true, READY_RUNTIME)).toBe(true);
    expect(canUseSkillPages(false, READY_RUNTIME)).toBe(false);
    expect(canUseSkillPages(true, { ...READY_RUNTIME, ready: false })).toBe(false);
    expect(canUseSkillPages(true, null)).toBe(false);
  });
});

describe('静默软件更新检查', () => {
  it('立即返回且只在异步结果确有更新时通知界面', async () => {
    let resolveCheck: (result: AppUpdateInfo) => void = () => undefined;
    const check = new Promise<AppUpdateInfo>((resolve) => {
      resolveCheck = resolve;
    });
    const onAvailable = vi.fn();

    expect(startSilentUpdateCheck(() => check, onAvailable)).toBeUndefined();
    expect(onAvailable).not.toHaveBeenCalled();
    resolveCheck(update(true));
    await check;
    await Promise.resolve();
    expect(onAvailable).toHaveBeenCalledWith(update(true));
  });

  it('静默吞掉自动检查失败且不产生误报', async () => {
    const onAvailable = vi.fn();
    startSilentUpdateCheck(() => Promise.reject(new Error('断网')), onAvailable);
    await Promise.resolve();
    await Promise.resolve();
    expect(onAvailable).not.toHaveBeenCalled();
  });
});
