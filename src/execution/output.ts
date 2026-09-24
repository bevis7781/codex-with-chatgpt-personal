import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { redact } from "../logger/index.js";
import { sanitizeExecutionOutput } from "./sanitize.js";

export const MAX_OUTPUT_RECORDS = 40;

export interface ExecutionOutputMeta {
  id: number;
  command: string;
  exitCode: number | null;
  timestamp: string;
  taskId?: string;
  iteration?: number;
  allowed: boolean;
  restrictedReason?: string;
  truncated: boolean;
  sizeBytes: number;
}

interface OutputIndex {
  nextId: number;
  items: ExecutionOutputMeta[];
}

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) throw new Error("Invalid workspace ID for execution output.");
}

function outputDir(workspaceId: string, create = false, stateDir = getStateDir()): string {
  assertWorkspaceId(workspaceId);
  const directory = path.join(stateDir, "execution-outputs", workspaceId);
  return create ? ensureDir(directory) : directory;
}

function indexFile(workspaceId: string, create = false, stateDir = getStateDir()): string {
  return path.join(outputDir(workspaceId, create, stateDir), "index.json");
}

function bodyFile(workspaceId: string, id: number, stateDir = getStateDir()): string {
  return path.join(outputDir(workspaceId, false, stateDir), "bodies", `${id}.txt`);
}

function readIndex(workspaceId: string, create = false, stateDir = getStateDir()): OutputIndex {
  return (
    readJsonIfExists<OutputIndex>(indexFile(workspaceId, create, stateDir)) ?? {
      nextId: 1,
      items: [],
    }
  );
}

function writeIndex(workspaceId: string, index: OutputIndex, stateDir = getStateDir()): void {
  writeSecureJson(indexFile(workspaceId, true, stateDir), index);
}

export interface SaveOutputInput {
  command: string;
  raw: string;
  exitCode?: number | null;
  taskId?: string;
  iteration?: number;
}

export function saveExecutionOutput(workspaceId: string, input: SaveOutputInput, stateDir = getStateDir()): ExecutionOutputMeta {
  const sanitized = sanitizeExecutionOutput(input.raw);
  const index = readIndex(workspaceId, true, stateDir);
  const id = index.nextId;
  const timestamp = new Date().toISOString();
  const allowed = sanitized.allowed;
  const text = allowed ? sanitized.text : "";
  const truncated = allowed ? sanitized.truncated : false;
  const meta: ExecutionOutputMeta = {
    id,
    command: redact(input.command).slice(0, 200),
    exitCode: input.exitCode ?? null,
    timestamp,
    taskId: input.taskId,
    iteration: input.iteration,
    allowed,
    restrictedReason: allowed ? undefined : sanitized.reason,
    truncated,
    sizeBytes: Buffer.byteLength(text, "utf8"),
  };
  if (allowed && text) {
    const file = bodyFile(workspaceId, id, stateDir);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, text, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* ignore */
    }
  }
  index.nextId = id + 1;
  index.items.push(meta);
  while (index.items.length > MAX_OUTPUT_RECORDS) {
    const dropped = index.items.shift();
    if (dropped) {
      fs.rmSync(bodyFile(workspaceId, dropped.id, stateDir), { force: true });
    }
  }
  writeIndex(workspaceId, index, stateDir);
  return meta;
}

export function listExecutionOutputs(workspaceId: string, limit = 20, stateDir = getStateDir()): ExecutionOutputMeta[] {
  const items = readIndex(workspaceId, false, stateDir).items;
  return items.slice(-Math.max(1, Math.min(50, limit)));
}

export function readExecutionOutput(
  workspaceId: string,
  id: number,
  stateDir = getStateDir()
):
  | { ok: true; meta: ExecutionOutputMeta; text: string }
  | { ok: false; error: "NOT_FOUND" | "OUTPUT_RESTRICTED" } {
  const meta = readIndex(workspaceId, false, stateDir).items.find((item) => item.id === id);
  if (!meta) return { ok: false, error: "NOT_FOUND" };
  if (!meta.allowed) return { ok: false, error: "OUTPUT_RESTRICTED" };
  const file = bodyFile(workspaceId, id, stateDir);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return { ok: true, meta, text };
}

export type ExecutionOutputSnapshot =
  | { state: "readable"; meta: ExecutionOutputMeta; text: string; textSha256: string }
  | { state: "restricted"; meta: ExecutionOutputMeta }
  | { state: "unavailable"; outputId: number; meta?: ExecutionOutputMeta; reason: string }
  | { state: "not-retained"; outputId: number };

function isInside(root: string, candidate: string): boolean {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const normalizedBase = process.platform === "win32" ? base.toLowerCase() : base;
  const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${path.sep}`);
}

function parseOutputMeta(value: unknown): ExecutionOutputMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(raw.id) || (raw.id as number) <= 0 ||
    typeof raw.command !== "string" || Buffer.byteLength(raw.command, "utf8") > 200 ||
    (raw.exitCode !== null && (!Number.isSafeInteger(raw.exitCode) || typeof raw.exitCode !== "number")) ||
    typeof raw.timestamp !== "string" ||
    (raw.taskId !== undefined && typeof raw.taskId !== "string") ||
    (raw.iteration !== undefined && (!Number.isSafeInteger(raw.iteration) || typeof raw.iteration !== "number")) ||
    typeof raw.allowed !== "boolean" ||
    (raw.restrictedReason !== undefined && typeof raw.restrictedReason !== "string") ||
    typeof raw.truncated !== "boolean" ||
    !Number.isSafeInteger(raw.sizeBytes) || (raw.sizeBytes as number) < 0 ||
    (raw.allowed === false && raw.sizeBytes !== 0)
  ) return null;
  return {
    id: raw.id as number,
    command: raw.command,
    exitCode: raw.exitCode as number | null,
    timestamp: raw.timestamp,
    taskId: raw.taskId as string | undefined,
    iteration: raw.iteration as number | undefined,
    allowed: raw.allowed,
    restrictedReason: raw.restrictedReason as string | undefined,
    truncated: raw.truncated,
    sizeBytes: raw.sizeBytes as number,
  };
}

/** Strict bounded read used when terminal capsules and archive bundles capture existing output. */
export function inspectExecutionOutput(
  workspaceId: string,
  id: number,
  stateDir = getStateDir()
): ExecutionOutputSnapshot {
  assertWorkspaceId(workspaceId);
  if (!Number.isSafeInteger(id) || id <= 0) return { state: "unavailable", outputId: id, reason: "INVALID_OUTPUT_ID" };
  const root = path.resolve(stateDir);
  const outputRoot = path.join(root, "execution-outputs", workspaceId);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    return { state: "not-retained", outputId: id };
  }
  for (const directory of [path.join(root, "execution-outputs"), outputRoot]) {
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { state: "unavailable", outputId: id, reason: "OUTPUT_DIRECTORY_INVALID" };
      const real = fs.realpathSync.native(directory);
      if (!isInside(realRoot, real)) return { state: "unavailable", outputId: id, reason: "OUTPUT_CONTAINMENT" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "not-retained", outputId: id };
      return { state: "unavailable", outputId: id, reason: "OUTPUT_DIRECTORY_UNREADABLE" };
    }
  }

  const index = path.join(outputRoot, "index.json");
  let indexText: string;
  try {
    const stat = fs.lstatSync(index);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) {
      return { state: "unavailable", outputId: id, reason: "OUTPUT_INDEX_INVALID" };
    }
    indexText = fs.readFileSync(index, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "not-retained", outputId: id };
    return { state: "unavailable", outputId: id, reason: "OUTPUT_INDEX_UNREADABLE" };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(indexText); } catch { return { state: "unavailable", outputId: id, reason: "OUTPUT_INDEX_MALFORMED" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "unavailable", outputId: id, reason: "OUTPUT_INDEX_MALFORMED" };
  }
  const rawIndex = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(rawIndex.nextId) || (rawIndex.nextId as number) <= 0 || !Array.isArray(rawIndex.items) || rawIndex.items.length > MAX_OUTPUT_RECORDS) {
    return { state: "unavailable", outputId: id, reason: "OUTPUT_INDEX_INVALID" };
  }
  const matches = rawIndex.items.map(parseOutputMeta);
  if (matches.some((item) => item === null)) return { state: "unavailable", outputId: id, reason: "OUTPUT_INDEX_INVALID" };
  const found = (matches as ExecutionOutputMeta[]).filter((item) => item.id === id);
  if (found.length === 0) return { state: "not-retained", outputId: id };
  if (found.length !== 1) return { state: "unavailable", outputId: id, reason: "OUTPUT_INDEX_DUPLICATE" };
  const meta = found[0];
  if (!meta.allowed) return { state: "restricted", meta };
  if (meta.sizeBytes > 64 * 1024) return { state: "unavailable", outputId: id, meta, reason: "OUTPUT_BODY_OVERSIZED" };

  const file = path.join(outputRoot, "bodies", `${id}.txt`);
  let text = "";
  try {
    const bodyStat = fs.lstatSync(file);
    if (!bodyStat.isFile() || bodyStat.isSymbolicLink() || bodyStat.size > 64 * 1024) {
      return { state: "unavailable", outputId: id, meta, reason: "OUTPUT_BODY_INVALID" };
    }
    const realBody = fs.realpathSync.native(file);
    if (!isInside(realRoot, realBody) || !isInside(outputRoot, realBody)) {
      return { state: "unavailable", outputId: id, meta, reason: "OUTPUT_BODY_CONTAINMENT" };
    }
    const bytes = fs.readFileSync(file);
    text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes) || bytes.byteLength !== meta.sizeBytes) {
      return { state: "unavailable", outputId: id, meta, reason: "OUTPUT_BODY_SIZE_MISMATCH" };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && meta.sizeBytes === 0) {
      text = "";
    } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "unavailable", outputId: id, meta, reason: "OUTPUT_BODY_MISSING" };
    } else {
      return { state: "unavailable", outputId: id, meta, reason: "OUTPUT_BODY_UNREADABLE" };
    }
  }
  return {
    state: "readable",
    meta,
    text,
    textSha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
  };
}
