import { errnoCodeOf, TaskbookError } from "./errors.js";
import { lstatOrNull } from "./fsutil.js";
import type { TaskbookIo } from "./io.js";

/**
 * Q3 — exclusive final-leaf create-new primitive.
 *
 * Returns `false` when the leaf already exists (of any type) so the caller picks
 * another UUID. Never overwrites, truncates, follows or replaces.
 *
 * The static leaf check is required in addition to `wx`: on Windows an exclusive
 * create *follows* a dangling final symlink and would create the link target. The
 * actual creation still uses exclusive-create semantics, so a leaf that appears
 * between the check and the open is still rejected by the OS for regular files,
 * directories and live links. Only an active same-machine TOCTOU swap is out of
 * scope for V0.1.
 *
 * Success requires a complete write and a successful close.
 */
export function createNewFileExclusive(io: TaskbookIo, file: string, data: string): boolean {
  if (lstatOrNull(io, file) !== null) return false;

  let fd: number;
  try {
    fd = io.openExclusive(file);
  } catch (error) {
    if (errnoCodeOf(error) === "EEXIST") return false;
    throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "OPEN_FAILED");
  }
  try {
    io.writeAll(fd, data);
    io.sync(fd);
    io.close(fd);
  } catch (error) {
    io.closeQuietly(fd);
    throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "WRITE_FAILED");
  }
  return true;
}
