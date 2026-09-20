import { TaskbookError, errnoCodeOf } from "./errors.js";
import type { TaskbookIo } from "./io.js";

/**
 * R1 — one filesystem-backed cross-process admission lock per workspace.
 *
 * The lock is a dedicated directory in its own namespace (outside the task
 * inventory, so it is never charged to inventory/storage quotas). It is acquired
 * with a non-recursive exclusive directory create: an existing lock fails closed
 * immediately. There is no wait, no queue, no retry, no timeout, no age
 * heuristic, no stale-break and no automatic cleanup — only an explicit local
 * operator repair.
 */

export function acquireTaskbookLock(io: TaskbookIo, lockPath: string): void {
  try {
    io.mkdir(lockPath);
  } catch (error) {
    const code = errnoCodeOf(error);
    if (code === "EEXIST") {
      throw new TaskbookError("STORAGE_ERROR", undefined, "LOCK_HELD");
    }
    throw new TaskbookError("STORAGE_ERROR", undefined, code ?? "LOCK_FAILED");
  }
}

/** Release the lock. Throws on failure; callers must handle post-success release failure. */
export function releaseTaskbookLock(io: TaskbookIo, lockPath: string): void {
  try {
    io.rmdir(lockPath);
  } catch (error) {
    throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "UNLOCK_FAILED");
  }
}
