import { createHash } from "node:crypto";
import path from "node:path";
import {
  inspectExecutionOutput,
  type ExecutionOutputSnapshot,
} from "../execution/output.js";
import {
  compactArchivedExecutionRecordLines,
  executionRecordSchema,
  MAX_STREAMED_RECORD_LINE_BYTES,
  readExecutionRecordLinesForTasks,
  type ExecutionRecord,
  type ExecutionRecordLine,
} from "../execution/records.js";
import { getStateDir } from "../config/paths.js";
import { LOCK_NAMESPACE_NAME, LOCK_SUFFIX, TASKS_ROOT_NAME } from "./constants.js";
import { MAX_ENVELOPE_BYTES } from "./constants.js";
import {
  bodySha256,
  isCanonicalTaskId,
  parseEnvelope,
  taskbookClaimFileName,
  taskbookFileName,
  taskbookResultFileName,
  type TaskbookEnvelope,
} from "./envelope.js";
import { createNewFileExclusive } from "./create.js";
import { TaskbookError, errnoCodeOf } from "./errors.js";
import {
  inventoryTaskbookState,
  type DetailedTaskbookInventory,
  type TaskbookLifecycleTask,
} from "./inventory.js";
import { lstatOrNull, lstatStrict, readTextStrict, realpathStrict } from "./fsutil.js";
import { nodeTaskbookIo, type TaskbookIo } from "./io.js";
import { acquireTaskbookLock, releaseTaskbookLock } from "./lock.js";
import {
  assertSafeWorkspaceId,
  ensureContainedDir,
  isInsideRoot,
  probeDeepestExisting,
  resolveTaskbookPaths,
  type TaskbookPaths,
} from "./paths.js";
import {
  parseClaimRecord,
  parseResultRecord,
  type AnyTaskbookResultRecord,
  type TaskbookClaimRecord,
} from "./lifecycle-records.js";
import {
  parseTaskbookTerminalEvidenceCapsule,
  readTaskbookTerminalEvidenceCapsule,
  serializeTaskbookTerminalEvidenceCapsule,
  type TaskbookTerminalEvidenceCapsule,
} from "./capsule.js";
import type { TaskbookLocalContext, TaskbookReadItem } from "./lifecycle.js";

export const TASKBOOK_ARCHIVE_ROOT_NAME = "taskbook-archive";
export const MAX_TASKBOOK_ARCHIVE_BUNDLE_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_DIRECTORY_ENTRIES = 100_000;

export interface TaskbookArchiveAuthorizationRef {
  authorizationSha256: string;
  authorizationKind: "claim" | "recovery";
}

export type TaskbookArchiveTerminalEvidence = {
  kind: "capsule";
  capsule: TaskbookTerminalEvidenceCapsule;
  capsuleSha256: string;
} | {
  kind: "legacy-snapshot";
  recordSnapshot: "read-back" | "none" | "incomplete";
  records: ExecutionRecord[];
  outputs: ExecutionOutputSnapshot[];
}

export interface TaskbookArchiveBundleBase {
  version: 1;
  workspaceId: string;
  taskId: string;
  bodySha256: string;
  envelope: TaskbookEnvelope;
  claim: TaskbookClaimRecord;
  result: AnyTaskbookResultRecord;
  terminalEvidence: TaskbookArchiveTerminalEvidence;
  executionRecords: ExecutionRecordLine[];
  outputs: ExecutionOutputSnapshot[];
  sourceDigests: {
    envelope: string;
    claim: string;
    result: string;
    capsuleSha256?: string;
  };
  authorizations: TaskbookArchiveAuthorizationRef[];
}

export interface TaskbookArchiveBundle extends TaskbookArchiveBundleBase {
  bundleSha256: string;
}

export interface TaskbookArchiveTaskPlan {
  taskId: string;
  status: string;
  finishedAt: string;
  bundleBytes: number;
  bundleSha256: string;
  executionRecordCount: number;
  outputStatuses: Array<{ outputId: number; state: ExecutionOutputSnapshot["state"] }>;
  alreadyPrepared: boolean;
}

export interface TaskbookArchiveOptions extends TaskbookLocalContext {
  keepTerminal?: number;
  maxTasks?: number;
  apply?: boolean;
}

export interface TaskbookArchiveResult {
  ok: boolean;
  workspaceId: string;
  apply: boolean;
  keepTerminal: number;
  maxTasks: number;
  terminalCount: number;
  unfinished: Array<{ taskId: string; claimId: string }>;
  reconcileTaskIds: string[];
  selected: TaskbookArchiveTaskPlan[];
  archivedTaskIds: string[];
  reconciledTaskIds: string[];
  blockedTaskId?: string;
  blockedReason?: string;
  compaction: { ok: boolean; removed: number; retained: number; reason?: string } | null;
}

interface RemnantSet {
  taskId: string;
  bundle: TaskbookArchiveBundle;
  files: string[];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function authorizationSha256(value: string): string {
  return sha256(Buffer.from(value, "utf8"));
}

function fail(detail: string): never {
  throw new TaskbookError("STORAGE_ERROR", undefined, detail);
}

function existingContainedDirectory(
  io: TaskbookIo,
  paths: TaskbookPaths,
  segments: readonly string[]
): string | null {
  let current = paths.stateRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stats = lstatOrNull(io, current);
    if (!stats) return null;
    if (stats.isSymbolicLink() || !stats.isDirectory()) fail("ARCHIVE_DIRECTORY_INVALID");
    const real = realpathStrict(io, current);
    if (!isInsideRoot(paths.stateRoot, real)) fail("ARCHIVE_CONTAINMENT");
    current = real;
  }
  return current;
}

function readStableFile(
  io: TaskbookIo,
  paths: TaskbookPaths,
  file: string,
  maxBytes: number,
  detail: string
): { text: string; sha256: string } {
  const before = lstatStrict(io, file);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) fail(`${detail}_INVALID`);
  const real = realpathStrict(io, file);
  if (!isInsideRoot(paths.stateRoot, real)) fail("ARCHIVE_CONTAINMENT");
  const text = readTextStrict(io, file);
  const after = lstatStrict(io, file);
  if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    fail(`${detail}_CHANGED_DURING_READ`);
  }
  if (Buffer.byteLength(text, "utf8") !== after.size) fail(`${detail}_SIZE_MISMATCH`);
  return { text, sha256: sha256(Buffer.from(text, "utf8")) };
}

function serializeBundleBase(base: TaskbookArchiveBundleBase): string {
  return JSON.stringify({
    version: base.version,
    workspaceId: base.workspaceId,
    taskId: base.taskId,
    bodySha256: base.bodySha256,
    envelope: base.envelope,
    claim: base.claim,
    result: base.result,
    terminalEvidence: base.terminalEvidence,
    executionRecords: base.executionRecords,
    outputs: base.outputs,
    sourceDigests: base.sourceDigests,
    authorizations: base.authorizations,
  });
}

function serializeBundle(base: TaskbookArchiveBundleBase): { bundle: TaskbookArchiveBundle; text: string } {
  const bundleSha256 = sha256(serializeBundleBase(base));
  const bundle: TaskbookArchiveBundle = { ...base, bundleSha256 };
  return { bundle, text: JSON.stringify({ ...base, bundleSha256 }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOutputSnapshot(value: unknown): ExecutionOutputSnapshot {
  if (!isRecord(value) || typeof value.state !== "string") fail("ARCHIVE_OUTPUT_INVALID");
  if (value.state === "readable") {
    if (
      !isRecord(value.meta) || typeof value.text !== "string" || typeof value.textSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.textSha256) || sha256(value.text) !== value.textSha256
    ) fail("ARCHIVE_OUTPUT_INVALID");
    const checked = validateOutputMeta(value.meta);
    if (checked.allowed !== true || checked.sizeBytes !== Buffer.byteLength(value.text, "utf8")) fail("ARCHIVE_OUTPUT_INVALID");
    return { state: "readable", meta: checked, text: value.text, textSha256: value.textSha256 };
  }
  if (value.state === "restricted") {
    if (!isRecord(value.meta)) fail("ARCHIVE_OUTPUT_INVALID");
    const checked = validateOutputMeta(value.meta);
    if (checked.allowed !== false) fail("ARCHIVE_OUTPUT_INVALID");
    return { state: "restricted", meta: checked };
  }
  if (value.state === "not-retained") {
    if (!Number.isSafeInteger(value.outputId) || (value.outputId as number) <= 0) fail("ARCHIVE_OUTPUT_INVALID");
    return { state: "not-retained", outputId: value.outputId as number };
  }
  if (value.state === "unavailable") {
    if (
      !Number.isSafeInteger(value.outputId) || (value.outputId as number) <= 0 || typeof value.reason !== "string" ||
      (value.meta !== undefined && !isRecord(value.meta))
    ) fail("ARCHIVE_OUTPUT_INVALID");
    return {
      state: "unavailable",
      outputId: value.outputId as number,
      meta: value.meta ? validateOutputMeta(value.meta) : undefined,
      reason: value.reason,
    };
  }
  fail("ARCHIVE_OUTPUT_INVALID");
}

function validateOutputMeta(raw: Record<string, unknown>): ExecutionOutputSnapshot extends never ? never : import("../execution/output.js").ExecutionOutputMeta {
  if (
    !Number.isSafeInteger(raw.id) || (raw.id as number) <= 0 || typeof raw.command !== "string" ||
    (raw.exitCode !== null && (typeof raw.exitCode !== "number" || !Number.isSafeInteger(raw.exitCode))) ||
    typeof raw.timestamp !== "string" || (raw.taskId !== undefined && typeof raw.taskId !== "string") ||
    (raw.iteration !== undefined && (typeof raw.iteration !== "number" || !Number.isSafeInteger(raw.iteration) || raw.iteration < 0)) ||
    typeof raw.allowed !== "boolean" || typeof raw.truncated !== "boolean" ||
    !Number.isSafeInteger(raw.sizeBytes) || (raw.sizeBytes as number) < 0 ||
    (raw.allowed === false && raw.sizeBytes !== 0) ||
    (raw.allowed === true && raw.restrictedReason !== undefined) ||
    (raw.restrictedReason !== undefined && typeof raw.restrictedReason !== "string")
  ) fail("ARCHIVE_OUTPUT_INVALID");
  return {
    id: raw.id as number,
    command: raw.command,
    exitCode: raw.exitCode as number | null,
    timestamp: raw.timestamp,
    taskId: raw.taskId as string | undefined,
    iteration: raw.iteration as number | undefined,
    allowed: raw.allowed,
    restrictedReason: raw.restrictedReason as string | undefined,
    truncated: raw.truncated,
    sizeBytes: raw.sizeBytes as number,
  };
}

export function parseTaskbookArchiveBundle(text: string): TaskbookArchiveBundle {
  if (Buffer.byteLength(text, "utf8") > MAX_TASKBOOK_ARCHIVE_BUNDLE_BYTES) fail("ARCHIVE_BUNDLE_TOO_LARGE");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { fail("ARCHIVE_BUNDLE_MALFORMED"); }
  if (!isRecord(raw)) fail("ARCHIVE_BUNDLE_MALFORMED");
  const keys = [
    "version", "workspaceId", "taskId", "bodySha256", "envelope", "claim", "result", "terminalEvidence",
    "executionRecords", "outputs", "sourceDigests", "authorizations", "bundleSha256",
  ];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(raw, key))) {
    fail("ARCHIVE_BUNDLE_FIELDS");
  }
  if (
    raw.version !== 1 || typeof raw.workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.workspaceId) ||
    typeof raw.taskId !== "string" || !isCanonicalTaskId(raw.taskId) ||
    typeof raw.bodySha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.bodySha256) ||
    typeof raw.bundleSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.bundleSha256) ||
    !Array.isArray(raw.executionRecords) || !Array.isArray(raw.outputs) || !Array.isArray(raw.authorizations) ||
    !isRecord(raw.sourceDigests) || !isRecord(raw.terminalEvidence)
  ) fail("ARCHIVE_BUNDLE_FIELDS");

  let envelope: TaskbookEnvelope;
  let claim: TaskbookClaimRecord;
  let result: AnyTaskbookResultRecord;
  try {
    envelope = parseEnvelope(JSON.stringify(raw.envelope));
    claim = parseClaimRecord(JSON.stringify(raw.claim));
    result = parseResultRecord(JSON.stringify(raw.result));
  } catch { fail("ARCHIVE_BUNDLE_LIFECYCLE_INVALID"); }
  if (
    claim.taskId !== raw.taskId || claim.bodySha256 !== raw.bodySha256 || bodySha256(envelope.body) !== raw.bodySha256 ||
    result.taskId !== raw.taskId || result.bodySha256 !== raw.bodySha256 || result.claimId !== claim.claimId
  ) fail("ARCHIVE_BUNDLE_LIFECYCLE_MISMATCH");

  const terminalEvidence = raw.terminalEvidence;
  let normalizedEvidence: TaskbookArchiveTerminalEvidence;
  if (terminalEvidence.kind === "capsule") {
    if (typeof terminalEvidence.capsuleSha256 !== "string" || !/^[0-9a-f]{64}$/.test(terminalEvidence.capsuleSha256)) {
      fail("ARCHIVE_CAPSULE_INVALID");
    }
    const capsule = parseTaskbookTerminalEvidenceCapsule(JSON.stringify(terminalEvidence.capsule));
    if (
      capsule.workspaceId !== raw.workspaceId || capsule.taskId !== raw.taskId || capsule.bodySha256 !== raw.bodySha256 ||
      capsule.claimId !== claim.claimId || JSON.stringify(capsule.result) !== JSON.stringify(result) ||
      sha256(serializeTaskbookTerminalEvidenceCapsule(capsule)) !== terminalEvidence.capsuleSha256
    ) fail("ARCHIVE_CAPSULE_MISMATCH");
    normalizedEvidence = { kind: "capsule", capsule, capsuleSha256: terminalEvidence.capsuleSha256 };
  } else if (terminalEvidence.kind === "legacy-snapshot") {
    if (
      (terminalEvidence.recordSnapshot !== "read-back" && terminalEvidence.recordSnapshot !== "none" && terminalEvidence.recordSnapshot !== "incomplete") ||
      !Array.isArray(terminalEvidence.records) || !Array.isArray(terminalEvidence.outputs)
    ) fail("ARCHIVE_LEGACY_EVIDENCE_INVALID");
    const records = terminalEvidence.records.map((record) => {
      const checked = executionRecordSchema.safeParse(record);
      if (!checked.success || checked.data.taskId !== raw.taskId) fail("ARCHIVE_LEGACY_RECORD_INVALID");
      return checked.data;
    });
    normalizedEvidence = {
      kind: "legacy-snapshot",
      recordSnapshot: terminalEvidence.recordSnapshot,
      records,
      outputs: terminalEvidence.outputs.map(parseOutputSnapshot),
    };
  } else {
    fail("ARCHIVE_TERMINAL_EVIDENCE_INVALID");
  }

  const executionRecords = raw.executionRecords.map((item) => {
    if (
      !isRecord(item) || typeof item.lineText !== "string" || Buffer.byteLength(item.lineText, "utf8") > MAX_STREAMED_RECORD_LINE_BYTES ||
      typeof item.lineSha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.lineSha256)
    ) {
      fail("ARCHIVE_EXECUTION_RECORD_INVALID");
    }
    const checked = executionRecordSchema.safeParse(item.record);
    let lineRecord: unknown;
    try { lineRecord = JSON.parse(item.lineText); } catch { fail("ARCHIVE_EXECUTION_RECORD_INVALID"); }
    const checkedLine = executionRecordSchema.safeParse(lineRecord);
    if (
      !checked.success || !checkedLine.success || checked.data.taskId !== raw.taskId || checkedLine.data.taskId !== raw.taskId ||
      JSON.stringify(checkedLine.data) !== JSON.stringify(checked.data) ||
      sha256(Buffer.from(`${item.lineText}\n`, "utf8")) !== item.lineSha256
    ) fail("ARCHIVE_EXECUTION_RECORD_INVALID");
    return { record: checked.data, lineText: item.lineText, lineSha256: item.lineSha256 };
  });
  const outputs = raw.outputs.map(parseOutputSnapshot);

  const sourceDigests = raw.sourceDigests;
  if (
    Object.keys(sourceDigests).some((key) => !["envelope", "claim", "result", "capsuleSha256"].includes(key)) ||
    ["envelope", "claim", "result"].some((key) => typeof sourceDigests[key] !== "string" || !/^[0-9a-f]{64}$/.test(sourceDigests[key] as string)) ||
    (sourceDigests.capsuleSha256 !== undefined && (typeof sourceDigests.capsuleSha256 !== "string" || !/^[0-9a-f]{64}$/.test(sourceDigests.capsuleSha256)))
  ) fail("ARCHIVE_SOURCE_DIGESTS_INVALID");
  if (
    (normalizedEvidence.kind === "capsule") !== (typeof sourceDigests.capsuleSha256 === "string") ||
    (normalizedEvidence.kind === "capsule" && sourceDigests.capsuleSha256 !== normalizedEvidence.capsuleSha256)
  ) fail("ARCHIVE_CAPSULE_DIGEST_MISMATCH");

  const authorizations = raw.authorizations.map((item) => {
    if (
      !isRecord(item) || typeof item.authorizationSha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.authorizationSha256) ||
      (item.authorizationKind !== "claim" && item.authorizationKind !== "recovery")
    ) fail("ARCHIVE_AUTHORIZATION_INVALID");
    return { authorizationSha256: item.authorizationSha256, authorizationKind: item.authorizationKind as "claim" | "recovery" };
  });
  const expectedAuthorizations = [
    { authorizationSha256: authorizationSha256(claim.authorizationId), authorizationKind: "claim" as const },
    ...(result.version === 2
      ? [{ authorizationSha256: authorizationSha256(result.recoveryAuthorizationId), authorizationKind: "recovery" as const }]
      : []),
  ].sort((a, b) => a.authorizationSha256.localeCompare(b.authorizationSha256));
  if (JSON.stringify(authorizations) !== JSON.stringify(expectedAuthorizations)) fail("ARCHIVE_AUTHORIZATION_MISMATCH");

  const base: TaskbookArchiveBundleBase = {
    version: 1,
    workspaceId: raw.workspaceId,
    taskId: raw.taskId,
    bodySha256: raw.bodySha256,
    envelope,
    claim,
    result,
    terminalEvidence: normalizedEvidence,
    executionRecords,
    outputs,
    sourceDigests: {
      envelope: sourceDigests.envelope as string,
      claim: sourceDigests.claim as string,
      result: sourceDigests.result as string,
      ...(typeof sourceDigests.capsuleSha256 === "string" ? { capsuleSha256: sourceDigests.capsuleSha256 } : {}),
    },
    authorizations,
  };
  const rebuilt = serializeBundle(base);
  if (rebuilt.bundle.bundleSha256 !== raw.bundleSha256 || rebuilt.text !== text) fail("ARCHIVE_BUNDLE_DIGEST_MISMATCH");
  return rebuilt.bundle;
}

function outputIdsFor(records: readonly ExecutionRecordLine[], result: AnyTaskbookResultRecord): number[] {
  const ids = new Set<number>();
  for (const item of records) if (item.record.outputId !== undefined) ids.add(item.record.outputId);
  if (result.outputId !== null) ids.add(result.outputId);
  return [...ids].sort((a, b) => a - b);
}

function makeAuthorizationRefs(claim: TaskbookClaimRecord, result: AnyTaskbookResultRecord): TaskbookArchiveAuthorizationRef[] {
  return [
    { authorizationSha256: authorizationSha256(claim.authorizationId), authorizationKind: "claim" as const },
    ...(result.version === 2
      ? [{ authorizationSha256: authorizationSha256(result.recoveryAuthorizationId), authorizationKind: "recovery" as const }]
      : []),
  ].sort((a, b) => a.authorizationSha256.localeCompare(b.authorizationSha256));
}

function readActiveSourceFiles(
  io: TaskbookIo,
  paths: TaskbookPaths,
  taskId: string
): { envelopeText: string; claimText: string; resultText: string; sourceDigests: TaskbookArchiveBundleBase["sourceDigests"] } {
  const root = paths.workspaceTaskRoot;
  const envelope = readStableFile(io, paths, path.join(root, taskbookFileName(taskId)), MAX_ENVELOPE_BYTES, "ARCHIVE_ENVELOPE");
  const claim = readStableFile(io, paths, path.join(root, taskbookClaimFileName(taskId)), 4096, "ARCHIVE_CLAIM");
  const result = readStableFile(io, paths, path.join(root, taskbookResultFileName(taskId)), 4096, "ARCHIVE_RESULT");
  return {
    envelopeText: envelope.text,
    claimText: claim.text,
    resultText: result.text,
    sourceDigests: { envelope: envelope.sha256, claim: claim.sha256, result: result.sha256 },
  };
}

function buildArchiveBundle(
  io: TaskbookIo,
  paths: TaskbookPaths,
  workspaceId: string,
  stateDir: string,
  task: TaskbookLifecycleTask
): { bundle: TaskbookArchiveBundle; text: string } {
  if (!task.claim || !task.result) fail("ARCHIVE_TASK_NOT_TERMINAL");
  const raw = readActiveSourceFiles(io, paths, task.taskId);
  const envelope = parseEnvelope(raw.envelopeText);
  const claim = parseClaimRecord(raw.claimText);
  const result = parseResultRecord(raw.resultText);
  if (
    claim.claimId !== task.claim.claimId || result.status !== task.result.status ||
    JSON.stringify(result) !== JSON.stringify(task.result) || bodySha256(envelope.body) !== task.bodySha256
  ) fail("STATE_CONFLICT");

  const recordScan = readExecutionRecordLinesForTasks(workspaceId, [task.taskId], stateDir);
  if (!recordScan.complete) fail("ARCHIVE_EXECUTION_LOG_INCOMPLETE");
  const executionRecords = recordScan.recordsByTask.get(task.taskId) ?? [];
  const outputs = outputIdsFor(executionRecords, result).map((id) => inspectExecutionOutput(workspaceId, id, stateDir));
  const capsuleRead = readTaskbookTerminalEvidenceCapsule(io, paths, workspaceId, task.taskId);
  let terminalEvidence: TaskbookArchiveTerminalEvidence;
  if (capsuleRead) {
    const capsule = capsuleRead.capsule;
    if (
      capsule.bodySha256 !== task.bodySha256 || capsule.claimId !== claim.claimId ||
      JSON.stringify(capsule.result) !== JSON.stringify(result)
    ) fail("ARCHIVE_CAPSULE_MISMATCH");
    raw.sourceDigests.capsuleSha256 = sha256(capsuleRead.text);
    terminalEvidence = { kind: "capsule", capsule, capsuleSha256: raw.sourceDigests.capsuleSha256 };
  } else {
    terminalEvidence = {
      kind: "legacy-snapshot",
      recordSnapshot: executionRecords.length > 0 ? "read-back" : "none",
      records: executionRecords.map((item) => item.record),
      outputs,
    };
  }
  const base: TaskbookArchiveBundleBase = {
    version: 1,
    workspaceId,
    taskId: task.taskId,
    bodySha256: task.bodySha256,
    envelope,
    claim,
    result,
    terminalEvidence,
    executionRecords,
    outputs,
    sourceDigests: raw.sourceDigests,
    authorizations: makeAuthorizationRefs(claim, result),
  };
  const serialized = serializeBundle(base);
  if (Buffer.byteLength(serialized.text, "utf8") > MAX_TASKBOOK_ARCHIVE_BUNDLE_BYTES) {
    throw new TaskbookError("LIMIT_EXCEEDED", undefined, "ARCHIVE_BUNDLE_TOO_LARGE");
  }
  return serialized;
}

function bundleFile(io: TaskbookIo, paths: TaskbookPaths, workspaceId: string, taskId: string): { bundle: TaskbookArchiveBundle; text: string } | null {
  const dir = existingContainedDirectory(io, paths, [TASKBOOK_ARCHIVE_ROOT_NAME, workspaceId, "bundles"]);
  if (!dir) return null;
  const file = path.join(dir, `${taskId}.json`);
  const stat = lstatOrNull(io, file);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TASKBOOK_ARCHIVE_BUNDLE_BYTES) fail("ARCHIVE_BUNDLE_FILE_INVALID");
  const real = realpathStrict(io, file);
  if (!isInsideRoot(paths.stateRoot, real)) fail("ARCHIVE_CONTAINMENT");
  const text = readTextStrict(io, file);
  const after = lstatStrict(io, file);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail("ARCHIVE_BUNDLE_CHANGED");
  return { bundle: parseTaskbookArchiveBundle(text), text };
}

function markerFile(
  io: TaskbookIo,
  paths: TaskbookPaths,
  workspaceId: string,
  authorizationHash: string
): { marker: Record<string, unknown>; text: string } | null {
  const dir = existingContainedDirectory(io, paths, [TASKBOOK_ARCHIVE_ROOT_NAME, workspaceId, "authorizations"]);
  if (!dir) return null;
  const file = path.join(dir, `${authorizationHash}.json`);
  const stat = lstatOrNull(io, file);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) fail("ARCHIVE_AUTHORIZATION_MARKER_INVALID");
  const real = realpathStrict(io, file);
  if (!isInsideRoot(paths.stateRoot, real)) fail("ARCHIVE_CONTAINMENT");
  const text = readTextStrict(io, file);
  const after = lstatStrict(io, file);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail("ARCHIVE_AUTHORIZATION_MARKER_CHANGED");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { fail("ARCHIVE_AUTHORIZATION_MARKER_MALFORMED"); }
  if (!isRecord(raw)) fail("ARCHIVE_AUTHORIZATION_MARKER_MALFORMED");
  const expectedKeys = ["version", "workspaceId", "taskId", "claimId", "authorizationSha256", "authorizationKind", "bundleSha256"];
  if (
    Object.keys(raw).length !== expectedKeys.length || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(raw, key)) ||
    raw.version !== 1 || raw.workspaceId !== workspaceId || typeof raw.taskId !== "string" || !isCanonicalTaskId(raw.taskId) ||
    typeof raw.claimId !== "string" || !isCanonicalTaskId(raw.claimId) || raw.authorizationSha256 !== authorizationHash ||
    (raw.authorizationKind !== "claim" && raw.authorizationKind !== "recovery") ||
    typeof raw.bundleSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.bundleSha256) || JSON.stringify(raw) !== text
  ) fail("ARCHIVE_AUTHORIZATION_MARKER_INVALID");
  return { marker: raw, text };
}

function verifyMarkerBundle(
  io: TaskbookIo,
  paths: TaskbookPaths,
  workspaceId: string,
  marker: Record<string, unknown>
): TaskbookArchiveBundle {
  const loaded = bundleFile(io, paths, workspaceId, marker.taskId as string);
  if (!loaded) fail("ARCHIVE_MARKER_BUNDLE_MISSING");
  const bundle = loaded.bundle;
  if (
    bundle.bundleSha256 !== marker.bundleSha256 || bundle.workspaceId !== workspaceId ||
    bundle.taskId !== marker.taskId || bundle.claim.claimId !== marker.claimId ||
    !bundle.authorizations.some((ref) => ref.authorizationSha256 === marker.authorizationSha256 && ref.authorizationKind === marker.authorizationKind)
  ) fail("ARCHIVE_MARKER_BUNDLE_MISMATCH");
  return bundle;
}

export function isArchivedAuthorizationUsed(io: TaskbookIo, paths: TaskbookPaths, authorizationId: string): boolean {
  const hash = authorizationSha256(authorizationId);
  const loaded = markerFile(io, paths, paths.workspaceTaskRoot.split(path.sep).at(-1) ?? "", hash);
  if (!loaded) return false;
  verifyMarkerBundle(io, paths, loaded.marker.workspaceId as string, loaded.marker);
  return true;
}

function authorizationMarkerText(
  workspaceId: string,
  bundle: TaskbookArchiveBundle,
  ref: TaskbookArchiveAuthorizationRef
): string {
  return JSON.stringify({
    version: 1,
    workspaceId,
    taskId: bundle.taskId,
    claimId: bundle.claim.claimId,
    authorizationSha256: ref.authorizationSha256,
    authorizationKind: ref.authorizationKind,
    bundleSha256: bundle.bundleSha256,
  });
}

function writeAtomicOwnedFile(io: TaskbookIo, paths: TaskbookPaths, file: string, temp: string, text: string, maxBytes: number, detail: string): string {
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new TaskbookError("LIMIT_EXCEEDED", undefined, `${detail}_TOO_LARGE`);
  const existing = lstatOrNull(io, file);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) fail(`${detail}_FILE_INVALID`);
    const current = readStableFile(io, paths, file, maxBytes, detail);
    if (current.text !== text) fail("STATE_CONFLICT");
    return current.sha256;
  }
  const tempStat = lstatOrNull(io, temp);
  if (tempStat) {
    if (tempStat.isSymbolicLink() || !tempStat.isFile()) fail(`${detail}_TEMP_INVALID`);
    if (!isInsideRoot(paths.stateRoot, realpathStrict(io, temp))) fail("ARCHIVE_CONTAINMENT");
    try { io.unlink(temp); } catch (error) { throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? `${detail}_TEMP_REMOVE_FAILED`); }
  }
  if (!createNewFileExclusive(io, temp, text)) fail(`${detail}_TEMP_EXISTS`);
  try { io.rename(temp, file); } catch (error) {
    throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? `${detail}_FINALIZE_FAILED`);
  }
  const finalized = readStableFile(io, paths, file, maxBytes, detail);
  if (finalized.text !== text) fail(`${detail}_READBACK_MISMATCH`);
  return finalized.sha256;
}

function writeArchiveBundle(
  io: TaskbookIo,
  paths: TaskbookPaths,
  workspaceId: string,
  text: string,
  taskId: string
): TaskbookArchiveBundle {
  const bundlesDir = ensureContainedDir(io, paths.stateRoot, [TASKBOOK_ARCHIVE_ROOT_NAME, workspaceId, "bundles"]);
  const file = path.join(bundlesDir, `${taskId}.json`);
  const temp = path.join(bundlesDir, `${taskId}.tmp`);
  writeAtomicOwnedFile(io, paths, file, temp, text, MAX_TASKBOOK_ARCHIVE_BUNDLE_BYTES, "ARCHIVE_BUNDLE");
  const readback = bundleFile(io, paths, workspaceId, taskId);
  if (!readback || readback.text !== text) fail("ARCHIVE_BUNDLE_READBACK_MISMATCH");
  return readback.bundle;
}

function writeAuthorizationMarkers(io: TaskbookIo, paths: TaskbookPaths, bundle: TaskbookArchiveBundle): void {
  const directory = ensureContainedDir(io, paths.stateRoot, [TASKBOOK_ARCHIVE_ROOT_NAME, bundle.workspaceId, "authorizations"]);
  for (const ref of bundle.authorizations) {
    const file = path.join(directory, `${ref.authorizationSha256}.json`);
    const temp = path.join(directory, `${ref.authorizationSha256}.tmp`);
    const text = authorizationMarkerText(bundle.workspaceId, bundle, ref);
    writeAtomicOwnedFile(io, paths, file, temp, text, 4096, "ARCHIVE_AUTHORIZATION_MARKER");
    const marker = markerFile(io, paths, bundle.workspaceId, ref.authorizationSha256);
    if (!marker || marker.text !== text) fail("ARCHIVE_AUTHORIZATION_MARKER_READBACK_MISMATCH");
    verifyMarkerBundle(io, paths, bundle.workspaceId, marker.marker);
  }
}

function verifyActiveRemnants(io: TaskbookIo, paths: TaskbookPaths, bundle: TaskbookArchiveBundle): string[] {
  const expected = [
    [taskbookFileName(bundle.taskId), bundle.sourceDigests.envelope],
    [taskbookClaimFileName(bundle.taskId), bundle.sourceDigests.claim],
    [taskbookResultFileName(bundle.taskId), bundle.sourceDigests.result],
  ] as const;
  const found: string[] = [];
  for (const [name, digest] of expected) {
    const file = path.join(paths.workspaceTaskRoot, name);
    const stat = lstatOrNull(io, file);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile()) fail("STATE_CONFLICT");
    const current = readStableFile(io, paths, file, MAX_ENVELOPE_BYTES, "ARCHIVE_ACTIVE_REMNANT");
    if (current.sha256 !== digest) fail("STATE_CONFLICT");
    found.push(file);
  }
  return found;
}

function collectVerifiedRemnants(io: TaskbookIo, paths: TaskbookPaths, workspaceId: string): RemnantSet[] {
  const bundleDir = existingContainedDirectory(io, paths, [TASKBOOK_ARCHIVE_ROOT_NAME, workspaceId, "bundles"]);
  if (!bundleDir) return [];
  const { names, exceeded } = io.readDirBounded(bundleDir, MAX_ARCHIVE_DIRECTORY_ENTRIES);
  if (exceeded) fail("ARCHIVE_DIRECTORY_OVER_CAP");
  const remnants: RemnantSet[] = [];
  for (const name of names) {
    if (name.endsWith(".tmp")) {
      const file = path.join(bundleDir, name);
      const stat = lstatStrict(io, file);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("ARCHIVE_TEMP_INVALID");
      continue;
    }
    const taskId = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!isCanonicalTaskId(taskId)) fail("ARCHIVE_DIRECTORY_INVALID");
    const loaded = bundleFile(io, paths, workspaceId, taskId);
    if (!loaded) continue;
    const markerLoads = loaded.bundle.authorizations.map((ref) => markerFile(io, paths, workspaceId, ref.authorizationSha256));
    if (markerLoads.every((marker) => marker === null)) continue;
    if (markerLoads.some((marker) => marker === null)) continue;
    for (const marker of markerLoads) {
      if (!marker) fail("ARCHIVE_AUTHORIZATION_MARKER_MISSING");
      verifyMarkerBundle(io, paths, workspaceId, marker.marker);
    }
    const files = verifyActiveRemnants(io, paths, loaded.bundle);
    if (files.length > 0) remnants.push({ taskId, bundle: loaded.bundle, files });
  }
  return remnants;
}

function inventoryIgnoringVerifiedRemnants(
  io: TaskbookIo,
  paths: TaskbookPaths,
  remnants: readonly RemnantSet[]
): DetailedTaskbookInventory {
  const ignored = new Set(remnants.flatMap((item) => item.files));
  const workspaceStat = lstatOrNull(io, paths.workspaceTaskRoot);
  if (!workspaceStat) {
    return {
      entries: 0,
      storageBytes: 0,
      pending: 0,
      tasks: [],
      invalidTaskIds: [],
      unfinishedClaims: [],
      authorizationIds: new Set(),
    };
  }
  if (ignored.size === 0) return inventoryTaskbookState(io, paths.workspaceTaskRoot);
  const filteredIo: TaskbookIo = {
    ...io,
    readDirBounded: (pathname, maxEntries) => {
      if (path.resolve(pathname) !== path.resolve(paths.workspaceTaskRoot)) return io.readDirBounded(pathname, maxEntries);
      const raw = io.readDirBounded(pathname, maxEntries + ignored.size);
      if (raw.exceeded) return { names: [], exceeded: true };
      const names = raw.names.filter((name) => !ignored.has(path.join(paths.workspaceTaskRoot, name)));
      return { names, exceeded: names.length > maxEntries };
    },
  };
  return inventoryTaskbookState(filteredIo, paths.workspaceTaskRoot);
}

function archiveFinishedAt(task: TaskbookLifecycleTask): string {
  if (!task.result) fail("ARCHIVE_TASK_NOT_TERMINAL");
  return task.result.finishedAt;
}

function taskPlan(task: TaskbookLifecycleTask, bundle: TaskbookArchiveBundle, text: string, alreadyPrepared: boolean): TaskbookArchiveTaskPlan {
  return {
    taskId: task.taskId,
    status: task.result?.status ?? "",
    finishedAt: archiveFinishedAt(task),
    bundleBytes: Buffer.byteLength(text, "utf8"),
    bundleSha256: bundle.bundleSha256,
    executionRecordCount: bundle.executionRecords.length,
    outputStatuses: bundle.outputs.map((output) => ({
      outputId: output.state === "readable" || output.state === "restricted" ? output.meta.id : output.outputId,
      state: output.state,
    })),
    alreadyPrepared,
  };
}

function preparedOrBuild(
  io: TaskbookIo,
  paths: TaskbookPaths,
  workspaceId: string,
  stateDir: string,
  task: TaskbookLifecycleTask
): { bundle: TaskbookArchiveBundle; text: string; alreadyPrepared: boolean } {
  const existing = bundleFile(io, paths, workspaceId, task.taskId);
  if (existing) {
    const current = readActiveSourceFiles(io, paths, task.taskId);
    if (
      current.sourceDigests.envelope !== existing.bundle.sourceDigests.envelope ||
      current.sourceDigests.claim !== existing.bundle.sourceDigests.claim ||
      current.sourceDigests.result !== existing.bundle.sourceDigests.result
    ) fail("STATE_CONFLICT");
    return { ...existing, alreadyPrepared: true };
  }
  const built = buildArchiveBundle(io, paths, workspaceId, stateDir, task);
  return { ...built, alreadyPrepared: false };
}

function runLocked<T>(io: TaskbookIo, paths: TaskbookPaths, operation: () => T): T {
  try {
    acquireTaskbookLock(io, paths.lockPath);
  } catch (error) {
    if (error instanceof TaskbookError && error.detail === "LOCK_HELD") throw new TaskbookError("BUSY", undefined, "LOCK_HELD");
    throw error;
  }
  let value: T | undefined;
  let failure: unknown;
  try { value = operation(); } catch (error) { failure = error; }
  try { releaseTaskbookLock(io, paths.lockPath); } catch { /* Preserve the operation result; a remaining lock blocks later work. */ }
  if (failure !== undefined) throw failure;
  return value as T;
}

function resolveArchivePathsReadOnly(options: TaskbookArchiveOptions, io: TaskbookIo): TaskbookPaths {
  assertSafeWorkspaceId(options.workspaceId);
  const projectRoot = realpathStrict(io, path.resolve(options.projectRoot));
  const stateInput = options.stateDir ?? getStateDir();
  const { existingReal, suffix } = probeDeepestExisting(io, stateInput);
  const stateRoot = suffix.length > 0 ? path.join(existingReal, ...suffix) : existingReal;
  if (isInsideRoot(projectRoot, stateRoot)) throw new TaskbookError("STORAGE_ERROR", undefined, "STATE_INSIDE_PROJECT");

  const tasksRoot = path.join(stateRoot, TASKS_ROOT_NAME);
  const workspaceTaskRoot = path.join(tasksRoot, options.workspaceId);
  const lockNamespace = path.join(stateRoot, LOCK_NAMESPACE_NAME);
  const lockPath = path.join(lockNamespace, `${options.workspaceId}${LOCK_SUFFIX}`);
  for (const directory of [tasksRoot, workspaceTaskRoot, lockNamespace]) {
    const stats = lstatOrNull(io, directory);
    if (!stats) continue;
    if (stats.isSymbolicLink() || !stats.isDirectory()) fail("ARCHIVE_DIRECTORY_INVALID");
    if (!isInsideRoot(stateRoot, realpathStrict(io, directory))) fail("ARCHIVE_CONTAINMENT");
  }
  if (lstatOrNull(io, lockPath)) throw new TaskbookError("BUSY", undefined, "LOCK_HELD");
  return { stateRoot, projectRoot, tasksRoot, workspaceTaskRoot, lockNamespace, lockPath };
}

function validateArchiveOptions(options: TaskbookArchiveOptions): { keepTerminal: number; maxTasks: number; apply: boolean } {
  const keepTerminal = options.keepTerminal ?? 100;
  const maxTasks = options.maxTasks ?? 50;
  if (!Number.isSafeInteger(keepTerminal) || keepTerminal < 0) throw new TaskbookError("INVALID_INPUT", undefined, "KEEP_TERMINAL");
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 100) throw new TaskbookError("INVALID_INPUT", undefined, "MAX_TASKS");
  return { keepTerminal, maxTasks, apply: options.apply === true };
}

function resultEnvelope(task: TaskbookLifecycleTask): TaskbookReadItem {
  if (!task.claim || !task.result) fail("ARCHIVE_TASK_NOT_TERMINAL");
  return {
    taskId: task.taskId,
    createdAt: task.envelope.createdAt,
    title: task.envelope.title,
    body: task.envelope.body,
    bodySha256: task.bodySha256,
    status: task.result.status,
    claimId: task.claim.claimId,
    result: task.result,
  };
}

function readArchivedBundle(
  io: TaskbookIo,
  paths: TaskbookPaths,
  workspaceId: string,
  taskId: string
): TaskbookArchiveBundle | null {
  const loaded = bundleFile(io, paths, workspaceId, taskId);
  if (!loaded) return null;
  for (const ref of loaded.bundle.authorizations) {
    const marker = markerFile(io, paths, workspaceId, ref.authorizationSha256);
    if (!marker) fail("ARCHIVE_AUTHORIZATION_MARKER_MISSING");
    verifyMarkerBundle(io, paths, workspaceId, marker.marker);
  }
  return loaded.bundle;
}

export function inspectArchivedTaskbook(options: TaskbookLocalContext & { taskId: string }): TaskbookReadItem | null {
  if (!isCanonicalTaskId(options.taskId)) throw new TaskbookError("INVALID_INPUT", undefined, "TASK_ID");
  const io = options.io ?? nodeTaskbookIo;
  const paths = resolveTaskbookPaths({
    workspaceId: options.workspaceId,
    projectRoot: options.projectRoot,
    stateDir: options.stateDir,
    io,
  });
  return runLocked(io, paths, () => {
    const bundle = readArchivedBundle(io, paths, options.workspaceId, options.taskId);
    if (!bundle) return null;
    return {
      taskId: bundle.taskId,
      createdAt: bundle.envelope.createdAt,
      title: bundle.envelope.title,
      body: bundle.envelope.body,
      bodySha256: bundle.bodySha256,
      status: bundle.result.status,
      claimId: bundle.claim.claimId,
      result: bundle.result,
    };
  });
}

function archiveOne(
  io: TaskbookIo,
  paths: TaskbookPaths,
  workspaceId: string,
  stateDir: string,
  task: TaskbookLifecycleTask
): void {
  const prepared = preparedOrBuild(io, paths, workspaceId, stateDir, task);
  const bundle = prepared.alreadyPrepared
    ? prepared.bundle
    : writeArchiveBundle(io, paths, workspaceId, prepared.text, task.taskId);
  writeAuthorizationMarkers(io, paths, bundle);
  for (const markerRef of bundle.authorizations) {
    const loaded = markerFile(io, paths, workspaceId, markerRef.authorizationSha256);
    if (!loaded) fail("ARCHIVE_AUTHORIZATION_MARKER_MISSING");
    verifyMarkerBundle(io, paths, workspaceId, loaded.marker);
  }
  const files = verifyActiveRemnants(io, paths, bundle);
  for (const file of files) {
    const baseName = path.basename(file);
    const expected = baseName === taskbookFileName(task.taskId)
      ? bundle.sourceDigests.envelope
      : baseName === taskbookClaimFileName(task.taskId)
        ? bundle.sourceDigests.claim
        : bundle.sourceDigests.result;
    const current = readStableFile(io, paths, file, MAX_ENVELOPE_BYTES, "ARCHIVE_ACTIVE_REMNANT");
    if (current.sha256 !== expected) fail("STATE_CONFLICT");
    try { io.unlink(file); } catch (error) { throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "ARCHIVE_ACTIVE_REMOVE_FAILED"); }
  }
}

function allVerifiedArchiveBundles(io: TaskbookIo, paths: TaskbookPaths, workspaceId: string): TaskbookArchiveBundle[] {
  const dir = existingContainedDirectory(io, paths, [TASKBOOK_ARCHIVE_ROOT_NAME, workspaceId, "bundles"]);
  if (!dir) return [];
  const { names, exceeded } = io.readDirBounded(dir, MAX_ARCHIVE_DIRECTORY_ENTRIES);
  if (exceeded) fail("ARCHIVE_DIRECTORY_OVER_CAP");
  const bundles: TaskbookArchiveBundle[] = [];
  for (const name of names) {
    if (name.endsWith(".tmp")) continue;
    const taskId = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!isCanonicalTaskId(taskId)) fail("ARCHIVE_DIRECTORY_INVALID");
    const bundle = readArchivedBundle(io, paths, workspaceId, taskId);
    if (bundle) bundles.push(bundle);
  }
  return bundles;
}

function executeArchive(options: TaskbookArchiveOptions): TaskbookArchiveResult {
  const { keepTerminal, maxTasks, apply } = validateArchiveOptions(options);
  const io = options.io ?? nodeTaskbookIo;
  const paths = apply
    ? resolveTaskbookPaths({
        workspaceId: options.workspaceId,
        projectRoot: options.projectRoot,
        stateDir: options.stateDir,
        io,
      })
    : resolveArchivePathsReadOnly(options, io);
  const stateDir = paths.stateRoot;
  const operation = (): TaskbookArchiveResult => {
    const remnants = collectVerifiedRemnants(io, paths, options.workspaceId);
    let inventory = inventoryIgnoringVerifiedRemnants(io, paths, remnants);
    const unfinished = inventory.unfinishedClaims.map((task) => ({
      taskId: task.taskId,
      claimId: task.claim?.claimId ?? "",
    }));
    const terminal = inventory.tasks
      .filter((task) => task.claim !== null && task.result !== null)
      .sort((left, right) => archiveFinishedAt(left).localeCompare(archiveFinishedAt(right)) || left.taskId.localeCompare(right.taskId));
    const eligibleCount = Math.max(0, terminal.length - keepTerminal);
    const selectedTasks = terminal.slice(0, Math.min(eligibleCount, maxTasks));
    const selected: TaskbookArchiveTaskPlan[] = selectedTasks.map((task) => {
      const prepared = preparedOrBuild(io, paths, options.workspaceId, stateDir, task);
      return taskPlan(task, prepared.bundle, prepared.text, prepared.alreadyPrepared);
    });
    const base: TaskbookArchiveResult = {
      ok: true,
      workspaceId: options.workspaceId,
      apply,
      keepTerminal,
      maxTasks,
      terminalCount: terminal.length,
      unfinished,
      reconcileTaskIds: remnants.map((item) => item.taskId).sort(),
      selected,
      archivedTaskIds: [],
      reconciledTaskIds: [],
      compaction: null,
    };
    if (!apply) return base;
    if (unfinished.length > 0) {
      return { ...base, ok: false, blockedReason: "UNFINISHED_CLAIMS" };
    }

    try {
      for (const remnant of remnants) {
        for (const markerRef of remnant.bundle.authorizations) {
          const marker = markerFile(io, paths, options.workspaceId, markerRef.authorizationSha256);
          if (!marker) fail("ARCHIVE_AUTHORIZATION_MARKER_MISSING");
          verifyMarkerBundle(io, paths, options.workspaceId, marker.marker);
        }
        const currentFiles = verifyActiveRemnants(io, paths, remnant.bundle);
        for (const file of currentFiles) {
          const baseName = path.basename(file);
          const expected = baseName === taskbookFileName(remnant.taskId)
            ? remnant.bundle.sourceDigests.envelope
            : baseName === taskbookClaimFileName(remnant.taskId)
              ? remnant.bundle.sourceDigests.claim
              : remnant.bundle.sourceDigests.result;
          if (readStableFile(io, paths, file, MAX_ENVELOPE_BYTES, "ARCHIVE_ACTIVE_REMNANT").sha256 !== expected) fail("STATE_CONFLICT");
          io.unlink(file);
        }
        base.reconciledTaskIds.push(remnant.taskId);
      }
      inventory = inventoryTaskbookState(io, paths.workspaceTaskRoot);
      if (inventory.unfinishedClaims.length > 0) return { ...base, ok: false, blockedReason: "UNFINISHED_CLAIMS" };
      for (const task of selectedTasks) {
        archiveOne(io, paths, options.workspaceId, stateDir, task);
        base.archivedTaskIds.push(task.taskId);
      }
    } catch (error) {
      const detail = error instanceof TaskbookError ? error.detail ?? error.code : "ARCHIVE_MUTATION_FAILED";
      base.ok = false;
      base.blockedTaskId = selectedTasks[base.archivedTaskIds.length]?.taskId;
      base.blockedReason = detail;
    }

    try {
      const bundles = allVerifiedArchiveBundles(io, paths, options.workspaceId);
      const lineHashes = bundles.flatMap((bundle) => bundle.executionRecords.map((item) => item.lineSha256));
      if (lineHashes.length > 0) {
        const compacted = compactArchivedExecutionRecordLines(options.workspaceId, lineHashes, stateDir);
        base.compaction = compacted;
        if (!compacted.ok) base.ok = false;
      } else if (base.archivedTaskIds.length > 0 || base.reconciledTaskIds.length > 0) {
        base.compaction = { ok: true, removed: 0, retained: 0 };
      }
    } catch {
      base.compaction = { ok: false, removed: 0, retained: 0, reason: "ARCHIVE_COMPACTION_PREPARATION_FAILED" };
      base.ok = false;
    }
    return base;
  };
  return apply ? runLocked(io, paths, operation) : operation();
}

export function archiveTaskbooks(options: TaskbookArchiveOptions): TaskbookArchiveResult {
  return executeArchive(options);
}
