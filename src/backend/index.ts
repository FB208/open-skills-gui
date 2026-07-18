import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP, BACKEND_EXTENSION_ID } from '../shared/constants.js';
import type { BackendResponse, OperationProgress } from '../shared/types.js';
import { AppUpdateService } from './app-update.js';
import { BackendException } from './errors.js';
import { LocalLogger } from './logger.js';
import { AsyncMutex } from './mutex.js';
import { createPathLayout, ensureDataDirectories } from './paths.js';
import { SpawnCommandRunner } from './process.js';
import { BackendRouter } from './router.js';
import { RuntimeService } from './runtime.js';
import { RestartApplicationsService } from './restart-applications.js';
import { SkillScanner } from './scanner.js';
import { SkillsCli } from './skills-cli.js';
import { SkillsService } from './skills-service.js';
import { StateRepository } from './state.js';
import { recoverFileTransaction } from './transaction.js';
import { RestartManagerLocks } from './windows-locks.js';

const REQUEST_EVENT = 'backend.request';
const RESPONSE_EVENT = 'backend.response';
const PROGRESS_EVENT = 'backend.progress';
const READY_EVENT = 'backend.ready';
const MAX_MESSAGE_BYTES = 1024 * 1024;

interface NeutralinoConnection {
  nlPort: number;
  nlToken: string;
  nlConnectToken: string;
  nlExtensionId: string;
}

interface ExtensionEvent {
  event: string;
  data?: unknown;
}

/** 从标准输入严格读取 Neutralino 连接参数。 */
function readConnection(): NeutralinoConnection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(process.stdin.fd, 'utf8'));
  } catch (error) {
    throw new BackendException(
      'INVALID_CONNECTION',
      'Neutralino 扩展连接参数无效',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BackendException('INVALID_CONNECTION', 'Neutralino 扩展连接参数必须是对象');
  }
  const value = parsed as Record<string, unknown>;
  const allowed = new Set(['nlPort', 'nlToken', 'nlConnectToken', 'nlExtensionId']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new BackendException('INVALID_CONNECTION', 'Neutralino 扩展连接参数包含未知字段');
  }
  const port = typeof value.nlPort === 'number' ? value.nlPort : Number(value.nlPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new BackendException('INVALID_CONNECTION', 'Neutralino 服务端口无效');
  const nlToken = connectionString(value.nlToken, '访问令牌');
  const nlConnectToken = connectionString(value.nlConnectToken, '连接令牌');
  const nlExtensionId = connectionString(value.nlExtensionId, '扩展标识');
  if (nlExtensionId !== BACKEND_EXTENSION_ID)
    throw new BackendException('INVALID_CONNECTION', 'Neutralino 扩展标识不匹配');
  return { nlPort: port, nlToken, nlConnectToken, nlExtensionId };
}

/** 校验连接参数中的非空字符串。 */
function connectionString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new BackendException('INVALID_CONNECTION', `Neutralino ${label}无效`);
  }
  return value;
}

/** 解析 Neutralino 发往扩展的事件封包。 */
function parseExtensionEvent(raw: unknown): ExtensionEvent | undefined {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES)
    return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.event !== 'string' ||
    Object.keys(value).some((key) => key !== 'event' && key !== 'data')
  )
    return undefined;
  return { event: value.event, data: value.data };
}

/** 向所有应用窗口广播扩展事件。 */
function broadcast(socket: WebSocket, accessToken: string, event: string, data: unknown): void {
  if (socket.readyState !== WebSocket.OPEN)
    throw new BackendException('BACKEND_DISCONNECTED', '后台连接已经断开');
  socket.send(
    JSON.stringify({
      id: randomUUID(),
      method: 'app.broadcast',
      accessToken,
      data: { event, data },
    }),
  );
}

/** 创建全部后端服务并连接 Neutralino WebSocket。 */
async function main(): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new BackendException('UNSUPPORTED_PLATFORM', 'Open Skills GUI 仅支持 Windows x64');
  }
  const connection = readConnection();
  const appRoot = path.resolve(process.env.OPEN_SKILLS_APP_ROOT ?? process.cwd());
  const layout = createPathLayout({ appRoot });
  const writes = new AsyncMutex();
  await writes.runExclusive(() => ensureDataDirectories(layout));
  const repository = new StateRepository(layout.stateFile, layout);
  await writes.runExclusive(() => recoverFileTransaction(layout, repository));
  const logger = new LocalLogger(layout.logsDir, writes);
  const runner = new SpawnCommandRunner();
  const runtime = new RuntimeService(layout, repository, runner, writes);
  const cli = new SkillsCli(runtime, runner, layout);
  const scanner = new SkillScanner(layout, repository);
  const locks = new RestartManagerLocks(layout, runner);
  const skills = new SkillsService(layout, repository, scanner, cli, locks, writes);

  const socket = new WebSocket(
    `ws://localhost:${connection.nlPort}?extensionId=${encodeURIComponent(connection.nlExtensionId)}&connectToken=${encodeURIComponent(connection.nlConnectToken)}`,
  );
  const emitProgress = async (progress: OperationProgress): Promise<void> =>
    broadcast(socket, connection.nlToken, PROGRESS_EVENT, progress);
  const appUpdate = new AppUpdateService(layout);
  const restartApplications = new RestartApplicationsService(
    layout.restartApplicationsFile,
    runner,
    writes,
  );
  const router = new BackendRouter(
    runtime,
    skills,
    appUpdate,
    writes,
    logger,
    emitProgress,
    restartApplications,
  );

  socket.onopen = () => {
    broadcast(socket, connection.nlToken, READY_EVENT, {
      extensionId: BACKEND_EXTENSION_ID,
      version: APP.version,
    });
    void logger.info('后台扩展已连接');
  };
  socket.onmessage = (message) => {
    const packet = parseExtensionEvent(message.data);
    if (!packet || packet.event !== REQUEST_EVENT) return;
    const request = packet.data as { requestId?: unknown; method?: unknown } | undefined;
    void (async () => {
      await logger.info('收到后台请求', {
        requestId: request?.requestId,
        method: request?.method,
      });
      const response: BackendResponse = await router.handle(packet.data);
      await logger.info('后台请求完成', {
        requestId: response.requestId,
        method: request?.method,
        ok: response.ok,
      });
      broadcast(socket, connection.nlToken, RESPONSE_EVENT, response);
    })().catch((error: unknown) =>
      logger.error('发送后端响应失败', error instanceof Error ? error.message : String(error)),
    );
  };
  socket.onerror = () => {
    void logger.error('Neutralino 后台连接发生错误');
  };
  socket.onclose = () => {
    process.exit(0);
  };
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
});
