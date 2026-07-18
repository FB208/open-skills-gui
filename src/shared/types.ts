import type { AGENT_TARGETS } from './constants.js';

export type AgentTarget = (typeof AGENT_TARGETS)[number];
export type SkillState = 'enabled' | 'disabled' | 'uninstalled';
export type SkillSourceType = 'github' | 'git' | 'local' | 'unknown';
export type UpdateStatus =
  | 'latest'
  | 'available'
  | 'local-modified'
  | 'conflict'
  | 'unavailable'
  | 'failed'
  | 'unchecked';

export interface SkillSource {
  type: SkillSourceType;
  locator: string;
  ref?: string;
  skillPath?: string;
}

export interface SkillRecord {
  id: string;
  name: string;
  source: SkillSource;
  state: SkillState;
  managed: boolean;
  targets: AgentTarget[];
  canonicalPath?: string;
  disabledPath?: string;
  observedPaths: string[];
  baselineHash?: string;
  localHash?: string;
  remoteHash?: string;
  updateStatus: UpdateStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  onboardingCompleted: boolean;
  legacyDecisionMade: boolean;
  selectedNodePath?: string;
  selectedNpxPath?: string;
  selectedGitPath?: string;
}

export interface AppState {
  schemaVersion: 1;
  settings: AppSettings;
  skills: Record<string, SkillRecord>;
}

export interface RuntimeComponentStatus {
  available: boolean;
  path?: string;
  version?: string;
  source?: 'private' | 'system';
  reason?: string;
}

export interface RuntimeStatus {
  ready: boolean;
  node: RuntimeComponentStatus;
  npx: RuntimeComponentStatus;
  git: RuntimeComponentStatus;
}

export interface RemoteSkillResult {
  name: string;
  source: string;
  installs?: number;
  installed: boolean;
}

export interface AppUpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseNotes?: string;
  publishedAt?: string;
  downloadUrl?: string;
  digest?: string;
}

export interface RestartApplication {
  id: string;
  name: string;
  executablePath: string;
  createdAt: string;
}

export interface RestartApplicationResult {
  application: RestartApplication;
  restarted: boolean;
  processId?: number;
}

export interface RestartApplicationsBatchResult {
  configured: number;
  restarted: RestartApplicationResult[];
  skipped: RestartApplication[];
  failed: Array<{ application: RestartApplication; message: string }>;
}

export type BackendMethod =
  | 'runtime.status'
  | 'runtime.install'
  | 'skills.scan'
  | 'skills.adopt'
  | 'skills.searchRemote'
  | 'skills.cancelSearch'
  | 'skills.install'
  | 'skills.enable'
  | 'skills.disable'
  | 'skills.remove'
  | 'skills.saveNote'
  | 'skills.checkUpdates'
  | 'skills.update'
  | 'app.checkUpdate'
  | 'app.installUpdate'
  | 'restartApplications.list'
  | 'restartApplications.add'
  | 'restartApplications.remove'
  | 'restartApplications.restart'
  | 'restartApplications.restartRunning';

export interface BackendRequest<T = unknown> {
  requestId: string;
  method: BackendMethod;
  payload?: T;
}

export interface BackendError {
  code: string;
  message: string;
  details?: string;
}

export interface BackendResponse<T = unknown> {
  requestId: string;
  ok: boolean;
  data?: T;
  error?: BackendError;
}

export interface OperationProgress {
  requestId: string;
  operation: BackendMethod;
  stage: string;
  current?: number;
  total?: number;
  message: string;
}
