export type RuntimeBootstrapAction = 'Status' | 'Install';

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 严格校验 Neutralino 应用目录并返回固定的运行环境脚本路径。 */
export function resolveBootstrapScriptPath(applicationPath: unknown): string {
  if (typeof applicationPath !== 'string' || !WINDOWS_ABSOLUTE_PATH.test(applicationPath)) {
    throw new Error('无法定位可信的运行环境引导脚本。');
  }

  if (
    applicationPath.includes('\0') ||
    applicationPath.includes('\r') ||
    applicationPath.includes('\n') ||
    applicationPath.includes('"')
  ) {
    throw new Error('运行环境引导脚本路径包含不允许的字符。');
  }

  const normalized = applicationPath.replaceAll('/', '\\').replace(/[\\]+$/, '');
  const segments = normalized.slice(3).split('\\');
  if (!normalized || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('运行环境引导脚本路径无效。');
  }

  return `${normalized}\\scripts\\runtime-bootstrap.ps1`;
}

/** 把 UTF-16LE 字节编码为 PowerShell EncodedCommand 所需的 Base64。 */
function encodePowerShellSource(source: string): string {
  const bytes = new Uint8Array(source.length * 2);
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >>> 8;
  }

  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const block = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64_ALPHABET[(block >>> 18) & 63];
    encoded += BASE64_ALPHABET[(block >>> 12) & 63];
    encoded += second === undefined ? '=' : BASE64_ALPHABET[(block >>> 6) & 63];
    encoded += third === undefined ? '=' : BASE64_ALPHABET[block & 63];
  }
  return encoded;
}

/** 为 Neutralino 仅支持字符串的接口生成无用户输入拼接的固定 PowerShell 命令。 */
export function buildRuntimeBootstrapCommand(
  applicationPath: unknown,
  action: RuntimeBootstrapAction,
): string {
  if (action !== 'Status' && action !== 'Install') {
    throw new Error('运行环境引导动作无效。');
  }

  const script = resolveBootstrapScriptPath(applicationPath).replaceAll("'", "''");
  const source = `& '${script}' -Action '${action}'`;
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellSource(source)}`;
}
