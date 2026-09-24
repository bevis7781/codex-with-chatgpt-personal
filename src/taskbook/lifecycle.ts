import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  MAX_INVENTORY_ENTRIES,
  MAX_LIFECYCLE_BYTES,
  MAX_PENDING,
  MAX_TOTAL_STORAGE_BYTES,
  TASKBOOK_STATUS_PENDING,
} from "./constants.js";
import {
  bodySha256,
  isCanonicalTaskId,
  isCanonicalUtcTimestamp,
  taskbookClaimFileName,
  taskbookResultFileName,
} from "./envelope.js";
import { TaskbookError } from "./errors.js";
import {
  inventoryTaskbookState,
  type DetailedTaskbookInventory,
  type TaskbookLifecycleTask,
} from "./inventory.js";
import { createNewFileExclusive } from "./create.js";
import { nodeTaskbookIo, type TaskbookIo } from "./io.js";
import { acquireTaskbookLock, releaseTaskbookLock } from "./lock.js";
import { resolveTaskbookPaths, type TaskbookPaths } from "./paths.js";
import {
  MAX_CLAIM_HARNESS_BYTES,
  parseClaimRecord,
  serializeClaimRecord,
  serializeResultRecord,
  type AnyTaskbookResultRecord,
  type TaskbookRecoveryResultRecord,
  type RecoveryReasonCode,
  type TaskbookClaimRecord,
  type TaskbookResultRecord,
  type TaskbookTerminalStatus,
} from "./lifecycle-records.js";
import {
  boundCapabilitySupportsResultVersion,
  type BoundTaskbookLifecycleCapability,
} from "./lifecycle-capability.js";

export interface TaskbookLocalContext {
  /** Locally derived workspace identity; never supplied by remote Taskbook text. */
  workspaceId: string;
  /** Canonical project root bound to the current Harness. */
  projectRoot: string;
  /** Test seam; production resolves the normal C2C state root. */
  stateDir?: string;
  /** Narrow filesystem seam used by fault-injection tests. */
  io?: TaskbookIo;
}

export interface TaskbookInspectOptions extends TaskbookLocalContext {
  /** Optional exact task to display; it does not reserve or claim anything. */
  taskId?: string;
}

export interface TaskbookReadItem {
  taskId: string;
  createdAt: string;
  title: string;
  body: string;
  bodySha256: string;
  status: typeof TASKBOOK_STATUS_PENDING | "claimed" | TaskbookTerminalStatus;
  claimId: string | null;
  result: AnyTaskbookResultRecord | null;
}

export interface TaskbookInspectResult {
  workspaceId: string;
  pending: TaskbookReadItem[];
  all: TaskbookReadItem[];
  unfinished: Array<{ taskId: string; claimId: string; harness: string }>;
}

export interface TaskbookClaimInput extends TaskbookLocalContext {
  taskId: string;
  bodySha256: string;
  authorizationId: string;
  harness: string;
  /** Timestamp captured by the Harness before any claim attempt. */
  authorizedAt?: string;
}

export interface TaskbookClaimedTask {
  taskId: string;
  title: string;
  body: string;
  bodySha256: string;
  claim: TaskbookClaimRecord;
}

export interface TaskbookExecutionEvidence {
  taskId: string;
  bodySha256: string;
  claimId: string;
  authorizationId: string;
  iteration: number;
  executionTimestamp: string;
  outputId: number | null;
  /** True only after the Harness read back a valid execution record. */
  recorded: boolean;
  /** True when a corresponding output record was written and read back. */
  outputRecorded: boolean;
  /** True when the existing sanitizer permits the output to be read. */
  outputAvailable: boolean;
  /** Read back from the output record when outputId is non-null. */
  exitCode: number | null;
  /** Required reason when a failed/blocked result has no output. */
  reason?: string;
}

export interface TaskbookEvidenceNote {
  bodySha256: string;
  claimId: string;
  authorizationId: string;
}

/** Bounded machine-readable linkage carried in an existing execution record note. */
export const TASKBOOK_EVIDENCE_NOTE_PREFIX = "taskbook-evidence-v1:";

export function encodeTaskbookEvidenceNote(note: TaskbookEvidenceNote): string {
  validateBodyHash(note.bodySha256, "BODY_HASH");
  validateUuid(note.claimId, "CLAIM_ID");
  validateUuid(note.authorizationId, "AUTHORIZATION_ID");
  return `${TASKBOOK_EVIDENCE_NOTE_PREFIX}${JSON.stringify({
    bodySha256: note.bodySha256,
    claimId: note.claimId,
    authorizationId: note.authorizationId,
  })}`;
}

export function decodeTaskbookEvidenceNote(value: string | undefined): TaskbookEvidenceNote | null {
  if (typeof value !== "string") return null;
  const marker = value
    .split(" | ")
    .map((part) => part.trim())
    .find((part) => part.startsWith(TASKBOOK_EVIDENCE_NOTE_PREFIX));
  if (!marker) return null;
  try {
    const parsed = JSON.parse(marker.slice(TASKBOOK_EVIDENCE_NOTE_PREFIX.length)) as Partial<TaskbookEvidenceNote>;
    if (
      typeof parsed.bodySha256 !== "string" ||
      typeof parsed.claimId !== "string" ||
      typeof parsed.authorizationId !== "string"
    ) {
      return null;
    }
    validateBodyHash(parsed.bodySha256, "BODY_HASH");
    validateUuid(parsed.claimId, "CLAIM_ID");
    validateUuid(parsed.authorizationId, "AUTHORIZATION_ID");
    return {
      bodySha256: parsed.bodySha256,
      claimId: parsed.claimId,
      authorizationId: parsed.authorizationId,
    };
  } catch {
    return null;
  }
}

export interface TaskbookFinishInput extends TaskbookLocalContext {
  taskId: string;
  claimId: string;
  authorizationId: string;
  bodySha256: string;
  status: TaskbookTerminalStatus;
  executionTimestamp: string;
  outputId: number | null;
  evidence: TaskbookExecutionEvidence;
}

export interface TaskbookLinkedRecordInput extends TaskbookLocalContext {
  taskId: string;
  bodySha256: string;
  claimId: string;
  authorizationId: string;
}

export type TaskbookRecoveryEvidence =
  | { classification: "complete"; status: TaskbookTerminalStatus; executionTimestamp: string; outputId: number | null }
  | { classification: "none" }
  | { classification: "incomplete" }
  | { classification: "ambiguous" };

export interface TaskbookRecoverInput extends TaskbookLocalContext {
  recoveryAuthorizationId: string;
}

export type TaskbookLifecycleCapabilityReader = (expectedBinding: {
  workspaceId: string;
  workspaceRoot: string;
  stateRoot: string;
}) => Promise<BoundTaskbookLifecycleCapability | null>;

export type TaskbookRecoverOutcome =
  | { outcome: "no-target" }
  | { outcome: "recovered"; result: TaskbookRecoveryResultRecord };

export function newTaskbookAuthorizationId(): string {
  return randomUUID();
}

/** Exact standalone command parser for a caller already in Personal Taskbook context. */
export function parseTaskbookCommand(
  value: unknown,
  options: { personalTaskbookContext?: boolean } = {}
): "Do" | "Read" | "Recover" | null {
  if (options.personalTaskbookContext === false || typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "do") return "Do";
  if (normalized === "read") return "Read";
  if (normalized === "recover") return "Recover";
  return null;
}

function contextIo(context: TaskbookLocalContext): TaskbookIo {
  return context.io ?? nodeTaskbookIo;
}

function pathsFor(context: TaskbookLocalContext, io: TaskbookIo): TaskbookPaths {
  return resolveTaskbookPaths({
    workspaceId: context.workspaceId,
    projectRoot: context.projectRoot,
    stateDir: context.stateDir,
    io,
  });
}

function runLocked<T>(io: TaskbookIo, paths: TaskbookPaths, operation: () => T): T {
  try {
    acquireTaskbookLock(io, paths.lockPath);
  } catch (error) {
    if (error instanceof TaskbookError && error.detail === "LOCK_HELD") {
      throw new TaskbookError("BUSY", undefined, "LOCK_HELD");
    }
    throw error;
  }
  let result: T | undefined;
  let failure: unknown;
  try {
    result = operation();
  } catch (error) {
    failure = error;
  }
  try {
    releaseTaskbookLock(io, paths.lockPath);
  } catch {
    // A successful mutation remains the durable evidence. Leaving the lock in
    // place forces later local investigation; no stale lock is removed here.
  }
  if (failure !== undefined) throw failure;
  return result as T;
}

async function runLockedAsync<T>(io: TaskbookIo, paths: TaskbookPaths, operation: () => Promise<T>): Promise<T> {
  try {
    acquireTaskbookLock(io, paths.lockPath);
  } catch (error) {
    if (error instanceof TaskbookError && error.detail === "LOCK_HELD") {
      throw new TaskbookError("BUSY", undefined, "LOCK_HELD");
    }
    throw error;
  }
  let result: T | undefined;
  let failure: unknown;
  try {
    result = await operation();
  } catch (error) {
    failure = error;
  }
  try {
    releaseTaskbookLock(io, paths.lockPath);
  } catch {
    // A successful mutation remains the durable evidence. Leaving the lock in
    // place forces later local investigation; no stale lock is removed here.
  }
  if (failure !== undefined) throw failure;
  return result as T;
}

function rejectCorruptState(inventory: DetailedTaskbookInventory): void {
  if (inventory.invalidTaskIds.length > 0) {
    throw new TaskbookError("STORAGE_ERROR", undefined, "CORRUPT_TASK_STATE");
  }
  if (inventory.unfinishedClaims.length > 1) {
    throw new TaskbookError("UNFINISHED_TASK", undefined, "MULTIPLE_UNFINISHED_CLAIMS");
  }
}

function compareTasks(a: TaskbookLifecycleTask, b: TaskbookLifecycleTask): number {
  const byTime = a.envelope.createdAt.localeCompare(b.envelope.createdAt);
  return byTime !== 0 ? byTime : a.taskId.localeCompare(b.taskId);
}

function readItem(task: TaskbookLifecycleTask): TaskbookReadItem {
  const status = task.result?.status ?? (task.claim ? "claimed" : TASKBOOK_STATUS_PENDING);
  return {
    taskId: task.taskId,
    createdAt: task.envelope.createdAt,
    title: task.envelope.title,
    body: task.envelope.body,
    bodySha256: task.bodySha256,
    status,
    claimId: task.claim?.claimId ?? null,
    result: task.result,
  };
}

function validateUuid(value: string, detail: string): void {
  if (!isCanonicalTaskId(value)) throw new TaskbookError("INVALID_INPUT", undefined, detail);
}

function validateBodyHash(value: string, detail: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TaskbookError("INVALID_INPUT", undefined, detail);
}

function validateClaimInput(input: TaskbookClaimInput): string {
  validateUuid(input.taskId, "TASK_ID");
  validateUuid(input.authorizationId, "AUTHORIZATION_ID");
  validateBodyHash(input.bodySha256, "BODY_HASH");
  if (
    typeof input.harness !== "string" ||
    input.harness.trim() === "" ||
    Buffer.byteLength(input.harness, "utf8") > MAX_CLAIM_HARNESS_BYTES
  ) {
    throw new TaskbookError("INVALID_INPUT", undefined, "HARNESS");
  }
  const authorizedAt = input.authorizedAt ?? new Date().toISOString();
  if (!isCanonicalUtcTimestamp(authorizedAt)) throw new TaskbookError("INVALID_INPUT", undefined, "AUTHORIZED_AT");
  return authorizedAt;
}

function validateFinishInput(input: TaskbookFinishInput): void {
  validateUuid(input.taskId, "TASK_ID");
  validateUuid(input.claimId, "CLAIM_ID");
  validateUuid(input.authorizationId, "AUTHORIZATION_ID");
  validateBodyHash(input.bodySha256, "BODY_HASH");
  if (input.status !== "succeeded" && input.status !== "failed" && input.status !== "blocked") {
    throw new TaskbookError("INVALID_INPUT", undefined, "STATUS");
  }
  if (!isCanonicalUtcTimestamp(input.executionTimestamp)) {
    throw new TaskbookError("INVALID_INPUT", undefined, "EXECUTION_TIMESTAMP");
  }
  if (
    input.outputId !== null &&
    (!Number.isSafeInteger(input.outputId) || input.outputId <= 0)
  ) {
    throw new TaskbookError("INVALID_INPUT", undefined, "OUTPUT_ID");
  }
}

function validateEvidence(input: TaskbookFinishInput): void {
  const evidence = input.evidence;
  if (!evidence || evidence.recorded !== true) throw new TaskbookError("EVIDENCE_INVALID", undefined, "NOT_RECORDED");
  if (
    evidence.taskId !== input.taskId ||
    evidence.bodySha256 !== input.bodySha256 ||
    evidence.claimId !== input.claimId ||
    evidence.authorizationId !== input.authorizationId ||
    evidence.iteration !== 1 ||
    evidence.executionTimestamp !== input.executionTimestamp ||
    evidence.outputId !== input.outputId
  ) {
    throw new TaskbookError("EVIDENCE_INVALID", undefined, "IDENTITY_MISMATCH");
  }
  if (input.status === "succeeded") {
    if (
      input.outputId === null ||
      evidence.outputRecorded !== true ||
      evidence.outputAvailable !== true ||
      evidence.exitCode !== 0
    ) {
      throw new TaskbookError("EVIDENCE_INVALID", undefined, "SUCCESS_OUTPUT_REQUIRED");
    }
  } else if (input.outputId === null) {
    if (evidence.outputRecorded || typeof evidence.reason !== "string" || evidence.reason.trim() === "") {
      throw new TaskbookError("EVIDENCE_INVALID", undefined, "TERMINAL_REASON_REQUIRED");
    }
  } else if (!evidence.outputRecorded) {
    throw new TaskbookError("EVIDENCE_INVALID", undefined, "OUTPUT_NOT_RECORDED");
  }
}

function checkCapacity(inventory: DetailedTaskbookInventory, additionalBytes: number, additionalEntries = 1): void {
  if (inventory.entries + additionalEntries > MAX_INVENTORY_ENTRIES) {
    throw new TaskbookError("LIMIT_EXCEEDED", undefined, "ENTRY_CAP");
  }
  if (inventory.storageBytes + additionalBytes > MAX_TOTAL_STORAGE_BYTES) {
    throw new TaskbookError("LIMIT_EXCEEDED", undefined, "STORAGE_CAP");
  }
}

/** Read-only local view. It acquires the same lock for a complete snapshot but never reserves a task. */
export function inspectTaskbooks(options: TaskbookInspectOptions): TaskbookInspectResult {
  const io = contextIo(options);
  const paths = pathsFor(options, io);
  return runLocked(io, paths, () => {
    const inventory = inventoryTaskbookState(io, paths.workspaceTaskRoot);
    rejectCorruptState(inventory);
    const sorted = [...inventory.tasks].sort(compareTasks);
    if (options.taskId !== undefined) {
      validateUuid(options.taskId, "TASK_ID");
      if (!sorted.some((task) => task.taskId === options.taskId)) {
        throw new TaskbookError("TASK_NOT_FOUND", undefined, "TASK_ID");
      }
    }
    const visible = options.taskId ? sorted.filter((task) => task.taskId === options.taskId) : sorted;
    return {
      workspaceId: options.workspaceId,
      pending: visible.filter((task) => task.claim === null).map(readItem),
      all: visible.map(readItem),
      unfinished: inventory.unfinishedClaims.map((task) => ({
        taskId: task.taskId,
        claimId: task.claim?.claimId ?? "",
        harness: task.claim?.harness ?? "",
      })),
    };
  });
}

/** Atomically bind one pending envelope to one locally-created Do authorization. */
export function claimTaskbook(input: TaskbookClaimInput): TaskbookClaimedTask {
  const authorizedAt = validateClaimInput(input);
  const io = contextIo(input);
  const paths = pathsFor(input, io);
  return runLocked(io, paths, () => {
    const inventory = inventoryTaskbookState(io, paths.workspaceTaskRoot);
    rejectCorruptState(inventory);
    if (inventory.unfinishedClaims.length > 0) {
      throw new TaskbookError("UNFINISHED_TASK", undefined, "CLAIM_EXISTS");
    }
    if (inventory.authorizationIds.has(input.authorizationId)) {
      throw new TaskbookError("AUTHORIZATION_REUSED", undefined, "AUTHORIZATION_ID");
    }
    if (inventory.pending > MAX_PENDING) {
      throw new TaskbookError("LIMIT_EXCEEDED", undefined, "PENDING_CAP");
    }
    const pending = inventory.tasks.filter((task) => task.claim === null).sort(compareTasks);
    const selected = pending[0];
    if (!selected) throw new TaskbookError("TASK_NOT_ELIGIBLE", undefined, "EMPTY_QUEUE");
    if (selected.taskId !== input.taskId) throw new TaskbookError("TASK_NOT_ELIGIBLE", undefined, "NOT_NEXT");
    if (selected.bodySha256 !== input.bodySha256) throw new TaskbookError("TASK_NOT_ELIGIBLE", undefined, "BODY_CHANGED");

    const claim: TaskbookClaimRecord = {
      version: 1,
      taskId: selected.taskId,
      claimId: randomUUID(),
      authorizationId: input.authorizationId,
      bodySha256: selected.bodySha256,
      harness: input.harness,
      authorizedAt,
      claimedAt: new Date().toISOString(),
    };
    const serialized = serializeClaimRecord(claim);
    checkCapacity(inventory, Buffer.byteLength(serialized, "utf8") + MAX_LIFECYCLE_BYTES, 2);
    const file = path.join(paths.workspaceTaskRoot, taskbookClaimFileName(selected.taskId));
    if (!createNewFileExclusive(io, file, serialized)) {
      throw new TaskbookError("STORAGE_ERROR", undefined, "CLAIM_EXISTS");
    }
    return {
      taskId: selected.taskId,
      title: selected.envelope.title,
      body: selected.envelope.body,
      bodySha256: selected.bodySha256,
      claim,
    };
  });
}

/**
 * Persist a Taskbook-linked execution/output pair while holding the same
 * workspace lifecycle lock used by claim, finish, and Recover.
 */
export function recordTaskbookExecution<T>(input: TaskbookLinkedRecordInput, persist: () => T): T {
  validateUuid(input.taskId, "TASK_ID");
  validateUuid(input.claimId, "CLAIM_ID");
  validateUuid(input.authorizationId, "AUTHORIZATION_ID");
  validateBodyHash(input.bodySha256, "BODY_HASH");
  const io = contextIo(input);
  const paths = pathsFor(input, io);
  return runLocked(io, paths, () => {
    const inventory = inventoryTaskbookState(io, paths.workspaceTaskRoot);
    rejectCorruptState(inventory);
    const task = inventory.tasks.find((candidate) => candidate.taskId === input.taskId);
    if (!task) throw new TaskbookError("TASK_NOT_FOUND", undefined, "TASK_ID");
    if (!task.claim || task.result) {
      throw new TaskbookError("TASK_NOT_ELIGIBLE", undefined, "TERMINAL_OR_UNCLAIMED");
    }
    if (
      task.claim.claimId !== input.claimId ||
      task.claim.authorizationId !== input.authorizationId ||
      task.claim.bodySha256 !== input.bodySha256 ||
      task.bodySha256 !== input.bodySha256
    ) {
      throw new TaskbookError("EVIDENCE_INVALID", undefined, "CLAIM_MISMATCH");
    }
    return persist();
  });
}

/** Resolve one existing unfinished claim from durable linked evidence, or abandon it as blocked. */
export async function recoverTaskbook(
  input: TaskbookRecoverInput,
  inspectEvidence: (task: TaskbookLifecycleTask) => TaskbookRecoveryEvidence,
  readCapability: TaskbookLifecycleCapabilityReader
): Promise<TaskbookRecoverOutcome> {
  validateUuid(input.recoveryAuthorizationId, "RECOVERY_AUTHORIZATION_ID");
  const io = contextIo(input);
  const paths = pathsFor(input, io);
  return runLockedAsync(io, paths, async () => {
    const inventory = inventoryTaskbookState(io, paths.workspaceTaskRoot);
    rejectCorruptState(inventory);
    const task = inventory.unfinishedClaims[0];
    if (!task?.claim) return { outcome: "no-target" };
    if (inventory.authorizationIds.has(input.recoveryAuthorizationId)) {
      throw new TaskbookError("AUTHORIZATION_REUSED", undefined, "RECOVERY_AUTHORIZATION_ID");
    }

    const evidence = inspectEvidence(task);
    const finishedAt = new Date().toISOString();
    let result: TaskbookRecoveryResultRecord;
    if (evidence.classification === "complete") {
      if (!isCanonicalUtcTimestamp(evidence.executionTimestamp)) {
        throw new TaskbookError("EVIDENCE_INVALID", undefined, "RECOVERY_EXECUTION_TIMESTAMP");
      }
      if (
        evidence.outputId !== null &&
        (!Number.isSafeInteger(evidence.outputId) || evidence.outputId <= 0)
      ) {
        throw new TaskbookError("EVIDENCE_INVALID", undefined, "RECOVERY_OUTPUT_ID");
      }
      result = {
        version: 2,
        taskId: task.taskId,
        bodySha256: task.bodySha256,
        claimId: task.claim.claimId,
        status: evidence.status,
        finishedAt,
        recoveryAuthorizationId: input.recoveryAuthorizationId,
        terminalOrigin: "recovery-closeout",
        evidenceState: "complete-linked-execution",
        executionTimestamp: evidence.executionTimestamp,
        outputId: evidence.outputId,
        reasonCode: `recovered-${evidence.status}` as RecoveryReasonCode,
      };
    } else {
      const noEvidence = evidence.classification === "none";
      result = {
        version: 2,
        taskId: task.taskId,
        bodySha256: task.bodySha256,
        claimId: task.claim.claimId,
        status: "blocked",
        finishedAt,
        recoveryAuthorizationId: input.recoveryAuthorizationId,
        terminalOrigin: "recovery-abandon",
        evidenceState: noEvidence ? "no-linked-evidence" : "incomplete-or-ambiguous",
        executionTimestamp: null,
        outputId: null,
        reasonCode:
          evidence.classification === "none"
            ? "no-linked-evidence"
            : evidence.classification === "ambiguous"
              ? "ambiguous-linked-evidence"
              : "incomplete-linked-evidence",
      };
    }
    const serialized = serializeResultRecord(result);
    checkCapacity(inventory, Buffer.byteLength(serialized, "utf8"));
    let capability: BoundTaskbookLifecycleCapability | null;
    try {
      capability = await readCapability({
        workspaceId: input.workspaceId,
        workspaceRoot: paths.projectRoot,
        stateRoot: paths.stateRoot,
      });
    } catch {
      throw new TaskbookError("UPGRADE_REQUIRED", undefined, "BRIDGE_LIFECYCLE_CAPABILITY_UNVERIFIED");
    }
    if (
      !boundCapabilitySupportsResultVersion(capability, result.version, {
        workspaceId: input.workspaceId,
        workspaceRoot: input.projectRoot,
      })
    ) {
      throw new TaskbookError("UPGRADE_REQUIRED", undefined, "UNSUPPORTED_LIFECYCLE_RESULT_VERSION");
    }
    const file = path.join(paths.workspaceTaskRoot, taskbookResultFileName(task.taskId));
    if (!createNewFileExclusive(io, file, serialized)) {
      throw new TaskbookError("STORAGE_ERROR", undefined, "RESULT_EXISTS");
    }
    return { outcome: "recovered", result };
  });
}

/** Verify read-back execution evidence and atomically write one terminal result. */
export function finishTaskbook(input: TaskbookFinishInput): TaskbookResultRecord {
  validateFinishInput(input);
  validateEvidence(input);
  const io = contextIo(input);
  const paths = pathsFor(input, io);
  return runLocked(io, paths, () => {
    const inventory = inventoryTaskbookState(io, paths.workspaceTaskRoot);
    rejectCorruptState(inventory);
    const task = inventory.tasks.find((candidate) => candidate.taskId === input.taskId);
    if (!task) throw new TaskbookError("TASK_NOT_FOUND", undefined, "TASK_ID");
    if (!task.claim || task.result) throw new TaskbookError("TASK_NOT_ELIGIBLE", undefined, "TERMINAL_OR_UNCLAIMED");
    if (
      task.claim.claimId !== input.claimId ||
      task.claim.authorizationId !== input.authorizationId ||
      task.claim.bodySha256 !== input.bodySha256 ||
      task.bodySha256 !== input.bodySha256
    ) {
      throw new TaskbookError("EVIDENCE_INVALID", undefined, "CLAIM_MISMATCH");
    }

    const result: TaskbookResultRecord = {
      version: 1,
      taskId: input.taskId,
      bodySha256: input.bodySha256,
      claimId: input.claimId,
      status: input.status,
      finishedAt: new Date().toISOString(),
      executionTimestamp: input.executionTimestamp,
      outputId: input.outputId,
    };
    const serialized = serializeResultRecord(result);
    checkCapacity(inventory, Buffer.byteLength(serialized, "utf8"));
    const file = path.join(paths.workspaceTaskRoot, taskbookResultFileName(input.taskId));
    if (!createNewFileExclusive(io, file, serialized)) {
      throw new TaskbookError("STORAGE_ERROR", undefined, "RESULT_EXISTS");
    }
    return result;
  });
}

/** Convenience helper for Harnesses that need to verify a claim body locally. */
export function verifyClaimBody(task: TaskbookClaimedTask): boolean {
  try {
    return bodySha256(task.body) === task.bodySha256 && parseClaimRecord(JSON.stringify(task.claim)).taskId === task.taskId;
  } catch {
    return false;
  }
}
