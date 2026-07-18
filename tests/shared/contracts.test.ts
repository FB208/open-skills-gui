import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AGENT_TARGETS, APP, RUNTIME } from '../../src/shared/constants.js';

describe('共享契约', () => {
  it('保持应用版本来源一致', async () => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
      version: string;
    };
    const neutralinoConfig = JSON.parse(
      await readFile(resolve('neutralino.config.json'), 'utf8'),
    ) as { version: string };

    expect(APP.version).toBe(packageJson.version);
    expect(neutralinoConfig.version).toBe(packageJson.version);
  });

  it('只公开已确认的三个 Agent 目标组', () => {
    expect(AGENT_TARGETS).toEqual(['universal', 'claude-code', 'windsurf']);
  });

  it('固定兼容的 skills 与 Node 版本', () => {
    expect(RUNTIME.skillsVersion).toBe('1.5.19');
    expect(RUNTIME.minNodeVersion).toBe('22.20.0');
    expect(RUNTIME.nodeVersion).toBe('24.18.0');
  });
});
