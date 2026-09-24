import { isCanonicalUtcTimestamp } from "./envelope.js";
import {
  decodeTaskbookEvidenceNote,
  TASKBOOK_EVIDENCE_NOTE_PREFIX,
  type TaskbookRecoveryEvidence,
} from "./lifecycle.js";
import type { TaskbookLifecycleTask } from "./inventory.js";
import { readExecutionRecordSnapshot, type ExecutionRecord } from "../execution/records.js";
import { listExecutionOutputs, readExecutionOutput, type ExecutionOutputMeta } from "../execution/output.js";

const MAX_RECOVERY_OUTPUT_INDEX_ITEMS = 50;

function noteMarkerCount(notes: string | undefined): number {
  if (!notes) return 0;
  return notes.split(TASKBOOK_EVIDENCE_NOTE_PREFIX).length - 1;
}

function hasReasonWithoutLinkage(notes: string | undefined): boolean {
  if (!notes) return false;
  return notes
    .split(" | ")
    .map((part) => part.trim())
    .some((part) => part.length > 0 && !part.startsWith(TASKBOOK_EVIDENCE_NOTE_PREFIX));
}

function sameOutputMeta(a: ExecutionOutputMeta, b: ExecutionOutputMeta): boolean {
  return (
    a.id === b.id &&
    a.timestamp === b.timestamp &&
    a.taskId === b.taskId &&
    a.iteration === b.iteration &&
    a.exitCode === b.exitCode &&
    a.allowed === b.allowed &&
    a.truncated === b.truncated &&
    a.sizeBytes === b.sizeBytes
  );
}

function readMatchingOutput(workspaceId: string, record: ExecutionRecord, taskId: string): ExecutionOutputMeta | null {
  if (!Number.isSafeInteger(record.outputId) || record.outputId === undefined || record.outputId <= 0) return null;
  const listed = listExecutionOutputs(workspaceId, MAX_RECOVERY_OUTPUT_INDEX_ITEMS).filter(
    (item) => item.id === record.outputId
  );
  if (listed.length !== 1) return null;
  const output = readExecutionOutput(workspaceId, record.outputId);
  if (
    output.ok !== true ||
    output.meta.taskId !== taskId ||
    output.meta.iteration !== 1 ||
    output.meta.allowed !== true ||
    !isCanonicalUtcTimestamp(output.meta.timestamp) ||
    output.meta.sizeBytes !== Buffer.byteLength(output.text, "utf8") ||
    !sameOutputMeta(listed[0], output.meta)
  ) {
    return null;
  }
  return output.meta;
}

/**
 * Inspect only existing, bounded execution evidence. It never creates state,
 * executes commands, or copies record prose/paths into a lifecycle result.
 */
export function inspectTaskbookRecoveryEvidence(workspaceId: string, task: TaskbookLifecycleTask): TaskbookRecoveryEvidence {
  if (!task.claim) return { classification: "none" };
  const snapshot = readExecutionRecordSnapshot(workspaceId);
  if (!snapshot.complete) return { classification: "ambiguous" };

  const related = snapshot.records.filter((record) => record.taskId === task.taskId && record.iteration === 1);
  const exact: ExecutionRecord[] = [];
  let partialOrSuspicious = false;
  for (const record of related) {
    const markers = noteMarkerCount(record.notes);
    if (markers === 0) continue;
    if (markers !== 1) {
      partialOrSuspicious = true;
      continue;
    }
    const note = decodeTaskbookEvidenceNote(record.notes);
    if (!note) {
      partialOrSuspicious = true;
      continue;
    }
    const touchesClaim =
      note.bodySha256 === task.bodySha256 ||
      note.claimId === task.claim.claimId ||
      note.authorizationId === task.claim.authorizationId;
    if (
      note.bodySha256 === task.bodySha256 &&
      note.claimId === task.claim.claimId &&
      note.authorizationId === task.claim.authorizationId
    ) {
      exact.push(record);
    } else if (touchesClaim) {
      partialOrSuspicious = true;
    }
  }

  if (exact.length > 1 || (exact.length === 1 && partialOrSuspicious)) return { classification: "ambiguous" };
  if (exact.length === 0) {
    return partialOrSuspicious ? { classification: "incomplete" } : { classification: "none" };
  }

  const record = exact[0];
  if (!isCanonicalUtcTimestamp(record.timestamp)) return { classification: "incomplete" };
  const outputId = record.outputId ?? null;
  let outputMeta: ExecutionOutputMeta | null = null;
  if (outputId !== null) {
    outputMeta = readMatchingOutput(workspaceId, record, task.taskId);
    if (!outputMeta || record.outputAvailable !== true) return { classification: "incomplete" };
  }

  if (record.exitStatus === "ok") {
    if (outputId === null || !outputMeta || outputMeta.exitCode !== 0) return { classification: "incomplete" };
    return {
      classification: "complete",
      status: "succeeded",
      executionTimestamp: record.timestamp,
      outputId,
    };
  }

  if (record.exitStatus !== "failed" && record.exitStatus !== "blocked") {
    return { classification: "incomplete" };
  }
  if (record.exitStatus === "failed" && outputId !== null && (!outputMeta || outputMeta.exitCode === null || outputMeta.exitCode === 0)) {
    return { classification: "incomplete" };
  }
  if (outputId === null && !hasReasonWithoutLinkage(record.notes)) return { classification: "incomplete" };
  return {
    classification: "complete",
    status: record.exitStatus,
    executionTimestamp: record.timestamp,
    outputId,
  };
}
