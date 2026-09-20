import { createHash, randomUUID } from "node:crypto";
import {
  CLAIM_FILE_SUFFIX,
  ENVELOPE_VERSION,
  MAX_BODY_BYTES,
  MAX_TITLE_BYTES,
  RESULT_FILE_SUFFIX,
  TASKBOOK_FILE_EXTENSION,
} from "./constants.js";
import { TaskbookError } from "./errors.js";

/**
 * Q2 — the persisted Taskbook envelope.
 *
 * Only `title` and `body` are caller-controlled. `version` and `createdAt` are
 * C2C-controlled. There are no lifecycle/status/claim fields and the workspace
 * ID is deliberately not duplicated into the envelope.
 */
export interface TaskbookEnvelope {
  version: typeof ENVELOPE_VERSION;
  createdAt: string;
  title: string;
  body: string;
}

const ENVELOPE_KEYS = ["version", "createdAt", "title", "body"] as const;
const ENVELOPE_KEY_SET: ReadonlySet<string> = new Set(ENVELOPE_KEYS);
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Canonical UTC timestamp used by envelopes and Gate 2 lifecycle evidence. */
export function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_8601_UTC.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/** UTF-8 byte length helper (never a JS character count). */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Q5 — SHA-256 of the exact accepted UTF-8 body bytes (not the envelope bytes). */
export function bodySha256(body: string): string {
  return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
}

/** Build the C2C-controlled envelope for one submission. */
export function createEnvelope(title: string, body: string, createdAt = new Date().toISOString()): TaskbookEnvelope {
  return { version: ENVELOPE_VERSION, createdAt, title, body };
}

/**
 * Serialize an envelope with a fixed key order so the byte length is stable and
 * auditable. Storage accounting uses the exact bytes produced here.
 */
export function serializeEnvelope(envelope: TaskbookEnvelope): string {
  return JSON.stringify({
    version: envelope.version,
    createdAt: envelope.createdAt,
    title: envelope.title,
    body: envelope.body,
  });
}

function isValidCreatedAt(value: string): boolean {
  return isCanonicalUtcTimestamp(value);
}

/**
 * Strictly parse a persisted envelope.
 *
 * Fail-closed on: malformed JSON, non-object root, missing required fields,
 * wrong field types, unsupported `version`, invalid `createdAt`, and any extra
 * persisted metadata (so unexpected keys can never become hidden metadata).
 */
export function parseEnvelope(text: string): TaskbookEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TaskbookError("STORAGE_ERROR", "Persisted Taskbook is malformed.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TaskbookError("STORAGE_ERROR", "Persisted Taskbook is malformed.");
  }
  const record = raw as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!ENVELOPE_KEY_SET.has(key)) {
      throw new TaskbookError("STORAGE_ERROR", "Persisted Taskbook has unsupported fields.");
    }
  }
  for (const key of ENVELOPE_KEYS) {
    if (!(key in record)) {
      throw new TaskbookError("STORAGE_ERROR", "Persisted Taskbook is incomplete.");
    }
  }

  if (record.version !== ENVELOPE_VERSION) {
    throw new TaskbookError("STORAGE_ERROR", "Persisted Taskbook version is unsupported.");
  }
  if (typeof record.createdAt !== "string" || !isValidCreatedAt(record.createdAt)) {
    throw new TaskbookError("STORAGE_ERROR", "Persisted Taskbook createdAt is invalid.");
  }
  if (typeof record.title !== "string" || typeof record.body !== "string") {
    throw new TaskbookError("STORAGE_ERROR", "Persisted Taskbook fields have invalid types.");
  }
  if (utf8Bytes(record.title) > MAX_TITLE_BYTES || utf8Bytes(record.body) > MAX_BODY_BYTES) {
    throw new TaskbookError("STORAGE_ERROR", "Persisted Taskbook exceeds the accepted limits.");
  }

  return {
    version: ENVELOPE_VERSION,
    createdAt: record.createdAt,
    title: record.title,
    body: record.body,
  };
}

/** Q3 — canonical lowercase UUID v4 text. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalTaskId(value: string): boolean {
  return UUID_V4.test(value);
}

/** Q3 — filename is exactly `<taskId>.json`. */
export function taskbookFileName(taskId: string): string {
  return `${taskId}${TASKBOOK_FILE_EXTENSION}`;
}

const CANONICAL_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const CLAIM_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.claim\.json$/;
const RESULT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.result\.json$/;

/** Parse a canonical `<lowercase-uuid-v4>.json` filename into its task ID. */
export function taskIdFromFileName(name: string): string | null {
  const match = CANONICAL_FILE.exec(name);
  return match ? match[1] : null;
}

/** Fixed direct-child filename for a Gate 2 claim sidecar. */
export function taskbookClaimFileName(taskId: string): string {
  return `${taskId}${CLAIM_FILE_SUFFIX}`;
}

/** Fixed direct-child filename for a Gate 2 terminal result sidecar. */
export function taskbookResultFileName(taskId: string): string {
  return `${taskId}${RESULT_FILE_SUFFIX}`;
}

/** Parse a canonical `<lowercase-uuid-v4>.claim.json` filename. */
export function taskIdFromClaimFileName(name: string): string | null {
  const match = CLAIM_FILE.exec(name);
  return match ? match[1] : null;
}

/** Parse a canonical `<lowercase-uuid-v4>.result.json` filename. */
export function taskIdFromResultFileName(name: string): string | null {
  const match = RESULT_FILE.exec(name);
  return match ? match[1] : null;
}

/** Q3 — C2C-generated cryptographically secure task ID. */
export function generateTaskId(): string {
  return randomUUID();
}
