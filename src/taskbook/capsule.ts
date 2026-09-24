import { createHash } from "node:crypto";
import path from "node:path";
import {
  parseResultRecord,
  type AnyTaskbookResultRecord,
  type TaskbookTerminalStatus,
} from "./lifecycle-records.js";
import { createNewFileExclusive } from "./create.js";
import { TaskbookError, errnoCodeOf } from "./errors.js";
import { lstatOrNull, lstatStrict, readTextStrict, realpathStrict } from "./fsutil.js";
import type { TaskbookIo } from "./io.js";
import { ensureContainedDir, isInsideRoot, type TaskbookPaths } from "./paths.js";
import { executionRecordSchema, type ExecutionRecord } from "../execution/records.js";
import type { ExecutionOutputMeta, ExecutionOutputSnapshot } from "../execution/output.js";

export const TASKBOOK_CAPSULE_ROOT_NAME = "taskbook-terminal-evidence";
export const MAX_TASKBOOK_CAPSULE_BYTES = 128 * 1024;

export type CapsuleTerminalOrigin = "finish" | "recovery-closeout" | "recovery-abandon";
export type CapsuleEvidenceClassification = "finish" | "complete" | "none" | "incomplete" | "ambiguous";

export interface TaskbookCapsuleEvidence {
  classification: CapsuleEvidenceClassification;
  recordSnapshot: "read-back" | "none" | "incomplete" | "not-provided";
  records: ExecutionRecord[];
  outputs: ExecutionOutputSnapshot[];
  reason: string | null;
}

export interface TaskbookTerminalEvidenceCapsule {
  version: 1;
  workspaceId: string;
  taskId: string;
  bodySha256: string;
  claimId: string;
  status: TaskbookTerminalStatus;
  terminalOrigin: CapsuleTerminalOrigin;
  terminalReason: string | null;
  result: AnyTaskbookResultRecord;
  executionIteration: number | null;
  executionTimestamp: string | null;
  executionStatus: string | null;
  outputId: number | null;
  evidence: TaskbookCapsuleEvidence;
}

function failConflict(detail: string): never {
  throw new TaskbookError("STORAGE_ERROR", undefined, detail);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function existingWorkspaceDir(io: TaskbookIo, paths: TaskbookPaths, workspaceId: string): string | null {
  let current = paths.stateRoot;
  for (const segment of [TASKBOOK_CAPSULE_ROOT_NAME, workspaceId]) {
    current = path.join(current, segment);
    const stats = lstatOrNull(io, current);
    if (!stats) return null;
    if (stats.isSymbolicLink() || !stats.isDirectory()) failConflict("CAPSULE_DIRECTORY_INVALID");
    const real = realpathStrict(io, current);
    if (!isInsideRoot(paths.stateRoot, real)) failConflict("CAPSULE_CONTAINMENT");
    current = real;
  }
  return current;
}

export function serializeTaskbookTerminalEvidenceCapsule(capsule: TaskbookTerminalEvidenceCapsule): string {
  return JSON.stringify({
    version: capsule.version,
    workspaceId: capsule.workspaceId,
    taskId: capsule.taskId,
    bodySha256: capsule.bodySha256,
    claimId: capsule.claimId,
    status: capsule.status,
    terminalOrigin: capsule.terminalOrigin,
    terminalReason: capsule.terminalReason,
    result: capsule.result,
    executionIteration: capsule.executionIteration,
    executionTimestamp: capsule.executionTimestamp,
    executionStatus: capsule.executionStatus,
    outputId: capsule.outputId,
    evidence: capsule.evidence,
  });
}

export function taskbookTerminalEvidenceCapsuleSha256(capsule: TaskbookTerminalEvidenceCapsule): string {
  return sha256(serializeTaskbookTerminalEvidenceCapsule(capsule));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOutputMeta(value: unknown): ExecutionOutputMeta {
  if (!isRecord(value)) failConflict("CAPSULE_OUTPUT_INVALID");
  if (
    !Number.isSafeInteger(value.id) || (value.id as number) <= 0 ||
    typeof value.command !== "string" || Buffer.byteLength(value.command, "utf8") > 200 ||
    (value.exitCode !== null && (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode))) ||
    typeof value.timestamp !== "string" ||
    (value.taskId !== undefined && typeof value.taskId !== "string") ||
    (value.iteration !== undefined && (!Number.isSafeInteger(value.iteration) || (value.iteration as number) < 0)) ||
    typeof value.allowed !== "boolean" ||
    (value.restrictedReason !== undefined && typeof value.restrictedReason !== "string") ||
    typeof value.truncated !== "boolean" ||
    !Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 0 ||
    (value.allowed === false && value.sizeBytes !== 0) ||
    (value.allowed === true && value.restrictedReason !== undefined)
  ) failConflict("CAPSULE_OUTPUT_INVALID");
  return {
    id: value.id as number,
    command: value.command,
    exitCode: value.exitCode as number | null,
    timestamp: value.timestamp,
    taskId: value.taskId as string | undefined,
    iteration: value.iteration as number | undefined,
    allowed: value.allowed,
    restrictedReason: value.restrictedReason as string | undefined,
    truncated: value.truncated,
    sizeBytes: value.sizeBytes as number,
  };
}

function parseOutputSnapshot(value: unknown): ExecutionOutputSnapshot {
  if (!isRecord(value) || typeof value.state !== "string") failConflict("CAPSULE_OUTPUT_INVALID");
  if (value.state === "readable" || value.state === "restricted") {
    const meta = parseOutputMeta(value.meta);
    if (value.state === "readable") {
      if (
        meta.allowed !== true || typeof value.text !== "string" || typeof value.textSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.textSha256) || sha256(value.text) !== value.textSha256 ||
        meta.sizeBytes !== Buffer.byteLength(value.text, "utf8")
      ) failConflict("CAPSULE_OUTPUT_INVALID");
      return { state: "readable", meta, text: value.text, textSha256: value.textSha256 };
    }
    if (meta.allowed !== false) failConflict("CAPSULE_OUTPUT_INVALID");
    return { state: "restricted", meta };
  }
  if (value.state === "not-retained") {
    if (!Number.isSafeInteger(value.outputId) || (value.outputId as number) <= 0) failConflict("CAPSULE_OUTPUT_INVALID");
    return { state: "not-retained", outputId: value.outputId as number };
  }
  if (value.state === "unavailable") {
    if (
      !Number.isSafeInteger(value.outputId) || (value.outputId as number) <= 0 || typeof value.reason !== "string" ||
      (value.meta !== undefined && !isRecord(value.meta))
    ) failConflict("CAPSULE_OUTPUT_INVALID");
    return {
      state: "unavailable",
      outputId: value.outputId as number,
      meta: value.meta === undefined ? undefined : parseOutputMeta(value.meta),
      reason: value.reason,
    };
  }
  failConflict("CAPSULE_OUTPUT_INVALID");
}

function recordMatchesCapsuleClaim(record: ExecutionRecord, capsule: Pick<TaskbookTerminalEvidenceCapsule, "bodySha256" | "claimId">): boolean {
  const markers = record.notes?.split(" | ").map((part) => part.trim()).filter((part) => part.startsWith("taskbook-evidence-v1:")) ?? [];
  if (markers.length !== 1) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(markers[0]!.slice("taskbook-evidence-v1:".length)); } catch { return false; }
  if (!isRecord(parsed)) return false;
  const keys = ["bodySha256", "claimId", "authorizationId"];
  return (
    Object.keys(parsed).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(parsed, key)) &&
    parsed.bodySha256 === capsule.bodySha256 && parsed.claimId === capsule.claimId &&
    typeof parsed.authorizationId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed.authorizationId)
  );
}

export function parseTaskbookTerminalEvidenceCapsule(text: string): TaskbookTerminalEvidenceCapsule {
  if (Buffer.byteLength(text, "utf8") > MAX_TASKBOOK_CAPSULE_BYTES) failConflict("CAPSULE_TOO_LARGE");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { failConflict("CAPSULE_MALFORMED"); }
  if (!isRecord(raw)) failConflict("CAPSULE_MALFORMED");
  const keys = [
    "version", "workspaceId", "taskId", "bodySha256", "claimId", "status", "terminalOrigin", "terminalReason",
    "result", "executionIteration", "executionTimestamp", "executionStatus", "outputId", "evidence",
  ];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(raw, key))) {
    failConflict("CAPSULE_FIELDS");
  }
  if (
    raw.version !== 1 ||
    typeof raw.workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.workspaceId) ||
    typeof raw.taskId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw.taskId) ||
    typeof raw.bodySha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.bodySha256) ||
    typeof raw.claimId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw.claimId) ||
    (raw.status !== "succeeded" && raw.status !== "failed" && raw.status !== "blocked") ||
    (raw.terminalOrigin !== "finish" && raw.terminalOrigin !== "recovery-closeout" && raw.terminalOrigin !== "recovery-abandon") ||
    (raw.terminalReason !== null && typeof raw.terminalReason !== "string") ||
    (raw.executionIteration !== null && (!Number.isSafeInteger(raw.executionIteration) || (raw.executionIteration as number) < 0)) ||
    (raw.executionTimestamp !== null && typeof raw.executionTimestamp !== "string") ||
    (raw.executionStatus !== null && typeof raw.executionStatus !== "string") ||
    (raw.outputId !== null && (!Number.isSafeInteger(raw.outputId) || (raw.outputId as number) <= 0)) ||
    !isRecord(raw.evidence)
  ) failConflict("CAPSULE_FIELDS");

  let result: AnyTaskbookResultRecord;
  try { result = parseResultRecord(JSON.stringify(raw.result)); } catch { failConflict("CAPSULE_RESULT_INVALID"); }
  if (
    result.taskId !== raw.taskId || result.bodySha256 !== raw.bodySha256 || result.claimId !== raw.claimId ||
    result.status !== raw.status || result.outputId !== raw.outputId
  ) failConflict("CAPSULE_RESULT_MISMATCH");

  const evidence = raw.evidence;
  const evidenceKeys = ["classification", "recordSnapshot", "records", "outputs", "reason"];
  if (
    Object.keys(evidence).length !== evidenceKeys.length || evidenceKeys.some((key) => !Object.prototype.hasOwnProperty.call(evidence, key)) ||
    !["finish", "complete", "none", "incomplete", "ambiguous"].includes(String(evidence.classification)) ||
    !["read-back", "none", "incomplete", "not-provided"].includes(String(evidence.recordSnapshot)) ||
    !Array.isArray(evidence.records) || !Array.isArray(evidence.outputs) ||
    (evidence.reason !== null && typeof evidence.reason !== "string")
  ) failConflict("CAPSULE_EVIDENCE_INVALID");
  const records: ExecutionRecord[] = [];
  for (const candidate of evidence.records) {
    const checked = executionRecordSchema.safeParse(candidate);
    if (!checked.success) failConflict("CAPSULE_RECORD_INVALID");
    if (checked.data.taskId !== raw.taskId) failConflict("CAPSULE_RECORD_IDENTITY_MISMATCH");
    records.push(checked.data);
  }
  const outputs = evidence.outputs.map(parseOutputSnapshot);

  const capsule: TaskbookTerminalEvidenceCapsule = {
    version: 1,
    workspaceId: raw.workspaceId,
    taskId: raw.taskId,
    bodySha256: raw.bodySha256,
    claimId: raw.claimId,
    status: raw.status,
    terminalOrigin: raw.terminalOrigin,
    terminalReason: raw.terminalReason as string | null,
    result,
    executionIteration: raw.executionIteration as number | null,
    executionTimestamp: raw.executionTimestamp as string | null,
    executionStatus: raw.executionStatus as string | null,
    outputId: raw.outputId as number | null,
    evidence: {
      classification: evidence.classification as CapsuleEvidenceClassification,
      recordSnapshot: evidence.recordSnapshot as TaskbookCapsuleEvidence["recordSnapshot"],
      records,
      outputs,
      reason: evidence.reason as string | null,
    },
  };
  if (capsule.executionTimestamp !== capsule.result.executionTimestamp) {
    failConflict("CAPSULE_EXECUTION_TIMESTAMP_MISMATCH");
  }
  if (capsule.result.outputId !== capsule.outputId) failConflict("CAPSULE_OUTPUT_ID_MISMATCH");
  if (capsule.result.version === 1) {
    if (
      capsule.terminalOrigin !== "finish" || capsule.terminalReason !== capsule.evidence.reason ||
      capsule.evidence.classification !== "finish" || capsule.executionIteration !== 1 ||
      (capsule.evidence.recordSnapshot !== "read-back" && capsule.evidence.recordSnapshot !== "not-provided") ||
      (capsule.evidence.recordSnapshot === "read-back" && capsule.evidence.records.length !== 1) ||
      (capsule.evidence.recordSnapshot === "not-provided" && (capsule.evidence.records.length !== 0 || capsule.executionStatus !== null)) ||
      (capsule.outputId === null && capsule.evidence.outputs.length !== 0) ||
      (capsule.outputId !== null && capsule.evidence.outputs.length > 1) ||
      (capsule.evidence.outputs.length === 1 &&
        (capsule.evidence.outputs[0]?.state !== "readable" || capsule.evidence.outputs[0].meta.id !== capsule.outputId))
    ) failConflict("CAPSULE_FINISH_RELATION_INVALID");
    if (capsule.evidence.recordSnapshot === "read-back") {
      const record = capsule.evidence.records[0]!;
      if (
        record.iteration !== 1 || record.timestamp !== capsule.executionTimestamp ||
        (capsule.outputId === null ? record.outputId !== undefined : record.outputId !== capsule.outputId) ||
        record.exitStatus !== capsule.executionStatus || !recordMatchesCapsuleClaim(record, capsule)
      ) failConflict("CAPSULE_FINISH_RECORD_MISMATCH");
    }
  } else {
    if (
      capsule.terminalOrigin !== capsule.result.terminalOrigin || capsule.terminalReason !== capsule.result.reasonCode ||
      (capsule.result.terminalOrigin === "recovery-closeout"
        ? capsule.evidence.classification !== "complete" || capsule.executionIteration !== 1
        : (capsule.evidence.classification !== "none" && capsule.evidence.classification !== "incomplete" && capsule.evidence.classification !== "ambiguous") || capsule.executionIteration !== null || capsule.executionTimestamp !== null || capsule.executionStatus !== null)
    ) failConflict("CAPSULE_RECOVERY_RELATION_INVALID");
    if (capsule.result.terminalOrigin === "recovery-closeout") {
      const linkedRecords = capsule.evidence.records.filter((record) =>
        record.iteration === 1 && record.timestamp === capsule.executionTimestamp &&
        (capsule.outputId === null ? record.outputId === undefined : record.outputId === capsule.outputId) &&
        recordMatchesCapsuleClaim(record, capsule)
      );
      if (linkedRecords.length !== 1 || linkedRecords[0]?.exitStatus !== capsule.executionStatus) {
        failConflict("CAPSULE_RECOVERY_RECORD_MISMATCH");
      }
    }
  }
  if (serializeTaskbookTerminalEvidenceCapsule(capsule) !== text) failConflict("CAPSULE_NON_CANONICAL");
  return capsule;
}

export function readTaskbookTerminalEvidenceCapsule(
  io: TaskbookIo,
  paths: TaskbookPaths,
  workspaceId: string,
  taskId: string
): { capsule: TaskbookTerminalEvidenceCapsule; text: string } | null {
  const directory = existingWorkspaceDir(io, paths, workspaceId);
  if (!directory) return null;
  const file = path.join(directory, `${taskId}.json`);
  const stat = lstatOrNull(io, file);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TASKBOOK_CAPSULE_BYTES) failConflict("CAPSULE_FILE_INVALID");
  const real = realpathStrict(io, file);
  if (!isInsideRoot(paths.stateRoot, real)) failConflict("CAPSULE_CONTAINMENT");
  const text = readTextStrict(io, file);
  if (Buffer.byteLength(text, "utf8") !== stat.size) failConflict("CAPSULE_CHANGED_DURING_READ");
  const capsule = parseTaskbookTerminalEvidenceCapsule(text);
  if (capsule.workspaceId !== workspaceId || capsule.taskId !== taskId) failConflict("CAPSULE_IDENTITY_MISMATCH");
  return { capsule, text };
}

function sameResultExceptFinishedAt(left: AnyTaskbookResultRecord, right: AnyTaskbookResultRecord): boolean {
  const { finishedAt: _leftFinishedAt, ...leftCore } = left;
  const { finishedAt: _rightFinishedAt, ...rightCore } = right;
  return JSON.stringify(leftCore) === JSON.stringify(rightCore);
}

/**
 * Persist a capsule before its terminal result. A previously finalized capsule
 * can be reused only for the exact same attempt; its original finishedAt is
 * carried into the result sidecar on retry.
 */
export function persistTaskbookTerminalEvidenceCapsule(
  io: TaskbookIo,
  paths: TaskbookPaths,
  attempted: TaskbookTerminalEvidenceCapsule
): { capsule: TaskbookTerminalEvidenceCapsule; result: AnyTaskbookResultRecord; capsuleSha256: string } {
  const attemptedText = serializeTaskbookTerminalEvidenceCapsule(attempted);
  if (Buffer.byteLength(attemptedText, "utf8") > MAX_TASKBOOK_CAPSULE_BYTES) {
    throw new TaskbookError("LIMIT_EXCEEDED", undefined, "CAPSULE_TOO_LARGE");
  }
  const validatedAttempt = parseTaskbookTerminalEvidenceCapsule(attemptedText);
  const existing = readTaskbookTerminalEvidenceCapsule(io, paths, attempted.workspaceId, attempted.taskId);
  let capsule = validatedAttempt;
  if (existing) {
    if (!sameResultExceptFinishedAt(existing.capsule.result, validatedAttempt.result)) failConflict("STATE_CONFLICT");
    const expected = { ...validatedAttempt, result: existing.capsule.result };
    if (serializeTaskbookTerminalEvidenceCapsule(existing.capsule) !== serializeTaskbookTerminalEvidenceCapsule(expected)) failConflict("STATE_CONFLICT");
    capsule = existing.capsule;
  } else {
    const directory = ensureContainedDir(io, paths.stateRoot, [TASKBOOK_CAPSULE_ROOT_NAME, attempted.workspaceId]);
    const file = path.join(directory, `${attempted.taskId}.json`);
    const temp = path.join(directory, `${attempted.taskId}.tmp`);
    const finalStat = lstatOrNull(io, file);
    if (finalStat) failConflict("STATE_CONFLICT");
    const tempStat = lstatOrNull(io, temp);
    if (tempStat) {
      if (tempStat.isSymbolicLink() || !tempStat.isFile()) failConflict("CAPSULE_TEMP_INVALID");
      const tempReal = realpathStrict(io, temp);
      if (!isInsideRoot(paths.stateRoot, tempReal)) failConflict("CAPSULE_CONTAINMENT");
      try { io.unlink(temp); } catch (error) { throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "CAPSULE_TEMP_REMOVE_FAILED"); }
    }
    if (!createNewFileExclusive(io, temp, attemptedText)) failConflict("CAPSULE_TEMP_EXISTS");
    try {
      io.rename(temp, file);
    } catch (error) {
      throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "CAPSULE_FINALIZE_FAILED");
    }
    const stored = readTaskbookTerminalEvidenceCapsule(io, paths, attempted.workspaceId, attempted.taskId);
    if (!stored || stored.text !== attemptedText) failConflict("CAPSULE_READBACK_MISMATCH");
    capsule = stored.capsule;
  }
  const text = serializeTaskbookTerminalEvidenceCapsule(capsule);
  return { capsule, result: capsule.result, capsuleSha256: sha256(text) };
}
