import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getStateDir } from "../config/paths.js";

export const SECURE_MCP_SCHEMA_VERSION = 1 as const;
export const SECURE_MCP_ROOT_NAME = "secure-mcp";

export class SecureMcpError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SecureMcpError";
  }
}

export interface SecureMcpPaths {
  stateRoot: string;
  root: string;
  configFile: string;
  registryDir: string;
  runtimeDir: string;
  managedDir: string;
  managedClientDir: string;
  managedClientBin: string;
  managedProfileDir: string;
  managedStateDir: string;
  secretDir: string;
  runtimeKeyFile: string;
}

function comparePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function isInside(root: string, candidate: string): boolean {
  const r = comparePath(path.resolve(root));
  const c = comparePath(path.resolve(candidate));
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : `${r}${path.sep}`);
}

function ensureDirectory(directory: string, parentRoot: string): string {
  const resolved = path.resolve(directory);
  if (!isInside(parentRoot, resolved)) {
    throw new SecureMcpError("SECURE_MCP_CONTAINMENT_ESCAPE", "Secure MCP state path escaped its state root.");
  }
  try {
    let current = path.resolve(parentRoot);
    const relative = path.relative(current, resolved);
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      const next = path.join(current, segment);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        fs.mkdirSync(next);
        stat = fs.lstatSync(next);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new SecureMcpError("SECURE_MCP_UNSAFE_PATH", "Secure MCP state path is not a regular directory.");
      }
      const canonical = fs.realpathSync.native(next);
      if (!isInside(parentRoot, canonical)) {
        throw new SecureMcpError("SECURE_MCP_CONTAINMENT_ESCAPE", "Secure MCP state path escaped its state root.");
      }
      current = canonical;
    }
    return current;
  } catch (error) {
    if (error instanceof SecureMcpError) throw error;
    throw new SecureMcpError("SECURE_MCP_STATE_UNAVAILABLE", "Secure MCP state directory is unavailable.");
  }
}

function ensureStateRoot(input: string): string {
  const resolved = path.resolve(input);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new SecureMcpError("SECURE_MCP_UNSAFE_STATE_ROOT", "The bound C2C state root is not a regular directory.");
    }
    return fs.realpathSync.native(resolved);
  } catch (error) {
    if (error instanceof SecureMcpError) throw error;
    throw new SecureMcpError("SECURE_MCP_STATE_UNAVAILABLE", "The bound C2C state root is unavailable.");
  }
}

export function resolveSecureMcpPaths(stateDir = getStateDir()): SecureMcpPaths {
  const stateRoot = ensureStateRoot(stateDir);
  const root = ensureDirectory(path.join(stateRoot, SECURE_MCP_ROOT_NAME), stateRoot);
  const registryDir = ensureDirectory(path.join(root, "registry"), stateRoot);
  const runtimeDir = ensureDirectory(path.join(root, "runtime"), stateRoot);
  const managedDir = ensureDirectory(path.join(root, "managed"), stateRoot);
  const managedClientDir = ensureDirectory(path.join(managedDir, "tunnel-client", "0.0.14"), stateRoot);
  const managedProfileDir = ensureDirectory(path.join(root, "profiles"), stateRoot);
  const managedStateDir = ensureDirectory(path.join(root, "client-state"), stateRoot);
  const secretDir = ensureDirectory(path.join(root, "secret"), stateRoot);
  const managedClientBin = path.join(managedClientDir, process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
  return {
    stateRoot,
    root,
    configFile: path.join(root, "config.json"),
    registryDir,
    runtimeDir,
    managedDir,
    managedClientDir,
    managedClientBin,
    managedProfileDir,
    managedStateDir,
    secretDir,
    runtimeKeyFile: path.join(secretDir, "runtime-key.dpapi"),
  };
}

export function assertStateOutsideProject(paths: SecureMcpPaths, projectRoot: string): void {
  try {
    const project = fs.realpathSync.native(path.resolve(projectRoot));
    if (isInside(project, paths.stateRoot) || isInside(paths.stateRoot, project)) {
      throw new SecureMcpError(
        "SECURE_MCP_STATE_INSIDE_PROJECT",
        "Secure MCP state cannot be inside the project workspace."
      );
    }
  } catch (error) {
    if (error instanceof SecureMcpError) throw error;
    throw new SecureMcpError("SECURE_MCP_STATE_UNAVAILABLE", "The project root could not be canonicalized.");
  }
}

export function secureMcpRuntimeFile(paths: SecureMcpPaths, workspaceId: string): string {
  if (!/^[0-9a-f]{12}$/.test(workspaceId)) {
    throw new SecureMcpError("SECURE_MCP_WORKSPACE_ID_INVALID", "Secure MCP workspace ID is invalid.");
  }
  return path.join(paths.runtimeDir, `${workspaceId}.json`);
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertWritableLeaf(file: string): void {
  let stat: fs.Stats | null;
  try {
    stat = lstatOrNull(file);
  } catch {
    throw new SecureMcpError("SECURE_MCP_STATE_CORRUPT", "Secure MCP state file is unavailable.");
  }
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SecureMcpError("SECURE_MCP_UNSAFE_PATH", "Refusing to replace an unsafe Secure MCP state file.");
  }
}

export function writeSecureMcpJson(file: string, value: unknown): void {
  assertWritableLeaf(file);
  const parent = path.dirname(file);
  const temp = path.join(parent, `.${path.basename(file)}.${randomBytes(10).toString("hex")}.tmp`);
  const content = JSON.stringify(value, null, 2);
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content, "utf8");
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
    if (error instanceof SecureMcpError) throw error;
    throw new SecureMcpError("SECURE_MCP_WRITE_FAILED", "Secure MCP state write failed.");
  }
}

export function writeSecureMcpBytes(file: string, value: Buffer): void {
  assertWritableLeaf(file);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(10).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, value);
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
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Preserve fail-closed behavior.
    }
    throw new SecureMcpError("SECURE_MCP_WRITE_FAILED", "Secure MCP state write failed.");
  }
}

export function readSecureMcpJson<T>(file: string): T | null {
  try {
    const stat = lstatOrNull(file);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe");
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    throw new SecureMcpError("SECURE_MCP_STATE_CORRUPT", "Secure MCP state is corrupt or unreadable.");
  }
}

export function readSecureMcpBytes(file: string): Buffer | null {
  try {
    const stat = lstatOrNull(file);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe");
    return fs.readFileSync(file);
  } catch {
    throw new SecureMcpError("SECURE_MCP_STATE_CORRUPT", "Secure MCP secret state is corrupt or unreadable.");
  }
}
