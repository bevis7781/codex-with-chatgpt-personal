import fs from "node:fs";
import path from "node:path";
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

function recordsFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

function existingRecordsFile(workspaceId: string): string {
  return path.join(getStateDir(), "executions", `${workspaceId}.jsonl`);
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): void {
  const file = recordsFile(workspaceId);
  fs.appendFileSync(file, JSON.stringify(executionRecordSchema.parse(record)) + "\n", { mode: 0o600 });
}

export function readExecutionRecords(workspaceId: string, limit = 10): ExecutionRecord[] {
  const file = recordsFile(workspaceId);
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
  maxBytes = 4 * 1024 * 1024
): { complete: true; records: ExecutionRecord[] } | { complete: false; records: [] } {
  const file = existingRecordsFile(workspaceId);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { complete: true, records: [] };
    return { complete: false, records: [] };
  }
  if (!before.isFile() || before.size > maxBytes) return { complete: false, records: [] };

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

export function latestExecutionRecord(workspaceId: string): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1);
  return records[records.length - 1] ?? null;
}
