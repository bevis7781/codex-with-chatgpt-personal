import type { Logger } from "../logger/index.js";

/**
 * Q6 — allowlisted submission audit metadata.
 *
 * Permitted fields only: task ID, workspace ID, timestamp, title UTF-8 byte
 * length, body UTF-8 byte length, body SHA-256, success/failure and a stable
 * result/error code. Plaintext title, full body, tokens, codes, secrets,
 * credential headers, raw paths and the raw envelope are never logged.
 */

export interface TaskbookAuditEvent {
  outcome: "success" | "failure";
  /** Stable result/error code (for example "OK", "FORBIDDEN", "LIMIT_EXCEEDED"). */
  code: string;
  workspaceId: string;
  timestamp: string;
  /** Present only when a task record actually exists; never fabricated. */
  taskId?: string;
  titleBytes?: number;
  bodyBytes?: number;
  bodySha256?: string;
}

export const TASKBOOK_AUDIT_EVENT = "taskbook.submit";

export function buildTaskbookAuditPayload(event: TaskbookAuditEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    event: TASKBOOK_AUDIT_EVENT,
    result: event.outcome,
    code: event.code,
    workspaceId: event.workspaceId,
    timestamp: event.timestamp,
  };
  if (event.taskId !== undefined) payload.taskId = event.taskId;
  if (event.titleBytes !== undefined) payload.titleBytes = event.titleBytes;
  if (event.bodyBytes !== undefined) payload.bodyBytes = event.bodyBytes;
  if (event.bodySha256 !== undefined) payload.bodySha256 = event.bodySha256;
  return payload;
}

/**
 * Best-effort audit emission. A logging failure must never retry, duplicate or
 * reverse a successful persistence, so every failure here is swallowed.
 */
export function emitTaskbookAudit(logger: Logger | undefined, event: TaskbookAuditEvent): void {
  if (!logger) return;
  try {
    logger.info("taskbook submission recorded", buildTaskbookAuditPayload(event));
  } catch {
    // logging must never change the submission outcome
  }
}
