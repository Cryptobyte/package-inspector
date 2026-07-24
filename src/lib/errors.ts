/**
 * Error types shared by every tool.
 *
 * The server never throws out of a request handler: `describeError` turns
 * anything thrown into a short, actionable message that is returned to the
 * model as an `isError` tool result.
 */

export type ToolErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_UNAVAILABLE'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  /** Upstream served a bot-protection challenge; retrying cannot clear it. */
  | 'BLOCKED'
  | 'TOO_LARGE'
  | 'INTERNAL';

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  /** Optional follow-up suggestion shown to the model after the message. */
  readonly hint?: string;

  constructor(code: ToolErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

export class HttpError extends ToolError {
  readonly status: number;
  readonly url: string;

  constructor(code: ToolErrorCode, status: number, url: string, message: string, hint?: string) {
    super(code, message, hint);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/** Thrown when an optional upstream (bundlephobia, OSV…) fails. */
export class DegradedError extends ToolError {
  readonly source: string;

  constructor(source: string, message: string) {
    super('UPSTREAM_UNAVAILABLE', message);
    this.name = 'DegradedError';
    this.source = source;
  }
}

export interface DescribedError {
  code: ToolErrorCode;
  message: string;
  hint?: string;
}

export function describeError(err: unknown): DescribedError {
  if (err instanceof ToolError) {
    const described: DescribedError = { code: err.code, message: err.message };
    if (err.hint) described.hint = err.hint;
    return described;
  }
  if (err instanceof Error) {
    // AbortSignal.timeout() rejects with a TimeoutError DOMException.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { code: 'TIMEOUT', message: 'The upstream request timed out.' };
    }
    return { code: 'INTERNAL', message: err.message || String(err) };
  }
  return { code: 'INTERNAL', message: String(err) };
}

/**
 * Runs an optional data source. Any failure is captured as a `note` instead of
 * propagating, so one flaky upstream never fails a whole tool call.
 */
export async function optional<T>(
  source: string,
  fn: () => Promise<T>,
): Promise<{ value: T; note: null } | { value: null; note: string }> {
  try {
    return { value: await fn(), note: null };
  } catch (err) {
    const { message } = describeError(err);
    return { value: null, note: `${source}: ${message}` };
  }
}
