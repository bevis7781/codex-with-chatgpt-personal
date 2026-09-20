import {
  LIFECYCLE_VERSION,
  MAX_LIFECYCLE_BYTES,
} from "./constants.js";
import {
  isCanonicalTaskId,
  isCanonicalUtcTimestamp,
} from "./envelope.js";
import { TaskbookError } from "./errors.js";

/** Terminal states for one claimed Taskbook. */
export type TaskbookTerminalStatus = "succeeded" | "failed" | "blocked";

/** The immutable claim sidecar persisted beside the original envelope. */
export interface TaskbookClaimRecord {
  version: typeof LIFECYCLE_VERSION;
  taskId: string;
  claimId: string;
  authorizationId: string;
  bodySha256: string;
  harness: string;
  authorizedAt: string;
  claimedAt: string;
}

/** The terminal result sidecar persisted after evidence is read back. */
export interface TaskbookResultRecord {
  version: typeof LIFECYCLE_VERSION;
  taskId: string;
  bodySha256: string;
  claimId: string;
  status: TaskbookTerminalStatus;
  finishedAt: string;
  executionTimestamp: string;
  outputId: number | null;
}

const CLAIM_KEYS = [
  "version",
  "taskId",
  "claimId",
  "authorizationId",
  "bodySha256",
  "harness",
  "authorizedAt",
  "claimedAt",
] as const;
const RESULT_KEYS = [
  "version",
  "taskId",
  "bodySha256",
  "claimId",
  "status",
  "finishedAt",
  "executionTimestamp",
  "outputId",
] as const;
const CLAIM_KEY_SET: ReadonlySet<string> = new Set(CLAIM_KEYS);
const RESULT_KEY_SET: ReadonlySet<string> = new Set(RESULT_KEYS);
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_HARNESS_BYTES = 128;

function malformed(detail: string): never {
  throw new TaskbookError("STORAGE_ERROR", undefined, detail);
}

function parseObject(text: string, maxBytes: number, detail: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > maxBytes) malformed(`${detail}_TOO_LARGE`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    malformed(`${detail}_MALFORMED`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) malformed(`${detail}_MALFORMED`);
  return raw as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], keySet: ReadonlySet<string>, detail: string): void {
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keySet.has(key))) malformed(`${detail}_FIELDS`);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) malformed(`${detail}_FIELDS`);
  }
}

function assertUuid(value: unknown, detail: string): asserts value is string {
  if (typeof value !== "string" || !isCanonicalTaskId(value)) malformed(detail);
}

function assertHash(value: unknown, detail: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) malformed(detail);
}

function assertTimestamp(value: unknown, detail: string): asserts value is string {
  if (!isCanonicalUtcTimestamp(value)) malformed(detail);
}

function assertSerializedSize(text: string, detail: string): void {
  if (Buffer.byteLength(text, "utf8") > MAX_LIFECYCLE_BYTES) malformed(`${detail}_TOO_LARGE`);
}

/** Parse and strictly validate one claim sidecar. */
export function parseClaimRecord(text: string): TaskbookClaimRecord {
  const record = parseObject(text, MAX_LIFECYCLE_BYTES, "CLAIM");
  assertExactKeys(record, CLAIM_KEYS, CLAIM_KEY_SET, "CLAIM");
  if (record.version !== LIFECYCLE_VERSION) malformed("CLAIM_VERSION");
  assertUuid(record.taskId, "CLAIM_TASK_ID");
  assertUuid(record.claimId, "CLAIM_ID");
  assertUuid(record.authorizationId, "CLAIM_AUTHORIZATION_ID");
  assertHash(record.bodySha256, "CLAIM_BODY_HASH");
  if (
    typeof record.harness !== "string" ||
    record.harness.trim() === "" ||
    Buffer.byteLength(record.harness, "utf8") > MAX_HARNESS_BYTES
  ) {
    malformed("CLAIM_HARNESS");
  }
  assertTimestamp(record.authorizedAt, "CLAIM_AUTHORIZED_AT");
  assertTimestamp(record.claimedAt, "CLAIM_CLAIMED_AT");
  return {
    version: LIFECYCLE_VERSION,
    taskId: record.taskId,
    claimId: record.claimId,
    authorizationId: record.authorizationId,
    bodySha256: record.bodySha256,
    harness: record.harness,
    authorizedAt: record.authorizedAt,
    claimedAt: record.claimedAt,
  };
}

/** Parse and strictly validate one terminal result sidecar. */
export function parseResultRecord(text: string): TaskbookResultRecord {
  const record = parseObject(text, MAX_LIFECYCLE_BYTES, "RESULT");
  assertExactKeys(record, RESULT_KEYS, RESULT_KEY_SET, "RESULT");
  if (record.version !== LIFECYCLE_VERSION) malformed("RESULT_VERSION");
  assertUuid(record.taskId, "RESULT_TASK_ID");
  assertHash(record.bodySha256, "RESULT_BODY_HASH");
  assertUuid(record.claimId, "RESULT_CLAIM_ID");
  if (record.status !== "succeeded" && record.status !== "failed" && record.status !== "blocked") {
    malformed("RESULT_STATUS");
  }
  assertTimestamp(record.finishedAt, "RESULT_FINISHED_AT");
  assertTimestamp(record.executionTimestamp, "RESULT_EXECUTION_TIMESTAMP");
  if (
    record.outputId !== null &&
    (typeof record.outputId !== "number" || !Number.isSafeInteger(record.outputId) || record.outputId <= 0)
  ) {
    malformed("RESULT_OUTPUT_ID");
  }
  return {
    version: LIFECYCLE_VERSION,
    taskId: record.taskId,
    bodySha256: record.bodySha256,
    claimId: record.claimId,
    status: record.status,
    finishedAt: record.finishedAt,
    executionTimestamp: record.executionTimestamp,
    outputId: record.outputId,
  };
}

/** Serialize a claim with its frozen key order and byte bound. */
export function serializeClaimRecord(record: TaskbookClaimRecord): string {
  const text = JSON.stringify({
    version: record.version,
    taskId: record.taskId,
    claimId: record.claimId,
    authorizationId: record.authorizationId,
    bodySha256: record.bodySha256,
    harness: record.harness,
    authorizedAt: record.authorizedAt,
    claimedAt: record.claimedAt,
  });
  assertSerializedSize(text, "CLAIM");
  return text;
}

/** Serialize a terminal result with its frozen key order and byte bound. */
export function serializeResultRecord(record: TaskbookResultRecord): string {
  const text = JSON.stringify({
    version: record.version,
    taskId: record.taskId,
    bodySha256: record.bodySha256,
    claimId: record.claimId,
    status: record.status,
    finishedAt: record.finishedAt,
    executionTimestamp: record.executionTimestamp,
    outputId: record.outputId,
  });
  assertSerializedSize(text, "RESULT");
  return text;
}

export function isCanonicalSha256(value: string): boolean {
  return SHA256.test(value);
}

export const MAX_CLAIM_HARNESS_BYTES = MAX_HARNESS_BYTES;
