import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_BODY_BYTES,
  MAX_ENVELOPE_BYTES,
  MAX_INVENTORY_ENTRIES,
  MAX_PENDING,
  MAX_TOTAL_STORAGE_BYTES,
  MAX_TITLE_BYTES,
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
  removeDir,
  writeTextFile,
} from "./taskbook-helpers.js";

/**
 * Phase B — bounded store admission (Q4 limits, serialized accounting, R3
 * inventory, pending/entry/storage quotas).
 */

const WS = "915f50d36e23";
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
}

function freshWorkspace(prefix = "c2c-tb-adm"): Workspace {
  const stateDir = externalTempDir(prefix);
  const paths = resolveTaskbookPaths({ workspaceId: WS, projectRoot, stateDir });
  return { stateDir, root: paths.workspaceTaskRoot };
}

function submitIn(workspace: Workspace, title: string, body: string, extra: Record<string, unknown> = {}) {
  return submitTaskbook({ title, body }, { workspaceId: WS, projectRoot, stateDir: workspace.stateDir, ...extra });
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

/** Deterministic canonical lowercase UUID v4 values (0..4095). */
function seqUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function validEnvelope(index: number): string {
  return serializeEnvelope(createEnvelope(`title-${index}`, `body-${index}`, "2026-09-11T00:00:00.000Z"));
}

function proposedBytesFor(title: string, body: string): number {
  // createdAt is a fixed-length ISO-8601 UTC string, so the serialized length is stable.
  return utf8Bytes(serializeEnvelope(createEnvelope(title, body, "2000-01-01T00:00:00.000Z")));
}

describe("B2 exact input limits (UTF-8 bytes, not characters)", () => {
  it("accepts 512 title bytes and rejects 513", () => {
    const workspace = freshWorkspace("c2c-tb-title");
    expect(submitIn(workspace, "a".repeat(MAX_TITLE_BYTES), "b").status).toBe("pending");
    expectCode(() => submitIn(workspace, "a".repeat(MAX_TITLE_BYTES + 1), "b"), "LIMIT_EXCEEDED");
  });

  it("applies the title limit to multibyte text", () => {
    const workspace = freshWorkspace("c2c-tb-title-mb");
    expect(submitIn(workspace, "测".repeat(170), "b").status).toBe("pending"); // 510 bytes
    expectCode(() => submitIn(workspace, "测".repeat(171), "b"), "LIMIT_EXCEEDED"); // 513 bytes
  });

  it("accepts 262144 body bytes and rejects 262145", () => {
    const workspace = freshWorkspace("c2c-tb-body");
    expect(submitIn(workspace, "t", "x".repeat(MAX_BODY_BYTES)).status).toBe("pending");
    expectCode(() => submitIn(workspace, "t", "x".repeat(MAX_BODY_BYTES + 1)), "LIMIT_EXCEEDED");
  });

  it("applies the body limit to multibyte text and never to character counts", () => {
    const workspace = freshWorkspace("c2c-tb-body-mb");
    const emoji = "🚀"; // 4 UTF-8 bytes
    expect(utf8Bytes(emoji)).toBe(4);
    expect(submitIn(workspace, "t", emoji.repeat(MAX_BODY_BYTES / 4)).status).toBe("pending");
    expectCode(
      () => submitIn(workspace, "t", `${emoji.repeat(MAX_BODY_BYTES / 4)}z`),
      "LIMIT_EXCEEDED"
    );
  });
});

describe("B3 serialized storage accounting", () => {
  it("charges the exact serialized envelope bytes, including JSON escaping overhead", () => {
    const workspace = freshWorkspace("c2c-tb-accounting");
    const title = '"quoted\\title"\n\t';
    const body = '"a\\b"'.repeat(50) + "\u0001\u0002\u0007" + "中文🚀";
    const receipt = submitIn(workspace, title, body);
    const file = path.join(workspace.root, `${receipt.taskId}.json`);
    const size = fs.statSync(file).size;
    expect(size).toBe(
      utf8Bytes(serializeEnvelope(createEnvelope(title, body, receipt.createdAt)))
    );
    // Escaping expansion: the stored bytes exceed the raw caller byte counts.
    expect(size).toBeGreaterThan(utf8Bytes(title) + utf8Bytes(body));
    expect(inventoryIn(workspace).storageBytes).toBe(size);
  });

  it("does not estimate storage from raw title/body lengths", () => {
    const workspace = freshWorkspace("c2c-tb-accounting2");
    const body = '"'.repeat(4096);
    const receipt = submitIn(workspace, "t", body);
    const file = path.join(workspace.root, `${receipt.taskId}.json`);
    expect(fs.statSync(file).size).toBeGreaterThan(utf8Bytes(body) + 4096 - 10);
  });
});

describe("B4 bounded R3 inventory", () => {
  it("reports an empty store", () => {
    const workspace = freshWorkspace("c2c-tb-inv-empty");
    expect(inventoryIn(workspace)).toEqual({ entries: 0, storageBytes: 0, pending: 0 });
  });

  it("counts valid canonical files as pending and storage", () => {
    const workspace = freshWorkspace("c2c-tb-inv-valid");
    writeTextFile(path.join(workspace.root, `${seqUuid(1)}.json`), validEnvelope(1));
    const inv = inventoryIn(workspace);
    expect(inv).toEqual({
      entries: 1,
      storageBytes: utf8Bytes(validEnvelope(1)),
      pending: 1,
    });
  });

  it("counts malformed, unsupported-version and noncanonical files as entry+storage but not pending", () => {
    const workspace = freshWorkspace("c2c-tb-inv-invalid");
    writeTextFile(path.join(workspace.root, `${seqUuid(1)}.json`), "{not json");
    writeTextFile(path.join(workspace.root, `${seqUuid(2)}.json`), JSON.stringify({ version: 2 }));
    writeTextFile(path.join(workspace.root, "notes.txt"), "not canonical");
    writeTextFile(path.join(workspace.root, `${seqUuid(3)}.json`), validEnvelope(3));

    const inv = inventoryIn(workspace);
    expect(inv.entries).toBe(4);
    expect(inv.pending).toBe(1);
    expect(inv.storageBytes).toBe(
      utf8Bytes("{not json") +
        utf8Bytes(JSON.stringify({ version: 2 })) +
        utf8Bytes("not canonical") +
        utf8Bytes(validEnvelope(3))
    );
  });

  it("counts a zero-byte file as one entry with zero storage and no pending", () => {
    const workspace = freshWorkspace("c2c-tb-inv-zero");
    writeTextFile(path.join(workspace.root, `${seqUuid(1)}.json`), "");
    expect(inventoryIn(workspace)).toEqual({ entries: 1, storageBytes: 0, pending: 0 });
  });

  it("fails closed on a direct directory child and never recurses into it", () => {
    const workspace = freshWorkspace("c2c-tb-inv-dir");
    const dir = path.join(workspace.root, "nested");
    fs.mkdirSync(dir);
    for (let i = 0; i < 500; i += 1) fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
    expectCode(() => inventoryIn(workspace), "STORAGE_ERROR", "UNEXPECTED_CHILD_TYPE");
  });

  it("fails closed on symlink and junction direct children", () => {
    const workspaceA = freshWorkspace("c2c-tb-inv-link");
    const outside = externalTempDir("c2c-tb-inv-link-target");
    fs.symlinkSync(outside, path.join(workspaceA.root, "link"), "dir");
    expectCode(() => inventoryIn(workspaceA), "STORAGE_ERROR", "UNEXPECTED_CHILD_SYMLINK");

    const workspaceB = freshWorkspace("c2c-tb-inv-junc");
    fs.symlinkSync(outside, path.join(workspaceB.root, "junction"), "junction");
    expectCode(() => inventoryIn(workspaceB), "STORAGE_ERROR", "UNEXPECTED_CHILD_SYMLINK");
  });

  it("fails closed when stat fails", () => {
    const workspace = freshWorkspace("c2c-tb-inv-stat");
    writeTextFile(path.join(workspace.root, `${seqUuid(1)}.json`), validEnvelope(1));
    const io = ioWith({
      lstat: (target) => {
        if (target.endsWith(".json")) throw Object.assign(new Error("nope"), { code: "EACCES" });
        return nodeTaskbookIo.lstat(target);
      },
    });
    expectCode(() => inventoryWorkspaceTaskRoot(io, workspace.root), "STORAGE_ERROR", "EACCES");
  });

  it("fails closed when enumeration fails", () => {
    const workspace = freshWorkspace("c2c-tb-inv-enum");
    const io = ioWith({
      readDirBounded: () => {
        throw Object.assign(new Error("nope"), { code: "EIO" });
      },
    });
    expectCode(() => inventoryWorkspaceTaskRoot(io, workspace.root), "STORAGE_ERROR", "EIO");
  });

  it("fails closed when an entry materially changes during inventory", () => {
    const workspace = freshWorkspace("c2c-tb-inv-change");
    const file = path.join(workspace.root, `${seqUuid(1)}.json`);
    writeTextFile(file, validEnvelope(1));
    const io = ioWith({
      readTextFile: (target) => {
        const text = nodeTaskbookIo.readTextFile(target);
        fs.appendFileSync(target, " ");
        return text;
      },
    });
    expectCode(() => inventoryWorkspaceTaskRoot(io, workspace.root), "STORAGE_ERROR", "INVENTORY_INCONSISTENT");
  });

  it("rejects an over-cap directory instead of counting it", () => {
    const workspace = freshWorkspace("c2c-tb-inv-over");
    for (let i = 0; i <= MAX_INVENTORY_ENTRIES; i += 1) {
      writeTextFile(path.join(workspace.root, `e${i}.bin`), "");
    }
    expectCode(() => inventoryIn(workspace), "LIMIT_EXCEEDED", "INVENTORY_OVER_CAP");
  });
});

describe("B4 entry ceiling", () => {
  it("admits one submission at 1023 existing entries (final 1024)", () => {
    const workspace = freshWorkspace("c2c-tb-entry-1023");
    for (let i = 0; i < 1023; i += 1) writeTextFile(path.join(workspace.root, `e${i}.bin`), "");
    expect(submitIn(workspace, "t", "b").status).toBe("pending");
    expect(inventoryIn(workspace).entries).toBe(MAX_INVENTORY_ENTRIES);
  });

  it("rejects a further submission at 1024 existing entries", () => {
    const workspace = freshWorkspace("c2c-tb-entry-1024");
    for (let i = 0; i < 1024; i += 1) writeTextFile(path.join(workspace.root, `e${i}.bin`), "");
    expectCode(() => submitIn(workspace, "t", "b"), "LIMIT_EXCEEDED", "ENTRY_CAP");
    expect(inventoryIn(workspace).entries).toBe(1024);
  });

  it("stops and rejects when a 1025th entry is observed", () => {
    const workspace = freshWorkspace("c2c-tb-entry-1025");
    for (let i = 0; i < 1025; i += 1) writeTextFile(path.join(workspace.root, `e${i}.bin`), "");
    expectCode(() => submitIn(workspace, "t", "b"), "LIMIT_EXCEEDED", "INVENTORY_OVER_CAP");
  });

  it("keeps many zero-byte files bounded by the entry count", () => {
    const workspace = freshWorkspace("c2c-tb-entry-zero");
    for (let i = 0; i < 1024; i += 1) writeTextFile(path.join(workspace.root, `z${i}.bin`), "");
    const inv = inventoryIn(workspace);
    expect(inv.entries).toBe(1024);
    expect(inv.storageBytes).toBe(0);
    expect(inv.pending).toBe(0);
    expectCode(() => submitIn(workspace, "t", "b"), "LIMIT_EXCEEDED", "ENTRY_CAP");
  });
});

describe("B5 pending limit", () => {
  it("admits the 32nd pending record and rejects the 33rd", () => {
    const workspace = freshWorkspace("c2c-tb-pending");
    for (let i = 0; i < MAX_PENDING - 1; i += 1) {
      writeTextFile(path.join(workspace.root, `${seqUuid(i)}.json`), validEnvelope(i));
    }
    expect(inventoryIn(workspace).pending).toBe(31);
    const receipt = submitIn(workspace, "final", "body");
    expect(receipt.status).toBe("pending");
    expect(inventoryIn(workspace).pending).toBe(MAX_PENDING);
    expectCode(() => submitIn(workspace, "overflow", "body"), "LIMIT_EXCEEDED", "PENDING_CAP");
    expect(inventoryIn(workspace).pending).toBe(MAX_PENDING);
  });

  it("does not let malformed or noncanonical files consume pending, but still charges entry/storage", () => {
    const workspace = freshWorkspace("c2c-tb-pending-mix");
    writeTextFile(path.join(workspace.root, "junk.bin"), "0123456789");
    writeTextFile(path.join(workspace.root, `${seqUuid(1)}.json`), "{bad");
    const before = inventoryIn(workspace);
    expect(before.pending).toBe(0);
    expect(before.entries).toBe(2);
    expect(before.storageBytes).toBe(utf8Bytes("0123456789") + utf8Bytes("{bad"));
    submitIn(workspace, "t", "b");
    const after = inventoryIn(workspace);
    expect(after.pending).toBe(1);
    expect(after.entries).toBe(3);
  });
});

describe("B6 storage limit", () => {
  function sidecar(workspace: Workspace, size: number): string {
    const file = path.join(workspace.root, "preexisting.bin");
    fs.writeFileSync(file, "");
    fs.truncateSync(file, size);
    return file;
  }

  it("accepts exactly at the storage cap and rejects one byte beyond", () => {
    const title = "cap-title";
    const body = "cap-body";
    const proposed = proposedBytesFor(title, body);

    const atCap = freshWorkspace("c2c-tb-storage-at");
    const atCapFile = sidecar(atCap, MAX_TOTAL_STORAGE_BYTES - proposed);
    expect(fs.statSync(atCapFile).size).toBe(MAX_TOTAL_STORAGE_BYTES - proposed);
    expect(submitIn(atCap, title, body).status).toBe("pending");
    expect(inventoryIn(atCap).storageBytes).toBeGreaterThan(MAX_TOTAL_STORAGE_BYTES - 1);
    expect(inventoryIn(atCap).storageBytes).toBeLessThanOrEqual(MAX_TOTAL_STORAGE_BYTES);

    const overCap = freshWorkspace("c2c-tb-storage-over");
    const overCapFile = sidecar(overCap, MAX_TOTAL_STORAGE_BYTES - proposed + 1);
    expectCode(() => submitIn(overCap, title, body), "LIMIT_EXCEEDED", "STORAGE_CAP");
    // No cleanup/purge to make room.
    expect(fs.statSync(overCapFile).size).toBe(MAX_TOTAL_STORAGE_BYTES - proposed + 1);
  });

  it("keeps charging storage for large malformed and noncanonical files", () => {
    const workspace = freshWorkspace("c2c-tb-storage-malformed");
    const file = sidecar(workspace, 4096);
    const inv = inventoryIn(workspace);
    expect(inv.storageBytes).toBe(4096);
    expect(inv.pending).toBe(0);
    expect(inv.entries).toBe(1);
    expect(fs.statSync(file).size).toBe(4096);
    removeDir(path.join(workspace.stateDir, "unused"));
  });
});

/**
 * Repair A — the pending quota must not be bypassable through JSON escaping.
 *
 * The pre-repair inventory skipped any canonical file larger than
 * `MAX_TITLE_BYTES + MAX_BODY_BYTES + 1024` (263680 bytes). A legal body made of
 * NUL characters is one UTF-8 byte each but six serialized bytes each, so a valid
 * pending Taskbook could exceed that threshold, be skipped by inventory, and stop
 * counting against `MAX_PENDING = 32`.
 */

/** 50000 NUL characters: 50000 accepted UTF-8 bytes, ~300002 serialized bytes. */
const HIGH_ESCAPE_BODY = "\u0000".repeat(50000);

/** The old, unsafe read filter this repair replaces. */
const OLD_UNSAFE_THRESHOLD = MAX_TITLE_BYTES + MAX_BODY_BYTES + 1024;

describe("Repair A — envelope escaping cannot bypass the pending quota", () => {
  it("A1 — one legal high-escaping Taskbook is persisted and counted as pending", () => {
    const workspace = freshWorkspace("c2c-tb-escape-a1");

    // The raw input is comfortably inside the frozen 262144-byte body limit.
    expect(utf8Bytes(HIGH_ESCAPE_BODY)).toBe(50000);
    expect(utf8Bytes(HIGH_ESCAPE_BODY)).toBeLessThanOrEqual(MAX_BODY_BYTES);

    const receipt = submitIn(workspace, "escape-a1", HIGH_ESCAPE_BODY);
    expect(receipt.status).toBe("pending");

    const file = path.join(workspace.root, `${receipt.taskId}.json`);
    const size = fs.statSync(file).size;
    // JSON escaping expanded the persisted file past the old threshold ...
    expect(size).toBeGreaterThan(OLD_UNSAFE_THRESHOLD);
    // ... while staying inside the new provably safe bound.
    expect(size).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);

    // Inventory must still recognise it as a pending Taskbook, not skip it.
    expect(inventoryIn(workspace)).toEqual({ entries: 1, storageBytes: size, pending: 1 });
    expect(inventoryIn(workspace).pending).toBe(1);
  });

  it("A2 — 32 high-escaping records saturate the pending cap and the 33rd is rejected", () => {
    const workspace = freshWorkspace("c2c-tb-escape-a2");

    for (let i = 0; i < MAX_PENDING; i += 1) {
      expect(submitIn(workspace, `escape-a2-${i}`, HIGH_ESCAPE_BODY).status).toBe("pending");
    }

    const saturated = inventoryIn(workspace);
    expect(saturated.pending).toBe(MAX_PENDING);
    expect(saturated.pending).toBe(32);
    expect(saturated.entries).toBe(32);
    // The storage cap is nowhere near exhausted, so only the pending cap can stop
    // the next request. This is the crux of the Controller finding.
    expect(saturated.storageBytes).toBeLessThan(MAX_TOTAL_STORAGE_BYTES);

    const rejected = expectCode(() => submitIn(workspace, "escape-a2-overflow", HIGH_ESCAPE_BODY), "LIMIT_EXCEEDED");
    expect(rejected.code).toBe("LIMIT_EXCEEDED");
    expect(rejected.detail).toBe("PENDING_CAP");

    const after = inventoryIn(workspace);
    expect(after.pending).toBe(32);
    expect(after.entries).toBe(32);
    expect(after.storageBytes).toBe(saturated.storageBytes);
    expect(after.storageBytes).toBeLessThan(MAX_TOTAL_STORAGE_BYTES);
  }, 180_000);

  it("A3 — every legal serialization stays within the new safe upper bound", () => {
    const cases: Array<{ label: string; title: string; body: string }> = [
      // NUL is the worst case: one UTF-8 byte, six serialized bytes.
      { label: "nul-max", title: "\u0000".repeat(MAX_TITLE_BYTES), body: "\u0000".repeat(MAX_BODY_BYTES) },
      { label: "control", title: "\u0001\u0002\u0003\u0007\u000b\u001f", body: "\u001f".repeat(MAX_BODY_BYTES) },
      { label: "quotes", title: '"'.repeat(MAX_TITLE_BYTES), body: '"'.repeat(MAX_BODY_BYTES) },
      { label: "backslashes", title: "\\".repeat(MAX_TITLE_BYTES), body: "\\".repeat(MAX_BODY_BYTES) },
      // Lone surrogates are escaped as \uXXXX; three UTF-8 bytes each.
      { label: "lone-surrogate", title: "\ud800".repeat(170), body: "\udfff".repeat(MAX_BODY_BYTES / 3) },
      // Multibyte text passes through unescaped.
      { label: "multibyte", title: "测".repeat(170), body: "🚀".repeat(MAX_BODY_BYTES / 4) },
      { label: "mixed", title: '"\\\u0000测\r\n\t', body: '"\\\u0000测🚀\u001f'.repeat(1000) },
    ];

    for (const entry of cases) {
      expect(utf8Bytes(entry.title), entry.label).toBeLessThanOrEqual(MAX_TITLE_BYTES);
      expect(utf8Bytes(entry.body), entry.label).toBeLessThanOrEqual(MAX_BODY_BYTES);
      const serialized = serializeEnvelope(createEnvelope(entry.title, entry.body, "2026-09-11T00:00:00.000Z"));
      expect(utf8Bytes(serialized), entry.label).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
    }

    // The bound is tight (achieved) and still dominates the old unsafe threshold.
    const worst = serializeEnvelope(
      createEnvelope("\u0000".repeat(MAX_TITLE_BYTES), "\u0000".repeat(MAX_BODY_BYTES), "2026-09-11T00:00:00.000Z")
    );
    expect(utf8Bytes(worst)).toBe(MAX_ENVELOPE_BYTES);
    expect(MAX_ENVELOPE_BYTES).toBeGreaterThan(OLD_UNSAFE_THRESHOLD);

    // ... and the persisted worst case is genuinely accepted by the store.
    const workspace = freshWorkspace("c2c-tb-escape-a3");
    const receipt = submitIn(workspace, "\u0000".repeat(MAX_TITLE_BYTES), "\u0000".repeat(MAX_BODY_BYTES));
    expect(receipt.status).toBe("pending");
    expect(fs.statSync(path.join(workspace.root, `${receipt.taskId}.json`)).size).toBe(MAX_ENVELOPE_BYTES);
    expect(inventoryIn(workspace).pending).toBe(1);
  }, 180_000);

  it("A4 — an impossible oversized canonical file counts entry/storage but is never read or counted pending", () => {
    const workspace = freshWorkspace("c2c-tb-escape-a4");
    const oversized = path.join(workspace.root, `${seqUuid(1)}.json`);
    const size = MAX_ENVELOPE_BYTES + 1;
    fs.writeFileSync(oversized, "");
    fs.truncateSync(oversized, size);
    expect(fs.statSync(oversized).size).toBe(size);

    const reads: string[] = [];
    const io = ioWith({
      readTextFile: (target) => {
        reads.push(target);
        return nodeTaskbookIo.readTextFile(target);
      },
    });

    const inv = inventoryWorkspaceTaskRoot(io, workspace.root);
    expect(inv).toEqual({ entries: 1, storageBytes: size, pending: 0 });
    // The impossible file is rejected from its size alone: no full read occurs.
    expect(reads).toEqual([]);
  });
});
