import type { Logger } from "../src/logger/index.js";

/**
 * Capturing logger for Taskbook audit evidence. Records the structured `extra`
 * payload passed to `info(...)` so tests can assert the allowlist.
 */

export interface CapturedAuditEvent {
  payload: Record<string, unknown>;
}

export interface AuditCapture {
  logger: Logger;
  events: CapturedAuditEvent[];
  reset(): void;
}

export function makeAuditCapture(): AuditCapture {
  const events: CapturedAuditEvent[] = [];
  const logger = {
    debug: () => undefined,
    info: (_message: string, extra?: unknown) => {
      if (extra && typeof extra === "object") events.push({ payload: extra as Record<string, unknown> });
    },
    warn: () => undefined,
    error: (_message: string, _extra?: unknown) => undefined,
  } as unknown as Logger;
  return {
    logger,
    events,
    reset: () => {
      events.length = 0;
    },
  };
}
