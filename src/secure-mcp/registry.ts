import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import {
  SECURE_MCP_SCHEMA_VERSION,
  readSecureMcpJson,
  assertStateOutsideProject,
  resolveSecureMcpPaths,
  writeSecureMcpJson,
  type SecureMcpPaths,
} from "./paths.js";

export const SECURE_MCP_TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/;

export interface SecureMcpWorkspaceRecord {
  schemaVersion: typeof SECURE_MCP_SCHEMA_VERSION;
  workspaceId: string;
  workspaceRoot: string;
  enabled: boolean;
  transport: "openai-secure-mcp";
  tunnelId: string;
  displayName: string;
  registeredAt: string;
  updatedAt: string;
}

export interface InvalidSecureMcpRecord {
  file: string;
  error: "INVALID_RECORD" | "UNEXPECTED_ENTRY";
}

export interface RegistrySnapshot {
  records: SecureMcpWorkspaceRecord[];
  invalid: InvalidSecureMcpRecord[];
}

function registryFile(paths: SecureMcpPaths, workspaceId: string): string {
  if (!/^[0-9a-f]{12}$/.test(workspaceId)) throw new Error("SECURE_MCP_WORKSPACE_ID_INVALID");
  return path.join(paths.registryDir, `${workspaceId}.json`);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isCanonicalUtc(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validateSecureMcpWorkspaceRecord(value: unknown, file = "record"): SecureMcpWorkspaceRecord {
  void file;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SECURE_MCP_REGISTRY_RECORD_INVALID");
  const raw = value as Record<string, unknown>;
  if (
    !hasExactKeys(raw, [
      "schemaVersion",
      "workspaceId",
      "workspaceRoot",
      "enabled",
      "transport",
      "tunnelId",
      "displayName",
      "registeredAt",
      "updatedAt",
    ])
  ) {
    throw new Error("SECURE_MCP_REGISTRY_RECORD_INVALID");
  }
  if (
    raw.schemaVersion !== SECURE_MCP_SCHEMA_VERSION ||
    typeof raw.workspaceId !== "string" ||
    !/^[0-9a-f]{12}$/.test(raw.workspaceId) ||
    typeof raw.workspaceRoot !== "string" ||
    typeof raw.enabled !== "boolean" ||
    raw.transport !== "openai-secure-mcp" ||
    typeof raw.tunnelId !== "string" ||
    !SECURE_MCP_TUNNEL_ID.test(raw.tunnelId) ||
    typeof raw.displayName !== "string" ||
    raw.displayName.length === 0 ||
    Buffer.byteLength(raw.displayName, "utf8") > 256 ||
    !isCanonicalUtc(raw.registeredAt) ||
    !isCanonicalUtc(raw.updatedAt)
  ) throw new Error("SECURE_MCP_REGISTRY_RECORD_INVALID");
  let workspace: Workspace;
  try {
    workspace = new Workspace(raw.workspaceRoot);
  } catch {
    throw new Error("SECURE_MCP_REGISTRY_RECORD_INVALID");
  }
  if (workspace.id !== raw.workspaceId || !samePath(workspace.root, raw.workspaceRoot)) {
    throw new Error("SECURE_MCP_REGISTRY_RECORD_INVALID");
  }
  return {
    schemaVersion: SECURE_MCP_SCHEMA_VERSION,
    workspaceId: raw.workspaceId,
    workspaceRoot: raw.workspaceRoot,
    enabled: raw.enabled,
    transport: "openai-secure-mcp",
    tunnelId: raw.tunnelId,
    displayName: raw.displayName,
    registeredAt: raw.registeredAt,
    updatedAt: raw.updatedAt,
  };
}

export function readSecureMcpRegistry(stateDir?: string): RegistrySnapshot {
  const paths = resolveSecureMcpPaths(stateDir);
  const records: SecureMcpWorkspaceRecord[] = [];
  const invalid: InvalidSecureMcpRecord[] = [];
  const entries = fs.readdirSync(paths.registryDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(paths.registryDir, entry.name);
    if (!entry.isFile() || !/^[0-9a-f]{12}\.json$/.test(entry.name)) {
      invalid.push({ file: entry.name, error: "UNEXPECTED_ENTRY" });
      continue;
    }
    try {
      const value = readSecureMcpJson<unknown>(full);
      if (value === null) throw new Error(full);
      const record = validateSecureMcpWorkspaceRecord(value, entry.name);
      if (record.workspaceId !== entry.name.slice(0, -5)) throw new Error(entry.name);
      assertStateOutsideProject(paths, record.workspaceRoot);
      records.push(record);
    } catch {
      invalid.push({ file: entry.name, error: "INVALID_RECORD" });
    }
  }
  records.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
  invalid.sort((a, b) => a.file.localeCompare(b.file));
  return { records, invalid };
}

export function registerSecureMcpWorkspace(opts: {
  workspaceRoot: string;
  tunnelId: string;
  enabled?: boolean;
  stateDir?: string;
}): SecureMcpWorkspaceRecord {
  if (!SECURE_MCP_TUNNEL_ID.test(opts.tunnelId)) throw new Error("SECURE_MCP_TUNNEL_ID_INVALID");
  const workspace = new Workspace(opts.workspaceRoot);
  const paths = resolveSecureMcpPaths(opts.stateDir);
  assertStateOutsideProject(paths, workspace.root);
  const file = registryFile(paths, workspace.id);
  const existing = readSecureMcpJson<unknown>(file);
  const now = new Date().toISOString();
  const old = existing === null ? null : validateSecureMcpWorkspaceRecord(existing, file);
  if (old && (old.workspaceId !== workspace.id || old.workspaceRoot !== workspace.root)) {
    throw new Error("SECURE_MCP_REGISTRY_IDENTITY_MISMATCH");
  }
  const snapshot = readSecureMcpRegistry(opts.stateDir);
  if (snapshot.invalid.length > 0) throw new Error("SECURE_MCP_REGISTRY_INVALID");
  const duplicate = snapshot.records.find(
    (candidate) => candidate.tunnelId === opts.tunnelId && candidate.workspaceId !== workspace.id
  );
  if (duplicate) throw new Error("SECURE_MCP_TUNNEL_ALREADY_REGISTERED");
  const record: SecureMcpWorkspaceRecord = {
    schemaVersion: SECURE_MCP_SCHEMA_VERSION,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    enabled: opts.enabled ?? old?.enabled ?? true,
    transport: "openai-secure-mcp",
    tunnelId: opts.tunnelId,
    displayName: workspace.name,
    registeredAt: old?.registeredAt ?? now,
    updatedAt: now,
  };
  writeSecureMcpJson(file, record);
  return record;
}

export function setSecureMcpWorkspaceEnabled(opts: {
  workspaceRoot: string;
  enabled: boolean;
  stateDir?: string;
}): SecureMcpWorkspaceRecord {
  const workspace = new Workspace(opts.workspaceRoot);
  const paths = resolveSecureMcpPaths(opts.stateDir);
  assertStateOutsideProject(paths, workspace.root);
  const file = registryFile(paths, workspace.id);
  const stored = readSecureMcpJson<unknown>(file);
  if (stored === null) throw new Error("SECURE_MCP_WORKSPACE_NOT_REGISTERED");
  const old = validateSecureMcpWorkspaceRecord(stored, file);
  if (!samePath(old.workspaceRoot, workspace.root)) throw new Error("SECURE_MCP_REGISTRY_IDENTITY_MISMATCH");
  const record = { ...old, enabled: opts.enabled, updatedAt: new Date().toISOString() };
  writeSecureMcpJson(file, record);
  return record;
}

export function validateCurrentWorkspaceRecord(record: SecureMcpWorkspaceRecord): Workspace {
  const workspace = new Workspace(record.workspaceRoot);
  if (workspace.id !== record.workspaceId || !samePath(workspace.root, record.workspaceRoot)) {
    throw new Error("SECURE_MCP_REGISTRY_IDENTITY_MISMATCH");
  }
  if (!SECURE_MCP_TUNNEL_ID.test(record.tunnelId)) throw new Error("SECURE_MCP_TUNNEL_ID_INVALID");
  return workspace;
}

export function getSecureMcpWorkspaceRecord(
  workspaceRoot: string,
  stateDir?: string
): SecureMcpWorkspaceRecord | null {
  const workspace = new Workspace(workspaceRoot);
  const paths = resolveSecureMcpPaths(stateDir);
  assertStateOutsideProject(paths, workspace.root);
  const file = registryFile(paths, workspace.id);
  const stored = readSecureMcpJson<unknown>(file);
  if (stored === null) return null;
  const record = validateSecureMcpWorkspaceRecord(stored, file);
  if (!samePath(record.workspaceRoot, workspace.root)) throw new Error("SECURE_MCP_REGISTRY_IDENTITY_MISMATCH");
  return record;
}
