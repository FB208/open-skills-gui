import path from 'node:path';
import type { AgentTarget, RemoteSkillResult, SkillSource } from '../shared/types.js';
import { RUNTIME } from '../shared/constants.js';
import { BackendException } from './errors.js';
import type { PathLayout } from './paths.js';
import { assertNoLinkedParents, assertSkillName } from './paths.js';
import type { CommandRunner, CommandSpec } from './process.js';
import { assertCommandSuccess } from './process.js';
import type { RuntimeService, RuntimeSelection } from './runtime.js';

export interface CliInstalledSkill {
  name: string;
  path?: string;
  scope?: string;
  agents?: string[];
}

export interface SkillsClient {
  list(homeDir?: string): Promise<CliInstalledSkill[]>;
  find(
    query: string,
    installedNames?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<RemoteSkillResult[]>;
  add(
    source: string | SkillSource,
    name: string,
    options?: { homeDir?: string; targets?: AgentTarget[]; signal?: AbortSignal },
  ): Promise<void>;
}

/** 通过固定版本 npx skills 提供 CLI 能力。 */
export class SkillsCli implements SkillsClient {
  constructor(
    private readonly runtime: RuntimeService,
    private readonly runner: CommandRunner,
    private readonly layout: PathLayout,
  ) {}

  /** 读取全局 Skill JSON 清单。 */
  async list(homeDir?: string): Promise<CliInstalledSkill[]> {
    const result = await this.execute(['list', '-g', '--json'], { homeDir });
    assertCommandSuccess(result, '读取 Skill 清单');
    return parseListOutput(result.stdout);
  }

  /** 搜索公开 Skill，并标记本地安装状态。 */
  async find(
    query: string,
    installedNames: ReadonlySet<string> = new Set(),
    signal?: AbortSignal,
  ): Promise<RemoteSkillResult[]> {
    const normalized = query.trim();
    if (!normalized) return [];
    if (normalized.length > 200)
      throw new BackendException('INVALID_INPUT', '搜索内容不能超过 200 个字符');
    const result = await this.execute(['find', normalized], { signal });
    assertCommandSuccess(result, '搜索 Skill');
    return parseFindOutput(result.stdout, installedNames);
  }

  /** 使用官方命令安装指定名称的公开 GitHub Skill。 */
  async add(
    source: string | SkillSource,
    name: string,
    options: { homeDir?: string; targets?: AgentTarget[]; signal?: AbortSignal } = {},
  ): Promise<void> {
    assertSkillName(name);
    const normalized =
      typeof source === 'string'
        ? normalizeSource(source)
        : normalizeSource(source.locator, source.ref, source.skillPath);
    if (normalized.type !== 'github')
      throw new BackendException('UPDATE_UNAVAILABLE', '仅支持公开 GitHub Skill 来源');
    const result = await this.execute(
      [
        'add',
        sourceSpecifier(normalized),
        '--skill',
        name,
        '--global',
        '--yes',
        '--agent',
        'codex',
      ],
      options,
    );
    assertCommandSuccess(result, `安装 Skill「${name}」`);
  }

  /** 用选定运行环境执行固定版本 skills 命令。 */
  private async execute(
    args: readonly string[],
    options: { homeDir?: string; signal?: AbortSignal } = {},
  ): Promise<Awaited<ReturnType<CommandRunner['run']>>> {
    await assertNoLinkedParents(path.dirname(this.layout.dataRoot), this.layout.cacheDir);
    const selected = await this.runtime.requireSelection();
    return await this.runner.run(createNpxCommand(selected, args, this.layout, options));
  }
}

/** 构建“node.exe + npx-cli.js”的无 shell 命令。 */
export function createNpxCommand(
  runtime: RuntimeSelection,
  skillsArgs: readonly string[],
  layout: PathLayout,
  options: { homeDir?: string; signal?: AbortSignal } = {},
): CommandSpec {
  if (
    ![runtime.nodePath, runtime.npxPath, runtime.gitPath].every(path.isAbsolute) ||
    !runtime.npxPath.toLowerCase().endsWith('npx-cli.js')
  ) {
    throw new BackendException('RUNTIME_NOT_READY', '运行环境路径不安全或 npx 未绑定到 Node.js');
  }
  const homeDir = path.resolve(options.homeDir ?? layout.homeDir);
  const safeExitModule = path
    .join(layout.appRoot, 'extensions', 'skills-safe-exit.cjs')
    .replaceAll('\\', '/');
  const systemDirectory = path.join(
    path.resolve(process.env.SystemRoot ?? 'C:\\Windows'),
    'System32',
  );
  const commandPath = [
    path.dirname(runtime.nodePath),
    path.dirname(runtime.gitPath),
    systemDirectory,
  ].join(path.delimiter);
  return {
    executable: runtime.nodePath,
    args: [runtime.npxPath, '--yes', `skills@${RUNTIME.skillsVersion}`, ...skillsArgs],
    env: {
      ...sanitizeCliEnvironment(process.env),
      HOME: homeDir,
      USERPROFILE: homeDir,
      Path: commandPath,
      PATH: commandPath,
      npm_config_cache: path.join(layout.cacheDir, 'npm'),
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      DISABLE_TELEMETRY: '1',
      DO_NOT_TRACK: '1',
      NO_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      // skills@1.5.19 关闭遥测后退出过早，预加载模块会等待 Windows 网络句柄关闭。
      NODE_OPTIONS: `--require=\"${safeExitModule}\"`,
    },
    signal: options.signal,
    timeoutMs: 5 * 60_000,
  };
}

/** 解析 list JSON，并对格式变化明确失败。 */
export function parseListOutput(value: string): CliInstalledSkill[] {
  const clean = stripAnsi(value).trim();
  const arrayStart = clean.indexOf('[');
  const objectStart = clean.indexOf('{');
  const starts = [arrayStart, objectStart].filter((index) => index >= 0);
  if (starts.length === 0)
    throw new BackendException('CLI_OUTPUT_CHANGED', '无法解析 skills list 输出');
  const start = Math.min(...starts);
  const closing = clean[start] === '[' ? clean.lastIndexOf(']') : clean.lastIndexOf('}');
  if (closing < start)
    throw new BackendException('CLI_OUTPUT_CHANGED', '无法解析 skills list 输出');
  try {
    const parsed: unknown = JSON.parse(clean.slice(start, closing + 1));
    const items = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { skills?: unknown }).skills)
        ? (parsed as { skills: unknown[] }).skills
        : undefined;
    if (!items) throw new Error('缺少 skills 数组');
    return items.map((item) => {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof (item as { name?: unknown }).name !== 'string'
      )
        throw new Error('Skill 项格式无效');
      const source = item as { name: string; path?: unknown; scope?: unknown; agents?: unknown };
      return {
        name: source.name,
        path: typeof source.path === 'string' ? source.path : undefined,
        scope: typeof source.scope === 'string' ? source.scope : undefined,
        agents: Array.isArray(source.agents)
          ? source.agents.filter((agent): agent is string => typeof agent === 'string')
          : undefined,
      };
    });
  } catch (error) {
    throw new BackendException(
      'CLI_OUTPUT_CHANGED',
      '无法解析 skills list 输出',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** 解析 1.5.19 find 文本输出，最多保留六项。 */
export function parseFindOutput(
  value: string,
  installedNames: ReadonlySet<string> = new Set(),
): RemoteSkillResult[] {
  const lines = stripAnsi(value).split(/\r?\n/);
  const results: RemoteSkillResult[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const short = line.match(/(?:^|\s)([\w.-]+\/[\w.-]+)@([\w.-]+)(?:\s+([^\r\n]*?))?\s*$/);
    const url = line.match(/https?:\/\/skills\.sh\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)/i);
    const source = short?.[1] ?? (url ? `${url[1]}/${url[2]}` : undefined);
    const name = short?.[2] ?? url?.[3];
    if (!source || !name) continue;
    const key = `${source}@${name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      name,
      source,
      installs: parseInstallCount(short?.[3] ?? line),
      installed: installedNames.has(name.toLowerCase()),
    });
    if (results.length === 6) break;
  }
  if (
    results.length === 0 &&
    lines.some((line) => /no (?:skills|results)|未找到|0 results/i.test(line))
  )
    return [];
  if (results.length === 0)
    throw new BackendException('CLI_OUTPUT_CHANGED', '无法解析 skills find 输出');
  return results;
}

/** 规范化公开 GitHub 来源、分支与仓库内路径。 */
export function normalizeSource(locator: string, ref?: string, skillPath?: string): SkillSource {
  const trimmed = locator
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\\/g, '/');
  const match = trimmed.match(
    /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\/tree\/([^/]+)(?:\/(.*))?)?$/i,
  );
  if (!match) {
    const type = /^https?:\/\//i.test(trimmed) || /^git@/i.test(trimmed) ? 'git' : 'unknown';
    return {
      type,
      locator: trimmed,
      ref: cleanOptional(ref),
      skillPath: cleanSkillPath(skillPath),
    };
  }
  return {
    type: 'github',
    locator: `${match[1].toLowerCase()}/${match[2].toLowerCase()}`,
    ref: cleanOptional(ref ?? match[3]),
    skillPath: cleanSkillPath(skillPath ?? match[4]),
  };
}

/** 生成用于同源分组的稳定键。 */
export function sourceKey(source: SkillSource): string {
  const normalized = normalizeSource(source.locator, source.ref, source.skillPath);
  return [
    normalized.type,
    normalized.locator.toLowerCase(),
    normalized.ref ?? '',
    normalized.skillPath ?? '',
  ].join('\0');
}

/** 按 skills 1.5.19 的“仓库/子路径#分支”语义生成来源参数。 */
export function sourceSpecifier(source: SkillSource): string {
  const normalized = normalizeSource(source.locator, source.ref, source.skillPath);
  if (normalized.type !== 'github') return normalized.locator;
  const withPath = normalized.skillPath
    ? `${normalized.locator}/${normalized.skillPath}`
    : normalized.locator;
  return normalized.ref ? `${withPath}#${encodeURIComponent(normalized.ref)}` : withPath;
}

/** 继承普通环境变量，但剥离可能向外部 CLI 泄露的认证与 SSH 上下文。 */
function sanitizeCliEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (/(?:token|auth|askpass|ssh)/i.test(key)) continue;
    output[key] = value;
  }
  return output;
}

/** 清理可选来源字段中的首尾空白。 */
function cleanOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/** 规范化并校验仓库内相对路径。 */
function cleanSkillPath(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized) return undefined;
  if (normalized.split('/').some((part) => part === '..' || part === '.'))
    throw new BackendException('INVALID_SOURCE', 'Skill 仓库路径不安全');
  return normalized;
}

/** 把 k/m 后缀安装量转换为整数。 */
function parseInstallCount(value: string): number | undefined {
  const match = value.match(/([\d,.]+)\s*([kKmM])?\s*(?:installs?)?/i);
  if (!match) return undefined;
  const numeric = Number.parseFloat(match[1].replaceAll(',', ''));
  const scale =
    match[2]?.toLowerCase() === 'k' ? 1_000 : match[2]?.toLowerCase() === 'm' ? 1_000_000 : 1;
  return Number.isFinite(numeric) ? Math.round(numeric * scale) : undefined;
}

/** 移除 CLI 输出中的 ANSI 控制序列。 */
function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}
