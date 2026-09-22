import fs from "node:fs";
import path from "node:path";
import { getStateDir, writeSecureJson } from "../config/paths.js";
import {
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import {
  findBridgeObservation,
  probeBridge,
  readRuntimeState,
  type RuntimeState,
} from "../bridge/runtime.js";
import { adminFetch, ensureBridge } from "./daemon.js";
import { Workspace } from "../workspace/manager.js";
import { normalizeNamedTunnelHostname } from "../tunnel/cloudflared-named.js";
import { isNamedTunnelReady, readTunnelState, type TunnelState } from "../tunnel/state.js";
import { CLOUDFLARE_NETWORK_BLOCKED, isCloudflareNetworkBlocked } from "../tunnel/errors.js";

export const D022_GATE = "D-022" as const;
export const D022_APPROVAL_REQUIRED = "D022_APPROVAL_REQUIRED" as const;
export const D022_RECOVERY_BLOCKED = "D022_RECOVERY_BLOCKED" as const;

const TUNNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECOVERY_VERSION = 1 as const;
const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";

export type ApprovedContextRecoveryStatus = "pending" | "succeeded" | "blocked";

export interface RecoveryRuntimeIdentity {
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  port: number;
  startedAt: string;
  publicUrl: string | null;
}

export interface RecoveryIdentity {
  workspaceId: string;
  tunnelName: string;
  tunnelId: string | null;
  hostname: string;
  endpoint: string;
  mcpUrl: string;
  stateRoot: string;
}

export interface ApprovedContextRecoveryAttempt {
  startedAt: string;
  oldPid: number;
  newPid?: number;
  retryCount: number;
  result: "succeeded" | "blocked";
  code?: string;
}

export interface ApprovedContextRecoveryCandidate {
  version: typeof RECOVERY_VERSION;
  gate: typeof D022_GATE;
  status: ApprovedContextRecoveryStatus;
  workspaceId: string;
  workspaceRoot: string;
  diagnosedRuntime: RecoveryRuntimeIdentity;
  identity: RecoveryIdentity;
  detectedAt: string;
  retryCount: number;
  attempt?: ApprovedContextRecoveryAttempt;
}

export interface ApprovedContextRecoverySummary {
  available: boolean;
  scope: "current-workspace-bridge";
  workspaceId: string;
  tunnelName: string;
  tunnelId: string | null;
  hostname: string;
  endpoint: string;
  retryCount: number;
  reason?: string;
}

export interface RecoveryTunnelInfo {
  provider: string;
  running: boolean;
  url: string | null;
  pid?: number;
}

export interface RecoveryAdminInfo {
  workspaceId: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: RecoveryTunnelInfo;
  pid: number;
  startedAt: string;
}

interface ObservedBridge {
  runtime: RuntimeState;
  info: RecoveryAdminInfo;
}

export type RecoveryAdminFetch = <T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs?: number
) => Promise<T>;

export interface ApprovedContextRecoveryOps {
  observe: (workspaceRoot: string) => Promise<ObservedBridge>;
  stopCurrent: (workspaceRoot: string, expected: RuntimeState) => Promise<void>;
  start: (workspaceRoot: string) => Promise<RuntimeState>;
  adminFetch: RecoveryAdminFetch;
  isProcessAlive: (pid: number) => boolean;
}

export interface ApprovedContextRecoveryResult {
  status: "approval_required" | "succeeded" | "blocked";
  action: "awaiting-approval" | "reused" | "recovered" | "blocked";
  retryCount: number;
  oldPid?: number;
  newPid?: number;
  reason?: string;
  code?: string;
  candidate: ApprovedContextRecoverySummary;
}

export interface SetupRecoveryGate {
  action: "none" | "approval_required" | "blocked";
  candidate?: ApprovedContextRecoverySummary;
  reason?: string;
  code?: string;
}

export function recoveryCandidateFile(workspaceId: string): string {
  return path.join(path.resolve(getStateDir()), "recovery", `${workspaceId}.json`);
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return CASE_INSENSITIVE_PATHS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameNullable(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return normalizePublicUrl(left) === normalizePublicUrl(right);
}

export function sameRecoveryRuntime(left: RecoveryRuntimeIdentity, right: RecoveryRuntimeIdentity): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    samePath(left.workspaceRoot, right.workspaceRoot) &&
    left.pid === right.pid &&
    left.port === right.port &&
    left.startedAt === right.startedAt &&
    sameNullable(left.publicUrl, right.publicUrl)
  );
}

function runtimeIdentity(runtime: RuntimeState): RecoveryRuntimeIdentity {
  return {
    workspaceId: runtime.workspaceId,
    workspaceRoot: runtime.workspaceRoot,
    pid: runtime.pid,
    port: runtime.port,
    startedAt: runtime.startedAt,
    publicUrl: runtime.publicUrl,
  };
}

function validTunnelId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (!TUNNEL_ID_RE.test(normalized)) throw new Error("D-022 requires a valid persisted Named tunnel UUID.");
  return normalized;
}

function identityFromState(
  workspaceId: string,
  tunnel: TunnelState,
  endpoint: LastEndpoint | null
): RecoveryIdentity {
  if (tunnel.workspaceId !== workspaceId || !isNamedTunnelReady(tunnel) || !tunnel.tunnelName || !tunnel.hostname) {
    throw new Error("D-022 requires an existing configured Named tunnel for the current workspace.");
  }
  const hostname = normalizeNamedTunnelHostname(tunnel.hostname);
  const tunnelName = tunnel.tunnelName.trim();
  if (!tunnelName) throw new Error("D-022 requires an existing Named tunnel name.");
  const tunnelId = validTunnelId(tunnel.tunnelId);
  if (endpoint && endpoint.workspaceId !== workspaceId) {
    throw new Error("D-022 endpoint identity is bound to another workspace.");
  }

  const expectedEndpoint = `https://${hostname}`;
  const endpointUrl = endpoint?.publicUrl ? normalizePublicUrl(endpoint.publicUrl) : expectedEndpoint;
  if (endpoint?.publicUrl && endpointUrl !== expectedEndpoint) {
    throw new Error("D-022 endpoint identity does not match the existing Named hostname.");
  }
  const expectedMcp = mcpUrlFromPublic(endpointUrl);
  const mcpUrl = endpoint?.mcpUrl ? normalizePublicUrl(endpoint.mcpUrl) : expectedMcp;
  if (!mcpUrl || mcpUrl !== expectedMcp) {
    throw new Error("D-022 MCP endpoint identity is malformed or has drifted.");
  }

  return {
    workspaceId,
    tunnelName,
    tunnelId,
    hostname,
    endpoint: endpointUrl,
    mcpUrl,
    stateRoot: path.resolve(getStateDir()),
  };
}

export function currentRecoveryIdentity(workspaceId: string): RecoveryIdentity {
  return identityFromState(workspaceId, readTunnelState(workspaceId), readLastEndpoint(workspaceId));
}

function sameRecoveryIdentity(left: RecoveryIdentity, right: RecoveryIdentity): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.tunnelName === right.tunnelName &&
    left.tunnelId === right.tunnelId &&
    left.hostname === right.hostname &&
    sameNullable(left.endpoint, right.endpoint) &&
    sameNullable(left.mcpUrl, right.mcpUrl) &&
    samePath(left.stateRoot, right.stateRoot)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRuntimeIdentity(value: unknown): value is RecoveryRuntimeIdentity {
  if (!isRecord(value)) return false;
  return (
    typeof value.workspaceId === "string" &&
    typeof value.workspaceRoot === "string" &&
    Number.isInteger(value.pid) &&
    Number.isInteger(value.port) &&
    typeof value.startedAt === "string" &&
    (value.publicUrl === null || typeof value.publicUrl === "string")
  );
}

function isRecoveryIdentity(value: unknown): value is RecoveryIdentity {
  if (!isRecord(value)) return false;
  return (
    typeof value.workspaceId === "string" &&
    typeof value.tunnelName === "string" &&
    (value.tunnelId === null || typeof value.tunnelId === "string") &&
    typeof value.hostname === "string" &&
    typeof value.endpoint === "string" &&
    typeof value.mcpUrl === "string" &&
    typeof value.stateRoot === "string"
  );
}

function isCandidate(value: unknown): value is ApprovedContextRecoveryCandidate {
  if (!isRecord(value)) return false;
  if (typeof value.retryCount !== "number" || !Number.isInteger(value.retryCount)) return false;
  if (
    value.version !== RECOVERY_VERSION ||
    value.gate !== D022_GATE ||
    (value.status !== "pending" && value.status !== "succeeded" && value.status !== "blocked") ||
    typeof value.workspaceId !== "string" ||
    typeof value.workspaceRoot !== "string" ||
    !isRuntimeIdentity(value.diagnosedRuntime) ||
    !isRecoveryIdentity(value.identity) ||
    typeof value.detectedAt !== "string" ||
    value.retryCount < 0 ||
    value.retryCount > 1
  ) {
    return false;
  }
  if (value.attempt !== undefined) {
    if (!isRecord(value.attempt)) return false;
    if (
      typeof value.attempt.startedAt !== "string" ||
      !Number.isInteger(value.attempt.oldPid) ||
      (value.attempt.newPid !== undefined && !Number.isInteger(value.attempt.newPid)) ||
      !Number.isInteger(value.attempt.retryCount) ||
      (value.attempt.result !== "succeeded" && value.attempt.result !== "blocked") ||
      (value.attempt.code !== undefined && typeof value.attempt.code !== "string")
    ) {
      return false;
    }
  }
  return true;
}

export function readRecoveryCandidate(workspaceId: string): ApprovedContextRecoveryCandidate | null {
  const file = recoveryCandidateFile(workspaceId);
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to use an invalid D-022 recovery candidate: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error(`Refusing to use an unreadable D-022 recovery candidate: ${file}`);
  }
  if (!isCandidate(parsed)) throw new Error(`Refusing to use an invalid D-022 recovery candidate: ${file}`);
  return parsed;
}

function writeRecoveryCandidate(candidate: ApprovedContextRecoveryCandidate): void {
  writeSecureJson(recoveryCandidateFile(candidate.workspaceId), candidate);
}

function summary(candidate: ApprovedContextRecoveryCandidate, reason?: string): ApprovedContextRecoverySummary {
  return {
    available: candidate.status === "pending" && candidate.retryCount === 0,
    scope: "current-workspace-bridge",
    workspaceId: candidate.workspaceId,
    tunnelName: candidate.identity.tunnelName,
    tunnelId: candidate.identity.tunnelId,
    hostname: candidate.identity.hostname,
    endpoint: candidate.identity.endpoint,
    retryCount: candidate.retryCount,
    ...(reason ? { reason } : {}),
  };
}

export function summarizeApprovedContextCandidate(
  candidate: ApprovedContextRecoveryCandidate,
  reason?: string
): ApprovedContextRecoverySummary {
  return summary(candidate, reason);
}

/**
 * Persist a narrow diagnosis after a Named start failed with the known
 * Cloudflare network-context family. This never stops or starts a process.
 */
export async function captureApprovedContextCandidate(
  workspaceRoot: string,
  error: unknown
): Promise<ApprovedContextRecoveryCandidate | null> {
  if (!isCloudflareNetworkBlocked(error)) return null;
  const workspace = new Workspace(workspaceRoot);
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state !== "healthy") return null;
  if (observation.runtime.workspaceId !== workspace.id || !samePath(observation.runtime.workspaceRoot, workspace.root)) {
    return null;
  }
  const identity = identityFromState(workspace.id, readTunnelState(workspace.id), readLastEndpoint(workspace.id));
  const existing = readRecoveryCandidate(workspace.id);
  if (existing?.status === "pending") {
    if (!sameRecoveryRuntime(existing.diagnosedRuntime, runtimeIdentity(observation.runtime))) {
      throw new Error("D-022 runtime changed after diagnosis; recovery is blocked.");
    }
    if (!sameRecoveryIdentity(existing.identity, identity)) {
      throw new Error("D-022 Named or endpoint identity changed after diagnosis; recovery is blocked.");
    }
    return existing;
  }

  const candidate: ApprovedContextRecoveryCandidate = {
    version: RECOVERY_VERSION,
    gate: D022_GATE,
    status: "pending",
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    diagnosedRuntime: runtimeIdentity(observation.runtime),
    identity,
    detectedAt: new Date().toISOString(),
    retryCount: 0,
  };
  writeRecoveryCandidate(candidate);
  return candidate;
}

function defaultOps(): ApprovedContextRecoveryOps {
  const admin: RecoveryAdminFetch = adminFetch;
  return {
    observe: async (workspaceRoot) => {
      const workspace = new Workspace(workspaceRoot);
      const observation = await findBridgeObservation(workspace.id);
      if (observation.state !== "healthy") {
        throw new Error(`D-022 current Bridge is not healthy (${observation.state}).`);
      }
      const info = await admin<RecoveryAdminInfo>(observation.runtime, "GET", "/admin/info");
      return { runtime: observation.runtime, info };
    },
    stopCurrent: async (workspaceRoot, expected) => {
      const workspace = new Workspace(workspaceRoot);
      const current = readRuntimeState(workspace.id);
      if (!current || !sameRecoveryRuntime(runtimeIdentity(current), runtimeIdentity(expected))) {
        throw new Error("D-022 runtime changed before the current Bridge could be stopped.");
      }
      const health = await probeBridge(current.port);
      if (!health || health.workspaceId !== workspace.id) {
        throw new Error("D-022 current Bridge identity could not be re-established.");
      }
      await admin(current, "POST", "/admin/shutdown", 5_000);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const after = readRuntimeState(workspace.id);
        if (!after) return;
        if (!sameRecoveryRuntime(runtimeIdentity(after), runtimeIdentity(expected))) {
          throw new Error("D-022 runtime changed while stopping the current Bridge.");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("D-022 current Bridge did not stop cleanly; no process was killed.");
    },
    start: async (workspaceRoot) => (await ensureBridge(workspaceRoot)).runtime,
    adminFetch: admin,
    isProcessAlive: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function candidateBlocked(
  candidate: ApprovedContextRecoveryCandidate,
  oldPid: number,
  code: string,
  newPid?: number,
  retryCount = 0
): ApprovedContextRecoveryResult {
  const attempt: ApprovedContextRecoveryAttempt = {
    startedAt: new Date().toISOString(),
    oldPid,
    ...(newPid === undefined ? {} : { newPid }),
    retryCount,
    result: "blocked",
    code,
  };
  const next: ApprovedContextRecoveryCandidate = {
    ...candidate,
    status: "blocked",
    retryCount,
    attempt,
  };
  writeRecoveryCandidate(next);
  return {
    status: "blocked",
    action: "blocked",
    retryCount,
    oldPid,
    ...(newPid === undefined ? {} : { newPid }),
    reason: code,
    code,
    candidate: summary(next, code),
  };
}

function candidateSucceeded(
  candidate: ApprovedContextRecoveryCandidate,
  oldPid: number,
  newPid: number | undefined,
  retryCount: number,
  action: "reused" | "recovered"
): ApprovedContextRecoveryResult {
  const attempt: ApprovedContextRecoveryAttempt = {
    startedAt: new Date().toISOString(),
    oldPid,
    ...(newPid === undefined ? {} : { newPid }),
    retryCount,
    result: "succeeded",
  };
  const next: ApprovedContextRecoveryCandidate = {
    ...candidate,
    status: "succeeded",
    retryCount,
    attempt,
  };
  writeRecoveryCandidate(next);
  return {
    status: "succeeded",
    action,
    retryCount,
    oldPid,
    ...(newPid === undefined ? {} : { newPid }),
    candidate: summary(next),
  };
}

function currentMatchesCandidate(
  workspace: Workspace,
  candidate: ApprovedContextRecoveryCandidate,
  observed: ObservedBridge
): void {
  if (observed.info.workspaceId !== workspace.id || !samePath(observed.info.workspaceRoot, workspace.root)) {
    throw new Error("D-022 Bridge identity does not belong to the current workspace.");
  }
  if (observed.info.tunnel.provider !== "cloudflare-named") {
    throw new Error("D-022 requires the current Bridge to retain the existing Named provider.");
  }
  if (!sameRecoveryRuntime(candidate.diagnosedRuntime, runtimeIdentity(observed.runtime))) {
    throw new Error("D-022 runtime changed after diagnosis; recovery is blocked.");
  }
  const currentIdentity = currentRecoveryIdentity(workspace.id);
  if (!sameRecoveryIdentity(candidate.identity, currentIdentity)) {
    throw new Error("D-022 Named or endpoint identity changed after diagnosis; recovery is blocked.");
  }
}

function newRuntimeMatchesWorkspace(workspace: Workspace, runtime: RuntimeState, oldPid: number): void {
  if (runtime.workspaceId !== workspace.id || !samePath(runtime.workspaceRoot, workspace.root)) {
    throw new Error("D-022 replacement Bridge identity does not belong to the current workspace.");
  }
  if (runtime.pid === oldPid) throw new Error("D-022 replacement Bridge reused the diagnosed process identity.");
}

function verifyNamedRegistration(
  workspace: Workspace,
  candidate: ApprovedContextRecoveryCandidate,
  observed: ObservedBridge,
  ops: ApprovedContextRecoveryOps
): void {
  if (observed.info.workspaceId !== workspace.id || !samePath(observed.info.workspaceRoot, workspace.root)) {
    throw new Error("D-022 post-recovery Bridge identity is not the current workspace.");
  }
  if (observed.info.tunnel.provider !== "cloudflare-named") {
    throw new Error("D-022 refused a non-Named tunnel during recovery.");
  }
  if (!observed.info.tunnel.running || !observed.info.tunnel.url) {
    throw new Error("D-022 Named registration did not become healthy.");
  }
  if (!sameNullable(observed.info.tunnel.url, candidate.identity.endpoint)) {
    throw new Error("D-022 endpoint identity changed during recovery.");
  }
  if (!sameNullable(observed.info.publicUrl, candidate.identity.endpoint)) {
    throw new Error("D-022 Bridge public endpoint did not match the preserved identity.");
  }
  const cloudflaredPid = observed.info.tunnel.pid;
  if (!cloudflaredPid || !ops.isProcessAlive(cloudflaredPid)) {
    throw new Error("D-022 cloudflared process registration could not be verified.");
  }
  if (!isNamedTunnelReady(readTunnelState(workspace.id))) {
    throw new Error("D-022 Named state is no longer ready after recovery.");
  }
  const currentIdentity = currentRecoveryIdentity(workspace.id);
  if (!sameRecoveryIdentity(candidate.identity, currentIdentity)) {
    throw new Error("D-022 Named or endpoint identity changed after recovery.");
  }
  if (!sameNullable(observed.runtime.publicUrl, candidate.identity.endpoint)) {
    throw new Error("D-022 runtime endpoint identity changed after recovery.");
  }
}

/**
 * Inspect the current candidate before normal Personal setup. A pending
 * candidate for the same runtime must interrupt reuse; a changed runtime is
 * fail-closed rather than an invitation to start another Bridge.
 */
export async function inspectSetupRecovery(workspaceRoot: string): Promise<SetupRecoveryGate> {
  const workspace = new Workspace(workspaceRoot);
  const candidate = readRecoveryCandidate(workspace.id);
  if (!candidate) return { action: "none" };
  const candidateSummary = summary(candidate);
  if (candidate.status === "succeeded") {
    const observation = await findBridgeObservation(workspace.id);
    if (observation.state === "healthy") {
      try {
        const info = await adminFetch<RecoveryAdminInfo>(observation.runtime, "GET", "/admin/info");
        if (
          info.workspaceId === workspace.id &&
          samePath(info.workspaceRoot, workspace.root) &&
          info.tunnel.provider === "cloudflare-named" &&
           info.tunnel.running &&
           info.tunnel.url &&
           sameNullable(info.tunnel.url, candidate.identity.endpoint) &&
           sameNullable(observation.runtime.publicUrl, candidate.identity.endpoint) &&
           sameRecoveryIdentity(candidate.identity, currentRecoveryIdentity(workspace.id))
        ) {
          return { action: "none" };
        }
      } catch {
        // A terminal candidate remains blocked when the healthy post-check is unavailable.
      }
    }
    return {
      action: "blocked",
      candidate: candidateSummary,
      code: D022_RECOVERY_BLOCKED,
      reason: "A previous D-022 recovery is terminal but its healthy post-check is no longer available.",
    };
  }
  if (candidate.status !== "pending") {
    return {
      action: "blocked",
      candidate: candidateSummary,
      code: D022_RECOVERY_BLOCKED,
      reason: "A previous D-022 recovery attempt is terminal; a new automatic attempt is forbidden.",
    };
  }

  const observation = await findBridgeObservation(workspace.id);
  if (observation.state !== "healthy") {
    return {
      action: "blocked",
      candidate: candidateSummary,
      code: D022_RECOVERY_BLOCKED,
      reason: "The diagnosed Bridge is no longer healthy; runtime identity could not be re-established.",
    };
  }
  try {
    if (!sameRecoveryRuntime(candidate.diagnosedRuntime, runtimeIdentity(observation.runtime))) {
      return {
        action: "blocked",
        candidate: candidateSummary,
        code: D022_RECOVERY_BLOCKED,
        reason: "The diagnosed Bridge runtime changed; recovery is blocked.",
      };
    }
    if (!sameRecoveryIdentity(candidate.identity, currentRecoveryIdentity(workspace.id))) {
      return {
        action: "blocked",
        candidate: candidateSummary,
        code: D022_RECOVERY_BLOCKED,
        reason: "The preserved Named or endpoint identity changed; recovery is blocked.",
      };
    }
  } catch (error) {
    return {
      action: "blocked",
      candidate: candidateSummary,
      code: D022_RECOVERY_BLOCKED,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    action: "approval_required",
    candidate: candidateSummary,
    code: D022_APPROVAL_REQUIRED,
    reason: "Explicit local approval is required before replacing the current workspace Bridge.",
  };
}

/**
 * Replace only the diagnosed current-workspace Bridge when the Harness has
 * already obtained explicit local approval. The Named start is invoked once.
 */
export async function runApprovedContextRecovery(
  workspaceRoot: string,
  options: { approved: boolean; ops?: Partial<ApprovedContextRecoveryOps> }
): Promise<ApprovedContextRecoveryResult> {
  const workspace = new Workspace(workspaceRoot);
  const candidate = readRecoveryCandidate(workspace.id);
  if (!candidate) {
    const empty: ApprovedContextRecoveryCandidate = {
      version: RECOVERY_VERSION,
      gate: D022_GATE,
      status: "blocked",
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      diagnosedRuntime: { workspaceId: workspace.id, workspaceRoot: workspace.root, pid: 0, port: 0, startedAt: "", publicUrl: null },
      identity: {
        workspaceId: workspace.id,
        tunnelName: "",
        tunnelId: null,
        hostname: "",
        endpoint: "https://invalid.local",
        mcpUrl: "https://invalid.local/mcp",
        stateRoot: path.resolve(getStateDir()),
      },
      detectedAt: new Date().toISOString(),
      retryCount: 0,
    };
    return {
      status: "blocked",
      action: "blocked",
      retryCount: 0,
      reason: "No D-022 network-context diagnosis is pending.",
      code: D022_RECOVERY_BLOCKED,
      candidate: summary(empty, "No D-022 network-context diagnosis is pending."),
    };
  }
  if (!options.approved) {
    return {
      status: "approval_required",
      action: "awaiting-approval",
      retryCount: candidate.retryCount,
      reason: "Explicit local approval is required before replacing the current workspace Bridge.",
      code: D022_APPROVAL_REQUIRED,
      candidate: summary(candidate, "Explicit local approval is required."),
    };
  }
  if (candidate.status !== "pending" || candidate.retryCount !== 0) {
    return {
      status: "blocked",
      action: "blocked",
      retryCount: candidate.retryCount,
      oldPid: candidate.diagnosedRuntime.pid,
      reason: "A previous D-022 recovery attempt is terminal; a new automatic attempt is forbidden.",
      code: D022_RECOVERY_BLOCKED,
      candidate: summary(candidate, "A previous D-022 recovery attempt is terminal."),
    };
  }

  const ops: ApprovedContextRecoveryOps = { ...defaultOps(), ...options.ops };
  let before: ObservedBridge;
  try {
    before = await ops.observe(workspaceRoot);
    currentMatchesCandidate(workspace, candidate, before);
  } catch (error) {
    return candidateBlocked(candidate, candidate.diagnosedRuntime.pid, D022_RECOVERY_BLOCKED);
  }

  if (
    before.info.tunnel.provider === "cloudflare-named" &&
    before.info.tunnel.running &&
    before.info.tunnel.url &&
    sameNullable(before.info.tunnel.url, candidate.identity.endpoint)
  ) {
    return candidateSucceeded(candidate, before.runtime.pid, undefined, 0, "reused");
  }

  // Re-read immediately before the only mutation and refuse a changed target.
  let confirmed: ObservedBridge;
  try {
    confirmed = await ops.observe(workspaceRoot);
    currentMatchesCandidate(workspace, candidate, confirmed);
    await ops.stopCurrent(workspaceRoot, confirmed.runtime);
  } catch (error) {
    return candidateBlocked(candidate, before.runtime.pid, D022_RECOVERY_BLOCKED);
  }

  let replacement: RuntimeState;
  try {
    replacement = await ops.start(workspaceRoot);
    newRuntimeMatchesWorkspace(workspace, replacement, before.runtime.pid);
  } catch (error) {
    return candidateBlocked(candidate, before.runtime.pid, D022_RECOVERY_BLOCKED);
  }

  try {
    const started = await ops.observe(workspaceRoot);
    newRuntimeMatchesWorkspace(workspace, started.runtime, before.runtime.pid);
    if (started.info.workspaceId !== workspace.id || !samePath(started.info.workspaceRoot, workspace.root)) {
      throw new Error("D-022 replacement Bridge identity does not belong to the current workspace.");
    }
    if (started.info.tunnel.provider !== "cloudflare-named") {
      throw new Error("D-022 replacement Bridge did not retain the existing Named provider.");
    }
    if (!sameRecoveryIdentity(candidate.identity, currentRecoveryIdentity(workspace.id))) {
      throw new Error("D-022 Named or endpoint identity changed before the single retry.");
    }

    // This is the sole approved-context Named retry. No loop or second restart.
    await ops.adminFetch(replacement, "POST", "/admin/tunnel/start", 90_000);
    const completed = await ops.observe(workspaceRoot);
    verifyNamedRegistration(workspace, candidate, completed, ops);
    return candidateSucceeded(candidate, before.runtime.pid, completed.runtime.pid, 1, "recovered");
  } catch (error) {
    const code = isCloudflareNetworkBlocked(error) ? CLOUDFLARE_NETWORK_BLOCKED : D022_RECOVERY_BLOCKED;
    return candidateBlocked(candidate, before.runtime.pid, code, replacement.pid, 1);
  }
}
