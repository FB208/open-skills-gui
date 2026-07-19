import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');

// 读取并解析项目内的 JSON 文件。
async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), 'utf8'));
}

// 断言两个固定值严格一致。
function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} 不一致：期望 ${expected}，实际 ${String(actual)}`);
  }
}

// 断言文本包含发布约定片段。
function assertIncludes(label, content, expected) {
  if (!content.includes(expected)) {
    throw new Error(`${label} 缺少：${expected}`);
  }
}

// 从 Inno Setup 源码中读取预处理定义。
function readDefine(content, name) {
  return content.match(new RegExp(`^#define\\s+${name}\\s+"([^"]+)"`, 'm'))?.[1];
}

// 校验应用、依赖、运行环境和安装程序版本完全一致。
async function verifyVersions() {
  const packageJson = await readJson('package.json');
  const lockFile = await readJson('package-lock.json');
  const config = await readJson('neutralino.config.json');
  const manifest = await readJson('scripts/runtime-manifest.json');
  const constants = await readFile(path.join(projectRoot, 'src', 'shared', 'constants.ts'), 'utf8');
  const installer = await readFile(
    path.join(projectRoot, 'installer', 'OpenSkillsGUI.iss'),
    'utf8',
  );
  const appVersion = packageJson.version;

  assertEqual('package-lock 应用版本', lockFile.packages?.['']?.version, appVersion);
  assertEqual('Node 最低版本', packageJson.engines?.node, '>=22.20.0');
  assertEqual('Neutralino 客户端版本', packageJson.dependencies?.['@neutralinojs/lib'], '6.5.0');
  assertEqual(
    'Neutralino 构建工具版本',
    packageJson.devDependencies?.['@neutralinojs/neu'],
    '11.7.1',
  );
  assertEqual(
    '锁文件 Neutralino 客户端版本',
    lockFile.packages?.['node_modules/@neutralinojs/lib']?.version,
    '6.5.0',
  );
  assertEqual(
    '锁文件 Neutralino 构建工具版本',
    lockFile.packages?.['node_modules/@neutralinojs/neu']?.version,
    '11.7.1',
  );

  assertEqual('Neutralino 应用版本', config.version, appVersion);
  assertEqual('Neutralino 应用标识', config.applicationId, 'io.github.fb208.openskillsgui');
  assertEqual('Neutralino 二进制版本', config.cli?.binaryVersion, '6.7.0');
  assertEqual('Neutralino 扩展开关', config.enableExtensions, true);
  assertEqual('Neutralino 令牌安全模式', config.tokenSecurity, 'one-time');
  assertEqual(
    'Neutralino 原生权限',
    JSON.stringify(config.nativeAllowList),
    JSON.stringify([
      'app.broadcast',
      'app.exit',
      'app.restartProcess',
      'extensions.dispatch',
      'extensions.getStats',
      'os.execCommand',
      'os.showOpenDialog',
    ]),
  );
  assertEqual(
    'Neutralino Windows 扩展命令',
    config.extensions?.[0]?.commandWindows,
    'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${NL_PATH}/extensions/backend-launcher.ps1"',
  );

  assertEqual('运行清单格式', manifest.schemaVersion, 1);
  assertEqual('运行清单架构', manifest.architecture, 'x64');
  assertEqual('运行清单 Neutralino 版本', manifest.neutralino?.version, '6.7.0');
  assertEqual('运行清单 Node 版本', manifest.node?.version, '24.18.0');
  assertEqual('运行清单 Node 最低版本', manifest.node?.minimumVersion, '22.20.0');
  assertEqual('运行清单 skills 版本', manifest.skills?.version, '1.5.19');
  assertEqual('运行清单 MinGit 版本', manifest.git?.version, '2.55.0.2');
  assertEqual('运行清单 Git 最低版本', manifest.git?.minimumVersion, '2.40.0');
  assertEqual(
    'Node 下载地址',
    manifest.node?.url,
    'https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip',
  );
  assertEqual(
    'Node SHA-256',
    manifest.node?.sha256,
    '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821',
  );
  assertEqual(
    'MinGit 下载地址',
    manifest.git?.url,
    'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.2/MinGit-2.55.0.2-64-bit.zip',
  );
  assertEqual(
    'MinGit SHA-256',
    manifest.git?.sha256,
    'e3ea2944cea4b3fabcd69c7c1669ef69b1b66c05ac7806d81224d0abad2dec31',
  );

  for (const [label, expression] of [
    ['共享应用版本', `version: '${appVersion}'`],
    ['共享 Node 版本', `nodeVersion: '${manifest.node.version}'`],
    ['共享 Node 最低版本', `minNodeVersion: '${manifest.node.minimumVersion}'`],
    ['共享 Git 最低版本', `minGitVersion: '${manifest.git.minimumVersion}'`],
    ['共享 MinGit 版本', `minGitPackageVersion: '${manifest.git.version}'`],
    ['共享 skills 版本', `skillsVersion: '${manifest.skills.version}'`],
  ]) {
    assertIncludes(label, constants, expression);
  }

  assertEqual('安装程序应用版本', readDefine(installer, 'AppVersion'), appVersion);
  assertEqual('安装程序应用标识', readDefine(installer, 'AppId'), 'io.github.fb208.openskillsgui');
  assertEqual('Inno Setup 版本', readDefine(installer, 'InnoVersion'), '6.7.3');
  assertIncludes('安装程序当前用户权限', installer, 'PrivilegesRequired=lowest');
  assertIncludes('安装程序 x64 限制', installer, 'ArchitecturesAllowed=x64os');
  assertIncludes('安装程序固定名称', installer, 'OutputBaseFilename={#InstallerName}');
  assertIncludes('安装程序用户数据保留规则', installer, '{localappdata}\\OpenSkillsGUI\\runtime');
  assertIncludes(
    'Neutralino 发布构建',
    packageJson.scripts?.['build:neutralino'] ?? '',
    '--release --clean',
  );

  const tagName = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
  if (tagName) assertEqual('Git 标签', tagName, `v${appVersion}`);
  process.stdout.write(`版本校验通过：${appVersion}\n`);
}

await verifyVersions();
