/**
 * Logging helpers for the `materialIndexTrigger` Lambda (Task 4.6).
 */
import type { LogFields, Logger } from './ports';

/** A one-line, log-safe description of anything thrown. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== 'Error'
      ? `${error.name}: ${error.message}`
      : error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    if (typeof message === 'string') {
      return typeof name === 'string' && name ? `${name}: ${message}` : message;
    }
  }
  return String(error);
}

/** The console methods the logger writes to. */
export interface ConsoleLike {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * A {@link Logger} that writes one JSON object per line, which CloudWatch Logs
 * Insights can query field by field.
 */
export function createConsoleLogger(
  sink: ConsoleLike = console,
  base: LogFields = { fn: 'materialIndexTrigger' }
): Logger {
  const write = (
    level: 'INFO' | 'WARN' | 'ERROR',
    method: keyof ConsoleLike,
    message: string,
    fields?: LogFields
  ): void => {
    sink[method](JSON.stringify({ level, message, ...base, ...fields }));
  };
  return {
    info: (message, fields) => write('INFO', 'log', message, fields),
    warn: (message, fields) => write('WARN', 'warn', message, fields),
    error: (message, fields) => write('ERROR', 'error', message, fields),
  };
}
