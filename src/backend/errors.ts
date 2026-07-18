import type { BackendError } from '../shared/types.js';

/** 供 IPC 安全返回的领域错误。 */
export class BackendException extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BackendException';
  }
}

/** 将未知异常转换成稳定的 IPC 错误结构。 */
export function toBackendError(error: unknown): BackendError {
  if (error instanceof BackendException) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: '操作失败', details: error.message };
  }
  return { code: 'INTERNAL_ERROR', message: '操作失败', details: String(error) };
}

/** 断言用户输入满足领域约束。 */
export function assertInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BackendException('INVALID_INPUT', message);
}
