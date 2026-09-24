import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureBridge, adminFetch } from "../process/daemon.js";
import { findBridgeObservation, type RuntimeState } from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";
import { readSecureMcpConfig, type SecureMcpConfig } from "./config.js";
import {
  OFFICIAL_TUNNEL_CLIENT_SHA256,
  OFFICIAL_TUNNEL_CLIENT_VERSION,
  readManagedRuntime,
  type ManagedRuntimeManifest,
} from "./managed-client.js";
import {
  readSecureMcpJson,
  resolveSecureMcpPaths,
  secureMcpRuntimeFile,
  writeSecureMcpJson,
  type SecureMcpPaths,
} from "./paths.js";
import {
  readSecureMcpRegistry,
  validateCurrentWorkspaceRecord,
  SECURE_MCP_TUNNEL_ID,
  type SecureMcpWorkspaceRecord,
} from "./registry.js";
import { readRuntimeKey, runtimeKeyStatus } from "./secrets.js";
import {
  redactControlPlaneProxy,
  sanitizeSecureMcpEnv,
  secureMcpChildEnv,
  validateControlPlaneProxy,
  validateLoopbackUrl,
  validateLoopbackMcpUrl,
} from "./proxy.js";

export const SECURE_MCP_RUNTIME_SCHEMA_VERSION = 1 as const;
export const SECURE_MCP_RUNTIME_ALIAS_PREFIX = "c2c-";

export type SecureMcpResultStatus = "PASS" | "BLOCKED" | "FAIL" | "SKIPPED";

export interface SecureMcpRuntimeState {
  schemaVersion: typeof SECURE_MCP_RUNTIME_SCHEMA_VERSION;
  workspaceId: string;
  workspaceRoot: string;
  tunnelId: string;
  alias: string;
  pid: number;
  bridgePort: number;
  mcpServerUrl: string;
  healthUrl: string | null;
  readyUrl: string | null;
  controlPlanePollHealth: string;
  binaryVersion: string;
  binarySha256: string;
  startedAt: string;
  observedAt: string;
}

export interface SecureMcpWorkspaceResult {
  workspaceId: string;
  workspaceRoot: string;
  tunnelId: string;
  enabled: boolean;
  status: SecureMcpResultStatus;
  reasonCode?: string;
  bridge?: {
    state: "healthy" | "stopped" | "stale" | "ambiguous" | "foreign";
    port?: number;
  };
  runtime?: {
    state: "ready" | "stopped" | "missing" | "ambiguous" | "mismatch" | "not-imported";
    alias: string;
    pid?: number;
    mcpServerUrl?: string;
    controlPlanePollHealth?: string;
  };
}

export interface SecureMcpBatchResult {
  ok: boolean;
  config: {
    schemaVersion: number;
    proxy: { configured: boolean; url: string | null };
    key: { configured: boolean; decryptable: boolean; protection: string };
    managedRuntime: { imported: boolean; version?: string; sha256?: string; commit?: string };
  };
  results: SecureMcpWorkspaceResult[];
  invalid: Array<{ file: string; error: string }>;
}

export interface NativeCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface NativeCommandRunner {
  run(binary: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }): NativeCommandResult;
}

const defaultRunner: NativeCommandRunner = {
  run(binary, args, options) {
    const result = spawnSync(binary, args, {
      env: options.env,
      encoding: "utf8",
      timeout: options.timeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error instanceof Error ? result.error : undefined,
    };
  },
};

interface NativeStatus {
  found: boolean;
  state: "running" | "ready" | "stopped" | "failed" | "unknown";
  processRunning: boolean | null;
  alias: string | null;
  workspaceId: string | null;
  pid: number | null;
  tunnelId: string | null;
  mcpServerUrl: string | null;
  targetKind: string | null;
  targetAmbiguous: boolean;
  identityAmbiguous: boolean;
  healthUrl: string | null;
  readyUrl: string | null;
  health: boolean | null;
  ready: boolean | null;
  controlPlanePollHealth: string;
  binaryPath: string | null;
  raw: unknown;
}

type NativeAssessment =
  | { state: "missing" }
  | { state: "stopped" }
  | { state: "ready"; status: NativeStatus }
  | { state: "mismatch"; status: NativeStatus; reasonCode: string }
  | { state: "ambiguous"; status: NativeStatus; reasonCode: string };

function errorCode(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]+$/.test(message) ? message : fallback;
}

function secureError(code: string, message = code): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function aliasFor(workspaceId: string): string {
  if (!/^[0-9a-f]{12}$/.test(workspaceId)) throw secureError("SECURE_MCP_WORKSPACE_ID_INVALID");
  return `${SECURE_MCP_RUNTIME_ALIAS_PREFIX}${workspaceId}`;
}

function parseJsonOutput(output: string): unknown | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // The native client may print a short human-readable line before JSON.
    }
  }
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizedKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function directValue(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const wanted = new Set(keys.map(normalizedKey));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (wanted.has(normalizedKey(key))) return child;
  }
  return undefined;
}

function findValue(value: unknown, keys: string[], depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return undefined;
  const wanted = new Set(keys.map(normalizedKey));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (wanted.has(normalizedKey(key))) return child;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findValue(child, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function stringValue(value: unknown, keys: string[]): string | null {
  const found = findValue(value, keys);
  return typeof found === "string" && found.trim() ? found.trim() : null;
}

function directStringValue(value: unknown, keys: string[]): string | null {
  const found = directValue(value, keys);
  return typeof found === "string" && found.trim() ? found.trim() : null;
}

function booleanValue(value: unknown, keys: string[]): boolean | null {
  const found = findValue(value, keys);
  return typeof found === "boolean" ? found : null;
}

function healthBooleanValue(value: unknown, keys: string[]): boolean | null {
  const found = findValue(value, keys);
  if (typeof found === "boolean") return found;
  if (typeof found !== "string") return null;
  const normalized = found.trim().toLowerCase();
  if (["true", "ok", "ready", "healthy"].includes(normalized)) return true;
  if (["false", "error", "failed", "unhealthy", "not_ready", "not-ready"].includes(normalized)) return false;
  return null;
}

function directHealthBooleanValue(value: unknown, keys: string[]): boolean | null {
  const found = directValue(value, keys);
  if (typeof found === "boolean") return found;
  if (typeof found !== "string") return null;
  const normalized = found.trim().toLowerCase();
  if (["true", "ok", "ready", "healthy"].includes(normalized)) return true;
  if (["false", "error", "failed", "unhealthy", "not_ready", "not-ready"].includes(normalized)) return false;
  return null;
}

function pollHealthValue(value: unknown): string {
  const raw = directValue(value, ["control_plane_poll_health", "controlplanepollhealth", "poll_health", "pollhealth"]);
  const found = typeof raw === "string" ? raw : directStringValue(raw, ["state", "status", "phase"]);
  if (!found) return "unknown";
  const normalized = found.toLowerCase();
  if (normalized.includes("healthy") || normalized === "ok" || normalized === "ready") return "healthy";
  if (normalized.includes("fail") || normalized.includes("error") || normalized.includes("unhealthy")) return "unhealthy";
  if (normalized.includes("poll") || normalized.includes("connect") || normalized.includes("run")) return "running";
  return "unknown";
}

function numberValue(value: unknown, keys: string[]): number | null {
  const found = findValue(value, keys);
  if (typeof found === "number" && Number.isInteger(found) && found > 0) return found;
  if (typeof found === "string" && /^\d+$/.test(found)) {
    const parsed = Number(found);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function directNumberValue(value: unknown, keys: string[]): number | null {
  const found = directValue(value, keys);
  if (typeof found === "number" && Number.isInteger(found) && found > 0) return found;
  if (typeof found === "string" && /^\d+$/.test(found)) {
    const parsed = Number(found);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function parseNativeStatus(output: string): NativeStatus {
  const raw = parseJsonOutput(output);
  if (!raw) throw secureError("SECURE_MCP_RUNTIME_STATUS_INVALID");
  const processInfo = directValue(raw, ["process"]);
  const processTargetKind = directStringValue(processInfo, ["target_kind", "targetkind"]);
  const processTargetValue = directStringValue(processInfo, ["target_value", "targetvalue"]);
  const processTargetIsServerUrl = processTargetKind?.toLowerCase() === "server_url";
  const topLevelMcpServerUrl = directStringValue(raw, ["mcp_server_url", "mcpserverurl", "target_url", "targeturl"]);
  const processMcpServerUrl = processTargetIsServerUrl ? processTargetValue : null;
  const processPid = directNumberValue(processInfo, ["pid"]);
  const topLevelPid = directNumberValue(raw, ["pid", "process_id", "processid", "runtime_pid"]);
  const processTunnelId = directStringValue(processInfo, ["tunnel_id", "tunnelid"]);
  const topLevelTunnelId = directStringValue(raw, ["tunnel_id", "tunnelid"]);
  const processWorkspaceId = directStringValue(processInfo, ["workspace_id", "workspaceid"]);
  const topLevelWorkspaceId = directStringValue(raw, ["workspace_id", "workspaceid"]);
  const processAlias = directStringValue(processInfo, ["alias", "runtime_alias"]);
  const topLevelAlias = directStringValue(raw, ["alias", "runtime_alias"]);
  const processBinaryPath = directStringValue(processInfo, ["binary", "binary_path", "binarypath", "tunnel_client_bin", "tunnelclientbin"]);
  const topLevelBinaryPath = directStringValue(raw, ["binary", "binary_path", "binarypath", "tunnel_client_bin", "tunnelclientbin"]);
  const valuesConflict = <T,>(left: T | null, right: T | null): boolean => left !== null && right !== null && left !== right;
  const targetAmbiguous =
    valuesConflict(
      topLevelMcpServerUrl ? normalizeUrl(topLevelMcpServerUrl) : null,
      processMcpServerUrl ? normalizeUrl(processMcpServerUrl) : null
    ) ||
    Boolean(topLevelMcpServerUrl && processTargetKind && !processTargetIsServerUrl);
  const identityAmbiguous =
    valuesConflict(topLevelAlias, processAlias) ||
    valuesConflict(topLevelWorkspaceId, processWorkspaceId) ||
    valuesConflict(topLevelPid, processPid) ||
    valuesConflict(topLevelTunnelId, processTunnelId) ||
    Boolean(
      topLevelBinaryPath &&
        processBinaryPath &&
        !samePath(path.resolve(topLevelBinaryPath), path.resolve(processBinaryPath))
    );
  const local = directValue(raw, ["local"]);
  const effectiveHealth = directValue(local, ["effective_health", "effectivehealth"]);
  const healthz = directValue(effectiveHealth, ["healthz"]);
  const readyz = directValue(effectiveHealth, ["readyz"]);
  const stateRaw = (
    directStringValue(raw, ["runtime_state", "runtimestate"]) ??
    stringValue(raw, ["status", "state", "phase"]) ??
    "unknown"
  ).toLowerCase();
  const state: NativeStatus["state"] = stateRaw.includes("fail") || stateRaw.includes("error") || stateRaw.includes("unhealthy") || stateRaw.includes("not_ready") || stateRaw.includes("not-ready")
    ? "failed"
    : stateRaw.includes("ready")
      ? "ready"
      : stateRaw.includes("stop") || stateRaw.includes("exit") || stateRaw.includes("not_found") || stateRaw.includes("not running")
        ? "stopped"
        : stateRaw.includes("run") || stateRaw.includes("connect") || stateRaw === "healthy"
          ? "running"
          : "unknown";
  const health =
    directHealthBooleanValue(raw, ["healthy", "healthz", "health_ok", "healthok", "health"]) ??
    healthBooleanValue(healthz, ["ok", "status"]);
  const ready =
    directHealthBooleanValue(raw, ["ready", "readyz", "readiness", "readiness_ok", "readinessok"]) ??
    healthBooleanValue(readyz, ["ok", "status"]);
  return {
    found: true,
    state,
    processRunning: directHealthBooleanValue(raw, ["process_running", "processrunning"]),
    alias: stringValue(raw, ["alias", "runtime_alias"]),
    workspaceId: stringValue(raw, ["workspace_id", "workspaceid"]),
    pid:
      directNumberValue(raw, ["pid", "process_id", "processid", "runtime_pid"]) ??
      directNumberValue(processInfo, ["pid"]) ??
      numberValue(raw, ["pid", "process_id", "processid", "runtime_pid"]),
    tunnelId:
      directStringValue(raw, ["tunnel_id", "tunnelid"]) ??
      directStringValue(processInfo, ["tunnel_id", "tunnelid"]) ??
      stringValue(raw, ["tunnel_id", "tunnelid"]),
    targetKind: processTargetKind?.toLowerCase() ?? null,
    targetAmbiguous,
    identityAmbiguous,
    mcpServerUrl:
      topLevelMcpServerUrl ??
      (processTargetKind?.toLowerCase() === "server_url" ? processTargetValue : null) ??
      stringValue(raw, ["mcp_server_url", "mcpserverurl", "target_url", "targeturl"]),
    healthUrl:
      directStringValue(raw, ["health_url", "healthz_url", "health_endpoint", "healthendpoint"]) ??
      directStringValue(healthz, ["url"]),
    readyUrl:
      directStringValue(raw, ["ready_url", "readyz_url", "readiness_url", "readinessendpoint"]) ??
      directStringValue(readyz, ["url"]),
    health,
    ready,
    controlPlanePollHealth: pollHealthValue(raw),
    binaryPath: stringValue(raw, ["binary", "binary_path", "binarypath", "tunnel_client_bin", "tunnelclientbin"]),
    raw,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMissingStatus(result: NativeCommandResult, alias?: string): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (/not found|not running|unknown alias|does not exist|no runtime|missing/.test(text)) return true;
  if (!alias) return false;
  const escapedAlias = escapeRegExp(alias.toLowerCase());
  return new RegExp(
    `\\balias\\s+${escapedAlias}\\s+is\\s+not\\s+known;\\s*run\\s+create\\s+or\\s+connect\\s+first\\b`
  ).test(text);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function normalizeUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function trustedChildEnv(
  config: SecureMcpConfig,
  mcpServerUrl: string | null,
  runtimeKey?: string,
  paths?: SecureMcpPaths
): NodeJS.ProcessEnv {
  const env = runtimeKey && mcpServerUrl
    ? secureMcpChildEnv(process.env, { runtimeKey, mcpServerUrl, config })
    : sanitizeSecureMcpEnv(process.env);
  env.NO_PROXY = "127.0.0.1,localhost,::1";
  env.no_proxy = env.NO_PROXY;
  if (mcpServerUrl) env.MCP_SERVER_URL = mcpServerUrl;
  else delete env.MCP_SERVER_URL;
  env.HARPOON_ALLOW_PLAINTEXT_HTTP = "true";
  if (runtimeKey) env.C2C_SECURE_MCP_RUNTIME_KEY = runtimeKey;
  else delete env.C2C_SECURE_MCP_RUNTIME_KEY;
  if (config.controlPlaneProxy) env.CONTROL_PLANE_HTTP_PROXY = validateControlPlaneProxy(config.controlPlaneProxy);
  else delete env.CONTROL_PLANE_HTTP_PROXY;
  if (paths) {
    env.TUNNEL_CLIENT_STATE_DIR = paths.managedStateDir;
    env.TUNNEL_CLIENT_PROFILE_DIR = paths.managedProfileDir;
  }
  return env;
}

function readRuntimeState(paths: SecureMcpPaths, workspaceId: string): SecureMcpRuntimeState | null {
  const raw = readSecureMcpJson<unknown>(secureMcpRuntimeFile(paths, workspaceId));
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw secureError("SECURE_MCP_RUNTIME_STATE_CORRUPT");
  const value = raw as Record<string, unknown>;
  const expectedKeys = [
    "schemaVersion",
    "workspaceId",
    "workspaceRoot",
    "tunnelId",
    "alias",
    "pid",
    "bridgePort",
    "mcpServerUrl",
    "healthUrl",
    "readyUrl",
    "controlPlanePollHealth",
    "binaryVersion",
    "binarySha256",
    "startedAt",
    "observedAt",
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index]) ||
    value.schemaVersion !== SECURE_MCP_RUNTIME_SCHEMA_VERSION ||
    value.workspaceId !== workspaceId ||
    typeof value.workspaceRoot !== "string" ||
    typeof value.tunnelId !== "string" ||
    typeof value.alias !== "string" ||
    typeof value.pid !== "number" ||
    typeof value.bridgePort !== "number" ||
    typeof value.mcpServerUrl !== "string" ||
    (value.healthUrl !== null && typeof value.healthUrl !== "string") ||
    (value.readyUrl !== null && typeof value.readyUrl !== "string") ||
    typeof value.controlPlanePollHealth !== "string" ||
    typeof value.binaryVersion !== "string" ||
    typeof value.binarySha256 !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.observedAt !== "string"
  ) {
    throw secureError("SECURE_MCP_RUNTIME_STATE_CORRUPT");
  }
  if (
    !SECURE_MCP_TUNNEL_ID.test(value.tunnelId) ||
    value.alias !== aliasFor(workspaceId) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !Number.isSafeInteger(value.bridgePort) ||
    value.bridgePort <= 0 ||
    value.binarySha256 !== OFFICIAL_TUNNEL_CLIENT_SHA256 ||
    value.binaryVersion !== OFFICIAL_TUNNEL_CLIENT_VERSION ||
    !["unknown", "running", "healthy", "unhealthy"].includes(value.controlPlanePollHealth)
  ) {
    throw secureError("SECURE_MCP_RUNTIME_STATE_CORRUPT");
  }
  try {
    const workspace = new Workspace(value.workspaceRoot);
    if (workspace.id !== workspaceId || !samePath(workspace.root, value.workspaceRoot)) {
      throw secureError("SECURE_MCP_RUNTIME_IDENTITY_MISMATCH");
    }
    validateLoopbackMcpUrl(value.mcpServerUrl);
    if (value.healthUrl !== null) validateLoopbackUrl(value.healthUrl);
    if (value.readyUrl !== null) validateLoopbackUrl(value.readyUrl);
    const target = new URL(value.mcpServerUrl);
    if (Number(target.port) !== value.bridgePort) throw secureError("SECURE_MCP_RUNTIME_STATE_CORRUPT");
    for (const timestamp of [value.startedAt, value.observedAt]) {
      if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
        throw secureError("SECURE_MCP_RUNTIME_STATE_CORRUPT");
      }
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string" &&
      (error as { code: string }).code.startsWith("SECURE_MCP_")
    ) {
      throw error;
    }
    throw secureError("SECURE_MCP_RUNTIME_STATE_CORRUPT");
  }
  return value as unknown as SecureMcpRuntimeState;
}

function writeRuntimeState(paths: SecureMcpPaths, state: SecureMcpRuntimeState): void {
  validateLoopbackMcpUrl(state.mcpServerUrl);
  const target = new URL(state.mcpServerUrl);
  if (Number(target.port) !== state.bridgePort) throw secureError("SECURE_MCP_RUNTIME_STATE_CORRUPT");
  writeSecureMcpJson(secureMcpRuntimeFile(paths, state.workspaceId), state);
}

function clearRuntimeState(paths: SecureMcpPaths, workspaceId: string): void {
  const file = secureMcpRuntimeFile(paths, workspaceId);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw secureError("SECURE_MCP_RUNTIME_STATE_CORRUPT");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw secureError("SECURE_MCP_RUNTIME_STATE_CORRUPT");
  fs.rmSync(file, { force: false });
}

async function fetchBridgeHealth(url: string, expectedStatus: string): Promise<boolean> {
  try {
    const localUrl = validateLoopbackUrl(url);
    const response = await fetch(localUrl, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { status?: unknown; workspaceId?: unknown } | null;
    return body?.status === expectedStatus || body?.status === "ok";
  } catch {
    return false;
  }
}

async function fetchNativeHealth(url: string, expectedStatus: string): Promise<boolean> {
  try {
    const localUrl = validateLoopbackUrl(url);
    const response = await fetch(localUrl, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const text = (await response.text()).trim();
    try {
      const body = JSON.parse(text) as { status?: unknown };
      if (body.status === expectedStatus || body.status === "ok") return true;
    } catch {
      // Official tunnel-client health endpoints use plain text.
    }
    const normalized = text.toLowerCase();
    return expectedStatus === "ok" ? normalized === "live" : expectedStatus === "ready" && normalized.startsWith("ready");
  } catch {
    return false;
  }
}

async function bridgeReadiness(runtime: RuntimeState, workspaceId: string): Promise<boolean> {
  const base = `http://127.0.0.1:${runtime.port}`;
  const [health, ready] = await Promise.all([
    fetchBridgeHealth(`${base}/healthz`, "ok"),
    fetchBridgeHealth(`${base}/readyz`, "ready"),
  ]);
  if (!health || !ready) return false;
  const observed = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2_000) })
    .then((response) => response.json() as Promise<{ workspaceId?: unknown }>)
    .catch(() => null);
  return observed?.workspaceId === workspaceId;
}

function nativeStatus(
  binary: string,
  alias: string,
  env: NodeJS.ProcessEnv,
  runner: NativeCommandRunner,
  timeoutMs: number
): NativeStatus | null {
  const result = runner.run(binary, ["runtimes", "status", alias, "--json"], { env, timeoutMs });
  if (result.error && result.status === null && !result.stdout && !result.stderr) {
    throw secureError("SECURE_MCP_RUNTIME_STATUS_FAILED");
  }
  if (result.status !== 0) {
    if (isMissingStatus(result, alias)) return null;
    throw secureError("SECURE_MCP_RUNTIME_STATUS_FAILED");
  }
  return parseNativeStatus(result.stdout);
}

async function assessNativeStatus(opts: {
  status: NativeStatus | null;
  expected: SecureMcpWorkspaceRecord;
  alias: string;
  mcpServerUrl: string | null;
  managedBinary: string;
  managed: ManagedRuntimeManifest;
}): Promise<NativeAssessment> {
  const { status } = opts;
  if (!status) return { state: "missing" };
  if (status.identityAmbiguous) {
    return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_IDENTITY_AMBIGUOUS" };
  }
  if (status.targetAmbiguous) {
    return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_TARGET_AMBIGUOUS" };
  }
  if (status.state === "stopped") return { state: "stopped" };
  if (status.state === "failed") {
    if (status.pid && processIsAlive(status.pid)) {
      return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_FAILED_LIVE" };
    }
    return { state: "stopped" };
  }
  if (status.processRunning === false) {
    if (status.pid && processIsAlive(status.pid)) {
      return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_PROCESS_STATE_MISMATCH" };
    }
    return { state: "stopped" };
  }
  if (status.alias !== opts.alias) {
    return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_ALIAS_MISMATCH" };
  }
  if (status.workspaceId && status.workspaceId !== opts.expected.workspaceId) {
    return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_WORKSPACE_MISMATCH" };
  }
  if (!status.pid || !processIsAlive(status.pid)) return { state: "stopped" };
  if (status.tunnelId !== opts.expected.tunnelId) {
    return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_TUNNEL_MISMATCH" };
  }
  const targetChanged =
    !status.mcpServerUrl ||
    normalizeUrl(status.mcpServerUrl) !== normalizeUrl(opts.mcpServerUrl ?? "");
  if (status.binaryPath) {
    const binary = path.resolve(status.binaryPath);
    const managed = path.resolve(opts.managedBinary);
    if (!samePath(binary, managed)) {
      return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_BINARY_MISMATCH" };
    }
  }
  if (status.health === false) {
    return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_HEALTH_FAILED" };
  }
  if (status.ready === false) {
    return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_READINESS_FAILED" };
  }
  const healthEvidence = status.health === true || status.state === "ready";
  const readyEvidence = status.ready === true || status.state === "ready";
  if (status.healthUrl && !(await fetchNativeHealth(status.healthUrl, "ok"))) {
    return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_HEALTH_FAILED" };
  }
  if (status.readyUrl && !(await fetchNativeHealth(status.readyUrl, "ready"))) {
    return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_READINESS_FAILED" };
  }
  if (status.controlPlanePollHealth === "unhealthy") {
    return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_CONTROL_PLANE_UNHEALTHY" };
  }
  if (!healthEvidence || !readyEvidence) {
    return { state: "ambiguous", status, reasonCode: "SECURE_MCP_RUNTIME_READINESS_UNAVAILABLE" };
  }
  if (targetChanged) return { state: "mismatch", status, reasonCode: "SECURE_MCP_RUNTIME_TARGET_CHANGED" };
  return { state: "ready", status };
}

function persistedStateOwnsTargetChange(opts: {
  previous: SecureMcpRuntimeState | null;
  status: NativeStatus;
  record: SecureMcpWorkspaceRecord;
  workspaceRoot: string;
  alias: string;
  managed: ManagedRuntimeManifest;
  managedBinary: string;
}): boolean {
  const { previous, status, record, workspaceRoot, alias, managed, managedBinary } = opts;
  return Boolean(
    previous &&
      status.targetKind === "server_url" &&
      status.mcpServerUrl &&
      status.alias === alias &&
      (status.workspaceId === null || status.workspaceId === record.workspaceId) &&
      status.pid !== null &&
      status.tunnelId === record.tunnelId &&
      (!status.binaryPath || samePath(path.resolve(status.binaryPath), path.resolve(managedBinary))) &&
      previous.workspaceId === record.workspaceId &&
      samePath(previous.workspaceRoot, workspaceRoot) &&
      previous.tunnelId === record.tunnelId &&
      previous.alias === alias &&
      previous.pid === status.pid &&
      normalizeUrl(previous.mcpServerUrl) === normalizeUrl(status.mcpServerUrl) &&
      previous.binaryVersion === managed.version &&
      previous.binarySha256 === managed.sha256
  );
}

function nativeConnect(opts: {
  binary: string;
  alias: string;
  tunnelId: string;
  mcpServerUrl: string;
  paths: SecureMcpPaths;
  runtimeKey: string;
  config: SecureMcpConfig;
  runner: NativeCommandRunner;
  timeoutMs: number;
}): void {
  validateLoopbackMcpUrl(opts.mcpServerUrl);
  const env = trustedChildEnv(opts.config, opts.mcpServerUrl, opts.runtimeKey, opts.paths);
  const args = [
    "runtimes",
    "connect",
    "--json",
    "--alias",
    opts.alias,
    "--profile",
    opts.alias,
    "--profile-dir",
    opts.paths.managedProfileDir,
    "--runtime-api-key",
    "env:C2C_SECURE_MCP_RUNTIME_KEY",
    "--tunnel-client-bin",
    opts.binary,
    "--tunnel-id",
    opts.tunnelId,
    "--mcp-server-url",
    opts.mcpServerUrl,
  ];
  const result = opts.runner.run(opts.binary, args, { env, timeoutMs: opts.timeoutMs });
  if (result.status !== 0 || result.error) throw secureError("SECURE_MCP_RUNTIME_CONNECT_FAILED");
}

function nativeStop(opts: {
  binary: string;
  alias: string;
  env: NodeJS.ProcessEnv;
  runner: NativeCommandRunner;
  timeoutMs: number;
  acceptMissing?: boolean;
}): void {
  const result = opts.runner.run(opts.binary, ["runtimes", "stop", opts.alias, "--json"], {
    env: opts.env,
    timeoutMs: opts.timeoutMs,
  });
  if (
    result.status !== 0 &&
    !(opts.acceptMissing !== false && isMissingStatus(result, opts.alias))
  ) {
    throw secureError("SECURE_MCP_RUNTIME_STOP_FAILED");
  }
}

async function waitForNativeReady(opts: {
  binary: string;
  alias: string;
  expected: SecureMcpWorkspaceRecord;
  mcpServerUrl: string;
  managed: ManagedRuntimeManifest;
  env: NodeJS.ProcessEnv;
  runner: NativeCommandRunner;
  timeoutMs: number;
  pollMs: number;
}): Promise<NativeStatus> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastAssessment: NativeAssessment | null = null;
  while (Date.now() <= deadline) {
    const status = nativeStatus(opts.binary, opts.alias, opts.env, opts.runner, Math.min(opts.timeoutMs, 10_000));
    lastAssessment = await assessNativeStatus({
      status,
      expected: opts.expected,
      alias: opts.alias,
      mcpServerUrl: opts.mcpServerUrl,
      managedBinary: opts.binary,
      managed: opts.managed,
    });
    if (lastAssessment.state === "ready") return lastAssessment.status;
    if (lastAssessment.state === "ambiguous" || lastAssessment.state === "mismatch") {
      throw secureError(lastAssessment.reasonCode);
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
  }
  throw secureError(
    lastAssessment?.state === "stopped" ? "SECURE_MCP_RUNTIME_EXITED" : "SECURE_MCP_RUNTIME_READY_TIMEOUT"
  );
}

async function liveBridgeFor(record: SecureMcpWorkspaceRecord): Promise<{
  runtime: RuntimeState;
  info: { workspaceId: string; workspaceRoot: string; publicUrl: string | null; tunnel: { provider: string } };
  ready: boolean;
}> {
  validateCurrentWorkspaceRecord(record);
  const ensured = await ensureBridge(record.workspaceRoot, { localOnly: true });
  const info = await adminFetch<{
    workspaceId: string;
    workspaceRoot: string;
    pid: number;
    publicUrl: string | null;
    tunnel: { provider: string };
  }>(ensured.runtime, "GET", "/admin/info");
  if (
    info.workspaceId !== record.workspaceId ||
    !samePath(info.workspaceRoot, record.workspaceRoot) ||
    info.pid !== ensured.runtime.pid ||
    info.publicUrl !== null ||
    info.tunnel.provider !== "local-only"
  ) {
    throw secureError("SECURE_MCP_BRIDGE_FOREIGN_PUBLIC_TRANSPORT");
  }
  const ready = await bridgeReadiness(ensured.runtime, record.workspaceId);
  if (!ready) throw secureError("SECURE_MCP_BRIDGE_NOT_READY");
  return { runtime: ensured.runtime, info, ready };
}

async function connectOne(opts: {
  record: SecureMcpWorkspaceRecord;
  paths: SecureMcpPaths;
  config: SecureMcpConfig;
  managed: ManagedRuntimeManifest;
  runtimeKey: string;
  runner: NativeCommandRunner;
  timeoutMs: number;
  pollMs: number;
}): Promise<SecureMcpWorkspaceResult> {
  const workspace = validateCurrentWorkspaceRecord(opts.record);
  const bridge = await liveBridgeFor(opts.record);
  const alias = aliasFor(workspace.id);
  const mcpServerUrl = `http://127.0.0.1:${bridge.runtime.port}/mcp`;
  let previous = readRuntimeState(opts.paths, opts.record.workspaceId);
  const statusEnv = trustedChildEnv(opts.config, mcpServerUrl, undefined, opts.paths);
  const existing = nativeStatus(opts.paths.managedClientBin, alias, statusEnv, opts.runner, 10_000);
  const assessment = await assessNativeStatus({
    status: existing,
    expected: opts.record,
    alias,
    mcpServerUrl,
    managedBinary: opts.paths.managedClientBin,
    managed: opts.managed,
  });
  if (assessment.state === "ambiguous") throw secureError(assessment.reasonCode);
  if (assessment.state === "mismatch") {
    if (
      assessment.reasonCode !== "SECURE_MCP_RUNTIME_TARGET_CHANGED" ||
      !persistedStateOwnsTargetChange({
        previous,
        status: assessment.status,
        record: opts.record,
        workspaceRoot: workspace.root,
        alias,
        managed: opts.managed,
        managedBinary: opts.paths.managedClientBin,
      })
    ) {
      throw secureError(assessment.reasonCode);
    }
    nativeStop({
      binary: opts.paths.managedClientBin,
      alias,
      env: statusEnv,
      runner: opts.runner,
      timeoutMs: Math.min(opts.timeoutMs, 10_000),
      acceptMissing: false,
    });
    clearRuntimeState(opts.paths, opts.record.workspaceId);
    previous = null;
  }
  let status: NativeStatus;
  if (assessment.state === "ready" && assessment.status.mcpServerUrl && normalizeUrl(assessment.status.mcpServerUrl) === normalizeUrl(mcpServerUrl)) {
    status = assessment.status;
  } else {
    nativeConnect({
      binary: opts.paths.managedClientBin,
      alias,
      tunnelId: opts.record.tunnelId,
      mcpServerUrl,
      paths: opts.paths,
      runtimeKey: opts.runtimeKey,
      config: opts.config,
      runner: opts.runner,
      timeoutMs: opts.timeoutMs,
    });
    status = await waitForNativeReady({
      binary: opts.paths.managedClientBin,
      alias,
      expected: opts.record,
      mcpServerUrl,
      managed: opts.managed,
      env: statusEnv,
      runner: opts.runner,
      timeoutMs: opts.timeoutMs,
      pollMs: opts.pollMs,
    });
  }
  const now = new Date().toISOString();
  writeRuntimeState(opts.paths, {
    schemaVersion: SECURE_MCP_RUNTIME_SCHEMA_VERSION,
    workspaceId: opts.record.workspaceId,
    workspaceRoot: workspace.root,
    tunnelId: opts.record.tunnelId,
    alias,
    pid: status.pid!,
    bridgePort: bridge.runtime.port,
    mcpServerUrl,
    healthUrl: status.healthUrl,
    readyUrl: status.readyUrl,
    controlPlanePollHealth: status.controlPlanePollHealth,
    binaryVersion: opts.managed.version,
    binarySha256: opts.managed.sha256,
    startedAt: previous?.startedAt ?? now,
    observedAt: now,
  });
  return {
    workspaceId: opts.record.workspaceId,
    workspaceRoot: workspace.root,
    tunnelId: opts.record.tunnelId,
    enabled: true,
    status: "PASS",
    bridge: { state: "healthy", port: bridge.runtime.port },
    runtime: {
      state: "ready",
      alias,
      pid: status.pid ?? undefined,
      mcpServerUrl,
      controlPlanePollHealth: status.controlPlanePollHealth,
    },
  };
}

function baseConfigStatus(config: SecureMcpConfig, key: ReturnType<typeof runtimeKeyStatus>, managed: ManagedRuntimeManifest | null) {
  return {
    schemaVersion: config.schemaVersion,
    proxy: {
      configured: Boolean(config.controlPlaneProxy),
      url: redactControlPlaneProxy(config.controlPlaneProxy),
    },
    key,
    managedRuntime: managed
      ? { imported: true, version: managed.version, sha256: managed.sha256, commit: managed.commit }
      : { imported: false },
  };
}

function resultForError(record: SecureMcpWorkspaceRecord, error: unknown, status: SecureMcpResultStatus = "BLOCKED"): SecureMcpWorkspaceResult {
  return {
    workspaceId: record.workspaceId,
    workspaceRoot: record.workspaceRoot,
    tunnelId: record.tunnelId,
    enabled: record.enabled,
    status,
    reasonCode: errorCode(error, "SECURE_MCP_WORKSPACE_FAILED"),
  };
}

export async function connectAll(opts: {
  stateDir?: string;
  runner?: NativeCommandRunner;
  timeoutMs?: number;
  pollMs?: number;
} = {}): Promise<SecureMcpBatchResult> {
  const paths = resolveSecureMcpPaths(opts.stateDir);
  const config = readSecureMcpConfig(opts.stateDir);
  const key = runtimeKeyStatus(opts.stateDir);
  let managed: ManagedRuntimeManifest | null = null;
  try {
    managed = readManagedRuntime(opts.stateDir).manifest;
  } catch {
    managed = null;
  }
  const snapshot = readSecureMcpRegistry(opts.stateDir);
  const results: SecureMcpWorkspaceResult[] = [];
  let runtimeKey = "";
  let keyError: unknown = null;
  if (!key.configured || !key.decryptable) keyError = secureError("SECURE_MCP_RUNTIME_KEY_NOT_READY");
  else {
    try {
      runtimeKey = readRuntimeKey(opts.stateDir);
    } catch (error) {
      keyError = error;
    }
  }
  try {
    for (const record of snapshot.records) {
      if (!record.enabled) {
        results.push({
          workspaceId: record.workspaceId,
          workspaceRoot: record.workspaceRoot,
          tunnelId: record.tunnelId,
          enabled: false,
          status: "SKIPPED",
          reasonCode: "DISABLED",
        });
        continue;
      }
      if (keyError) {
        results.push(resultForError(record, keyError));
        continue;
      }
      if (!managed) {
        results.push(resultForError(record, secureError("SECURE_MCP_RUNTIME_NOT_IMPORTED")));
        continue;
      }
      try {
        results.push(
          await connectOne({
            record,
            paths,
            config,
            managed,
            runtimeKey,
            runner: opts.runner ?? defaultRunner,
            timeoutMs: opts.timeoutMs ?? 30_000,
            pollMs: opts.pollMs ?? 300,
          })
        );
      } catch (error) {
        results.push(resultForError(record, error, "FAIL"));
      }
    }
  } finally {
    runtimeKey = "";
  }
  return {
    ok:
      snapshot.invalid.length === 0 &&
      results.every((result) => result.status !== "FAIL" && result.status !== "BLOCKED"),
    config: baseConfigStatus(config, key, managed),
    results,
    invalid: snapshot.invalid,
  };
}

async function statusOne(
  record: SecureMcpWorkspaceRecord,
  paths: SecureMcpPaths,
  config: SecureMcpConfig,
  managed: ManagedRuntimeManifest | null,
  runner: NativeCommandRunner
): Promise<SecureMcpWorkspaceResult> {
  try {
    const workspace = validateCurrentWorkspaceRecord(record);
    const observation = await findBridgeObservation(workspace.id, workspace.root);
    if (observation.state === "unknown") throw secureError("SECURE_MCP_BRIDGE_AMBIGUOUS");
    let bridge: SecureMcpWorkspaceResult["bridge"];
    let bridgeReady = false;
    let bridgeRuntime: RuntimeState | null = null;
    if (observation.state === "healthy") {
      if (observation.runtime.transport !== "local-only" || observation.runtime.publicUrl !== null) {
        bridge = { state: "foreign" };
        throw secureError("SECURE_MCP_BRIDGE_FOREIGN_PUBLIC_TRANSPORT");
      }
      const info = await adminFetch<{
        workspaceId: string;
        workspaceRoot: string;
        pid: number;
        publicUrl: string | null;
        tunnel: { provider: string };
      }>(observation.runtime, "GET", "/admin/info");
      if (
        info.workspaceId !== record.workspaceId ||
        !samePath(info.workspaceRoot, record.workspaceRoot) ||
        info.pid !== observation.runtime.pid ||
        info.publicUrl !== null ||
        info.tunnel.provider !== "local-only"
      ) {
        bridge = { state: "foreign" };
        throw secureError("SECURE_MCP_BRIDGE_IDENTITY_MISMATCH");
      }
      bridgeRuntime = observation.runtime;
      bridgeReady = await bridgeReadiness(observation.runtime, workspace.id);
      bridge = { state: bridgeReady ? "healthy" : "ambiguous", port: observation.runtime.port };
      if (!bridgeReady) throw secureError("SECURE_MCP_BRIDGE_NOT_READY");
    } else if (observation.state === "stale") {
      bridge = { state: "stale" };
    } else {
      bridge = { state: "stopped" };
    }
    const alias = aliasFor(record.workspaceId);
    if (!managed) {
      return {
        workspaceId: record.workspaceId,
        workspaceRoot: workspace.root,
        tunnelId: record.tunnelId,
        enabled: record.enabled,
        status: record.enabled ? "BLOCKED" : "SKIPPED",
        reasonCode: record.enabled ? "SECURE_MCP_RUNTIME_NOT_IMPORTED" : "DISABLED",
        bridge,
        runtime: { state: "not-imported", alias },
      };
    }
    const mcpServerUrl = bridgeRuntime ? `http://127.0.0.1:${bridgeRuntime.port}/mcp` : null;
    const env = trustedChildEnv(config, mcpServerUrl, undefined, paths);
    const native = nativeStatus(paths.managedClientBin, alias, env, runner, 10_000);
    const assessment = await assessNativeStatus({
      status: native,
      expected: record,
      alias,
      mcpServerUrl,
      managedBinary: paths.managedClientBin,
      managed,
    });
    const runtime =
      assessment.state === "ready"
        ? {
            state: "ready" as const,
            alias,
            pid: assessment.status.pid ?? undefined,
            mcpServerUrl: assessment.status.mcpServerUrl ?? undefined,
            controlPlanePollHealth: assessment.status.controlPlanePollHealth,
          }
        : { state: assessment.state === "missing" ? ("missing" as const) : assessment.state, alias };
    const status: SecureMcpResultStatus =
      !record.enabled
        ? "SKIPPED"
        : bridge.state === "healthy" && assessment.state === "ready"
          ? "PASS"
          : "BLOCKED";
    return {
      workspaceId: record.workspaceId,
      workspaceRoot: workspace.root,
      tunnelId: record.tunnelId,
      enabled: record.enabled,
      status,
      reasonCode: status === "PASS" || status === "SKIPPED" ? (record.enabled ? undefined : "DISABLED") : `SECURE_MCP_RUNTIME_${assessment.state.toUpperCase()}`,
      bridge,
      runtime,
    };
  } catch (error) {
    return resultForError(record, error, record.enabled ? "BLOCKED" : "SKIPPED");
  }
}

export async function statusAll(opts: { stateDir?: string; runner?: NativeCommandRunner } = {}): Promise<SecureMcpBatchResult> {
  const paths = resolveSecureMcpPaths(opts.stateDir);
  const config = readSecureMcpConfig(opts.stateDir);
  const key = runtimeKeyStatus(opts.stateDir);
  let managed: ManagedRuntimeManifest | null = null;
  try {
    managed = readManagedRuntime(opts.stateDir).manifest;
  } catch {
    managed = null;
  }
  const snapshot = readSecureMcpRegistry(opts.stateDir);
  const results: SecureMcpWorkspaceResult[] = [];
  for (const record of snapshot.records) {
    results.push(await statusOne(record, paths, config, managed, opts.runner ?? defaultRunner));
  }
  return {
    ok:
      snapshot.invalid.length === 0 &&
      results.every((result) => result.status !== "FAIL" && result.status !== "BLOCKED"),
    config: baseConfigStatus(config, key, managed),
    results,
    invalid: snapshot.invalid,
  };
}

async function stopOwnedBridge(record: SecureMcpWorkspaceRecord): Promise<void> {
  const observation = await findBridgeObservation(record.workspaceId, record.workspaceRoot);
  if (observation.state === "stopped") return;
  if (observation.state !== "healthy") throw secureError("SECURE_MCP_BRIDGE_AMBIGUOUS");
  if (observation.runtime.transport !== "local-only" || observation.runtime.publicUrl !== null) {
    throw secureError("SECURE_MCP_BRIDGE_FOREIGN_PUBLIC_TRANSPORT");
  }
  const info = await adminFetch<{
    workspaceId: string;
    workspaceRoot: string;
    pid: number;
    publicUrl: string | null;
    tunnel: { provider: string };
  }>(
    observation.runtime,
    "GET",
    "/admin/info",
    5_000
  );
  if (
    info.workspaceId !== record.workspaceId ||
    !samePath(info.workspaceRoot, record.workspaceRoot) ||
    info.pid !== observation.runtime.pid ||
    info.publicUrl !== null ||
    info.tunnel.provider !== "local-only"
  ) {
    throw secureError("SECURE_MCP_BRIDGE_IDENTITY_MISMATCH");
  }
  await adminFetch(observation.runtime, "POST", "/admin/shutdown", 5_000);
}

export async function disconnectAll(opts: {
  stateDir?: string;
  runner?: NativeCommandRunner;
  timeoutMs?: number;
} = {}): Promise<SecureMcpBatchResult> {
  const paths = resolveSecureMcpPaths(opts.stateDir);
  const config = readSecureMcpConfig(opts.stateDir);
  const key = runtimeKeyStatus(opts.stateDir);
  let managed: ManagedRuntimeManifest | null = null;
  try {
    managed = readManagedRuntime(opts.stateDir).manifest;
  } catch {
    managed = null;
  }
  const snapshot = readSecureMcpRegistry(opts.stateDir);
  const results: SecureMcpWorkspaceResult[] = [];
  for (const record of snapshot.records) {
    const alias = aliasFor(record.workspaceId);
    try {
      if (managed) {
        const env = trustedChildEnv(config, "http://127.0.0.1:1/mcp", undefined, paths);
        const native = nativeStatus(paths.managedClientBin, alias, env, opts.runner ?? defaultRunner, 10_000);
        if (native) {
          if (native.state === "stopped") {
            clearRuntimeState(paths, record.workspaceId);
          } else if (native.state !== "running" && native.state !== "ready") {
            throw secureError("SECURE_MCP_RUNTIME_AMBIGUOUS");
          } else if (
            !native.pid ||
            native.tunnelId !== record.tunnelId ||
            native.alias !== alias ||
            (native.workspaceId && native.workspaceId !== record.workspaceId) ||
            (native.binaryPath && !samePath(path.resolve(native.binaryPath), path.resolve(paths.managedClientBin))) ||
            !native.mcpServerUrl
          ) {
            throw secureError("SECURE_MCP_RUNTIME_AMBIGUOUS");
          } else {
            validateLoopbackMcpUrl(native.mcpServerUrl);
            if (!processIsAlive(native.pid)) {
              clearRuntimeState(paths, record.workspaceId);
            } else {
              nativeStop({
                binary: paths.managedClientBin,
                alias,
                env,
                runner: opts.runner ?? defaultRunner,
                timeoutMs: opts.timeoutMs ?? 10_000,
              });
              clearRuntimeState(paths, record.workspaceId);
            }
          }
        } else {
          const persisted = readRuntimeState(paths, record.workspaceId);
          if (persisted && processIsAlive(persisted.pid)) throw secureError("SECURE_MCP_RUNTIME_AMBIGUOUS");
          if (persisted) clearRuntimeState(paths, record.workspaceId);
        }
      } else if (readRuntimeState(paths, record.workspaceId)) {
        throw secureError("SECURE_MCP_RUNTIME_NOT_IMPORTED");
      }
      await stopOwnedBridge(record);
      results.push({
        workspaceId: record.workspaceId,
        workspaceRoot: record.workspaceRoot,
        tunnelId: record.tunnelId,
        enabled: record.enabled,
        status: "PASS",
        bridge: { state: "stopped" },
        runtime: { state: "stopped", alias },
      });
    } catch (error) {
      results.push({ ...resultForError(record, error, "BLOCKED"), runtime: { state: "ambiguous", alias } });
    }
  }
  return {
    ok:
      snapshot.invalid.length === 0 &&
      results.every((result) => result.status !== "FAIL" && result.status !== "BLOCKED"),
    config: baseConfigStatus(config, key, managed),
    results,
    invalid: snapshot.invalid,
  };
}

export function secureMcpRuntimeState(stateDir: string | undefined, workspaceId: string): SecureMcpRuntimeState | null {
  return readRuntimeState(resolveSecureMcpPaths(stateDir), workspaceId);
}
