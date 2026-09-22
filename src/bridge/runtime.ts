import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { Workspace } from "../workspace/manager.js";

/**
 * Runtime state file: how the CLI/Skill finds a running bridge for a
 * workspace. Contains the admin token, so it is 0600 and lives in the user
 * state dir, never in the project.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  /** Legacy state files omit this; local-only Secure MCP Bridges set it. */
  transport?: "local-only" | "legacy-tunnel";
  startedAt: string;
}

export function runtimeFile(workspaceId: string): string {
  if (!/^[0-9a-f]{12}$/.test(workspaceId)) throw new Error("C2C_RUNTIME_WORKSPACE_ID_INVALID");
  const stateRoot = path.resolve(getStateDir());
  fs.mkdirSync(stateRoot, { recursive: true });
  const stateRootStat = fs.lstatSync(stateRoot);
  if (stateRootStat.isSymbolicLink() || !stateRootStat.isDirectory()) {
    throw new Error("C2C_RUNTIME_STATE_ROOT_UNSAFE");
  }
  const directory = ensureDir(path.join(stateRoot, "runtime"));
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("C2C_RUNTIME_STATE_DIRECTORY_UNSAFE");
  }
  return path.join(directory, `${workspaceId}.json`);
}

export function writeRuntimeState(state: RuntimeState): void {
  validateRuntimeState(state);
  const file = runtimeFile(state.workspaceId);
  assertWritableLeaf(file);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(10).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Best effort on Windows/filesystems without chmod semantics.
    }
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  const file = runtimeFile(workspaceId);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("C2C_RUNTIME_STATE_UNAVAILABLE");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("C2C_RUNTIME_STATE_CORRUPT");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    validateRuntimeState(parsed);
    const state = parsed as RuntimeState;
    if (state.workspaceId !== workspaceId) throw new Error("C2C_RUNTIME_IDENTITY_MISMATCH");
    return state;
  } catch (error) {
    if (error instanceof Error && /^C2C_RUNTIME_/.test(error.message)) throw error;
    throw new Error("C2C_RUNTIME_STATE_CORRUPT");
  }
}

function assertWritableLeaf(file: string): void {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("C2C_RUNTIME_STATE_UNSAFE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof Error && /^C2C_RUNTIME_/.test(error.message)) throw error;
    throw new Error("C2C_RUNTIME_STATE_UNSAFE");
  }
}

function validateRuntimeState(value: unknown): asserts value is RuntimeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("C2C_RUNTIME_STATE_CORRUPT");
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state).sort();
  const expected = [
    "adminToken",
    "pid",
    "port",
    "publicUrl",
    "service",
    "startedAt",
    "transport",
    "version",
    "workspaceId",
    "workspaceRoot",
  ];
  const legacyKeys = expected.filter((key) => key !== "transport");
  const exact = (items: string[]) => keys.length === items.length && keys.every((key, index) => key === items[index]);
  if (!exact(expected) && !exact(legacyKeys)) throw new Error("C2C_RUNTIME_STATE_CORRUPT");
  if (
    state.service !== SERVICE_NAME ||
    state.version !== VERSION ||
    typeof state.workspaceId !== "string" ||
    !/^[0-9a-f]{12}$/.test(state.workspaceId) ||
    typeof state.workspaceRoot !== "string" ||
    typeof state.pid !== "number" ||
    !Number.isSafeInteger(state.pid) ||
    state.pid < 0 ||
    typeof state.port !== "number" ||
    !Number.isSafeInteger(state.port) ||
    state.port <= 0 ||
    state.port > 65535 ||
    typeof state.adminToken !== "string" ||
    state.adminToken.length === 0 ||
    (state.publicUrl !== null && typeof state.publicUrl !== "string") ||
    (state.transport !== undefined && state.transport !== "local-only" && state.transport !== "legacy-tunnel") ||
    typeof state.startedAt !== "string" ||
    !Number.isFinite(Date.parse(state.startedAt)) ||
    new Date(state.startedAt).toISOString() !== state.startedAt
  ) {
    throw new Error("C2C_RUNTIME_STATE_CORRUPT");
  }
  try {
    const workspace = new Workspace(state.workspaceRoot);
    const sameRoot = process.platform === "win32"
      ? workspace.root.toLowerCase() === state.workspaceRoot.toLowerCase()
      : workspace.root === state.workspaceRoot;
    if (workspace.id !== state.workspaceId || !sameRoot) throw new Error("C2C_RUNTIME_IDENTITY_MISMATCH");
  } catch (error) {
    if (error instanceof Error && /^C2C_RUNTIME_/.test(error.message)) throw error;
    throw new Error("C2C_RUNTIME_IDENTITY_MISMATCH");
  }
}

export function clearRuntimeState(workspaceId: string): void {
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
  } catch {
    // ignore
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  workspaceId: string;
  status: string;
}

/** Probe a port and check whether a healthy c2c bridge for the workspace answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    if (body.status !== "ok" || typeof body.workspaceId !== "string" || !body.workspaceId) return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type BridgeObservation =
  | { state: "healthy"; runtime: RuntimeState }
  | { state: "stopped"; runtime: RuntimeState | null; reason: "runtime_missing" | "pid_missing" }
  | {
      state: "stale";
      runtime: RuntimeState;
      reason: "pid_missing_workspace_mismatch";
      otherWorkspaceId: string;
    }
  | { state: "unknown"; runtime: RuntimeState | null; reason: "probe_failed" | "pid_unknown" | "workspace_mismatch" };

function observePid(pid: number): "present" | "missing" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

/**
 * Distinguish a dead bridge from a probe that simply failed.
 * Read-only: never starts, stops, or clears runtime.
 */
export async function findBridgeObservation(workspaceId: string, expectedWorkspaceRoot?: string): Promise<BridgeObservation> {
  const runtime = readRuntimeState(workspaceId);
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };
  if (expectedWorkspaceRoot && !sameWorkspaceRoot(runtime.workspaceRoot, expectedWorkspaceRoot)) {
    return { state: "unknown", runtime, reason: "workspace_mismatch" };
  }

  const health = await probeBridge(runtime.port);
  if (health && health.workspaceId === workspaceId) {
    const pid = observePid(runtime.pid);
    if (pid !== "present") return { state: "unknown", runtime, reason: "pid_unknown" };
    return { state: "healthy", runtime };
  }
  if (health) {
    const pid = observePid(runtime.pid);
    if (pid === "missing") {
      return {
        state: "stale",
        runtime,
        reason: "pid_missing_workspace_mismatch",
        otherWorkspaceId: health.workspaceId,
      };
    }
    return { state: "unknown", runtime, reason: "workspace_mismatch" };
  }

  const pid = observePid(runtime.pid);
  if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
  return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
}

export async function findLiveBridge(workspaceId: string, expectedWorkspaceRoot?: string): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation(workspaceId, expectedWorkspaceRoot);
  return observation.state === "healthy" ? observation.runtime : null;
}

function sameWorkspaceRoot(left: string, right: string): boolean {
  try {
    const leftCanonical = fs.realpathSync.native(path.resolve(left));
    const rightCanonical = fs.realpathSync.native(path.resolve(right));
    return process.platform === "win32"
      ? leftCanonical.toLowerCase() === rightCanonical.toLowerCase()
      : leftCanonical === rightCanonical;
  } catch {
    return false;
  }
}

function sameRuntimeState(left: RuntimeState, right: RuntimeState): boolean {
  return (
    left.service === right.service &&
    left.version === right.version &&
    left.workspaceId === right.workspaceId &&
    left.workspaceRoot === right.workspaceRoot &&
    left.pid === right.pid &&
    left.port === right.port &&
    left.adminToken === right.adminToken &&
    left.publicUrl === right.publicUrl &&
    left.transport === right.transport &&
    left.startedAt === right.startedAt
  );
}

/**
 * Remove a runtime record only when the exact record that was observed as
 * stale is still present. A changed or unreadable record remains untouched.
 */
export function clearStaleRuntimeState(workspaceId: string, expected: RuntimeState): boolean {
  const current = readRuntimeState(workspaceId);
  if (!current || !sameRuntimeState(current, expected)) return false;
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: false });
    return true;
  } catch {
    return false;
  }
}

export { SERVICE_NAME, VERSION };
