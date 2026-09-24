import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";

/**
 * Lightweight execution records written by the Codex harness after each
 * iteration (via `c2c record`). ChatGPT reads them through the
 * `execution_summary` and `test_status` MCP tools.
 */
export const executionRecordSchema = z.object({
  taskId: z.string(),
  iteration: z.number().int().nonnegative(),
  changedFiles: z.union([z.array(z.string()), z.number().int().nonnegative()]),
  tests: z.string().nullable(),
  exitStatus: z.string(),
  timestamp: z.string(),
  notes: z.string().optional(),
  outputId: z.number().int().positive().optional(),
  outputAvailable: z.boolean().optional(),
});

export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

export const MAX_STREAMED_RECORD_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_RECORD_CAPTURE_BYTES = 1024 * 1024;
export const MAX_ARCHIVE_RECORD_CAPTURE_COUNT = 10_000;
const STREAM_CHUNK_BYTES = 64 * 1024;

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) throw new Error("Invalid workspace ID for execution records.");
}

function executionsDir(stateDir = getStateDir()): string {
  return path.join(path.resolve(stateDir), "executions");
}

function recordsFile(workspaceId: string, stateDir = getStateDir()): string {
  assertWorkspaceId(workspaceId);
  const dir = ensureDir(executionsDir(stateDir));
  return path.join(dir, `${workspaceId}.jsonl`);
}

function existingRecordsFile(workspaceId: string, stateDir = getStateDir()): string {
  assertWorkspaceId(workspaceId);
  return path.join(executionsDir(stateDir), `${workspaceId}.jsonl`);
}

function withRecordLogLock<T>(workspaceId: string, stateDir: string, operation: () => T): T {
  const dir = ensureDir(executionsDir(stateDir));
  const lock = path.join(dir, `${workspaceId}.lock`);
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Execution record log is busy; retry after the active writer or compaction finishes.");
    }
    throw error;
  }
  try {
    return operation();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      // Keep a failed lock release visible as a future fail-closed writer error.
    }
  }
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord, stateDir = getStateDir()): void {
  const serialized = JSON.stringify(executionRecordSchema.parse(record)) + "\n";
  withRecordLogLock(workspaceId, stateDir, () => {
    const file = recordsFile(workspaceId, stateDir);
    fs.appendFileSync(file, serialized, { mode: 0o600 });
  });
}

export function readExecutionRecords(workspaceId: string, limit = 10, stateDir = getStateDir()): ExecutionRecord[] {
  const file = recordsFile(workspaceId, stateDir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: ExecutionRecord[] = [];
  const requestedLimit = Math.max(1, Math.floor(limit));
  for (let index = lines.length - 1; index >= 0 && records.length < requestedLimit; index--) {
    try {
      const record = executionRecordSchema.safeParse(JSON.parse(lines[index]));
      if (record.success) records.push(record.data);
    } catch {
      // skip corrupt lines
    }
  }
  return records.reverse();
}

/** Bounded, read-only full snapshot for strict Taskbook recovery evidence. */
export function readExecutionRecordSnapshot(
  workspaceId: string,
  maxBytes = 4 * 1024 * 1024,
  stateDir = getStateDir()
): { complete: true; records: ExecutionRecord[] } | { complete: false; records: [] } {
  const file = existingRecordsFile(workspaceId, stateDir);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { complete: true, records: [] };
    return { complete: false, records: [] };
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) return { complete: false, records: [] };

  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { complete: false, records: [] };
  }
  let after: fs.Stats;
  try {
    after = fs.lstatSync(file);
  } catch {
    return { complete: false, records: [] };
  }
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    Buffer.byteLength(text, "utf8") !== after.size ||
    (text.length > 0 && !text.endsWith("\n"))
  ) {
    return { complete: false, records: [] };
  }
  const records: ExecutionRecord[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { complete: false, records: [] };
    }
    const record = executionRecordSchema.safeParse(parsed);
    if (!record.success) return { complete: false, records: [] };
    records.push(record.data);
  }
  return { complete: true, records };
}

export interface ExecutionRecordLine {
  record: ExecutionRecord;
  /** Exact UTF-8 JSON bytes of this JSONL row, excluding its final LF. */
  lineText: string;
  /** SHA-256 of the exact UTF-8 JSONL bytes, including the newline. */
  lineSha256: string;
}

export type ExecutionRecordLinesResult =
  | { complete: true; recordsByTask: Map<string, ExecutionRecordLine[]>; fileDigest: string; bytes: number }
  | { complete: false; recordsByTask: Map<string, ExecutionRecordLine[]>; reason: string; bytes: number };

function isInside(root: string, candidate: string): boolean {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const normalizedBase = process.platform === "win32" ? base.toLowerCase() : base;
  const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${path.sep}`);
}

function stableStats(before: fs.Stats, after: fs.Stats): boolean {
  return (
    before.isFile() &&
    !before.isSymbolicLink() &&
    after.isFile() &&
    !after.isSymbolicLink() &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ino === after.ino &&
    before.dev === after.dev
  );
}

/**
 * Streaming-safe, strict JSONL read for archive evidence. The total log has no
 * size ceiling; each individual JSONL row is capped at 4 MiB so one hostile or
 * damaged line cannot force an unbounded allocation. Recover keeps its separate
 * historical 4 MiB whole-file ceiling above.
 */
export function readExecutionRecordLinesForTasks(
  workspaceId: string,
  taskIds: readonly string[],
  stateDir = getStateDir(),
  captureBounds: { maxBytes?: number; maxRecords?: number } = {}
): ExecutionRecordLinesResult {
  assertWorkspaceId(workspaceId);
  const targets = new Set(taskIds);
  const recordsByTask = new Map<string, ExecutionRecordLine[]>();
  for (const taskId of targets) recordsByTask.set(taskId, []);
  const maxCapturedBytes = captureBounds.maxBytes ?? MAX_ARCHIVE_RECORD_CAPTURE_BYTES;
  const maxCapturedRecords = captureBounds.maxRecords ?? MAX_ARCHIVE_RECORD_CAPTURE_COUNT;
  if (!Number.isSafeInteger(maxCapturedBytes) || maxCapturedBytes < 0 || !Number.isSafeInteger(maxCapturedRecords) || maxCapturedRecords < 0) {
    return { complete: false, recordsByTask: new Map(), reason: "INVALID_CAPTURE_BOUNDS", bytes: 0 };
  }
  const file = existingRecordsFile(workspaceId, stateDir);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { complete: true, recordsByTask, fileDigest: createHash("sha256").digest("hex"), bytes: 0 };
    }
    return { complete: false, recordsByTask: new Map(), reason: "LOG_STAT_FAILED", bytes: 0 };
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    return { complete: false, recordsByTask: new Map(), reason: "LOG_NOT_REGULAR", bytes: 0 };
  }
  try {
    const realRoot = fs.realpathSync.native(path.resolve(stateDir));
    const realFile = fs.realpathSync.native(file);
    if (!isInside(realRoot, realFile)) {
      return { complete: false, recordsByTask: new Map(), reason: "LOG_CONTAINMENT", bytes: 0 };
    }
  } catch {
    return { complete: false, recordsByTask: new Map(), reason: "LOG_REALPATH_FAILED", bytes: 0 };
  }

  const fd = fs.openSync(file, "r");
  const fileHash = createHash("sha256");
  let bytesRead = 0;
  let carry = Buffer.alloc(0);
  let capturedBytes = 0;
  let capturedRecords = 0;
  let failure: string | null = null;
  const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);

  const processLine = (lineWithNewline: Buffer): void => {
    if (failure) return;
    if (lineWithNewline.length === 0 || lineWithNewline[lineWithNewline.length - 1] !== 0x0a) {
      failure = "LOG_LINE_TERMINATOR";
      return;
    }
    const line = lineWithNewline.subarray(0, lineWithNewline.length - 1);
    if (line.length > MAX_STREAMED_RECORD_LINE_BYTES) {
      failure = "LOG_LINE_TOO_LARGE";
      return;
    }
    const text = line.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(line)) {
      failure = "LOG_INVALID_UTF8";
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      failure = "LOG_MALFORMED_LINE";
      return;
    }
    const checked = executionRecordSchema.safeParse(parsed);
    if (!checked.success) {
      failure = "LOG_INVALID_RECORD";
      return;
    }
    if (targets.has(checked.data.taskId)) {
      const lineText = line.toString("utf8");
      const captureCost = lineWithNewline.length + Buffer.byteLength(JSON.stringify(checked.data), "utf8") + 64;
      if (capturedRecords >= maxCapturedRecords) {
        failure = "TARGET_RECORD_COUNT_OVER_CAP";
        return;
      }
      if (captureCost > maxCapturedBytes - capturedBytes) {
        failure = "TARGET_RECORD_CAPTURE_OVER_CAP";
        return;
      }
      capturedRecords += 1;
      capturedBytes += captureCost;
      recordsByTask.get(checked.data.taskId)?.push({
        record: checked.data,
        lineText,
        lineSha256: createHash("sha256").update(lineWithNewline).digest("hex"),
      });
    }
  };

  try {
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      bytesRead += count;
      const part = chunk.subarray(0, count);
      fileHash.update(part);
      const combined = carry.length === 0 ? part : Buffer.concat([carry, part]);
      let start = 0;
      for (;;) {
        const newline = combined.indexOf(0x0a, start);
        if (newline < 0) break;
        processLine(combined.subarray(start, newline + 1));
        start = newline + 1;
        if (failure) break;
      }
      carry = failure ? Buffer.alloc(0) : Buffer.from(combined.subarray(start));
      if (carry.length > MAX_STREAMED_RECORD_LINE_BYTES) failure = "LOG_LINE_TOO_LARGE";
      if (failure) break;
    }
    if (!failure && carry.length > 0) failure = "LOG_MISSING_FINAL_NEWLINE";
  } catch {
    failure = "LOG_READ_FAILED";
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      failure ??= "LOG_CLOSE_FAILED";
    }
  }

  let after: fs.Stats | null = null;
  try {
    after = fs.lstatSync(file);
  } catch {
    failure ??= "LOG_RESTAT_FAILED";
  }
  if (!after || !stableStats(before, after) || bytesRead !== after.size) failure ??= "LOG_CHANGED_DURING_READ";
  if (failure) return { complete: false, recordsByTask: new Map(), reason: failure, bytes: bytesRead };
  return { complete: true, recordsByTask, fileDigest: fileHash.digest("hex"), bytes: bytesRead };
}

export interface ExecutionRecordCompactionResult {
  ok: boolean;
  removed: number;
  retained: number;
  reason?: string;
}

/**
 * Atomically remove only exact JSONL rows already captured in verified archive
 * bundles. Every writer shares a per-workspace log lock with this operation.
 */
export function compactArchivedExecutionRecordLines(
  workspaceId: string,
  archivedLineHashes: readonly string[],
  stateDir = getStateDir()
): ExecutionRecordCompactionResult {
  assertWorkspaceId(workspaceId);
  const remove = new Set(archivedLineHashes);
  if ([...remove].some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
    return { ok: false, removed: 0, retained: 0, reason: "INVALID_ARCHIVE_LINE_HASH" };
  }

  return withRecordLogLock(workspaceId, stateDir, () => {
    const file = existingRecordsFile(workspaceId, stateDir);
    let before: fs.Stats;
    try {
      before = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, removed: 0, retained: 0 };
      return { ok: false, removed: 0, retained: 0, reason: "LOG_STAT_FAILED" };
    }
    if (!before.isFile() || before.isSymbolicLink()) return { ok: false, removed: 0, retained: 0, reason: "LOG_NOT_REGULAR" };

    const temp = `${file}.compact-${randomUUID()}.tmp`;
    let inputFd: number | null = null;
    let outputFd: number | null = null;
    let removed = 0;
    let retained = 0;
    const expectedDigest = createHash("sha256");
    let carry = Buffer.alloc(0);
    let failure: string | null = null;
    const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);

    try {
      inputFd = fs.openSync(file, "r");
      outputFd = fs.openSync(temp, "wx", 0o600);
      const processLine = (lineWithNewline: Buffer): void => {
        if (failure) return;
        if (lineWithNewline.length === 0 || lineWithNewline[lineWithNewline.length - 1] !== 0x0a) {
          failure = "LOG_LINE_TERMINATOR";
          return;
        }
        const line = lineWithNewline.subarray(0, lineWithNewline.length - 1);
        if (line.length > MAX_STREAMED_RECORD_LINE_BYTES) {
          failure = "LOG_LINE_TOO_LARGE";
          return;
        }
        const text = line.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(line)) {
          failure = "LOG_INVALID_UTF8";
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          failure = "LOG_MALFORMED_LINE";
          return;
        }
        if (!executionRecordSchema.safeParse(parsed).success) {
          failure = "LOG_INVALID_RECORD";
          return;
        }
        const lineHash = createHash("sha256").update(lineWithNewline).digest("hex");
        if (remove.has(lineHash)) {
          removed += 1;
        } else {
          fs.writeSync(outputFd!, lineWithNewline);
          expectedDigest.update(lineWithNewline);
          retained += 1;
        }
      };

      for (;;) {
        const count = fs.readSync(inputFd, chunk, 0, chunk.length, null);
        if (count === 0) break;
        const combined = carry.length === 0 ? chunk.subarray(0, count) : Buffer.concat([carry, chunk.subarray(0, count)]);
        let start = 0;
        for (;;) {
          const newline = combined.indexOf(0x0a, start);
          if (newline < 0) break;
          processLine(combined.subarray(start, newline + 1));
          start = newline + 1;
          if (failure) break;
        }
        carry = failure ? Buffer.alloc(0) : Buffer.from(combined.subarray(start));
        if (carry.length > MAX_STREAMED_RECORD_LINE_BYTES) failure = "LOG_LINE_TOO_LARGE";
        if (failure) break;
      }
      if (!failure && carry.length > 0) failure = "LOG_MISSING_FINAL_NEWLINE";
      if (!failure) fs.fsyncSync(outputFd);
    } catch {
      failure ??= "COMPACTION_IO_FAILED";
    } finally {
      if (inputFd !== null) {
        try { fs.closeSync(inputFd); } catch { failure ??= "LOG_CLOSE_FAILED"; }
      }
      if (outputFd !== null) {
        try { fs.closeSync(outputFd); } catch { failure ??= "TEMP_CLOSE_FAILED"; }
      }
    }

    if (failure) {
      try { fs.unlinkSync(temp); } catch { /* temp residue is inert */ }
      return { ok: false, removed: 0, retained: 0, reason: failure };
    }

    let after: fs.Stats;
    try {
      after = fs.lstatSync(file);
    } catch {
      try { fs.unlinkSync(temp); } catch { /* temp residue is inert */ }
      return { ok: false, removed: 0, retained: 0, reason: "LOG_RESTAT_FAILED" };
    }
    if (!stableStats(before, after)) {
      try { fs.unlinkSync(temp); } catch { /* temp residue is inert */ }
      return { ok: false, removed: 0, retained: 0, reason: "LOG_CHANGED_DURING_COMPACTION" };
    }

    const expected = expectedDigest.digest("hex");
    const verified = readExecutionRecordLinesForTasks(workspaceId, [], stateDir);
    // The pre-rename read verifies the original source log. Validate the temp
    // separately by temporarily applying the same strict streaming contract.
    const tempVerification = verifyExecutionRecordFile(temp);
    if (!verified.complete || !tempVerification.ok || tempVerification.digest !== expected) {
      try { fs.unlinkSync(temp); } catch { /* temp residue is inert */ }
      return { ok: false, removed: 0, retained: 0, reason: tempVerification.reason ?? "TEMP_VERIFY_FAILED" };
    }

    try {
      fs.renameSync(temp, file);
    } catch {
      try { fs.unlinkSync(temp); } catch { /* temp residue is inert */ }
      return { ok: false, removed: 0, retained: 0, reason: "ATOMIC_REPLACE_FAILED" };
    }
    const finalVerification = verifyExecutionRecordFile(file);
    if (!finalVerification.ok || finalVerification.digest !== expected) {
      return { ok: false, removed, retained, reason: "POST_REPLACE_VERIFY_FAILED" };
    }
    return { ok: true, removed, retained };
  });
}

function verifyExecutionRecordFile(file: string): { ok: boolean; digest: string; reason?: string } {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch {
    return { ok: false, digest: "", reason: "VERIFY_STAT_FAILED" };
  }
  if (!before.isFile() || before.isSymbolicLink()) return { ok: false, digest: "", reason: "VERIFY_NOT_REGULAR" };
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  let carry = Buffer.alloc(0);
  let bytes = 0;
  let failure: string | null = null;
  try {
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      bytes += count;
      const combined = carry.length === 0 ? chunk.subarray(0, count) : Buffer.concat([carry, chunk.subarray(0, count)]);
      let start = 0;
      for (;;) {
        const newline = combined.indexOf(0x0a, start);
        if (newline < 0) break;
        const lineWithNewline = combined.subarray(start, newline + 1);
        const line = lineWithNewline.subarray(0, lineWithNewline.length - 1);
        if (line.length > MAX_STREAMED_RECORD_LINE_BYTES) { failure = "VERIFY_LINE_TOO_LARGE"; break; }
        const text = line.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(line)) { failure = "VERIFY_INVALID_UTF8"; break; }
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { failure = "VERIFY_MALFORMED_LINE"; break; }
        if (!executionRecordSchema.safeParse(parsed).success) { failure = "VERIFY_INVALID_RECORD"; break; }
        hash.update(lineWithNewline);
        start = newline + 1;
      }
      if (failure) break;
      carry = Buffer.from(combined.subarray(start));
      if (carry.length > MAX_STREAMED_RECORD_LINE_BYTES) { failure = "VERIFY_LINE_TOO_LARGE"; break; }
    }
    if (!failure && carry.length > 0) failure = "VERIFY_MISSING_FINAL_NEWLINE";
  } catch {
    failure = "VERIFY_READ_FAILED";
  } finally {
    try { fs.closeSync(fd); } catch { failure ??= "VERIFY_CLOSE_FAILED"; }
  }
  let after: fs.Stats | null = null;
  try { after = fs.lstatSync(file); } catch { failure ??= "VERIFY_RESTAT_FAILED"; }
  if (!after || !stableStats(before, after) || bytes !== after.size) failure ??= "VERIFY_CHANGED";
  return failure ? { ok: false, digest: "", reason: failure } : { ok: true, digest: hash.digest("hex") };
}

export function latestExecutionRecord(workspaceId: string, stateDir = getStateDir()): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1, stateDir);
  return records[records.length - 1] ?? null;
}
