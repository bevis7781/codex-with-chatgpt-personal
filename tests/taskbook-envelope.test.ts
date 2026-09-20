import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  TaskbookError,
  createEnvelope,
  createNewFileExclusive,
  isCanonicalTaskId,
  nodeTaskbookIo,
  parseEnvelope,
  serializeEnvelope,
  submitTaskbook,
  type TaskbookIo,
} from "../src/taskbook/index.js";
import {
  cleanupExternalTempDirs,
  envelopeText,
  externalTempDir,
  projectWorkspaceFixture,
  removeDir,
  sha256Hex,
  writeTextFile,
} from "./taskbook-helpers.js";

const WORKSPACE_ID = "915f50d36e23";
let stateDir: string;
let projectRoot: string;

beforeAll(() => {
  stateDir = externalTempDir("c2c-taskbook-envelope-state");
  projectRoot = projectWorkspaceFixture();
});

afterAll(() => {
  cleanupExternalTempDirs();
});

function taskRoot(): string {
  return path.join(stateDir, "tasks", WORKSPACE_ID);
}

function submit(
  title: unknown,
  body: unknown,
  extra: Record<string, unknown> = {}
): ReturnType<typeof submitTaskbook> {
  return submitTaskbook(
    { title, body },
    { workspaceId: WORKSPACE_ID, projectRoot, stateDir, ...extra }
  );
}

function expectTaskbookError(fn: () => unknown, code: string, detail?: string): TaskbookError {
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

describe("A2 envelope: caller text stays opaque and C2C fields are not callable", () => {
  it("round-trips exact caller strings", () => {
    const title = "  exact   title  ";
    const body = "line1\nline2\n\ttabbed\n";
    const envelope = createEnvelope(title, body);
    expect(envelope.title).toBe(title);
    expect(envelope.body).toBe(body);
    expect(parseEnvelope(serializeEnvelope(envelope))).toEqual(envelope);
  });

  it("keeps markdown / JSON-like / YAML-like / path-like body text opaque", () => {
    const bodies = [
      "# Heading\n\n- item\n\n```json\n{\"version\": 2}\n```\n",
      '{"version":2,"createdAt":"1999-01-01T00:00:00.000Z","status":"claimed","taskId":"abc"}',
      "version: 2\ncreatedAt: 1999-01-01T00:00:00.000Z\nstatus: claimed\n",
      "C:\\\\Windows\\\\System32\\..\\..\\secrets.json",
      "../../../../etc/passwd",
    ];
    for (const body of bodies) {
      const receipt = submit("opaque body", body);
      const file = path.join(taskRoot(), `${receipt.taskId}.json`);
      const persisted = parseEnvelope(fs.readFileSync(file, "utf8"));
      expect(persisted.body).toBe(body);
      expect(persisted.version).toBe(1);
      expect(persisted.title).toBe("opaque body");
      expect(receipt.bodySha256).toBe(sha256Hex(body));
    }
  });

  it("never lets caller text introduce version/createdAt/workspace/status/taskId/path metadata", () => {
    const hostile = JSON.stringify({
      version: 2,
      createdAt: "1999-01-01T00:00:00.000Z",
      workspaceId: "deadbeef0000",
      status: "claimed",
      taskId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      path: "C:\\\\evil\\\\x.json",
      filename: "evil.json",
    });
    const receipt = submit(hostile, hostile);
    const file = path.join(taskRoot(), `${receipt.taskId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["body", "createdAt", "title", "version"]);
    expect(raw.version).toBe(1);
    expect(raw.title).toBe(hostile);
    expect(raw.body).toBe(hostile);
    expect(raw.createdAt).not.toBe("1999-01-01T00:00:00.000Z");
    // The hostile metadata survives only as opaque title/body text: it never
    // becomes an envelope field, and no caller field is promoted to metadata.
    for (const field of ["workspaceId", "status", "taskId", "path", "filename"]) {
      expect(Object.prototype.hasOwnProperty.call(raw, field)).toBe(false);
    }
    expect(typeof raw.createdAt).toBe("string");
    expect(raw.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("parses the supported version and rejects everything else", () => {
    const valid = envelopeText();
    expect(parseEnvelope(valid).version).toBe(1);

    const bad: Array<[string, string]> = [
      ["unsupported version", envelopeText({ version: 2 })],
      ["version as string", envelopeText({ version: "1" })],
      ["malformed JSON", "{not json"],
      ["trailing garbage", `${envelopeText()} trailing`],
      ["array root", "[]"],
      ["null root", "null"],
      ["wrong title type", envelopeText({ title: 5 })],
      ["wrong body type", envelopeText({ body: null })],
      ["wrong createdAt type", envelopeText({ createdAt: 123 })],
      ["non-ISO createdAt", envelopeText({ createdAt: "2026-09-11" })],
      ["local-time createdAt", envelopeText({ createdAt: "2026-09-11T04:00:00+08:00" })],
    ];
    for (const [label, text] of bad) {
      expectTaskbookError(() => parseEnvelope(text), "STORAGE_ERROR");
      expect(label).toBeTruthy();
    }

    for (const missing of ["version", "createdAt", "title", "body"]) {
      const record: Record<string, unknown> = JSON.parse(envelopeText());
      delete record[missing];
      expectTaskbookError(() => parseEnvelope(JSON.stringify(record)), "STORAGE_ERROR");
    }

    for (const extra of ["workspaceId", "status", "taskId", "path", "filename", "claimedAt"]) {
      expectTaskbookError(
        () => parseEnvelope(envelopeText({ [extra]: "x" })),
        "STORAGE_ERROR"
      );
    }
  });

  it("survives an exact UTF-8 round trip for Chinese and emoji", () => {
    const title = "测试标题 🚀 — 边界";
    const body = "中文正文内容。emoji: 🎉🧪👩‍💻 flags: 🇨🇳";
    const receipt = submit(title, body);
    const file = path.join(taskRoot(), `${receipt.taskId}.json`);
    const persisted = parseEnvelope(fs.readFileSync(file, "utf8"));
    expect(persisted.title).toBe(title);
    expect(persisted.body).toBe(body);
    expect(receipt.bodySha256).toBe(sha256Hex(body));
  });
});

function err(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Remove a fixture path of any type so each case starts from a known state. */
function resetPath(target: string): void {
  try {
    fs.lstatSync(target);
  } catch {
    return;
  }
  try {
    fs.unlinkSync(target);
    return;
  } catch {
    /* not a file-like leaf */
  }
  try {
    fs.rmdirSync(target);
    return;
  } catch {
    /* not a directory-like leaf */
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Deterministic, well-formed lowercase UUID v4 for a repeated hex digit. */
function v4(digit: string): string {
  return `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
}

function leafDir(): string {
  return path.join(stateDir, "leaf-cases");
}
const WRITE_FAIL_ID = "44444444-4444-4444-8444-444444444444";
const CLOSE_FAIL_ID = "55555555-5555-4555-8555-555555555555";

describe("A3 UUID + exclusive create-new on the real filesystem", () => {
  it("generates a canonical lowercase UUID v4 and a <uuid>.json filename", () => {
    const receipt = submit("t", "b");
    expect(isCanonicalTaskId(receipt.taskId)).toBe(true);
    expect(receipt.taskId).toBe(receipt.taskId.toLowerCase());
    expect(fs.readdirSync(taskRoot())).toContain(`${receipt.taskId}.json`);
    expect(Object.keys(receipt).sort()).toEqual(["bodySha256", "createdAt", "status", "taskId"]);
    expect(receipt.status).toBe("pending");
  });

  it("creates a normal new file", () => {
    fs.mkdirSync(leafDir(), { recursive: true });
    const leaf = path.join(leafDir(), `${v4("1")}.json`);
    resetPath(leaf);
    expect(createNewFileExclusive(nodeTaskbookIo, leaf, "NORMAL-CONTENT")).toBe(true);
    expect(fs.readFileSync(leaf, "utf8")).toBe("NORMAL-CONTENT");
  });

  it("never overwrites an existing regular file leaf", () => {
    fs.mkdirSync(leafDir(), { recursive: true });
    const leaf = path.join(leafDir(), `${v4("2")}.json`);
    resetPath(leaf);
    writeTextFile(leaf, "PRESERVE-ME");
    expect(createNewFileExclusive(nodeTaskbookIo, leaf, "NEW-CONTENT")).toBe(false);
    expect(fs.readFileSync(leaf, "utf8")).toBe("PRESERVE-ME");
  });

  it("never replaces an existing directory leaf", () => {
    const target = path.join(leafDir(), `${v4("3")}.json`);
    resetPath(target);
    fs.mkdirSync(target, { recursive: true });
    writeTextFile(path.join(target, "inner.txt"), "keep");
    expect(createNewFileExclusive(nodeTaskbookIo, target, "NEW-CONTENT")).toBe(false);
    expect(fs.lstatSync(target).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(target, "inner.txt"), "utf8")).toBe("keep");
  });

  it("never follows or replaces a file symlink leaf", () => {
    const symlinkTarget = path.join(stateDir, "symlink-target.txt");
    writeTextFile(symlinkTarget, "TARGET-CONTENT");
    const leaf = path.join(leafDir(), `${v4("4")}.json`);
    resetPath(leaf);
    fs.symlinkSync(symlinkTarget, leaf, "file");
    expect(createNewFileExclusive(nodeTaskbookIo, leaf, "NEW-CONTENT")).toBe(false);
    expect(fs.lstatSync(leaf).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(symlinkTarget, "utf8")).toBe("TARGET-CONTENT");
  });

  it("never follows or replaces a dangling symlink leaf", () => {
    const danglingTarget = path.join(stateDir, "never-created.json");
    resetPath(danglingTarget);
    const leaf = path.join(leafDir(), `${v4("5")}.json`);
    resetPath(leaf);
    fs.symlinkSync(danglingTarget, leaf, "file");
    expect(createNewFileExclusive(nodeTaskbookIo, leaf, "NEW-CONTENT")).toBe(false);
    expect(fs.lstatSync(leaf).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(danglingTarget)).toBe(false);
  });

  it("never follows or replaces a junction leaf", () => {
    const junctionTarget = path.join(stateDir, "junction-target");
    fs.mkdirSync(junctionTarget, { recursive: true });
    const leaf = path.join(leafDir(), `${v4("6")}.json`);
    resetPath(leaf);
    fs.symlinkSync(junctionTarget, leaf, "junction");
    expect(createNewFileExclusive(nodeTaskbookIo, leaf, "NEW-CONTENT")).toBe(false);
    expect(fs.lstatSync(leaf).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(junctionTarget)).toEqual([]);
  });

  it("never follows or replaces a directory symlink leaf", () => {
    const dirTarget = path.join(stateDir, "dir-symlink-target");
    fs.mkdirSync(dirTarget, { recursive: true });
    const leaf = path.join(leafDir(), `${v4("7")}.json`);
    resetPath(leaf);
    fs.symlinkSync(dirTarget, leaf, "dir");
    expect(createNewFileExclusive(nodeTaskbookIo, leaf, "NEW-CONTENT")).toBe(false);
    expect(fs.lstatSync(leaf).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(dirTarget)).toEqual([]);
  });

  it("resolves a UUID collision by selecting another UUID", () => {
    const colliding = v4("a");
    const fresh = v4("b");
    const leaf = path.join(taskRoot(), `${colliding}.json`);
    resetPath(leaf);
    writeTextFile(leaf, "COLLIDING-LEAF");
    const seen: string[] = [];
    const receipt = submit("t", "b", {
      nextTaskId: () => {
        const next = seen.length < 3 ? colliding : fresh;
        seen.push(next);
        return next;
      },
    });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(receipt.taskId).toBe(fresh);
    expect(fs.readFileSync(leaf, "utf8")).toBe("COLLIDING-LEAF");
  });

  it("requires a complete write: write failure never reports success", () => {
    resetPath(path.join(taskRoot(), `${WRITE_FAIL_ID}.json`));
    expectTaskbookError(
      () =>
        submit("write-fail", "b", {
          nextTaskId: () => WRITE_FAIL_ID,
          io: ioWith({
            writeAll: () => {
              throw err("EIO");
            },
          }),
        }),
      "STORAGE_ERROR",
      "EIO"
    );
    const leaf = path.join(taskRoot(), `${WRITE_FAIL_ID}.json`);
    if (fs.existsSync(leaf)) {
      expect(fs.statSync(leaf).size).toBe(0);
      expectTaskbookError(() => parseEnvelope(fs.readFileSync(leaf, "utf8")), "STORAGE_ERROR");
    }
  });

  it("requires a successful close: close failure never reports success", () => {
    resetPath(path.join(taskRoot(), `${CLOSE_FAIL_ID}.json`));
    expectTaskbookError(
      () =>
        submit("close-fail", "b", {
          nextTaskId: () => CLOSE_FAIL_ID,
          io: ioWith({
            close: () => {
              throw err("EIO");
            },
          }),
        }),
      "STORAGE_ERROR",
      "EIO"
    );
    // No success receipt was produced. Gate 1 has no cleanup policy, so anything
    // left behind by a close failure is never repaired, purged or guessed valid.
    expect(fs.existsSync(path.join(stateDir, "tasks", WORKSPACE_ID))).toBe(true);
  });

  it("does not auto-repair an incomplete file left by a failure", () => {
    const leaf = path.join(taskRoot(), `${WRITE_FAIL_ID}.json`);
    if (fs.existsSync(leaf)) expect(fs.statSync(leaf).size).toBe(0);
    submit("later-ok", "b");
    if (fs.existsSync(leaf)) expect(fs.statSync(leaf).size).toBe(0);
  });
});

describe("A1 module boundary hygiene", () => {
  it("does not use the permissive readJsonIfExists helper for persisted Taskbook validity", () => {
    const sources = fs
      .readdirSync(path.join(process.cwd(), "src", "taskbook"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => fs.readFileSync(path.join(process.cwd(), "src", "taskbook", name), "utf8"));
    for (const source of sources) {
      expect(source).not.toContain("readJsonIfExists");
      expect(source).not.toContain("Workspace.canonicalize");
      expect(source).not.toContain("child_process");
    }
  });

  it("keeps fixtures out of the repository", () => {
    expect(stateDir.startsWith(process.cwd())).toBe(false);
    expect(projectRoot.startsWith(process.cwd())).toBe(false);
    removeDir(path.join(stateDir, "definitely-not-there"));
  });
});
