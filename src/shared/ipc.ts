import type {
  AgentTarget,
  AppUpdateInfo,
  BackendMethod,
  BackendRequest,
  RemoteSkillResult,
  RestartApplication,
  RestartApplicationResult,
  RestartApplicationsBatchResult,
  RuntimeStatus,
  SkillRecord,
  SkillSource,
} from './types.js';

export interface BackendPayloadMap {
  'runtime.status': undefined;
  'runtime.install': undefined;
  'skills.scan': undefined;
  'skills.adopt': {
    ids?: string[];
    decline?: boolean;
    sourceBindings?: Record<string, SkillSource>;
    conflictWinners?: Record<string, string>;
  };
  'skills.searchRemote': { query: string };
  'skills.cancelSearch': { requestId?: string } | undefined;
  'skills.install': { source: string; name: string; targets: AgentTarget[] };
  'skills.enable': { id: string; force?: boolean };
  'skills.disable': { id: string; force?: boolean };
  'skills.remove': { id: string; force?: boolean };
  'skills.saveNote': { id: string; note: string };
  'skills.checkUpdates': { ids?: string[] };
  'skills.update': { ids: string[]; overwriteConflicts?: string[] };
  'app.checkUpdate': { manual: boolean };
  'app.installUpdate': { update: AppUpdateInfo };
  'restartApplications.list': undefined;
  'restartApplications.add': { executablePath: string };
  'restartApplications.remove': { id: string };
  'restartApplications.restart': { id: string };
  'restartApplications.restartRunning': undefined;
}

export interface BackendResultMap {
  'runtime.status': RuntimeStatus;
  'runtime.install': RuntimeStatus;
  'skills.scan': { skills: SkillRecord[]; legacyDetected: boolean };
  'skills.adopt': SkillRecord[];
  'skills.searchRemote': RemoteSkillResult[];
  'skills.cancelSearch': { cancelled: boolean };
  'skills.install': SkillRecord;
  'skills.enable': SkillRecord;
  'skills.disable': SkillRecord;
  'skills.remove': SkillRecord;
  'skills.saveNote': SkillRecord;
  'skills.checkUpdates': SkillRecord[];
  'skills.update': SkillRecord[];
  'app.checkUpdate': AppUpdateInfo;
  'app.installUpdate': { started: boolean };
  'restartApplications.list': RestartApplication[];
  'restartApplications.add': RestartApplication;
  'restartApplications.remove': { removed: boolean };
  'restartApplications.restart': RestartApplicationResult;
  'restartApplications.restartRunning': RestartApplicationsBatchResult;
}

export type TypedBackendRequest<M extends BackendMethod> = Omit<
  BackendRequest,
  'method' | 'payload'
> & {
  method: M;
  payload: BackendPayloadMap[M];
};
