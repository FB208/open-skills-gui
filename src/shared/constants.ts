/** 应用与外部运行环境的固定版本和标识。 */
export const APP = {
  id: 'io.github.fb208.openskillsgui',
  name: 'Open Skills GUI',
  version: '1.0.0',
  repository: 'FB208/open-skills-gui',
  installerAsset: 'OpenSkillsGUI-Setup-x64.exe',
} as const;

export const RUNTIME = {
  nodeVersion: '24.18.0',
  minNodeVersion: '22.20.0',
  minGitVersion: '2.40.0',
  minGitPackageVersion: '2.55.0.2',
  skillsVersion: '1.5.19',
} as const;

export const BACKEND_EXTENSION_ID = 'io.github.fb208.openskillsgui.backend';

export const AGENT_TARGETS = ['universal', 'claude-code', 'windsurf'] as const;
