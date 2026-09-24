import path from "node:path";
import { MAX_ENVELOPE_BYTES, MAX_INVENTORY_ENTRIES, MAX_LIFECYCLE_BYTES } from "./constants.js";
import {
  bodySha256,
  parseEnvelope,
  taskIdFromClaimFileName,
  taskIdFromFileName,
  taskIdFromResultFileName,
  type TaskbookEnvelope,
} from "./envelope.js";
import {
  parseClaimRecord,
  parseResultRecord,
  type AnyTaskbookResultRecord,
  type TaskbookClaimRecord,
} from "./lifecycle-records.js";
import { TaskbookError, errnoCodeOf } from "./errors.js";
import { lstatStrict, readTextStrict } from "./fsutil.js";
import type { TaskbookIo } from "./io.js";

/** The original Gate 1 inventory summary (kept as an exact three-field shape). */
export interface TaskbookInventory {
  entries: number;
  storageBytes: number;
  pending: number;
}

/** A valid envelope plus any validated Gate 2 lifecycle sidecars. */
export interface TaskbookLifecycleTask {
  taskId: string;
  envelope: TaskbookEnvelope;
  bodySha256: string;
  claim: TaskbookClaimRecord | null;
  result: AnyTaskbookResultRecord | null;
}

/** Complete state information used by local inspect/claim/finish operations. */
export interface DetailedTaskbookInventory extends TaskbookInventory {
  tasks: TaskbookLifecycleTask[];
  /** Canonical envelope names whose contents are invalid or impossible by size. */
  invalidTaskIds: string[];
  /** Valid claims without a terminal result. */
  unfinishedClaims: TaskbookLifecycleTask[];
  /** Bounded historical authorization IDs found in claim sidecars. */
  authorizationIds: Set<string>;
}

interface EnvelopeEntry {
  taskId: string;
  envelope: TaskbookEnvelope;
}

interface ClaimEntry {
  taskId: string;
  claim: TaskbookClaimRecord;
}

interface ResultEntry {
  taskId: string;
  result: AnyTaskbookResultRecord;
}

function assertStable(io: TaskbookIo, absolute: string, before: ReturnType<TaskbookIo["lstat"]>): void {
  const after = lstatStrict(io, absolute);
  if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new TaskbookError("STORAGE_ERROR", undefined, "INVENTORY_INCONSISTENT");
  }
}

/**
 * Complete, direct-child, fail-closed inventory for both Gate 1 and Gate 2.
 * Gate 1 callers receive only the original summary via
 * {@link inventoryWorkspaceTaskRoot}; lifecycle callers use this richer result
 * to validate sidecar relationships and unfinished claims.
 */
export function inventoryTaskbookState(io: TaskbookIo, workspaceTaskRoot: string): DetailedTaskbookInventory {
  let names: string[];
  let exceeded: boolean;
  try {
    ({ names, exceeded } = io.readDirBounded(workspaceTaskRoot, MAX_INVENTORY_ENTRIES));
  } catch (error) {
    throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "ENUMERATION_FAILED");
  }
  if (exceeded) throw new TaskbookError("LIMIT_EXCEEDED", undefined, "INVENTORY_OVER_CAP");

  let entries = 0;
  let storageBytes = 0;
  const envelopes = new Map<string, EnvelopeEntry>();
  const claims = new Map<string, ClaimEntry>();
  const results = new Map<string, ResultEntry>();
  const invalidTaskIds = new Set<string>();
  const claimAuthorizationIds = new Set<string>();
  const recoveryAuthorizationIds = new Set<string>();

  for (const name of names) {
    const absolute = path.join(workspaceTaskRoot, name);
    const before = lstatStrict(io, absolute);
    if (before.isSymbolicLink()) throw new TaskbookError("STORAGE_ERROR", undefined, "UNEXPECTED_CHILD_SYMLINK");
    if (!before.isFile()) throw new TaskbookError("STORAGE_ERROR", undefined, "UNEXPECTED_CHILD_TYPE");

    entries += 1;
    storageBytes += before.size;

    const envelopeTaskId = taskIdFromFileName(name);
    const claimTaskId = taskIdFromClaimFileName(name);
    const resultTaskId = taskIdFromResultFileName(name);

    if (envelopeTaskId !== null) {
      // An impossible oversized canonical envelope still consumes bytes/entries,
      // but cannot be a pending task and need not be read.
      if (before.size === 0 || before.size > MAX_ENVELOPE_BYTES) {
        invalidTaskIds.add(envelopeTaskId);
        assertStable(io, absolute, before);
        continue;
      }
      const text = readTextStrict(io, absolute);
      assertStable(io, absolute, before);
      try {
        envelopes.set(envelopeTaskId, { taskId: envelopeTaskId, envelope: parseEnvelope(text) });
      } catch {
        // Gate 1 preserves malformed canonical regular files as bounded storage;
        // Gate 2 turns this marker into a corrupt-state stop before claiming.
        invalidTaskIds.add(envelopeTaskId);
      }
      continue;
    }

    if (claimTaskId !== null) {
      if (before.size > MAX_LIFECYCLE_BYTES) {
        throw new TaskbookError("STORAGE_ERROR", undefined, "CLAIM_TOO_LARGE");
      }
      const text = readTextStrict(io, absolute);
      assertStable(io, absolute, before);
      let claim: TaskbookClaimRecord;
      try {
        claim = parseClaimRecord(text);
      } catch {
        throw new TaskbookError("STORAGE_ERROR", undefined, "MALFORMED_CLAIM");
      }
      if (claim.taskId !== claimTaskId || claims.has(claimTaskId)) {
        throw new TaskbookError("STORAGE_ERROR", undefined, "MISMATCHED_CLAIM");
      }
      claims.set(claimTaskId, { taskId: claimTaskId, claim });
      if (claimAuthorizationIds.has(claim.authorizationId)) {
        throw new TaskbookError("STORAGE_ERROR", undefined, "DUPLICATE_AUTHORIZATION_ID");
      }
      claimAuthorizationIds.add(claim.authorizationId);
      continue;
    }

    if (resultTaskId !== null) {
      if (before.size > MAX_LIFECYCLE_BYTES) {
        throw new TaskbookError("STORAGE_ERROR", undefined, "RESULT_TOO_LARGE");
      }
      const text = readTextStrict(io, absolute);
      assertStable(io, absolute, before);
      let result: AnyTaskbookResultRecord;
      try {
        result = parseResultRecord(text);
      } catch (error) {
        if (error instanceof TaskbookError && error.code === "UPGRADE_REQUIRED") throw error;
        throw new TaskbookError("STORAGE_ERROR", undefined, "MALFORMED_RESULT");
      }
      if (result.taskId !== resultTaskId || results.has(resultTaskId)) {
        throw new TaskbookError("STORAGE_ERROR", undefined, "MISMATCHED_RESULT");
      }
      results.set(resultTaskId, { taskId: resultTaskId, result });
      if (result.version === 2) {
        if (recoveryAuthorizationIds.has(result.recoveryAuthorizationId)) {
          throw new TaskbookError("STORAGE_ERROR", undefined, "DUPLICATE_AUTHORIZATION_ID");
        }
        recoveryAuthorizationIds.add(result.recoveryAuthorizationId);
      }
      continue;
    }

    // Unknown/non-canonical regular files are bounded accounting entries. They
    // are deliberately not promoted to lifecycle state or silently followed.
    assertStable(io, absolute, before);
  }

  for (const authorizationId of recoveryAuthorizationIds) {
    if (claimAuthorizationIds.has(authorizationId)) {
      throw new TaskbookError("STORAGE_ERROR", undefined, "DUPLICATE_AUTHORIZATION_ID");
    }
  }

  const tasks: TaskbookLifecycleTask[] = [];
  const taskIds = new Set<string>([...envelopes.keys(), ...claims.keys(), ...results.keys()]);
  for (const taskId of taskIds) {
    const envelopeEntry = envelopes.get(taskId);
    const claimEntry = claims.get(taskId);
    const resultEntry = results.get(taskId);
    if (!envelopeEntry) throw new TaskbookError("STORAGE_ERROR", undefined, "ORPHAN_LIFECYCLE_RECORD");
    if (invalidTaskIds.has(taskId)) {
      throw new TaskbookError("STORAGE_ERROR", undefined, "INVALID_LIFECYCLE_ENVELOPE");
    }
    if (claimEntry && claimEntry.claim.bodySha256 !== bodySha256(envelopeEntry.envelope.body)) {
      throw new TaskbookError("STORAGE_ERROR", undefined, "CLAIM_BODY_MISMATCH");
    }
    if (resultEntry && !claimEntry) throw new TaskbookError("STORAGE_ERROR", undefined, "ORPHAN_RESULT");
    if (resultEntry && claimEntry) {
      const { result } = resultEntry;
      if (
        result.bodySha256 !== claimEntry.claim.bodySha256 ||
        result.bodySha256 !== bodySha256(envelopeEntry.envelope.body) ||
        result.claimId !== claimEntry.claim.claimId
      ) {
        throw new TaskbookError("STORAGE_ERROR", undefined, "LIFECYCLE_RELATION_MISMATCH");
      }
    }
    tasks.push({
      taskId,
      envelope: envelopeEntry.envelope,
      bodySha256: bodySha256(envelopeEntry.envelope.body),
      claim: claimEntry?.claim ?? null,
      result: resultEntry?.result ?? null,
    });
  }

  const pending = tasks.filter((task) => task.claim === null).length;
  const unfinishedClaims = tasks.filter((task) => task.claim !== null && task.result === null);
  return {
    entries,
    storageBytes,
    pending,
    tasks,
    invalidTaskIds: [...invalidTaskIds].sort(),
    unfinishedClaims,
    authorizationIds: new Set([...claimAuthorizationIds, ...recoveryAuthorizationIds]),
  };
}

/** Gate 1 compatibility wrapper with its historical exact return shape. */
export function inventoryWorkspaceTaskRoot(io: TaskbookIo, workspaceTaskRoot: string): TaskbookInventory {
  const detailed = inventoryTaskbookState(io, workspaceTaskRoot);
  return {
    entries: detailed.entries,
    storageBytes: detailed.storageBytes,
    pending: detailed.pending,
  };
}
