import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  TaskbookError,
  isInsideRoot,
  nodeTaskbookIo,
  resolveTaskbookPaths,
  submitTaskbook,
  inventoryWorkspaceTaskRoot,
  serializeEnvelope,
  createEnvelope,
} from "../src/taskbook/index.js";
import {
  cleanupExternalTempDirs,
  externalTempDir,
  projectWorkspaceFixture,
} from "./taskbook-helpers.js";

/**
 * R2 static containment on the real Windows filesystem (symlink / junction /
 * reparse topology). Every case is reported explicitly as PASS or NOT VERIFIED;
 * an unavailable topology is never silently treated as a pass.
 */

const WS_A = "915f50d36e23";
const WS_B = "deadbeef0000";
const CASE_FILE = path.join(os.tmpdir(), "c2c-taskbook-windows-cases.json");

type CaseStatus = "PASS" | "NOT_VERIFIED";
const cases: Array<{ id: string; status: CaseStatus; reason?: string }> = [];

function recordCase(id: string, status: CaseStatus, reason?: string): void {
  cases.push(reason === undefined ? { id, status } : { id, status, reason });
  console.log(`TASKBOOK-WIN-CASE: ${id} = ${status}${reason ? ` (${reason})` : ""}`);
}

/** Attempt real OS topology; report NOT VERIFIED instead of a silent skip. */
function buildTopology(id: string, build: () => void): boolean {
  try {
    build();
    return true;
  } catch (error) {
    const code = (error as { code?: string })?.code ?? "unavailable";
    recordCase(id, "NOT_VERIFIED", `real topology could not be constructed: ${code}`);
    return false;
  }
}

function expectReject(fn: () => unknown, detail: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TaskbookError);
    expect((error as TaskbookError).detail).toBe(detail);
    return;
  }
  throw new Error(`expected rejection with detail ${detail}`);
}

let project: string;

beforeAll(() => {
  project = projectWorkspaceFixture();
});

afterAll(() => {
  try {
    fs.writeFileSync(CASE_FILE, JSON.stringify({ platform: process.platform, cases }, null, 2));
  } catch {
    // best effort
  }
  cleanupExternalTempDirs();
});

describe("A4 static containment", () => {
  it("resolves a normal state directory outside the project", () => {
    const state = externalTempDir("c2c-tb-ok");
    const paths = resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state });
    expect(fs.lstatSync(paths.tasksRoot).isDirectory()).toBe(true);
    expect(fs.lstatSync(paths.workspaceTaskRoot).isDirectory()).toBe(true);
    expect(fs.lstatSync(paths.lockNamespace).isDirectory()).toBe(true);
    expect(isInsideRoot(paths.stateRoot, paths.workspaceTaskRoot)).toBe(true);
    expect(isInsideRoot(project, paths.workspaceTaskRoot)).toBe(false);
    expect(isInsideRoot(project, paths.lockPath)).toBe(false);
    recordCase("state-outside-project", "PASS");
  });

  it("rejects a state root that equals the project workspace", () => {
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: project }),
      "STATE_INSIDE_PROJECT"
    );
    expect(fs.existsSync(path.join(project, "tasks"))).toBe(false);
    recordCase("state-root-equals-project", "PASS");
  });

  it("rejects a state root inside the project workspace", () => {
    const inside = path.join(project, "taskbook-state");
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: inside }),
      "STATE_INSIDE_PROJECT"
    );
    expect(fs.existsSync(inside)).toBe(false);
    recordCase("state-root-inside-project", "PASS");
  });

  it("rejects a state root symlinked into the project workspace", () => {
    const state = externalTempDir("c2c-tb-symstate");
    const link = path.join(state, "state-link");
    if (!buildTopology("state-root-symlink-into-project", () => fs.symlinkSync(project, link, "dir"))) return;
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: link }),
      "STATE_INSIDE_PROJECT"
    );
    recordCase("state-root-symlink-into-project", "PASS");
  });

  it("rejects a `tasks` ancestor file-symlink escape", () => {
    const state = externalTempDir("c2c-tb-tasks-sym");
    const outside = externalTempDir("c2c-tb-outside-tasks");
    if (!buildTopology("tasks-ancestor-symlink-escape", () => fs.symlinkSync(outside, path.join(state, "tasks"), "dir"))) return;
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    recordCase("tasks-ancestor-symlink-escape", "PASS");
  });

  it("rejects a `tasks` ancestor junction escape", () => {
    const state = externalTempDir("c2c-tb-tasks-junc");
    const outside = externalTempDir("c2c-tb-outside-junc");
    if (!buildTopology("tasks-ancestor-junction-escape", () => fs.symlinkSync(outside, path.join(state, "tasks"), "junction"))) return;
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    recordCase("tasks-ancestor-junction-escape", "PASS");
  });

  it("rejects a dangling `tasks` ancestor link instead of creating through it", () => {
    const state = externalTempDir("c2c-tb-tasks-dangling");
    const danglingTarget = path.join(state, "never-there");
    if (!buildTopology("tasks-ancestor-dangling-link", () => fs.symlinkSync(danglingTarget, path.join(state, "tasks"), "dir"))) return;
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.existsSync(danglingTarget)).toBe(false);
    recordCase("tasks-ancestor-dangling-link", "PASS");
  });

  it("rejects a workspace task root symlink escape", () => {
    const state = externalTempDir("c2c-tb-ws-sym");
    const outside = externalTempDir("c2c-tb-ws-outside");
    fs.mkdirSync(path.join(state, "tasks"));
    if (!buildTopology("workspace-task-root-symlink-escape", () => fs.symlinkSync(outside, path.join(state, "tasks", WS_A), "dir"))) return;
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    recordCase("workspace-task-root-symlink-escape", "PASS");
  });

  it("rejects a workspace task root junction escape", () => {
    const state = externalTempDir("c2c-tb-ws-junc");
    const outside = externalTempDir("c2c-tb-ws-junc-outside");
    fs.mkdirSync(path.join(state, "tasks"));
    if (!buildTopology("workspace-task-root-junction-escape", () => fs.symlinkSync(outside, path.join(state, "tasks", WS_A), "junction"))) return;
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    recordCase("workspace-task-root-junction-escape", "PASS");
  });

  it("rejects workspace A redirected to workspace B inside `tasks`", () => {
    const state = externalTempDir("c2c-tb-a2b");
    const tasks = path.join(state, "tasks");
    fs.mkdirSync(tasks);
    fs.mkdirSync(path.join(tasks, WS_B));
    if (!buildTopology("workspace-A-to-B-redirect", () => fs.symlinkSync(path.join(tasks, WS_B), path.join(tasks, WS_A), "dir"))) return;
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.readdirSync(path.join(tasks, WS_B))).toEqual([]);
    recordCase("workspace-A-to-B-redirect", "PASS");
  });

  it("rejects a task root redirected into the project workspace", () => {
    const state = externalTempDir("c2c-tb-into-project");
    fs.mkdirSync(path.join(state, "tasks"));
    if (!buildTopology("task-root-into-project", () => fs.symlinkSync(project, path.join(state, "tasks", WS_A), "dir"))) return;
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.readdirSync(project)).toEqual([]);
    recordCase("task-root-into-project", "PASS");
  });

  it("rejects a lock namespace redirected outside the state root", () => {
    const state = externalTempDir("c2c-tb-lock-out");
    const outside = externalTempDir("c2c-tb-lock-outside");
    if (!buildTopology("lock-namespace-escape", () => fs.symlinkSync(outside, path.join(state, "taskbook-locks"), "dir"))) return;
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    recordCase("lock-namespace-escape", "PASS");
  });

  it("rejects a lock namespace redirected into the project workspace", () => {
    const state = externalTempDir("c2c-tb-lock-project");
    if (!buildTopology("lock-namespace-into-project", () => fs.symlinkSync(project, path.join(state, "taskbook-locks"), "junction"))) return;
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.readdirSync(project)).toEqual([]);
    recordCase("lock-namespace-into-project", "PASS");
  });

  it("fails closed when the lock leaf itself is a live symlink", () => {
    const state = externalTempDir("c2c-tb-lock-leaf");
    const lockDir = path.join(state, "taskbook-locks");
    fs.mkdirSync(lockDir, { recursive: true });
    const elsewhere = externalTempDir("c2c-tb-lock-elsewhere");
    if (!buildTopology("lock-leaf-symlink", () => fs.symlinkSync(elsewhere, path.join(lockDir, `${WS_A}.lock`), "dir"))) return;
    expectReject(
      () => submitTaskbook({ title: "t", body: "b" }, { workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "LOCK_HELD"
    );
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    recordCase("lock-leaf-symlink", "PASS");
  });

  it("rejects an unsafe workspace identifier before touching the filesystem", () => {
    const state = externalTempDir("c2c-tb-badws");
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: "../evil", projectRoot: project, stateDir: state }),
      "UNSAFE_WORKSPACE_ID"
    );
    expect(fs.readdirSync(state)).toEqual([]);
    recordCase("unsafe-workspace-id", "PASS");
  });
});

/**
 * Repair C — additional reparse-point topologies, reported per class.
 *
 * The pre-repair claim "Windows topology 15/15 PASS / 0 NOT VERIFIED" was
 * overstated: it covered ordinary absolute symlink/junction fixtures only. These
 * cases add the topologies this machine can actually construct (relative
 * symlinks, dangling junctions, reparse chains) and record an explicit
 * NOT VERIFIED for every class that cannot be constructed, with the exact
 * command output that justifies the claim.
 *
 * Test-only tooling: `fsutil reparsepoint query` and `compact.exe` are invoked
 * read-only/locally, touch only isolated temp directories, change no global
 * setting, and are cleaned up best-effort.
 */

const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows";
const FSUTIL = path.join(SYSTEM_ROOT, "System32", "fsutil.exe");
const COMPACT = path.join(SYSTEM_ROOT, "System32", "compact.exe");

const TAG_SYMLINK = "0xa000000c";
const TAG_MOUNT_POINT = "0xa0000003";

interface ReparseQuery {
  available: boolean;
  exit: number | null;
  tag: string | null;
  /** Printable-ASCII projection of the raw fsutil output (evidence only). */
  raw: string;
}

function queryReparse(target: string): ReparseQuery {
  const result = spawnSync(FSUTIL, ["reparsepoint", "query", target], { encoding: "buffer" });
  const text = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)])
    .toString("latin1")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    available: result.error === undefined,
    exit: result.status,
    tag: text.match(/0x[0-9a-fA-F]{4,}/)?.[0]?.toLowerCase() ?? null,
    raw: text.slice(0, 220),
  };
}

function runCompact(args: string[]): { exit: number | null; raw: string } {
  const result = spawnSync(COMPACT, args, { encoding: "buffer" });
  const text = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)])
    .toString("latin1")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { exit: result.status, raw: text.slice(0, 160) };
}

describe("Repair C — additional reparse topologies (honest per-class evidence)", () => {
  it("calibrates fsutil against known reparse points before trusting any negative answer", () => {
    const cal = externalTempDir("c2c-tb-fsutil-cal");
    const realDir = path.join(cal, "real-dir");
    fs.mkdirSync(realDir);
    const junction = path.join(cal, "junction");
    fs.symlinkSync(realDir, junction, "junction");
    const plain = path.join(cal, "plain.txt");
    fs.writeFileSync(plain, "x");

    const qJunction = queryReparse(junction);
    const qPlain = queryReparse(plain);
    expect(qJunction.available).toBe(true);
    expect(qJunction.exit).toBe(0);
    expect(qJunction.tag).toBe(TAG_MOUNT_POINT);
    expect(qPlain.tag).toBeNull();
    recordCase(
      "fsutil-reparse-calibration",
      "PASS",
      `fsutil reparsepoint query junction -> exit ${qJunction.exit} tag ${qJunction.tag}; plain file -> exit ${qPlain.exit} no tag (fsutil does report Microsoft reparse tags on this machine)`
    );
  });

  it("rejects a relative directory symlink used as the `tasks` ancestor", () => {
    const state = externalTempDir("c2c-tb-rel-tasks");
    const outside = externalTempDir("c2c-tb-rel-tasks-outside");
    const relativeTarget = `..${path.sep}${path.basename(outside)}`;
    if (!buildTopology("reparse-relative-symlink-tasks-ancestor", () => fs.symlinkSync(relativeTarget, path.join(state, "tasks"), "dir"))) return;

    const q = queryReparse(path.join(state, "tasks"));
    // Relative reparse semantics: resolution is relative to the link's own
    // directory, not the process CWD (this process runs in the repo checkout).
    expect(fs.realpathSync.native(path.join(state, "tasks"))).toBe(fs.realpathSync.native(outside));

    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    recordCase(
      "reparse-relative-symlink-tasks-ancestor",
      "PASS",
      `relative target "${relativeTarget}" (tag ${q.tag}); resolved to the outside dir while cwd=${process.cwd()}; containment rejected SYMLINK_REDIRECT and outside stayed empty`
    );
  });

  it("rejects a relative symlink escape out of the state boundary", () => {
    const state = externalTempDir("c2c-tb-rel-escape");
    const escapeTarget = externalTempDir("c2c-tb-rel-escape-target");
    const relativeTarget = `..${path.sep}${path.basename(escapeTarget)}`;
    if (!buildTopology("reparse-relative-symlink-escape", () => fs.symlinkSync(relativeTarget, path.join(state, "tasks"), "dir"))) return;

    const q = queryReparse(path.join(state, "tasks"));
    expect(fs.realpathSync.native(path.join(state, "tasks"))).toBe(fs.realpathSync.native(escapeTarget));
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.readdirSync(escapeTarget)).toEqual([]);
    recordCase(
      "reparse-relative-symlink-escape",
      "PASS",
      `relative escape target "${relativeTarget}" (tag ${q.tag}) resolves outside the state root; rejected SYMLINK_REDIRECT; escape target stayed empty`
    );
  });

  it("rejects a relative directory symlink used as the workspace task root", () => {
    const state = externalTempDir("c2c-tb-rel-wsroot");
    const outside = externalTempDir("c2c-tb-rel-wsroot-outside");
    fs.mkdirSync(path.join(state, "tasks"), { recursive: true });
    const relativeTarget = `..${path.sep}..${path.sep}${path.basename(outside)}`;
    if (!buildTopology("reparse-relative-symlink-workspace-root", () => fs.symlinkSync(relativeTarget, path.join(state, "tasks", WS_A), "dir"))) return;

    const q = queryReparse(path.join(state, "tasks", WS_A));
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    recordCase(
      "reparse-relative-symlink-workspace-root",
      "PASS",
      `relative target "${relativeTarget}" (tag ${q.tag}) on the workspace segment; rejected SYMLINK_REDIRECT; outside stayed empty`
    );
  });

  it("rejects a dangling junction and never creates through it", () => {
    const state = externalTempDir("c2c-tb-dangling-junc");
    const danglingTarget = path.join(state, "never-created-by-junction");
    if (!buildTopology("reparse-dangling-junction-tasks-ancestor", () => fs.symlinkSync(danglingTarget, path.join(state, "tasks"), "junction"))) return;

    const q = queryReparse(path.join(state, "tasks"));
    expect(q.tag).toBe(TAG_MOUNT_POINT);
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.existsSync(danglingTarget)).toBe(false);
    recordCase(
      "reparse-dangling-junction-tasks-ancestor",
      "PASS",
      `MOUNT_POINT junction with a non-existent substitute (tag ${q.tag}); rejected SYMLINK_REDIRECT; substitute target never materialized`
    );
  });

  it("rejects a chained reparse topology (symlink -> junction -> outside)", () => {
    const state = externalTempDir("c2c-tb-reparse-chain");
    const outside = externalTempDir("c2c-tb-chain-outside");
    const mid = path.join(state, "mid");
    if (
      !buildTopology("reparse-chain-symlink-to-junction", () => {
        fs.symlinkSync(path.basename(mid), path.join(state, "tasks"), "dir");
        fs.symlinkSync(outside, mid, "junction");
      })
    ) {
      return;
    }

    const qTasks = queryReparse(path.join(state, "tasks"));
    const qMid = queryReparse(mid);
    expect(qTasks.tag).toBe(TAG_SYMLINK);
    expect(qMid.tag).toBe(TAG_MOUNT_POINT);
    expectReject(
      () => resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state }),
      "SYMLINK_REDIRECT"
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    recordCase(
      "reparse-chain-symlink-to-junction",
      "PASS",
      `tasks=SYMLINK(${qTasks.tag}) -> mid=MOUNT_POINT(${qMid.tag}) -> outside; rejected SYMLINK_REDIRECT at the first segment; outside stayed empty`
    );
  });

  it("attempts a non-symlink/non-junction reparse point (compact/WOF) and records the exact result", () => {
    const state = externalTempDir("c2c-tb-wof");
    const paths = resolveTaskbookPaths({ workspaceId: WS_A, projectRoot: project, stateDir: state });
    const leaf = path.join(paths.workspaceTaskRoot, "33333333-3333-4333-8333-333333333333.json");
    const envelope = serializeEnvelope(createEnvelope("wof-probe", "wof body", "2026-09-11T00:00:00.000Z"));
    fs.writeFileSync(leaf, envelope);

    const wof = runCompact(["/c", "/f", "/exe:XPRESS16K", leaf]);
    const classic = runCompact(["/c", "/f", leaf]);
    const q = queryReparse(leaf);

    const evidence =
      `compact /c /f /exe:XPRESS16K -> exit ${wof.exit}; compact /c /f -> exit ${classic.exit}; ` +
      `fsutil reparsepoint query -> exit ${q.exit} tag ${q.tag ?? "none"} raw="${q.raw}"`;

    if (q.tag && q.tag !== TAG_SYMLINK && q.tag !== TAG_MOUNT_POINT) {
      // A genuinely non-symlink/non-junction reparse point exists: prove the
      // Taskbook layer treats it as a plain, non-redirecting regular file.
      const inv = inventoryWorkspaceTaskRoot(nodeTaskbookIo, paths.workspaceTaskRoot);
      expect(inv.entries).toBe(1);
      expect(inv.pending).toBe(1);
      expect(fs.readFileSync(leaf, "utf8")).toBe(envelope);
      recordCase("reparse-non-symlink-junction-tag", "PASS", evidence + "; treated as a plain non-redirecting regular file (entry+storage+pending, content intact)");
      return;
    }

    // No such reparse point could be constructed with built-in commands.
    recordCase(
      "reparse-non-symlink-junction-tag",
      "NOT_VERIFIED",
      evidence + " | no reparse point was produced; compact.exe (classic NTFS and WOF modes) did not create one and fsutil reparsepoint exposes no `set` subcommand on this build"
    );
    // The layer must still behave safely towards whatever is actually on disk.
    const inv = inventoryWorkspaceTaskRoot(nodeTaskbookIo, paths.workspaceTaskRoot);
    expect(inv).toEqual({ entries: 1, storageBytes: fs.statSync(leaf).size, pending: 1 });
  });

  it("reports the volume-mount-point class as NOT VERIFIED instead of a silent pass", () => {
    recordCase(
      "reparse-volume-mount-point",
      "NOT_VERIFIED",
      "not attempted by design: mounting the system volume inside its own tree (mountvol <dir> \\\\?\\Volume{...}\\) creates a directory cycle inside the temp area, and recursive test cleanup over an unremoved mount could traverse the volume; no second volume or VHD is available"
    );
  });
});
