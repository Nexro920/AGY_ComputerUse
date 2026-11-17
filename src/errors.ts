export type CuaErrorCode =
  | 'ElementNotFound'
  | 'ElementDetached'
  | 'Occluded'
  | 'NavigationFailed'
  | 'Timeout'
  | 'InvalidArgument'
  | 'SafetyBlocked'
  | 'BrowserUnavailable';

export class CuaError extends Error {
  readonly code: CuaErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CuaErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'CuaError';
    this.code = code;
    this.details = details;
  }
}

export function formatError(err: unknown): string {
  if (err instanceof CuaError) {
    const extra = err.details ? ` ${JSON.stringify(err.details)}` : '';
    return `${err.message}${extra}`;
  }
  if (err instanceof Error) {
    return err.stack || `${err.name}: ${err.message}`;
  }
  return String(err);
}
