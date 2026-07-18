import { describe, expect, it } from 'vitest';

import {
  buildRuntimeBootstrapCommand,
  resolveBootstrapScriptPath,
} from '../../src/ui/runtime-bootstrap.js';

/** 从固定命令中解码 PowerShell 脚本，验证实际执行内容。 */
function decodeCommand(command: string): string {
  const encoded = command.split(' ').at(-1);
  if (!encoded) throw new Error('测试命令缺少 EncodedCommand 内容');
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

describe('resolveBootstrapScriptPath', () => {
  it('仅在可信的 Windows 绝对目录下追加固定脚本路径', () => {
    expect(resolveBootstrapScriptPath('D:/中文 目录/OpenSkillsGUI/')).toBe(
      'D:\\中文 目录\\OpenSkillsGUI\\scripts\\runtime-bootstrap.ps1',
    );
  });

  it('拒绝相对路径、遍历片段和命令注入字符', () => {
    expect(() => resolveBootstrapScriptPath('OpenSkillsGUI')).toThrow();
    expect(() => resolveBootstrapScriptPath('C:\\Apps\\..\\Other')).toThrow();
    expect(() => resolveBootstrapScriptPath('C:\\Apps\nInjected')).toThrow();
    expect(() => resolveBootstrapScriptPath('C:\\Apps"Bad')).toThrow();
  });
});

describe('buildRuntimeBootstrapCommand', () => {
  it('通过 EncodedCommand 安全传递固定动作和带单引号路径', () => {
    const command = buildRuntimeBootstrapCommand("C:\\Users\\O'Brien\\OpenSkillsGUI", 'Status');
    expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive/);
    expect(decodeCommand(command)).toBe(
      "& 'C:\\Users\\O''Brien\\OpenSkillsGUI\\scripts\\runtime-bootstrap.ps1' -Action 'Status'",
    );
  });

  it('运行时也拒绝类型系统之外的未知动作', () => {
    expect(() => buildRuntimeBootstrapCommand('C:\\OpenSkillsGUI', 'Remove' as 'Status')).toThrow(
      '运行环境引导动作无效',
    );
  });
});
