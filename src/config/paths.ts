import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const STATE_ROOT_BINDING_FILE = "codex-with-chatgpt-state-root.json";

interface StateRootBinding {
  version: 1;
  stateDir: string;
}

function codexHomeForStateBinding(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".codex");
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function normalizeStateDir(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("C2C state-root binding must contain a non-empty stateDir.");
  }
  return path.resolve(value);
}

export function stateRootBindingFile(codexHome?: string): string {
  return path.join(path.resolve(codexHome ?? codexHomeForStateBinding()), STATE_ROOT_BINDING_FILE);
}

/**
 * Read the machine-local state-root binding without falling back when it is
 * malformed or replaced by a link. A split state view is safer to stop than
 * to silently reinterpret as a new C2C installation.
 */
export function readStateRootBinding(codexHome?: string): string | null {
  const file = stateRootBindingFile(codexHome);
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to use an invalid C2C state-root binding: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error(`Refusing to use an unreadable C2C state-root binding: ${file}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { stateDir?: unknown }).stateDir !== "string"
  ) {
    throw new Error(`Refusing to use an invalid C2C state-root binding: ${file}`);
  }
  return normalizeStateDir((parsed as StateRootBinding).stateDir);
}

/**
 * Establish one durable machine-local state root. Rebinding an existing
 * installation is intentionally rejected; migration must be separately
 * reviewed so historical Taskbook and connector state cannot be split.
 */
export function bindStateRoot(stateDir: string, codexHome?: string): string {
  const resolved = normalizeStateDir(stateDir);
  const existing = readStateRootBinding(codexHome);
  if (existing && !samePath(existing, resolved)) {
    throw new Error(`C2C state-root binding differs from the requested root: ${existing}`);
  }
  if (!existing) {
    writeSecureJson(stateRootBindingFile(codexHome), { version: 1, stateDir: resolved } satisfies StateRootBinding);
  }
  return resolved;
}

/**
 * State directory resolution, following OS conventions.
 * Override with C2C_STATE_DIR (used heavily by tests).
 */
export function getStateDir(): string {
  const override = process.env.C2C_STATE_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  const bound = readStateRootBinding();
  if (bound) return bound;
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "codex-with-chatgpt");
    case "win32":
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "codex-with-chatgpt");
    default: {
      const base = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
      return path.join(base, "codex-with-chatgpt");
    }
  }
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function stateSubdir(name: string): string {
  return ensureDir(path.join(getStateDir(), name));
}

/** Write a JSON file with owner-only permissions. */
export function writeSecureJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
}

export function readJsonIfExists<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const DEFAULT_PORT = 48765;
export const DEFAULT_HOST = "127.0.0.1";
