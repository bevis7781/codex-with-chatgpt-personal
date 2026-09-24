import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  TASKBOOK_LIFECYCLE_CAPABILITY,
  TaskbookError,
  archiveTaskbooks,
  claimTaskbook,
  encodeTaskbookEvidenceNote,
  finishTaskbook,
  inspectArchivedTaskbook,
  inspectTaskbooks,
  parseTaskbookArchiveBundle,
  recoverTaskbook,
  submitTaskbook,
  taskbookClaimFileName,
  taskbookFileName,
  taskbookResultFileName,
  type BoundTaskbookLifecycleCapability,
  type TaskbookExecutionEvidence,
  type TaskbookIo,
} from "../src/taskbook/index.js";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { inspectExecutionOutput, saveExecutionOutput } from "../src/execution/output.js";
import { nodeTaskbookIo } from "../src/taskbook/io.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanupExternalTempDirs, externalTempDir, projectWorkspaceFixture } from "./taskbook-helpers.js";

const WORKSPACE_ID = "915f50d36e23";
const TASK_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];
const AUTH_IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
];
const RECOVERY_AUTH_ID = "99999999-9999-4999-8999-999999999999";
const cliEntry = path.join(process.cwd(), "src", "cli", "index.ts");

interface Fixture {
  stateDir: string;
  projectRoot: string;
}

function fixture(prefix = "c2c-archive"): Fixture {
  return { stateDir: externalTempDir(`${prefix}-state`), projectRoot: projectWorkspaceFixture() };
}

function context(f: Fixture) {
  return { workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir };
}

function submitAndClaim(f: Fixture, index: number) {
  const taskId = TASK_IDS[index];
  const receipt = submitTaskbook(
    { title: `archive ${index}`, body: `archive body ${index}` },
    { ...context(f), nextTaskId: () => taskId }
  );
  const claim = claimTaskbook({
    ...context(f),
    taskId: receipt.taskId,
    bodySha256: receipt.bodySha256,
    authorizationId: AUTH_IDS[index],
    authorizedAt: `2026-09-24T00:00:0${index}.000Z`,
    harness: "archive-test",
  });
  return { receipt, claim };
}

function finishEvidence(
  f: Fixture,
  index: number,
  status: "succeeded" | "failed" | "blocked",
  withOutput: boolean
): { evidence: TaskbookExecutionEvidence; timestamp: string; outputId: number | null } {
  const { receipt, claim } = submitAndClaim(f, index);
  const timestamp = new Date(Date.now() + index).toISOString();
  const output = withOutput
    ? saveExecutionOutput(WORKSPACE_ID, {
        command: "archive fixture command",
        raw: `actual output for ${index}\n`,
        exitCode: status === "succeeded" ? 0 : 1,
        taskId: receipt.taskId,
        iteration: 1,
      }, f.stateDir)
    : null;
  const outputId = output?.id ?? null;
  const exitStatus = status === "succeeded" ? "ok" : status;
  const record = {
    taskId: receipt.taskId,
    iteration: 1,
    changedFiles: ["src/taskbook/archive.ts"],
    tests: "archive fixture",
    exitStatus,
    timestamp,
    notes: encodeTaskbookEvidenceNote({
      bodySha256: receipt.bodySha256,
      claimId: claim.claim.claimId,
      authorizationId: AUTH_IDS[index],
    }),
    ...(outputId === null ? {} : { outputId, outputAvailable: output?.allowed ?? false }),
  };
  appendExecutionRecord(WORKSPACE_ID, record, f.stateDir);
  const outputEvidence = outputId === null ? undefined : inspectExecutionOutput(WORKSPACE_ID, outputId, f.stateDir);
  const evidence: TaskbookExecutionEvidence = {
    taskId: receipt.taskId,
    bodySha256: receipt.bodySha256,
    claimId: claim.claim.claimId,
    authorizationId: AUTH_IDS[index],
    iteration: 1,
    executionTimestamp: timestamp,
    outputId,
    recorded: true,
    outputRecorded: outputId !== null,
    outputAvailable: outputEvidence?.state === "readable",
    exitCode: outputId === null ? null : status === "succeeded" ? 0 : 1,
    ...(outputId === null ? { reason: `terminal ${status} without output` } : {}),
    executionRecord: record,
    ...(outputEvidence?.state === "readable" ? { outputEvidence } : {}),
  };
  const result = finishTaskbook({
    ...context(f),
    taskId: receipt.taskId,
    claimId: claim.claim.claimId,
    authorizationId: AUTH_IDS[index],
    bodySha256: receipt.bodySha256,
    status,
    executionTimestamp: timestamp,
    outputId,
    evidence,
  });
  return { evidence, timestamp, outputId };
}

function capability(f: Fixture): BoundTaskbookLifecycleCapability {
  return {
    evidence: "authenticated-loopback-admin-info",
    observedAt: new Date().toISOString(),
    runtime: {
      service: "c2c-bridge",
      version: "0.1.1",
      workspaceId: WORKSPACE_ID,
      workspaceRoot: f.projectRoot,
      pid: process.pid,
      port: 14369,
      startedAt: "2026-09-23T00:00:00.000Z",
    },
    capability: TASKBOOK_LIFECYCLE_CAPABILITY,
  };
}

async function recoverWithoutEvidence(f: Fixture, index: number, recoveryAuthorizationId = RECOVERY_AUTH_ID) {
  const { receipt, claim } = submitAndClaim(f, index);
  const outcome = await recoverTaskbook(
    { ...context(f), recoveryAuthorizationId },
    () => ({ classification: "none" }),
    async () => capability(f)
  );
  return { receipt, claim, outcome };
}

function archivePath(f: Fixture, area: "bundles" | "authorizations", filename?: string): string {
  return path.join(f.stateDir, "taskbook-archive", WORKSPACE_ID, area, ...(filename ? [filename] : []));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectTaskbookError(run: () => unknown, detail?: string): TaskbookError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TaskbookError);
    if (detail) expect((error as TaskbookError).detail).toBe(detail);
    return error as TaskbookError;
  }
  throw new Error("expected TaskbookError");
}

function archiveOptions(f: Fixture, options: { keepTerminal?: number; maxTasks?: number; apply?: boolean } = {}) {
  return { ...context(f), keepTerminal: 0, maxTasks: 50, apply: false, ...options };
}

describe("Taskbook terminal archive", () => {
  it("writes a bounded capsule before Result V1 and captures failed/blocked null-output evidence", () => {
    const f = fixture("c2c-archive-capsules");
    const success = finishEvidence(f, 0, "succeeded", true);
    const failed = finishEvidence(f, 1, "failed", false);
    const blocked = finishEvidence(f, 2, "blocked", false);
    const capsuleRoot = path.join(f.stateDir, "taskbook-terminal-evidence", WORKSPACE_ID);
    for (const [index, status, timestamp, outputId] of [
      [0, "succeeded", success.timestamp, success.outputId],
      [1, "failed", failed.timestamp, null],
      [2, "blocked", blocked.timestamp, null],
    ] as const) {
      const capsule = JSON.parse(fs.readFileSync(path.join(capsuleRoot, `${TASK_IDS[index]}.json`), "utf8")) as Record<string, unknown>;
      expect(capsule).toMatchObject({
        taskId: TASK_IDS[index],
        status,
        terminalOrigin: "finish",
        executionIteration: 1,
        executionTimestamp: timestamp,
        outputId,
      });
      const evidence = capsule.evidence as { classification: string; recordSnapshot: string; records: Array<{ exitStatus: string }>; outputs: unknown[] };
      expect(evidence.classification).toBe("finish");
      expect(evidence.recordSnapshot).toBe("read-back");
      expect(evidence.records).toHaveLength(1);
      expect(evidence.records[0]?.exitStatus).toBe(status === "succeeded" ? "ok" : status);
      expect(evidence.outputs.length).toBe(outputId === null ? 0 : 1);
    }

    const taskRoot = path.join(f.stateDir, "tasks", WORKSPACE_ID);
    const persistedNames: string[] = [];
    const realIo: TaskbookIo = {
      ...nodeTaskbookIo,
      openExclusive: (pathname) => {
        persistedNames.push(path.basename(pathname));
        return nodeTaskbookIo.openExclusive(pathname);
      },
    };
    const beforeTask = TASK_IDS[3];
    const receipt = submitTaskbook(
      { title: "write order", body: "write order body" },
      { ...context(f), nextTaskId: () => beforeTask }
    );
    const claim = claimTaskbook({
      ...context(f), taskId: beforeTask, bodySha256: receipt.bodySha256,
      authorizationId: AUTH_IDS[3], harness: "write-order",
    });
    const timestamp = new Date().toISOString();
    persistedNames.length = 0;
    finishTaskbook({
      ...context(f), taskId: beforeTask, claimId: claim.claim.claimId, authorizationId: AUTH_IDS[3],
      bodySha256: receipt.bodySha256, status: "blocked", executionTimestamp: timestamp, outputId: null,
      evidence: {
        taskId: beforeTask, bodySha256: receipt.bodySha256, claimId: claim.claim.claimId,
        authorizationId: AUTH_IDS[3], iteration: 1, executionTimestamp: timestamp, outputId: null,
        recorded: true, outputRecorded: false, outputAvailable: false, exitCode: null, reason: "ordering",
      },
      io: realIo,
    });
    expect(persistedNames.slice(0, 2)).toEqual([`${beforeTask}.tmp`, taskbookResultFileName(beforeTask)]);
    expect(fs.existsSync(path.join(taskRoot, taskbookFileName(beforeTask)))).toBe(true);
  });

  it("does not write during dry-run, including when the state root is absent", () => {
    const projectRoot = projectWorkspaceFixture();
    const parent = externalTempDir("c2c-archive-readonly-parent");
    const missingState = path.join(parent, "missing", "state");
    const result = archiveTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot, stateDir: missingState });
    expect(result).toMatchObject({ ok: true, apply: false, terminalCount: 0, selected: [] });
    expect(fs.existsSync(missingState)).toBe(false);
    expect(fs.existsSync(path.join(parent, "missing"))).toBe(false);
  });

  it("blocks apply while any claim is unfinished and preserves its active files", () => {
    const f = fixture("c2c-archive-unfinished");
    const { receipt } = submitAndClaim(f, 0);
    const taskRoot = path.join(f.stateDir, "tasks", WORKSPACE_ID);
    const before = fs.readdirSync(taskRoot).sort();
    const result = archiveTaskbooks(archiveOptions(f, { apply: true }));
    expect(result).toMatchObject({ ok: false, blockedReason: "UNFINISHED_CLAIMS", archivedTaskIds: [] });
    expect(result.unfinished.map((item) => item.taskId)).toEqual([receipt.taskId]);
    expect(fs.readdirSync(taskRoot).sort()).toEqual(before);
    expect(fs.existsSync(archivePath(f, "bundles", `${receipt.taskId}.json`))).toBe(false);
  });

  it("selects terminal outcomes deterministically and exact-inspects archived tasks outside active inventory", async () => {
    const f = fixture("c2c-archive-selection");
    finishEvidence(f, 0, "succeeded", true);
    await new Promise((resolve) => setTimeout(resolve, 3));
    finishEvidence(f, 1, "failed", false);
    await new Promise((resolve) => setTimeout(resolve, 3));
    finishEvidence(f, 2, "blocked", false);
    await new Promise((resolve) => setTimeout(resolve, 3));
    const recovered = await recoverWithoutEvidence(f, 3);
    expect(recovered.outcome.outcome).toBe("recovered");

    const preview = archiveTaskbooks(archiveOptions(f, { keepTerminal: 0, maxTasks: 4 }));
    expect(preview.terminalCount).toBe(4);
    expect(preview.selected.map((item) => item.taskId)).toEqual(TASK_IDS.slice(0, 4));
    expect(preview.selected.map((item) => item.status)).toEqual(["succeeded", "failed", "blocked", "blocked"]);
    expect(fs.existsSync(archivePath(f, "bundles"))).toBe(false);

    const applied = archiveTaskbooks(archiveOptions(f, { keepTerminal: 1, maxTasks: 2, apply: true }));
    expect(applied.ok).toBe(true);
    expect(applied.archivedTaskIds).toEqual(TASK_IDS.slice(0, 2));
    const active = inspectTaskbooks(context(f));
    expect(active.all.map((item) => item.taskId)).toEqual(TASK_IDS.slice(2, 4));
    expect(active.pending).toEqual([]);
    expect(inspectArchivedTaskbook({ ...context(f), taskId: TASK_IDS[0] })?.body).toBe("archive body 0");
    const exact = inspectTaskbooks({ ...context(f), taskId: TASK_IDS[0] });
    expect(exact.all.map((item) => item.taskId)).toEqual([TASK_IDS[0]]);
    expect(exact.all[0]?.status).toBe("succeeded");
  });

  it("archives exact source, claim, result, capsule and execution-line evidence", () => {
    const f = fixture("c2c-archive-bundle");
    const terminal = finishEvidence(f, 0, "succeeded", true);
    const result = archiveTaskbooks(archiveOptions(f, { apply: true, maxTasks: 1 }));
    expect(result.ok).toBe(true);
    const bundlePath = archivePath(f, "bundles", `${TASK_IDS[0]}.json`);
    const text = fs.readFileSync(bundlePath, "utf8");
    const bundle = parseTaskbookArchiveBundle(text);
    expect(bundle).toMatchObject({
      workspaceId: WORKSPACE_ID,
      taskId: TASK_IDS[0],
      envelope: { body: "archive body 0" },
      claim: { taskId: TASK_IDS[0], authorizationId: AUTH_IDS[0] },
      result: { status: "succeeded", outputId: terminal.outputId },
      terminalEvidence: { kind: "capsule" },
      sourceDigests: { envelope: expect.stringMatching(/^[0-9a-f]{64}$/), claim: expect.stringMatching(/^[0-9a-f]{64}$/), result: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(bundle.executionRecords).toHaveLength(1);
    const capturedLine = bundle.executionRecords[0];
    expect(JSON.parse(capturedLine!.lineText).taskId).toBe(TASK_IDS[0]);
    expect(sha256(`${capturedLine!.lineText}\n`)).toBe(capturedLine!.lineSha256);
    expect(bundle.outputs).toMatchObject([{ state: "readable", meta: { id: terminal.outputId }, text: "actual output for 0\n" }]);
    expect(fs.existsSync(path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookFileName(TASK_IDS[0])))).toBe(false);
    expect(fs.existsSync(path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookClaimFileName(TASK_IDS[0])))).toBe(false);
    expect(fs.existsSync(path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookResultFileName(TASK_IDS[0])))).toBe(false);
    expect(readExecutionRecords(WORKSPACE_ID, 100, f.stateDir)).toEqual([]);
  });

  it("rejects readable output snapshots whose metadata marks them restricted", () => {
    const f = fixture("c2c-archive-output-state-mismatch");
    finishEvidence(f, 0, "succeeded", true);
    expect(archiveTaskbooks(archiveOptions(f, { apply: true, maxTasks: 1 })).ok).toBe(true);
    const raw = JSON.parse(fs.readFileSync(archivePath(f, "bundles", `${TASK_IDS[0]}.json`), "utf8")) as {
      outputs: Array<{ state: string; meta?: { allowed?: boolean } }>;
    };
    raw.outputs[0]!.meta!.allowed = false;
    expectTaskbookError(() => parseTaskbookArchiveBundle(JSON.stringify(raw)), "ARCHIVE_OUTPUT_INVALID");
  });

  it("records an evicted output honestly while preserving the succeeded result and finish capsule", () => {
    const f = fixture("c2c-archive-evicted-output");
    const terminal = finishEvidence(f, 0, "succeeded", true);
    if (terminal.outputId === null) throw new Error("expected output ID");
    for (let index = 0; index < 40; index += 1) {
      saveExecutionOutput(WORKSPACE_ID, { command: "later command", raw: `later ${index}`, taskId: TASK_IDS[1], iteration: index }, f.stateDir);
    }
    expect(inspectExecutionOutput(WORKSPACE_ID, terminal.outputId, f.stateDir).state).toBe("not-retained");
    const result = archiveTaskbooks(archiveOptions(f, { apply: true, maxTasks: 1 }));
    expect(result.ok).toBe(true);
    expect(result.selected[0]?.status).toBe("succeeded");
    expect(result.selected[0]?.outputStatuses).toContainEqual({ outputId: terminal.outputId, state: "not-retained" });
    const bundle = parseTaskbookArchiveBundle(fs.readFileSync(archivePath(f, "bundles", `${TASK_IDS[0]}.json`), "utf8"));
    expect(bundle.result.status).toBe("succeeded");
    if (bundle.terminalEvidence.kind !== "capsule") throw new Error("expected capsule evidence");
    expect(bundle.terminalEvidence.capsule.evidence.outputs[0]?.state).toBe("readable");
  });

  it("refuses to reuse claim and recovery authorizations after their archived markers are verified", async () => {
    const f = fixture("c2c-archive-auth-replay");
    finishEvidence(f, 0, "blocked", false);
    expect(archiveTaskbooks(archiveOptions(f, { apply: true, maxTasks: 1 })).ok).toBe(true);
    const next = submitTaskbook({ title: "next", body: "next" }, { ...context(f), nextTaskId: () => TASK_IDS[1] });
    expect(() => claimTaskbook({
      ...context(f), taskId: next.taskId, bodySha256: next.bodySha256, authorizationId: AUTH_IDS[0], harness: "replay",
    })).toThrowError(expect.objectContaining({ code: "AUTHORIZATION_REUSED" }));

    const g = fixture("c2c-archive-recovery-auth-replay");
    const recovered = await recoverWithoutEvidence(g, 0);
    expect(recovered.outcome.outcome).toBe("recovered");
    expect(archiveTaskbooks(archiveOptions(g, { apply: true, maxTasks: 1 })).ok).toBe(true);
    const nextRecovery = submitTaskbook({ title: "next", body: "next" }, { ...context(g), nextTaskId: () => TASK_IDS[1] });
    const nextClaim = claimTaskbook({
      ...context(g), taskId: nextRecovery.taskId, bodySha256: nextRecovery.bodySha256, authorizationId: AUTH_IDS[1], harness: "replay",
    });
    let inspected = false;
    await expect(recoverTaskbook(
      { ...context(g), recoveryAuthorizationId: RECOVERY_AUTH_ID },
      () => { inspected = true; return { classification: "none" }; },
      async () => capability(g)
    )).rejects.toMatchObject({ code: "AUTHORIZATION_REUSED" });
    expect(inspected).toBe(false);
    expect(nextClaim.taskId).toBe(TASK_IDS[1]);
  });

  it("leaves active lifecycle files intact until bundle and all authorization markers verify", () => {
    const f = fixture("c2c-archive-marker-failure");
    finishEvidence(f, 0, "blocked", false);
    const io: TaskbookIo = {
      ...nodeTaskbookIo,
      rename: (from, to) => {
        if (to.includes(`${path.sep}authorizations${path.sep}`)) throw Object.assign(new Error("marker rename failed"), { code: "EIO" });
        nodeTaskbookIo.rename(from, to);
      },
    };
    const result = archiveTaskbooks({ ...archiveOptions(f, { apply: true, maxTasks: 1 }), io });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookFileName(TASK_IDS[0])))).toBe(true);
    expect(fs.existsSync(path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookClaimFileName(TASK_IDS[0])))).toBe(true);
    expect(fs.existsSync(path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookResultFileName(TASK_IDS[0])))).toBe(true);
  });

  it("reconciles an interrupted archive from verified remnants and fails closed on mismatches", () => {
    const f = fixture("c2c-archive-reconcile");
    finishEvidence(f, 0, "blocked", false);
    const firstIo: TaskbookIo = {
      ...nodeTaskbookIo,
      unlink: (pathname) => {
        if (pathname.endsWith(taskbookClaimFileName(TASK_IDS[0]))) throw Object.assign(new Error("interrupted removal"), { code: "EIO" });
        nodeTaskbookIo.unlink(pathname);
      },
    };
    const first = archiveTaskbooks({ ...archiveOptions(f, { apply: true, maxTasks: 1 }), io: firstIo });
    expect(first.ok).toBe(false);
    expect(fs.existsSync(path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookFileName(TASK_IDS[0])))).toBe(false);
    expect(fs.existsSync(path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookClaimFileName(TASK_IDS[0])))).toBe(true);

    const reconciled = archiveTaskbooks(archiveOptions(f, { apply: true, maxTasks: 1 }));
    expect(reconciled.ok).toBe(true);
    expect(reconciled.reconciledTaskIds).toEqual([TASK_IDS[0]]);
    expect(fs.readdirSync(path.join(f.stateDir, "tasks", WORKSPACE_ID))).toEqual([]);
    expect(inspectTaskbooks({ ...context(f), taskId: TASK_IDS[0] }).all[0]?.status).toBe("blocked");

    const g = fixture("c2c-archive-reconcile-mismatch");
    finishEvidence(g, 0, "blocked", false);
    archiveTaskbooks({ ...archiveOptions(g, { apply: true, maxTasks: 1 }), io: firstIo });
    const claimPath = path.join(g.stateDir, "tasks", WORKSPACE_ID, taskbookClaimFileName(TASK_IDS[0]));
    fs.appendFileSync(claimPath, " ");
    expectTaskbookError(() => archiveTaskbooks(archiveOptions(g, { apply: true, maxTasks: 1 })), "STATE_CONFLICT");
    expect(fs.existsSync(claimPath)).toBe(true);
  });

  it("compacts only exact verified archived rows and rejects a forged hash before deleting another task row", () => {
    const f = fixture("c2c-archive-line-hash");
    finishEvidence(f, 0, "blocked", false);
    const unarchivedTaskId = "77777777-7777-4777-8777-777777777777";
    const unarchivedRecord = {
      taskId: unarchivedTaskId,
      iteration: 2,
      changedFiles: ["keep.ts"],
      tests: "keep this row",
      exitStatus: "ok",
      timestamp: "2026-09-24T00:01:00.000Z",
    };
    appendExecutionRecord(WORKSPACE_ID, unarchivedRecord, f.stateDir);
    const keptLine = `${JSON.stringify(unarchivedRecord)}\n`;
    expect(archiveTaskbooks(archiveOptions(f, { apply: true, maxTasks: 1 })).ok).toBe(true);
    expect(readExecutionRecords(WORKSPACE_ID, 100, f.stateDir)).toEqual([unarchivedRecord]);

    const bundlePath = archivePath(f, "bundles", `${TASK_IDS[0]}.json`);
    const bundleRaw = JSON.parse(fs.readFileSync(bundlePath, "utf8")) as Record<string, any>;
    bundleRaw.executionRecords[0].lineText = JSON.stringify(unarchivedRecord);
    bundleRaw.executionRecords[0].lineSha256 = sha256(keptLine);
    delete bundleRaw.bundleSha256;
    const baseJson = JSON.stringify(bundleRaw);
    bundleRaw.bundleSha256 = sha256(baseJson);
    fs.writeFileSync(bundlePath, JSON.stringify(bundleRaw));
    for (const filename of fs.readdirSync(archivePath(f, "authorizations"))) {
      const markerPath = archivePath(f, "authorizations", filename);
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
      marker.bundleSha256 = bundleRaw.bundleSha256;
      fs.writeFileSync(markerPath, JSON.stringify(marker));
    }

    expectTaskbookError(
      () => archiveTaskbooks(archiveOptions(f, { apply: true, maxTasks: 1 })),
      "ARCHIVE_EXECUTION_RECORD_INVALID"
    );
    expect(readExecutionRecords(WORKSPACE_ID, 100, f.stateDir)).toEqual([unarchivedRecord]);
  });

  it("rejects archive state inside the project and exposes archive only through the local CLI", () => {
    const projectRoot = projectWorkspaceFixture();
    expectTaskbookError(
      () => archiveTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot, stateDir: path.join(projectRoot, ".state") }),
      "STATE_INSIDE_PROJECT"
    );
    expect(fs.existsSync(path.join(projectRoot, ".state"))).toBe(false);

    const f = fixture("c2c-archive-cli");
    const workspace = new Workspace(f.projectRoot);
    const receipt = submitTaskbook(
      { title: "CLI archive", body: "inspect from archive" },
      { workspaceId: workspace.id, projectRoot: workspace.root, stateDir: f.stateDir, nextTaskId: () => TASK_IDS[0] }
    );
    const claim = claimTaskbook({
      workspaceId: workspace.id,
      projectRoot: workspace.root,
      stateDir: f.stateDir,
      taskId: receipt.taskId,
      bodySha256: receipt.bodySha256,
      authorizationId: AUTH_IDS[0],
      harness: "cli-archive",
    });
    const timestamp = new Date().toISOString();
    finishTaskbook({
      workspaceId: workspace.id,
      projectRoot: workspace.root,
      stateDir: f.stateDir,
      taskId: receipt.taskId,
      claimId: claim.claim.claimId,
      authorizationId: AUTH_IDS[0],
      bodySha256: receipt.bodySha256,
      status: "blocked",
      executionTimestamp: timestamp,
      outputId: null,
      evidence: {
        taskId: receipt.taskId, bodySha256: receipt.bodySha256, claimId: claim.claim.claimId,
        authorizationId: AUTH_IDS[0], iteration: 1, executionTimestamp: timestamp, outputId: null,
        recorded: true, outputRecorded: false, outputAvailable: false, exitCode: null, reason: "CLI archive fixture",
      },
    });
    const env = { ...process.env, C2C_STATE_DIR: f.stateDir };
    const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
      cwd: process.cwd(), encoding: "utf8", env, windowsHide: true,
    });
    const archived = run(["taskbook", "archive", "--workspace", f.projectRoot, "--keep-terminal", "0", "--max-tasks", "1", "--apply", "--json"]);
    expect(archived.status).toBe(0);
    expect(JSON.parse(archived.stdout).archivedTaskIds).toEqual([TASK_IDS[0]]);
    const inspected = run(["taskbook", "inspect", "--workspace", f.projectRoot, "--task", TASK_IDS[0], "--json"]);
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout).all[0]).toMatchObject({ taskId: TASK_IDS[0], body: "inspect from archive", status: "blocked" });
  });

  it("does not expose archived tasks or authorization markers to another workspace", () => {
    const f = fixture("c2c-archive-workspace-isolation");
    finishEvidence(f, 0, "blocked", false);
    expect(archiveTaskbooks(archiveOptions(f, { apply: true, maxTasks: 1 })).ok).toBe(true);
    const otherProject = projectWorkspaceFixture();
    const otherWorkspaceId = "915f50d36e24";
    expect(inspectArchivedTaskbook({
      workspaceId: otherWorkspaceId,
      projectRoot: otherProject,
      stateDir: f.stateDir,
      taskId: TASK_IDS[0],
    })).toBeNull();
    expectTaskbookError(() => inspectTaskbooks({
      workspaceId: otherWorkspaceId,
      projectRoot: otherProject,
      stateDir: f.stateDir,
      taskId: TASK_IDS[0],
    }), "TASK_ID");

    const otherReceipt = submitTaskbook(
      { title: "same identity in other workspace", body: "other workspace body" },
      { workspaceId: otherWorkspaceId, projectRoot: otherProject, stateDir: f.stateDir, nextTaskId: () => TASK_IDS[0] }
    );
    const otherClaim = claimTaskbook({
      workspaceId: otherWorkspaceId,
      projectRoot: otherProject,
      stateDir: f.stateDir,
      taskId: TASK_IDS[0],
      bodySha256: otherReceipt.bodySha256,
      authorizationId: AUTH_IDS[0],
      harness: "other-workspace",
    });
    expect(otherClaim.claim.authorizationId).toBe(AUTH_IDS[0]);
  });

  it("fails closed when target execution-log capture exceeds the bounded bundle budget", () => {
    const f = fixture("c2c-archive-record-cap");
    finishEvidence(f, 0, "blocked", false);
    const logDir = path.join(f.stateDir, "executions");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${WORKSPACE_ID}.jsonl`);
    const rows = Array.from({ length: 900 }, (_, index) => JSON.stringify({
      taskId: TASK_IDS[0],
      iteration: index + 2,
      changedFiles: 0,
      tests: "bounded capture fixture",
      exitStatus: "ok",
      timestamp: new Date(Date.UTC(2026, 8, 24, 1, 0, index % 60)).toISOString(),
      notes: "x".repeat(1400),
    })).join("\n") + "\n";
    fs.appendFileSync(logPath, rows);
    expectTaskbookError(() => archiveTaskbooks(archiveOptions(f)), "ARCHIVE_EXECUTION_LOG_INCOMPLETE");
    expect(fs.existsSync(archivePath(f, "bundles"))).toBe(false);
  });

  it("keeps finish retry idempotent, while a damaged or mismatched capsule blocks write and archive", () => {
    const f = fixture("c2c-archive-capsule-retry");
    const { receipt, claim } = submitAndClaim(f, 0);
    const timestamp = new Date().toISOString();
    const evidence: TaskbookExecutionEvidence = {
      taskId: receipt.taskId,
      bodySha256: receipt.bodySha256,
      claimId: claim.claim.claimId,
      authorizationId: AUTH_IDS[0],
      iteration: 1,
      executionTimestamp: timestamp,
      outputId: null,
      recorded: true,
      outputRecorded: false,
      outputAvailable: false,
      exitCode: null,
      reason: "exact retry",
    };
    const io: TaskbookIo = {
      ...nodeTaskbookIo,
      openExclusive: (pathname) => {
        if (pathname.endsWith(taskbookResultFileName(TASK_IDS[0]))) throw Object.assign(new Error("result open failed"), { code: "EIO" });
        return nodeTaskbookIo.openExclusive(pathname);
      },
    };
    const finishInput = { ...context(f), taskId: TASK_IDS[0], claimId: claim.claim.claimId, authorizationId: AUTH_IDS[0], bodySha256: receipt.bodySha256, status: "blocked" as const, executionTimestamp: timestamp, outputId: null, evidence };
    expectTaskbookError(() => finishTaskbook({ ...finishInput, io }), "EIO");
    const capsulePath = path.join(f.stateDir, "taskbook-terminal-evidence", WORKSPACE_ID, `${TASK_IDS[0]}.json`);
    const capsuleBefore = fs.readFileSync(capsulePath, "utf8");
    expect(fs.existsSync(path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookResultFileName(TASK_IDS[0])))).toBe(false);
    expectTaskbookError(() => finishTaskbook({
      ...finishInput,
      evidence: { ...evidence, reason: "mismatched retry" },
    }), "STATE_CONFLICT");
    const retried = finishTaskbook(finishInput);
    expect(retried.finishedAt).toBe((JSON.parse(capsuleBefore) as { result: { finishedAt: string } }).result.finishedAt);
    expect(fs.readFileSync(capsulePath, "utf8")).toBe(capsuleBefore);

    fs.writeFileSync(capsulePath, "{}");
    expectTaskbookError(() => archiveTaskbooks(archiveOptions(f)), "CAPSULE_FIELDS");
    expect(fs.existsSync(path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookResultFileName(TASK_IDS[0])))).toBe(true);
  });
});

afterAll(() => cleanupExternalTempDirs());
