import path from "node:path";
import { SECURE_MCP_SCHEMA_VERSION, readSecureMcpJson, resolveSecureMcpPaths, writeSecureMcpJson, type SecureMcpPaths } from "./paths.js";
import { validateControlPlaneProxy } from "./proxy.js";

export interface SecureMcpManagedRuntimeRef {
  version: "0.0.14";
  commit: "0f870e50a973fa820d4c409000059e181e8d242b";
  sha256: string;
  installedAt: string;
  binaryName: string;
  sourceProvenance: "local-approved-release";
}

export interface SecureMcpConfig {
  schemaVersion: typeof SECURE_MCP_SCHEMA_VERSION;
  transport: "openai-secure-mcp";
  managedRuntime: SecureMcpManagedRuntimeRef | null;
  controlPlaneProxy: string | null;
  runtimeKey: {
    path: string;
    protection: "windows-current-user-dpapi";
  };
  updatedAt: string;
}

export function defaultSecureMcpConfig(paths: SecureMcpPaths): SecureMcpConfig {
  return {
    schemaVersion: SECURE_MCP_SCHEMA_VERSION,
    transport: "openai-secure-mcp",
    managedRuntime: null,
    controlPlaneProxy: null,
    runtimeKey: {
      path: path.relative(paths.root, paths.runtimeKeyFile).split(path.sep).join("/"),
      protection: "windows-current-user-dpapi",
    },
    updatedAt: new Date(0).toISOString(),
  };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateConfig(value: unknown, paths: SecureMcpPaths): SecureMcpConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid config");
  const raw = value as Record<string, unknown>;
  const expectedKeys = ["schemaVersion", "transport", "managedRuntime", "controlPlaneProxy", "runtimeKey", "updatedAt"];
  const actualKeys = Object.keys(raw).sort();
  if (actualKeys.length !== expectedKeys.length || !actualKeys.every((key, index) => key === expectedKeys.slice().sort()[index])) {
    throw new Error("invalid config");
  }
  const runtimeKey = raw.runtimeKey as Record<string, unknown> | undefined;
  if (
    raw.schemaVersion !== SECURE_MCP_SCHEMA_VERSION ||
    raw.transport !== "openai-secure-mcp" ||
    (raw.controlPlaneProxy !== null && typeof raw.controlPlaneProxy !== "string") ||
    !runtimeKey ||
    !hasExactKeys(runtimeKey, ["path", "protection"]) ||
    runtimeKey.protection !== "windows-current-user-dpapi" ||
    runtimeKey.path !== path.relative(paths.root, paths.runtimeKeyFile).split(path.sep).join("/") ||
    typeof raw.updatedAt !== "string"
  ) {
    throw new Error("invalid config");
  }
  if (!Number.isFinite(Date.parse(raw.updatedAt)) || new Date(raw.updatedAt).toISOString() !== raw.updatedAt) {
    throw new Error("invalid config");
  }
  if (raw.controlPlaneProxy !== null) validateControlPlaneProxy(raw.controlPlaneProxy as string);
  const managed = raw.managedRuntime;
  if (managed !== null) {
    if (!managed || typeof managed !== "object") throw new Error("invalid managed runtime");
    const item = managed as Record<string, unknown>;
    if (
      !hasExactKeys(item, ["version", "commit", "sha256", "installedAt", "binaryName", "sourceProvenance"]) ||
      item.version !== "0.0.14" ||
      item.commit !== "0f870e50a973fa820d4c409000059e181e8d242b" ||
      typeof item.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.sha256) ||
      typeof item.installedAt !== "string" ||
      !Number.isFinite(Date.parse(item.installedAt as string)) ||
      new Date(item.installedAt as string).toISOString() !== item.installedAt ||
      typeof item.binaryName !== "string" ||
      item.sourceProvenance !== "local-approved-release"
    ) throw new Error("invalid managed runtime");
  }
  return {
    schemaVersion: SECURE_MCP_SCHEMA_VERSION,
    transport: "openai-secure-mcp",
    managedRuntime: managed as SecureMcpManagedRuntimeRef | null,
    controlPlaneProxy: raw.controlPlaneProxy as string | null,
    runtimeKey: {
      path: runtimeKey.path as string,
      protection: "windows-current-user-dpapi",
    },
    updatedAt: raw.updatedAt as string,
  };
}

export function readSecureMcpConfig(stateDir?: string): SecureMcpConfig {
  const paths = resolveSecureMcpPaths(stateDir);
  const stored = readSecureMcpJson<unknown>(paths.configFile);
  if (stored === null) return defaultSecureMcpConfig(paths);
  try {
    return validateConfig(stored, paths);
  } catch {
    throw new Error("SECURE_MCP_CONFIG_INVALID");
  }
}

export function writeSecureMcpConfig(config: SecureMcpConfig, stateDir?: string): SecureMcpConfig {
  const paths = resolveSecureMcpPaths(stateDir);
  const next: SecureMcpConfig = {
    ...config,
    schemaVersion: SECURE_MCP_SCHEMA_VERSION,
    transport: "openai-secure-mcp",
    runtimeKey: {
      path: path.relative(paths.root, paths.runtimeKeyFile).split(path.sep).join("/"),
      protection: "windows-current-user-dpapi",
    },
    updatedAt: new Date().toISOString(),
  };
  validateConfig(next, paths);
  writeSecureMcpJson(paths.configFile, next);
  return next;
}
