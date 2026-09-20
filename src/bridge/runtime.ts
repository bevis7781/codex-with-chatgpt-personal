import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";

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
  startedAt: string;
}

export function runtimeFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.json`);
}

export function writeRuntimeState(state: RuntimeState): void {
  writeSecureJson(runtimeFile(state.workspaceId), state);
}

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(runtimeFile(workspaceId));
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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    if (body.status !== "ok" || typeof body.workspaceId !== "string" || !body.workspaceId) return null;
    return body;
  } catch {
    return null;
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
export async function findBridgeObservation(workspaceId: string): Promise<BridgeObservation> {
  const runtime = readRuntimeState(workspaceId);
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };

  const health = await probeBridge(runtime.port);
  if (health && health.workspaceId === workspaceId) {
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

export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation(workspaceId);
  return observation.state === "healthy" ? observation.runtime : null;
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
