import { events, extensions, init } from '@neutralinojs/lib';

import { BACKEND_EXTENSION_ID } from '@shared/constants';
import type { BackendPayloadMap, BackendResultMap, TypedBackendRequest } from '@shared/ipc';
import type {
  BackendError,
  BackendMethod,
  BackendRequest,
  BackendResponse,
  OperationProgress,
} from '@shared/types';

const REQUEST_EVENT = 'backend.request';
const RESPONSE_EVENT = 'backend.response';
const PROGRESS_EVENT = 'backend.progress';
const READY_EVENT = 'backend.ready';

interface PendingRequest {
  method: BackendMethod;
  resolve: (value: unknown) => void;
  reject: (reason: BackendCallError) => void;
  timer: number;
}

export interface BackendOperation<M extends BackendMethod> {
  requestId: string;
  promise: Promise<BackendResultMap[M]>;
}

type BackendCallArguments<M extends BackendMethod> = undefined extends BackendPayloadMap[M]
  ? [payload?: BackendPayloadMap[M]]
  : [payload: BackendPayloadMap[M]];

/** 表示后端返回的、可供界面识别的业务错误。 */
export class BackendCallError extends Error {
  readonly code: string;
  readonly details?: string;

  /** 将统一错误结构转换为标准 Error。 */
  constructor(error: BackendError) {
    super(error.message);
    this.name = 'BackendCallError';
    this.code = error.code;
    this.details = error.details;
  }
}

/** 生成无需依赖后端的请求编号。 */
function createRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 根据操作类型设置合理的等待上限。 */
function timeoutFor(method: BackendMethod): number {
  if (method === 'runtime.install' || method === 'app.installUpdate') {
    return 30 * 60 * 1_000;
  }

  if (method === 'skills.install' || method === 'skills.update') {
    return 15 * 60 * 1_000;
  }

  if (method === 'skills.checkUpdates' || method === 'skills.searchRemote') {
    return 5 * 60 * 1_000;
  }

  return 2 * 60 * 1_000;
}

/** 兼容扩展直接广播和包裹 data 两种事件详情。 */
function unwrapEventDetail<T>(event: CustomEvent): T {
  const detail = event.detail as T | { data: T };
  if (
    detail &&
    typeof detail === 'object' &&
    'data' in detail &&
    Object.keys(detail as object).length === 1
  ) {
    return (detail as { data: T }).data;
  }

  return detail as T;
}

/** 封装 Neutralino 扩展的请求、响应和进度事件。 */
export class BackendClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly progressListeners = new Set<(progress: OperationProgress) => void>();
  private readonly readyListeners = new Set<() => void>();
  private initializePromise: Promise<void> | null = null;

  /** 初始化 Neutralino，并注册扩展事件监听器。 */
  initialize(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = this.initializeInternal();
    return this.initializePromise;
  }

  /** 发送类型安全的请求并等待后端返回。 */
  async call<M extends BackendMethod>(
    method: M,
    ...args: BackendCallArguments<M>
  ): Promise<BackendResultMap[M]> {
    return this.begin(method, ...args).promise;
  }

  /** 发起类型安全的请求，同时暴露请求编号供取消操作使用。 */
  begin<M extends BackendMethod>(method: M, ...args: BackendCallArguments<M>): BackendOperation<M> {
    const requestId = createRequestId();
    const request: TypedBackendRequest<M> = {
      requestId,
      method,
      payload: args[0] as BackendPayloadMap[M],
    };

    const promise = new Promise<BackendResultMap[M]>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new BackendCallError({
            code: 'REQUEST_TIMEOUT',
            message: '操作等待超时，请检查网络或运行环境后重试。',
          }),
        );
      }, timeoutFor(method));

      this.pending.set(requestId, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      void this.dispatch(request).catch((error: unknown) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pending.delete(requestId);
        reject(
          error instanceof BackendCallError
            ? error
            : new BackendCallError({
                code: 'BACKEND_UNAVAILABLE',
                message: '无法连接后台服务，请重新启动应用后重试。',
                details: error instanceof Error ? error.message : String(error),
              }),
        );
      });
    });

    return { requestId, promise };
  }

  /** 订阅长任务进度，并返回取消订阅函数。 */
  onProgress(listener: (progress: OperationProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /** 订阅扩展就绪事件，并返回取消订阅函数。 */
  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  /** 注销事件并拒绝仍在等待的请求。 */
  async dispose(): Promise<void> {
    await Promise.all([
      events.off(RESPONSE_EVENT, this.handleResponse),
      events.off(PROGRESS_EVENT, this.handleProgress),
      events.off(READY_EVENT, this.handleReady),
    ]);

    for (const item of this.pending.values()) {
      window.clearTimeout(item.timer);
      item.reject(
        new BackendCallError({
          code: 'CLIENT_DISPOSED',
          message: '界面已关闭，操作未能完成。',
        }),
      );
    }
    this.pending.clear();
  }

  /** 完成底层 Neutralino 初始化。 */
  private async initializeInternal(): Promise<void> {
    init();
    await Promise.all([
      events.on(RESPONSE_EVENT, this.handleResponse),
      events.on(PROGRESS_EVENT, this.handleProgress),
      events.on(READY_EVENT, this.handleReady),
    ]);
  }

  /** 将统一请求事件分派给指定扩展。 */
  private async dispatch(request: BackendRequest): Promise<void> {
    await this.initialize();
    await extensions.dispatch(BACKEND_EXTENSION_ID, REQUEST_EVENT, request);
  }

  /** 解析响应并结束对应的等待任务。 */
  private readonly handleResponse = (event: CustomEvent): void => {
    const response = unwrapEventDetail<BackendResponse>(event);
    const pending = response?.requestId ? this.pending.get(response.requestId) : undefined;
    if (!pending) return;

    window.clearTimeout(pending.timer);
    this.pending.delete(response.requestId);

    if (!response.ok) {
      pending.reject(
        new BackendCallError(
          response.error ?? {
            code: 'UNKNOWN_BACKEND_ERROR',
            message: `${pending.method} 执行失败。`,
          },
        ),
      );
      return;
    }

    pending.resolve(response.data);
  };

  /** 把进度事件转发给所有界面订阅者。 */
  private readonly handleProgress = (event: CustomEvent): void => {
    const progress = unwrapEventDetail<OperationProgress>(event);
    if (!progress?.requestId) return;
    this.progressListeners.forEach((listener) => listener(progress));
  };

  /** 通知界面后台扩展已完成连接。 */
  private readonly handleReady = (): void => {
    this.readyListeners.forEach((listener) => listener());
  };
}

export const backend = new BackendClient();
