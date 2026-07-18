/** 比较仅含数字段的版本，返回 -1、0、1。 */
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  const size = Math.max(a.length, b.length);
  for (let index = 0; index < size; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference < 0) return -1;
    if (difference > 0) return 1;
  }
  return 0;
}

/** 从命令输出或标签中提取数字版本。 */
export function extractVersion(value: string): string | undefined {
  return value.match(/(?:^|[^0-9])(\d+\.\d+\.\d+(?:\.\d+)?)(?:[^0-9]|$)/)?.[1];
}

function normalizeVersion(value: string): number[] {
  const extracted = extractVersion(value) ?? value.replace(/^v/i, '');
  const parts = extracted.split('.').map((part) => Number.parseInt(part, 10));
  return parts.every(Number.isFinite) ? parts : [0];
}
