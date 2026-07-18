import type { RuntimeStatus, SkillRecord } from '@shared/types';

import type { BackendClient } from './backend';

/** 仅供 TypeScript 验证前端不能自报返回类型或遗漏必填请求参数。 */
export function assertBackendClientTypes(client: BackendClient): void {
  const runtime: Promise<RuntimeStatus> = client.call('runtime.status');
  const note: Promise<SkillRecord> = client.call('skills.saveNote', {
    id: 'skill-id',
    note: '备注',
  });
  void runtime;
  void note;

  // @ts-expect-error 安装请求必须提供来源、名称和目标目录。
  client.call('skills.install', { name: 'pdf' });
  // @ts-expect-error 返回类型由方法固定，调用方不能自行指定结果泛型。
  client.call<string>('runtime.status');
}
