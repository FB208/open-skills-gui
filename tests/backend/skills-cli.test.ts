import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNTIME } from '../../src/shared/constants.js';
import { createPathLayout } from '../../src/backend/paths.js';
import {
  createNpxCommand,
  normalizeSource,
  parseFindOutput,
  parseListOutput,
  sourceKey,
  sourceSpecifier,
} from '../../src/backend/skills-cli.js';

/** 恢复单个进程环境变量，避免测试污染后续用例。 */
function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('skills CLI 输出解析', () => {
  it('解析带前导日志和 ANSI 的 list JSON 包装结构', () => {
    const output =
      '\u001b[32m正在读取\u001b[0m\r\n' +
      JSON.stringify({
        skills: [
          {
            name: '中文-skill',
            path: 'C:\\用户\\.agents\\skills\\中文-skill',
            scope: 'global',
            agents: ['codex', 1],
          },
          { name: 'another' },
        ],
      });

    expect(parseListOutput(output)).toEqual([
      {
        name: '中文-skill',
        path: 'C:\\用户\\.agents\\skills\\中文-skill',
        scope: 'global',
        agents: ['codex'],
      },
      { name: 'another', path: undefined, scope: undefined, agents: undefined },
    ]);
  });

  it('find 同时支持短格式和 skills.sh 地址，去重、标记已安装且最多返回六项', () => {
    const lines = [
      'owner/repo@alpha 1.2k installs',
      'https://skills.sh/OWNER/repo/alpha 1.2k installs',
      'owner/repo@beta 25 installs',
      'owner/repo@gamma 2m installs',
      'owner/repo@delta 4 installs',
      'owner/repo@epsilon 5 installs',
      'owner/repo@zeta 6 installs',
      'owner/repo@seventh 7 installs',
    ];
    const parsed = parseFindOutput(lines.join('\r\n'), new Set(['alpha', 'GAMMA'.toLowerCase()]));

    expect(parsed).toHaveLength(6);
    expect(parsed[0]).toEqual({
      name: 'alpha',
      source: 'owner/repo',
      installs: 1200,
      installed: true,
    });
    expect(parsed[1]).toMatchObject({ name: 'beta', installs: 25, installed: false });
    expect(parsed[2]).toMatchObject({ name: 'gamma', installs: 2_000_000, installed: true });
    expect(parsed.some((item) => item.name === 'seventh')).toBe(false);
  });

  it('明确区分“没有结果”和未知输出格式', () => {
    expect(parseFindOutput('No skills found')).toEqual([]);
    expect(() => parseFindOutput('服务返回了一种全新的格式')).toThrowError(
      expect.objectContaining({ code: 'CLI_OUTPUT_CHANGED' }),
    );
    expect(() => parseListOutput('{"unexpected":[]}')).toThrowError(
      expect.objectContaining({ code: 'CLI_OUTPUT_CHANGED' }),
    );
  });
});

describe('Skill 来源规范化', () => {
  it('将 GitHub URL、大小写、分支与仓库子路径归一化为稳定来源', () => {
    const fromUrl = normalizeSource(
      ' https://github.com/Owner/Repo/tree/release/skills/tool/ ',
      undefined,
      undefined,
    );
    const fromParts = normalizeSource('owner/repo.git', 'release', 'skills\\tool');

    expect(fromUrl).toEqual({
      type: 'github',
      locator: 'owner/repo',
      ref: 'release',
      skillPath: 'skills/tool',
    });
    expect(fromParts).toEqual(fromUrl);
    expect(sourceKey(fromUrl)).toBe(sourceKey(fromParts));
    expect(sourceKey(normalizeSource('OWNER/REPO', 'Release', 'Skills/Tool'))).not.toBe(
      sourceKey(normalizeSource('owner/repo', 'release', 'skills/tool')),
    );
    expect(sourceSpecifier(fromUrl)).toBe('owner/repo/skills/tool#release');
    expect(sourceSpecifier(normalizeSource('owner/repo', undefined, 'skills/tool'))).toBe(
      'owner/repo/skills/tool',
    );
    const slashRef = sourceSpecifier(
      normalizeSource('owner/repo', 'feature/topic', 'skills/ToolCase'),
    );
    expect(slashRef).toBe('owner/repo/skills/ToolCase#feature%2Ftopic');
    // skills 1.5.19 的 parseFragmentRef 会 decodeURIComponent，因此不会得到字面 %2F。
    expect(decodeURIComponent(slashRef.split('#')[1])).toBe('feature/topic');
  });

  it('非公开 GitHub 地址不冒充可更新来源，并拒绝子路径穿越', () => {
    expect(normalizeSource('https://git.example.test/team/repo.git')).toMatchObject({
      type: 'git',
      locator: 'https://git.example.test/team/repo',
    });
    expect(() => normalizeSource('owner/repo', undefined, '../secret')).toThrowError(
      expect.objectContaining({ code: 'INVALID_SOURCE' }),
    );
  });

  it('固定使用绝对 node.exe 执行同目录 npx-cli.js，并隔离 HOME、缓存、遥测和认证变量', () => {
    const previous = {
      token: process.env.GITHUB_TOKEN,
      askpass: process.env.GIT_ASKPASS,
      ssh: process.env.SSH_AUTH_SOCK,
      proxy: process.env.HTTPS_PROXY,
    };
    process.env.GITHUB_TOKEN = '不能继承的令牌';
    process.env.GIT_ASKPASS = 'C:\\秘密\\askpass.exe';
    process.env.SSH_AUTH_SOCK = 'C:\\秘密\\ssh.sock';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8080';
    const layout = createPathLayout({
      appRoot: 'C:\\程序\\Open Skills GUI',
      dataRoot: 'C:\\用户数据\\OpenSkillsGUI',
      homeDir: 'C:\\用户 家目录',
    });
    const command = createNpxCommand(
      {
        nodePath: 'C:\\运行环境\\node\\node.exe',
        npxPath: 'C:\\运行环境\\node\\node_modules\\npm\\bin\\npx-cli.js',
        gitPath: 'C:\\运行环境\\git\\cmd\\git.exe',
      },
      ['find', '中文'],
      layout,
      { homeDir: 'C:\\隔离 目录' },
    );

    expect(command.executable).toBe('C:\\运行环境\\node\\node.exe');
    expect(command.args?.slice(0, 3)).toEqual([
      'C:\\运行环境\\node\\node_modules\\npm\\bin\\npx-cli.js',
      '--yes',
      `skills@${RUNTIME.skillsVersion}`,
    ]);
    expect(command.env).toMatchObject({
      HOME: 'C:\\隔离 目录',
      USERPROFILE: 'C:\\隔离 目录',
      DISABLE_TELEMETRY: '1',
      DO_NOT_TRACK: '1',
      npm_config_cache: path.join(layout.cacheDir, 'npm'),
      HTTPS_PROXY: 'http://127.0.0.1:8080',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      NODE_OPTIONS: '--require="C:/程序/Open Skills GUI/extensions/skills-safe-exit.cjs"',
    });
    expect(command.env?.GITHUB_TOKEN).toBeUndefined();
    expect(command.env?.GIT_ASKPASS).toBeUndefined();
    expect(command.env?.SSH_AUTH_SOCK).toBeUndefined();
    expect(command.executable.toLowerCase()).not.toContain('npx.cmd');
    restoreEnvironment('GITHUB_TOKEN', previous.token);
    restoreEnvironment('GIT_ASKPASS', previous.askpass);
    restoreEnvironment('SSH_AUTH_SOCK', previous.ssh);
    restoreEnvironment('HTTPS_PROXY', previous.proxy);
  });
});
