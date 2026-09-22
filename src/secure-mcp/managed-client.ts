import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readSecureMcpConfig, writeSecureMcpConfig, type SecureMcpManagedRuntimeRef } from "./config.js";
import { SecureMcpError, readSecureMcpJson, resolveSecureMcpPaths, writeSecureMcpJson, type SecureMcpPaths } from "./paths.js";

export const OFFICIAL_TUNNEL_CLIENT_VERSION = "0.0.14" as const;
export const OFFICIAL_TUNNEL_CLIENT_COMMIT = "0f870e50a973fa820d4c409000059e181e8d242b" as const;
export const OFFICIAL_TUNNEL_CLIENT_SHA256 = "fcc85a69ec0ad82518e4f8964f60c45e31787957782a0fc9c1b0c44e82d61b9b" as const;
const VERSION_RE = /0\.0\.14\+([0-9a-f]{40})/i;

export interface ManagedRuntimeManifest extends SecureMcpManagedRuntimeRef {
  sourceProvenance: "local-approved-release";
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateManifest(value: unknown, paths: SecureMcpPaths): ManagedRuntimeManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SecureMcpError("SECURE_MCP_RUNTIME_MANIFEST_INVALID", "Managed tunnel-client manifest is invalid.");
  }
  const raw = value as Record<string, unknown>;
  if (
    !hasExactKeys(raw, ["version", "commit", "sha256", "installedAt", "binaryName", "sourceProvenance"]) ||
    raw.version !== OFFICIAL_TUNNEL_CLIENT_VERSION ||
    raw.commit !== OFFICIAL_TUNNEL_CLIENT_COMMIT ||
    typeof raw.sha256 !== "string" ||
    raw.sha256 !== OFFICIAL_TUNNEL_CLIENT_SHA256 ||
    typeof raw.installedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.installedAt as string)) ||
    new Date(raw.installedAt as string).toISOString() !== raw.installedAt ||
    raw.binaryName !== path.basename(paths.managedClientBin) ||
    raw.sourceProvenance !== "local-approved-release"
  ) {
    throw new SecureMcpError("SECURE_MCP_RUNTIME_MANIFEST_INVALID", "Managed tunnel-client manifest is invalid.");
  }
  return raw as unknown as ManagedRuntimeManifest;
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function versionOf(binary: string): string {
  try {
    const output = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.trim();
  } catch {
    throw new SecureMcpError("SECURE_MCP_RUNTIME_VERSION_UNAVAILABLE", "Managed tunnel-client version could not be verified.");
  }
}

function officialSpdxHash(sourceDir: string): string | null {
  const sidecar = fs.readdirSync(sourceDir).find((name) => name.endsWith(".spdx.json"));
  if (!sidecar) return null;
  try {
    const sidecarPath = path.join(sourceDir, sidecar);
    const sidecarStat = fs.lstatSync(sidecarPath);
    if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink()) return null;
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as {
      files?: Array<{ fileName?: string; checksums?: Array<{ algorithm?: string; checksumValue?: string }> }>;
    };
    const file = parsed.files?.find((item) => {
      const name = item.fileName ? path.basename(item.fileName.replace(/\\/g, "/")) : "";
      return name === "tunnel-client.exe" || name === "tunnel-client";
    });
    return file?.checksums?.find((item) => item.algorithm === "SHA256")?.checksumValue?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function verifyManagedBinary(binary: string, expectedHash?: string): { sha256: string; version: string } {
  if (!fs.existsSync(binary)) {
    throw new SecureMcpError("SECURE_MCP_RUNTIME_MISSING", "Managed tunnel-client binary is missing.");
  }
  const stat = fs.lstatSync(binary);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new SecureMcpError("SECURE_MCP_RUNTIME_UNSAFE_FILE", "Managed tunnel-client must be a regular file.");
  }
  const version = versionOf(binary);
  const match = VERSION_RE.exec(version);
  if (!match || match[1].toLowerCase() !== OFFICIAL_TUNNEL_CLIENT_COMMIT) {
    throw new SecureMcpError("SECURE_MCP_RUNTIME_VERSION_MISMATCH", "Managed tunnel-client is not the approved v0.0.14 release.");
  }
  const sha256 = sha256File(binary);
  if (sha256 !== OFFICIAL_TUNNEL_CLIENT_SHA256) {
    throw new SecureMcpError("SECURE_MCP_RUNTIME_HASH_MISMATCH", "Managed tunnel-client integrity verification failed.");
  }
  if (expectedHash && sha256 !== expectedHash.toLowerCase()) {
    throw new SecureMcpError("SECURE_MCP_RUNTIME_HASH_MISMATCH", "Managed tunnel-client integrity verification failed.");
  }
  return { sha256, version };
}

export function readManagedRuntime(stateDir?: string): { paths: SecureMcpPaths; manifest: ManagedRuntimeManifest; version: string } {
  const paths = resolveSecureMcpPaths(stateDir);
  const stored = readSecureMcpJson<unknown>(path.join(paths.managedClientDir, "manifest.json"));
  if (stored === null) {
    throw new SecureMcpError("SECURE_MCP_RUNTIME_NOT_IMPORTED", "The approved tunnel-client has not been imported.");
  }
  const manifest = validateManifest(stored, paths);
  const verified = verifyManagedBinary(paths.managedClientBin, manifest.sha256);
  return { paths, manifest, version: verified.version };
}

function assertCopyTarget(file: string): void {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SecureMcpError("SECURE_MCP_RUNTIME_TARGET_UNSAFE", "Managed tunnel-client target is not a regular file.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof SecureMcpError) throw error;
    throw new SecureMcpError("SECURE_MCP_RUNTIME_TARGET_UNSAFE", "Managed tunnel-client target is unavailable.");
  }
}

function copyApprovedFile(source: string, target: string): void {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new SecureMcpError("SECURE_MCP_RUNTIME_SOURCE_INVALID", "The approved release contains an unsafe file.");
  }
  assertCopyTarget(target);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(10).toString("hex")}.tmp`);
  try {
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
    try {
      fs.chmodSync(temp, 0o700);
    } catch {
      // Best effort on Windows/filesystems without chmod semantics.
    }
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Preserve the original failure.
    }
    if (error instanceof SecureMcpError) throw error;
    throw new SecureMcpError("SECURE_MCP_RUNTIME_IMPORT_FAILED", "Managed tunnel-client import failed.");
  }
}

export function importManagedRuntime(opts: { sourceDir: string; stateDir?: string }): ManagedRuntimeManifest {
  if (process.platform !== "win32") throw new SecureMcpError("SECURE_MCP_WINDOWS_ONLY", "Secure MCP managed runtime import is Windows-only.");
  const sourceDir = path.resolve(opts.sourceDir);
  if (!fs.existsSync(sourceDir)) {
    throw new SecureMcpError("SECURE_MCP_RUNTIME_SOURCE_INVALID", "The approved local tunnel-client release directory is unavailable.");
  }
  const sourceStat = fs.lstatSync(sourceDir);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new SecureMcpError("SECURE_MCP_RUNTIME_SOURCE_INVALID", "The approved release directory must be a regular directory.");
  }
  const sourceBinary = path.join(sourceDir, "tunnel-client.exe");
  const preflight = verifyManagedBinary(sourceBinary);
  const spdxHash = officialSpdxHash(sourceDir);
  if (!spdxHash || spdxHash !== preflight.sha256) {
    throw new SecureMcpError("SECURE_MCP_RUNTIME_PROVENANCE_MISMATCH", "The local release lacks a matching official SHA-256 provenance record.");
  }
  const paths = resolveSecureMcpPaths(opts.stateDir);
  copyApprovedFile(sourceBinary, paths.managedClientBin);
  for (const name of fs.readdirSync(sourceDir)) {
    if (!/\.(spdx\.json|txt|md|NOTICE|LICENSE)$/i.test(name) && !/^(NOTICE|LICENSE)$/i.test(name)) continue;
    const source = path.join(sourceDir, name);
    const stat = fs.lstatSync(source);
    if (stat.isFile() && !stat.isSymbolicLink()) copyApprovedFile(source, path.join(paths.managedClientDir, name));
  }
  const verified = verifyManagedBinary(paths.managedClientBin, preflight.sha256);
  const manifest: ManagedRuntimeManifest = {
    version: OFFICIAL_TUNNEL_CLIENT_VERSION,
    commit: OFFICIAL_TUNNEL_CLIENT_COMMIT,
    sha256: verified.sha256,
    installedAt: new Date().toISOString(),
    binaryName: path.basename(paths.managedClientBin),
    sourceProvenance: "local-approved-release",
  };
  writeSecureMcpJson(path.join(paths.managedClientDir, "manifest.json"), manifest);
  const config = readSecureMcpConfig(opts.stateDir);
  writeSecureMcpConfig({ ...config, managedRuntime: manifest }, opts.stateDir);
  return manifest;
}
