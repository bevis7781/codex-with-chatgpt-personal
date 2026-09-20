import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { LOCK_NAMESPACE_NAME, LOCK_SUFFIX, TASKS_ROOT_NAME } from "./constants.js";
import { TaskbookError, errnoCodeOf } from "./errors.js";
import { lstatOrNull, realpathStrict } from "./fsutil.js";
import { nodeTaskbookIo, type TaskbookIo } from "./io.js";

/**
 * R2 — path/platform containment.
 *
 * The canonical C2C state root is the boundary. Every security-sensitive
 * Taskbook child is created and validated **independently, one segment at a
 * time**: an existing symlink/junction/reparse point anywhere in the chain is
 * rejected instead of followed, and each level is re-canonicalized and checked
 * to remain inside the boundary.
 *
 * Resolution errors fail closed. This does not attempt to defend against an
 * active same-machine attacker swapping ancestors during syscall windows.
 */

export interface TaskbookPaths {
  /** Canonical C2C state root (the containment boundary). */
  stateRoot: string;
  /** Canonical real project workspace root. */
  projectRoot: string;
  /** `<stateRoot>/tasks` */
  tasksRoot: string;
  /** `<stateRoot>/tasks/<workspaceId>` */
  workspaceTaskRoot: string;
  /** `<stateRoot>/taskbook-locks` (dedicated lock namespace, outside task inventory). */
  lockNamespace: string;
  /** `<stateRoot>/taskbook-locks/<workspaceId>.lock` (a directory). */
  lockPath: string;
}

function normForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** True when `candidate` is `root` or lies strictly below it. */
export function isInsideRoot(root: string, candidate: string): boolean {
  const r = normForCompare(path.resolve(root));
  const c = normForCompare(path.resolve(candidate));
  if (c === r) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(prefix);
}

function assertSafeSegment(segment: string): void {
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0")
  ) {
    throw new TaskbookError("STORAGE_ERROR", undefined, "UNSAFE_SEGMENT");
  }
}

/** Workspace IDs are C2C-derived; validate shape as defense in depth. */
export function assertSafeWorkspaceId(workspaceId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) {
    throw new TaskbookError("STORAGE_ERROR", undefined, "UNSAFE_WORKSPACE_ID");
  }
}

/**
 * Probe a path that may not exist yet: realpath its deepest existing ancestor and
 * return the remaining (non-existent) segments. Creates nothing.
 *
 * Unlike a permissive helper it never falls back to an ancestor on a real
 * resolution error: only ENOENT is treated as "not created yet".
 */
export function probeDeepestExisting(io: TaskbookIo, absolute: string): { existingReal: string; suffix: string[] } {
  let current = path.resolve(absolute);
  const suffix: string[] = [];
  for (;;) {
    const stats = lstatOrNull(io, current);
    if (stats) break;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new TaskbookError("STORAGE_ERROR", undefined, "NO_EXISTING_ANCESTOR");
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return { existingReal: realpathStrict(io, current), suffix };
}

/** Canonical (non-creating) form of a path that may not exist yet. */
export function canonicalizeDeepestExisting(io: TaskbookIo, absolute: string): string {
  const { existingReal, suffix } = probeDeepestExisting(io, absolute);
  return suffix.length > 0 ? path.join(existingReal, ...suffix) : existingReal;
}

/**
 * Create/validate a chain of direct children below an already-canonical base.
 * Each level: absent -> non-recursive mkdir; existing symlink/junction -> reject;
 * non-directory -> reject; then re-canonicalize and require containment.
 */
export function ensureContainedDir(io: TaskbookIo, baseCanonical: string, segments: string[]): string {
  let current = baseCanonical;
  for (const segment of segments) {
    assertSafeSegment(segment);
    const next = path.join(current, segment);
    let stats = lstatOrNull(io, next);
    if (!stats) {
      try {
        io.mkdir(next);
      } catch (error) {
        if (errnoCodeOf(error) !== "EEXIST") {
          throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "MKDIR_FAILED");
        }
      }
      stats = lstatOrNull(io, next);
      if (!stats) throw new TaskbookError("STORAGE_ERROR", undefined, "MKDIR_MISSING");
    }
    if (stats.isSymbolicLink()) {
      throw new TaskbookError("STORAGE_ERROR", undefined, "SYMLINK_REDIRECT");
    }
    if (!stats.isDirectory()) {
      throw new TaskbookError("STORAGE_ERROR", undefined, "NOT_A_DIRECTORY");
    }
    const real = realpathStrict(io, next);
    if (!isInsideRoot(baseCanonical, real)) {
      throw new TaskbookError("STORAGE_ERROR", undefined, "CONTAINMENT_ESCAPE");
    }
    current = real;
  }
  return current;
}

export interface ResolveTaskbookPathsInput {
  workspaceId: string;
  /** Real project workspace root (trusted, derived from the authenticated session). */
  projectRoot: string;
  /** Test/CLI override; defaults to the C2C state dir provider. */
  stateDir?: string;
  io?: TaskbookIo;
}

export function resolveTaskbookPaths(input: ResolveTaskbookPathsInput): TaskbookPaths {
  const io = input.io ?? nodeTaskbookIo;
  assertSafeWorkspaceId(input.workspaceId);

  const projectRoot = realpathStrict(io, path.resolve(input.projectRoot));

  const stateInput = input.stateDir ?? getStateDir();
  const { existingReal, suffix } = probeDeepestExisting(io, stateInput);
  const plannedStateRoot = suffix.length > 0 ? path.join(existingReal, ...suffix) : existingReal;

  // Reject before creating anything: the state boundary must not equal or sit
  // inside the project workspace.
  if (isInsideRoot(projectRoot, plannedStateRoot)) {
    throw new TaskbookError("STORAGE_ERROR", undefined, "STATE_INSIDE_PROJECT");
  }

  // Only now materialize the state root, one validated segment at a time.
  const stateRoot =
    suffix.length > 0 ? ensureContainedDir(io, existingReal, suffix) : existingReal;
  if (isInsideRoot(projectRoot, stateRoot)) {
    throw new TaskbookError("STORAGE_ERROR", undefined, "STATE_INSIDE_PROJECT");
  }

  const tasksRoot = ensureContainedDir(io, stateRoot, [TASKS_ROOT_NAME]);
  const workspaceTaskRoot = ensureContainedDir(io, tasksRoot, [input.workspaceId]);
  const lockNamespace = ensureContainedDir(io, stateRoot, [LOCK_NAMESPACE_NAME]);
  const lockPath = path.join(lockNamespace, `${input.workspaceId}${LOCK_SUFFIX}`);

  // Defense in depth: neither the task root nor the lock may resolve into the project.
  if (isInsideRoot(projectRoot, workspaceTaskRoot) || isInsideRoot(projectRoot, lockPath)) {
    throw new TaskbookError("STORAGE_ERROR", undefined, "TASK_STATE_INSIDE_PROJECT");
  }

  return { stateRoot, projectRoot, tasksRoot, workspaceTaskRoot, lockNamespace, lockPath };
}
