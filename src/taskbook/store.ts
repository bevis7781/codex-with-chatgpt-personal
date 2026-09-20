import path from "node:path";
import type { Logger } from "../logger/index.js";
import { emitTaskbookAudit } from "./audit.js";
import {
  MAX_BODY_BYTES,
  MAX_INVENTORY_ENTRIES,
  MAX_PENDING,
  MAX_TOTAL_STORAGE_BYTES,
  MAX_TITLE_BYTES,
  MAX_UUID_ATTEMPTS,
  TASKBOOK_STATUS_PENDING,
} from "./constants.js";
import { createEnvelope, bodySha256, generateTaskId, serializeEnvelope, taskbookFileName, utf8Bytes } from "./envelope.js";
import { TaskbookError, toTaskbookError } from "./errors.js";
import { createNewFileExclusive } from "./create.js";
import { inventoryWorkspaceTaskRoot } from "./inventory.js";
import { nodeTaskbookIo, type TaskbookIo } from "./io.js";
import { acquireTaskbookLock, releaseTaskbookLock } from "./lock.js";
import { resolveTaskbookPaths } from "./paths.js";

/**
 * Gate 1 bounded Taskbook admission.
 *
 * The remote caller only ever supplies `title` and `body`. Everything that
 * determines where and how the record is stored (workspace, directory, path,
 * filename, extension, task ID, lifecycle) is derived locally.
 */

export interface TaskbookSubmitInput {
  title: unknown;
  body: unknown;
}

export interface TaskbookSubmitContext {
  /** Authenticated workspace ID (trusted, derived from the bearer token). */
  workspaceId: string;
  /** Real project workspace root (trusted). */
  projectRoot: string;
  /** Test/CLI override for the C2C state root. */
  stateDir?: string;
  logger?: Logger;
  /** Test seam for low-level fault injection. */
  io?: TaskbookIo;
  /** Test seam for deterministic UUID collision coverage. */
  nextTaskId?: () => string;
}

/** Q5 — the success receipt. Exactly these four fields. */
export interface TaskbookReceipt {
  taskId: string;
  createdAt: string;
  status: typeof TASKBOOK_STATUS_PENDING;
  bodySha256: string;
}

interface PreparedSubmission {
  title: string;
  body: string;
  createdAt: string;
  serialized: string;
  proposedBytes: number;
  bodySha256: string;
  titleBytes: number;
  bodyBytes: number;
}

/**
 * Pure validation/hash/serialization. Makes no filesystem admission decision,
 * so it runs before the R1 lock.
 */
export function prepareSubmission(input: TaskbookSubmitInput): PreparedSubmission {
  if (typeof input.title !== "string" || typeof input.body !== "string") {
    throw new TaskbookError("INVALID_INPUT", "Taskbook title and body must be strings.");
  }
  const titleBytes = utf8Bytes(input.title);
  const bodyBytes = utf8Bytes(input.body);
  if (titleBytes > MAX_TITLE_BYTES) {
    throw new TaskbookError("LIMIT_EXCEEDED", `Taskbook title exceeds ${MAX_TITLE_BYTES} UTF-8 bytes.`);
  }
  if (bodyBytes > MAX_BODY_BYTES) {
    throw new TaskbookError("LIMIT_EXCEEDED", `Taskbook body exceeds ${MAX_BODY_BYTES} UTF-8 bytes.`);
  }
  const createdAt = new Date().toISOString();
  const envelope = createEnvelope(input.title, input.body, createdAt);
  const serialized = serializeEnvelope(envelope);
  return {
    title: input.title,
    body: input.body,
    createdAt,
    serialized,
    proposedBytes: utf8Bytes(serialized),
    bodySha256: bodySha256(input.body),
    titleBytes,
    bodyBytes,
  };
}

/**
 * Bounded, allowlisted metadata that can be derived from correctly typed input
 * without ever inspecting an invalid caller object.
 */
interface SubmissionMetadata {
  titleBytes?: number;
  bodyBytes?: number;
  bodySha256?: string;
}

/**
 * Derive only the metadata that is safe to compute up front.
 *
 * A non-string title/body contributes nothing at all: no `String()`, no
 * `JSON.stringify`, no property access beyond `typeof`. Untrusted objects are
 * therefore never stringified merely to build audit metadata.
 */
function deriveSubmissionMetadata(input: TaskbookSubmitInput): SubmissionMetadata {
  const metadata: SubmissionMetadata = {};
  if (typeof input.title === "string") metadata.titleBytes = utf8Bytes(input.title);
  if (typeof input.body === "string") metadata.bodyBytes = utf8Bytes(input.body);
  return metadata;
}

/**
 * Submit one bounded Taskbook record.
 *
 * Every call emits exactly one Q6 audit result, whether it fails during
 * pre-admission validation (invalid types, title/body over limit) or during
 * admission (lock, inventory, quota, create). The audit never fabricates a task
 * ID and never carries caller plaintext, paths or the raw envelope.
 *
 * Critical section (inside the R1 lock): complete inventory -> pending quota ->
 * storage quota -> inventory-cap -> UUID selection/collision -> exclusive final
 * create -> complete write -> successful close. The lock is released before audit
 * logging. A release failure after successful persistence keeps the success and
 * leaves the lock in place so later submissions fail closed.
 */
export function submitTaskbook(
  input: TaskbookSubmitInput,
  context: TaskbookSubmitContext
): TaskbookReceipt {
  const io = context.io ?? nodeTaskbookIo;
  const metadata = deriveSubmissionMetadata(input);

  let lockAcquired = false;
  let lockPath: string | null = null;
  let receipt: TaskbookReceipt | null = null;
  let failure: TaskbookError | null = null;

  try {
    // Pre-admission validation runs before the lock and may throw INVALID_INPUT
    // or LIMIT_EXCEEDED; those failures are audited exactly like admission
    // failures, so a rejected attempt is never invisible to Q6.
    const prepared = prepareSubmission(input);
    metadata.bodySha256 = prepared.bodySha256;

    const paths = resolveTaskbookPaths({
      workspaceId: context.workspaceId,
      projectRoot: context.projectRoot,
      stateDir: context.stateDir,
      io,
    });
    lockPath = paths.lockPath;

    acquireTaskbookLock(io, paths.lockPath);
    lockAcquired = true;

    const inventory = inventoryWorkspaceTaskRoot(io, paths.workspaceTaskRoot);
    if (inventory.entries >= MAX_INVENTORY_ENTRIES) {
      throw new TaskbookError("LIMIT_EXCEEDED", undefined, "ENTRY_CAP");
    }
    if (inventory.pending >= MAX_PENDING) {
      throw new TaskbookError("LIMIT_EXCEEDED", undefined, "PENDING_CAP");
    }
    if (inventory.storageBytes + prepared.proposedBytes > MAX_TOTAL_STORAGE_BYTES) {
      throw new TaskbookError("LIMIT_EXCEEDED", undefined, "STORAGE_CAP");
    }

    for (let attempt = 0; attempt < MAX_UUID_ATTEMPTS; attempt += 1) {
      const taskId = (context.nextTaskId ?? generateTaskId)();
      const file = path.join(paths.workspaceTaskRoot, taskbookFileName(taskId));
      if (!createNewFileExclusive(io, file, prepared.serialized)) continue;
      receipt = {
        taskId,
        createdAt: prepared.createdAt,
        status: TASKBOOK_STATUS_PENDING,
        bodySha256: prepared.bodySha256,
      };
      break;
    }
    if (!receipt) {
      throw new TaskbookError("STORAGE_ERROR", undefined, "UUID_COLLISION_EXHAUSTED");
    }
  } catch (error) {
    failure = toTaskbookError(error);
  } finally {
    if (lockAcquired && lockPath) {
      try {
        releaseTaskbookLock(io, lockPath);
      } catch {
        // Post-success unlock failure: the persisted result stands, no retry, and
        // the surviving lock blocks later submissions fail-closed.
      }
    }
  }

  // Exactly one audit per submission attempt. `emitTaskbookAudit` omits any
  // undefined field, so a failure carries no taskId and an invalid-type failure
  // carries no fabricated lengths or hash.
  const timestamp = new Date().toISOString();
  emitTaskbookAudit(context.logger, {
    outcome: receipt ? "success" : "failure",
    code: receipt ? "OK" : failure?.code ?? "STORAGE_ERROR",
    workspaceId: context.workspaceId,
    timestamp,
    taskId: receipt?.taskId,
    titleBytes: metadata.titleBytes,
    bodyBytes: metadata.bodyBytes,
    bodySha256: metadata.bodySha256,
  });

  if (failure) throw failure;
  if (!receipt) throw new TaskbookError("STORAGE_ERROR", undefined, "NO_RESULT");
  return receipt;
}
