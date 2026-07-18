import type { SkillRecord } from '../shared/types.js';

export type UpdateFeedbackTone = 'success' | 'error' | 'info';

export interface UpdateFeedback {
  updated: number;
  failed: number;
  skipped: number;
  text: string;
  tone: UpdateFeedbackTone;
}

/** 统一搜索文本，避免大小写和空白影响匹配。 */
export function normalizeText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s_./\\-]+/g, '');
}

/** 使用连续包含或字符顺序匹配完成轻量模糊查询。 */
export function fuzzyMatch(value: string, query: string): boolean {
  const source = normalizeText(value);
  const target = normalizeText(query);
  if (!target) return true;
  if (source.includes(target)) return true;

  let index = 0;
  for (const character of source) {
    if (character === target[index]) index += 1;
    if (index === target.length) return true;
  }
  return false;
}

/** 将后端返回的 Skill 合并到当前列表。 */
export function mergeSkills(current: SkillRecord[], incoming: SkillRecord[]): SkillRecord[] {
  const records = new Map(current.map((skill) => [skill.id, skill]));
  incoming.forEach((skill) => records.set(skill.id, skill));
  return [...records.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

/** 按后端最终状态汇总实际更新、失败和跳过数量。 */
export function summarizeUpdateResults(
  results: SkillRecord[],
  requestedIds: string[],
): UpdateFeedback {
  const records = new Map(results.map((skill) => [skill.id, skill]));
  let updated = 0;
  let failed = 0;
  let skipped = 0;

  for (const id of requestedIds) {
    const status = records.get(id)?.updateStatus;
    if (status === 'latest') updated += 1;
    else if (status === 'failed') failed += 1;
    else skipped += 1;
  }

  return {
    updated,
    failed,
    skipped,
    text: `已更新 ${updated}，失败 ${failed}，跳过 ${skipped}`,
    tone: failed ? 'error' : skipped ? 'info' : 'success',
  };
}
