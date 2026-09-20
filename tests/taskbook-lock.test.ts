import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  MAX_TOTAL_STORAGE_BYTES,
  TaskbookError,
  createEnvelope,
  inventoryWorkspaceTaskRoot,
  nodeTaskbookIo,
  resolveTaskbookPaths,
  serializeEnvelope,
  submitTaskbook,
  utf8Bytes,
  type TaskbookIo,
} from "../src/taskbook/index.js";
import {
  cleanupExternalTempDirs,
  externalTempDir,
  projectWorkspaceFixture,
  writeTextFile,
} from "./taskbook-helpers.js";

/**
 * R1 cross-process admission lock.
 *
 * The concurrency cases use genuinely independent child processes sharing one
 * C2C state root and workspace ID; two promises in one process are not used as
 * the concurrency proof.
 */

const WS_A = "915f50d36e23";
const WS_B = "deadbeef0000";
const CHILD_SCRIPT = path.join(process.cwd(), "tests", "fixtures", "taskbook-submit-child.ts");
let projectRoot: string;

beforeAll(() => {
  projectRoot = projectWorkspaceFixture();
});

afterAll(() => {
  cleanupExternalTempDirs();
});

interface Workspace {
  stateDir: string;
  root: string;
  lockPath: string;
}

function freshWorkspace(prefix: string, workspaceId = WS_A): Workspace {
  const stateDir = externalTempDir(prefix);
  const paths = resolveTaskbookPaths({ workspaceId, projectRoot, stateDir });
  return { stateDir, root: paths.workspaceTaskRoot, lockPath: paths.lockPath };
}

function submitIn(workspace: Workspace, title: string, body: string, extra: Record<string, unknown> = {}) {
  return submitTaskbook({ title, body }, { workspaceId: WS_A, projectRoot, stateDir: workspace.stateDir, ...extra });
}

function inventoryIn(workspace: Workspace) {
  return inventoryWorkspaceTaskRoot(nodeTaskbookIo, workspace.root);
}

function expectCode(fn: () => unknown, code: string, detail?: string): TaskbookError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TaskbookError);
    const taskbookError = error as TaskbookError;
    expect(taskbookError.code).toBe(code);
    if (detail !== undefined) expect(taskbookError.detail).toBe(detail);
    return taskbookError;
  }
  throw new Error(`expected a TaskbookError with code ${code}`);
}

function ioWith(overrides: Partial<TaskbookIo>): TaskbookIo {
  return { ...nodeTaskbookIo, ...overrides };
}

function err(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function seqUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function validEnvelope(index: number): string {
  return serializeEnvelope(createEnvelope(`title-${index}`, `body-${index}`, "2026-09-11T00:00:00.000Z"));
}

function proposedBytesFor(title: string, body: string): number {
  return utf8Bytes(serializeEnvelope(createEnvelope(title, body, "2000-01-01T00:00:00.000Z")));
}

interface ChildResult {
  ok: boolean;
  code?: string;
  receipt?: { taskId: string; status: string; bodySha256: string };
}

function runChild(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", CHILD_SCRIPT, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function readResult(file: string): ChildResult {
  return JSON.parse(fs.readFileSync(file, "utf8")) as ChildResult;
}

function childArgs(workspace: Workspace, title: string, resultFile: string, workspaceId = WS_A): string[] {
  return [workspace.stateDir, projectRoot, workspaceId, title, `body-${title}`, resultFile];
}

describe("B7 lock semantics", () => {
  it("keeps the lock outside the task inventory and releases it after success", () => {
    const workspace = freshWorkspace("c2c-tb-lock-basic");
    const receipt = submitIn(workspace, "t", "b");
    expect(receipt.status).toBe("pending");
    expect(fs.existsSync(workspace.lockPath)).toBe(false);
    // Task inventory counts task records only; the lock namespace is not chargeable.
    expect(inventoryIn(workspace)).toEqual({
      entries: 1,
      storageBytes: fs.statSync(path.join(workspace.root, `${receipt.taskId}.json`)).size,
      pending: 1,
    });
  });

  it("fails closed immediately when the lock already exists", () => {
    const workspace = freshWorkspace("c2c-tb-lock-held");
    fs.mkdirSync(workspace.lockPath);
    const started = Date.now();
    expectCode(() => submitIn(workspace, "t", "b"), "STORAGE_ERROR", "LOCK_HELD");
    expect(Date.now() - started).toBeLessThan(2000);
    // No waiting, no queue, no retry: nothing was created.
    expect(inventoryIn(workspace).entries).toBe(0);
  });

  it("does not auto-break a stale-looking lock", () => {
    const workspace = freshWorkspace("c2c-tb-lock-stale");
    fs.mkdirSync(workspace.lockPath);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(workspace.lockPath, old, old);
    expectCode(() => submitIn(workspace, "t", "b"), "STORAGE_ERROR", "LOCK_HELD");
    expect(fs.existsSync(workspace.lockPath)).toBe(true);
    expect(inventoryIn(workspace).entries).toBe(0);
  });

  it("releases the lock after an ordinary failure when release itself works", () => {
    const workspace = freshWorkspace("c2c-tb-lock-release");
    const paths = resolveTaskbookPaths({ workspaceId: WS_A, projectRoot, stateDir: workspace.stateDir });
    for (let i = 0; i < 32; i += 1) {
      writeTextFile(path.join(workspace.root, `${seqUuid(i)}.json`), validEnvelope(i));
    }
    expectCode(() => submitIn(workspace, "t", "b"), "LIMIT_EXCEEDED", "PENDING_CAP");
    expect(fs.existsSync(paths.lockPath)).toBe(false);
    // A second attempt must fail on the quota again, not on a leaked lock.
    expectCode(() => submitIn(workspace, "t", "b"), "LIMIT_EXCEEDED", "PENDING_CAP");
  });

  it("emits the audit event only after the lock has been released", () => {
    const workspace = freshWorkspace("c2c-tb-lock-audit");
    const observed: boolean[] = [];
    const logger = {
      debug: () => undefined,
      info: () => {
        observed.push(fs.existsSync(workspace.lockPath));
      },
      warn: () => undefined,
      error: () => undefined,
    };
    const receipt = submitIn(workspace, "t", "b", { logger });
    expect(receipt.status).toBe("pending");
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((exists) => exists === false)).toBe(true);
  });
});

describe("B8 post-close / unlock failure semantics", () => {
  it("keeps success, does not retry or duplicate, and blocks later submissions when unlock fails", () => {
    const workspace = freshWorkspace("c2c-tb-unlock-fail");
    const io = ioWith({
      rmdir: () => {
        throw err("EPERM");
      },
    });
    const receipt = submitIn(workspace, "unlock", "b", { io });
    expect(receipt.status).toBe("pending");

    const taskFile = path.join(workspace.root, `${receipt.taskId}.json`);
    expect(fs.existsSync(taskFile)).toBe(true);
    expect(fs.readdirSync(workspace.root).filter((name) => name === `${receipt.taskId}.json`)).toHaveLength(1);
    expect(fs.existsSync(workspace.lockPath)).toBe(true);

    // The surviving lock blocks the next submission fail-closed.
    expectCode(() => submitIn(workspace, "next", "b"), "STORAGE_ERROR", "LOCK_HELD");
  });

  it("never reports success when the write fails", () => {
    const workspace = freshWorkspace("c2c-tb-write-fail");
    const error = expectCode(
      () =>
        submitIn(workspace, "t", "b", {
          io: ioWith({
            writeAll: () => {
              throw err("EIO");
            },
          }),
        }),
      "STORAGE_ERROR",
      "EIO"
    );
    expect(error.code).toBe("STORAGE_ERROR");
    expect(inventoryIn(workspace).pending).toBe(0);
  });

  it("never reports success when the close fails", () => {
    const workspace = freshWorkspace("c2c-tb-close-fail");
    expectCode(
      () =>
        submitIn(workspace, "t", "b", {
          io: ioWith({
            close: () => {
              throw err("EIO");
            },
          }),
        }),
      "STORAGE_ERROR",
      "EIO"
    );
  });
});

describe("B7 real cross-process concurrency", () => {
  it("never lets a pending race reach 33 pending records", async () => {
    const workspace = freshWorkspace("c2c-tb-race-pending");
    for (let i = 0; i < 31; i += 1) {
      writeTextFile(path.join(workspace.root, `${seqUuid(i)}.json`), validEnvelope(i));
    }
    const resultA = path.join(workspace.stateDir, "result-a.json");
    const resultB = path.join(workspace.stateDir, "result-b.json");
    await Promise.all([
      runChild(childArgs(workspace, "race-a", resultA)),
      runChild(childArgs(workspace, "race-b", resultB)),
    ]);
    const a = readResult(resultA);
    const b = readResult(resultB);
    const successes = [a, b].filter((result) => result.ok);
    expect(successes.length).toBe(1);
    const inventory = inventoryIn(workspace);
    expect(inventory.pending).toBe(32);
    expect(inventory.pending).not.toBe(33);
    const loser = [a, b].find((result) => !result.ok);
    console.log(
      `TASKBOOK-RACE-PENDING: winners=1 losers=1 loserCode=${loser?.code ?? "none"} finalPending=${inventory.pending}`
    );
  }, 120_000);

  it("never lets a storage race exceed the storage cap", async () => {
    const title = "race-storage";
    const body = "race-storage-body";
    const proposed = proposedBytesFor(title, body);
    const workspace = freshWorkspace("c2c-tb-race-storage");
    const sidecar = path.join(workspace.root, "preexisting.bin");
    const sidecarSize = MAX_TOTAL_STORAGE_BYTES - 2 * proposed + 1;
    fs.writeFileSync(sidecar, "");
    fs.truncateSync(sidecar, sidecarSize);

    const resultA = path.join(workspace.stateDir, "result-a.json");
    const resultB = path.join(workspace.stateDir, "result-b.json");
    await Promise.all([
      runChild(childArgs(workspace, title, resultA)),
      runChild(childArgs(workspace, title, resultB)),
    ]);
    const a = readResult(resultA);
    const b = readResult(resultB);
    const successes = [a, b].filter((result) => result.ok);
    expect(successes.length).toBeLessThanOrEqual(1);
    const storage = inventoryIn(workspace).storageBytes;
    expect(storage).toBeLessThanOrEqual(MAX_TOTAL_STORAGE_BYTES);
    console.log(
      `TASKBOOK-RACE-STORAGE: winners=${successes.length} finalBytes=${storage} cap=${MAX_TOTAL_STORAGE_BYTES}`
    );
  }, 120_000);

  it("proves real cross-process lock contention on the same workspace", async () => {
    const workspace = freshWorkspace("c2c-tb-race-lock");
    fs.mkdirSync(workspace.lockPath);
    const result = path.join(workspace.stateDir, "result.json");
    const run = await runChild(childArgs(workspace, "blocked", result));
    expect(run.code).toBe(0);
    const parsed = readResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("STORAGE_ERROR");
    expect(fs.existsSync(workspace.lockPath)).toBe(true);
    expect(inventoryIn(workspace).entries).toBe(0);
    console.log("TASKBOOK-LOCK-CONTENTION: separate process failed closed on an existing lock");
  }, 120_000);

  it("gives different workspace IDs independent lock leaves", async () => {
    const workspaceA = freshWorkspace("c2c-tb-race-wsA", WS_A);
    const workspaceB = freshWorkspace("c2c-tb-race-wsB", WS_B);
    expect(workspaceA.lockPath).not.toBe(workspaceB.lockPath);

    fs.mkdirSync(workspaceA.lockPath);
    const result = path.join(workspaceB.stateDir, "result-wsB.json");
    const args = [workspaceB.stateDir, projectRoot, WS_B, "ws-b", "body-ws-b", result];
    const run = await runChild(args);
    expect(run.code).toBe(0);
    expect(readResult(result).ok).toBe(true);
    expect(fs.existsSync(workspaceA.lockPath)).toBe(true);
    expect(inventoryIn(workspaceA).entries).toBe(0);
    expect(inventoryIn(workspaceB).pending).toBe(1);
    console.log("TASKBOOK-LOCK-ISOLATION: workspace B succeeded while workspace A's lock was held");
  }, 120_000);
});
