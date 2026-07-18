import { describe, expect, it } from 'vitest';

import type { SkillRecord, UpdateStatus } from '../../src/shared/types.js';
import { fuzzyMatch, mergeSkills, summarizeUpdateResults } from '../../src/ui/skill-utils.js';

/** 创建满足共享协议的最小 Skill 测试记录。 */
function makeSkill(
  id: string,
  name: string,
  updateStatus: UpdateStatus = 'unchecked',
): SkillRecord {
  return {
    id,
    name,
    source: { type: 'unknown', locator: '' },
    state: 'enabled',
    managed: true,
    targets: ['universal'],
    observedPaths: [],
    updateStatus,
    note: '',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

describe('fuzzyMatch', () => {
  it('忽略大小写、空白和常见路径分隔符', () => {
    expect(fuzzyMatch('Open-Skills/GUI', 'open skills gui')).toBe(true);
  });

  it('支持保持顺序的非连续字符匹配', () => {
    expect(fuzzyMatch('data-analysis-tool', 'dast')).toBe(true);
    expect(fuzzyMatch('data-analysis-tool', 'tsad')).toBe(false);
  });

  it('空查询匹配全部内容', () => {
    expect(fuzzyMatch('任意 Skill', '  ')).toBe(true);
  });
});

describe('mergeSkills', () => {
  it('按身份覆盖旧记录并按中文名称排序', () => {
    const current = [makeSkill('a', 'Beta'), makeSkill('b', '旧名称')];
    const replacement = { ...makeSkill('b', 'Alpha'), note: '新备注' };

    const result = mergeSkills(current, [replacement]);

    expect(result.map((skill: SkillRecord) => skill.id)).toEqual(['b', 'a']);
    expect(result[0]?.note).toBe('新备注');
  });
});

describe('summarizeUpdateResults', () => {
  it('分别统计最新、失败和被跳过的请求', () => {
    const result = summarizeUpdateResults(
      [
        makeSkill('a', 'A', 'latest'),
        makeSkill('b', 'B', 'failed'),
        makeSkill('c', 'C', 'conflict'),
      ],
      ['a', 'b', 'c', 'missing'],
    );

    expect(result).toEqual({
      updated: 1,
      failed: 1,
      skipped: 2,
      text: '已更新 1，失败 1，跳过 2',
      tone: 'error',
    });
  });

  it('全部完成时返回成功反馈', () => {
    const result = summarizeUpdateResults(
      [makeSkill('a', 'A', 'latest'), makeSkill('b', 'B', 'latest')],
      ['a', 'b'],
    );

    expect(result.tone).toBe('success');
    expect(result.updated).toBe(2);
  });
});
