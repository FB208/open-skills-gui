/** 隐藏 Windows 用户主目录，并兼容大小写与两种路径分隔符。 */
export function redactUserHomePaths(value: string): string {
  const homes = [process.env.USERPROFILE, process.env.HOME]
    .filter((item): item is string => Boolean(item?.trim()))
    .map((item) => item.trim().replace(/[\\/]+$/g, ''))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let output = value;
  for (const home of new Set(homes)) {
    output = output.replace(homePathPattern(home), '%USERPROFILE%');
  }
  return output;
}

/** 把路径字符转换为分隔符不敏感、大小写不敏感的正则。 */
function homePathPattern(home: string): RegExp {
  let pattern = '';
  for (const character of home) {
    pattern += /[\\/]/.test(character) ? '[\\\\/]+' : escapeRegularExpression(character);
  }
  return new RegExp(pattern, 'gi');
}

/** 转义单个正则表达式字面字符。 */
function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
