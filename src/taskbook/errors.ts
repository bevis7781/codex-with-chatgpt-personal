/**
 * Taskbook error taxonomy (Q5) and the internal error type.
 *
 * Remote-facing messages are deliberately short and sanitized: they must never
 * carry filesystem paths, raw OS error text, caller content or secrets.
 */

export type TaskbookErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "LIMIT_EXCEEDED"
  | "STORAGE_ERROR"
  | "BUSY"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_ELIGIBLE"
  | "AUTHORIZATION_REUSED"
  | "UNFINISHED_TASK"
  | "EVIDENCE_INVALID"
  | "UPGRADE_REQUIRED";

/** Default short, safe message per code. */
const DEFAULT_MESSAGES: Record<TaskbookErrorCode, string> = {
  UNAUTHORIZED: "Authentication is required for this operation.",
  FORBIDDEN: "This operation requires the 'taskbook.submit' scope.",
  INVALID_INPUT: "The submitted Taskbook input is not valid.",
  LIMIT_EXCEEDED: "A Taskbook limit was exceeded.",
  STORAGE_ERROR: "The Taskbook could not be stored safely.",
  BUSY: "The Taskbook workspace is busy; no task was claimed.",
  TASK_NOT_FOUND: "The requested Taskbook was not found.",
  TASK_NOT_ELIGIBLE: "The requested Taskbook is not eligible for this operation.",
  AUTHORIZATION_REUSED: "This local authorization has already been consumed.",
  UNFINISHED_TASK: "An unfinished claimed Taskbook requires local investigation.",
  EVIDENCE_INVALID: "Execution evidence is incomplete or does not match the claim.",
  UPGRADE_REQUIRED: "The bound Bridge does not prove support for this Taskbook lifecycle version.",
};

/**
 * Internal Taskbook failure.
 *
 * `detail` is an optional *sanitized* internal discriminator (for example a bare
 * errno code such as "EEXIST"). It must never contain paths or raw OS messages,
 * and it is never returned to a remote caller.
 */
export class TaskbookError extends Error {
  readonly code: TaskbookErrorCode;
  readonly detail?: string;

  constructor(code: TaskbookErrorCode, message?: string, detail?: string) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = "TaskbookError";
    this.code = code;
    this.detail = detail;
  }
}

/** Public (remote-safe) message for a code. */
export function publicMessage(code: TaskbookErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

/**
 * Normalize an unknown throwable into a sanitized TaskbookError.
 * The raw error text/paths are intentionally discarded except for a bare errno code.
 */
export function toTaskbookError(error: unknown, fallback: TaskbookErrorCode = "STORAGE_ERROR"): TaskbookError {
  if (error instanceof TaskbookError) return error;
  const detail = errnoCodeOf(error);
  return new TaskbookError(fallback, undefined, detail);
}

/** Extract a bare errno code from an unknown error, if present. */
export function errnoCodeOf(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)) return code;
  }
  return undefined;
}
