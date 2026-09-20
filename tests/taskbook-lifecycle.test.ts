import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  TaskbookError,
  bodySha256,
  claimTaskbook,
  finishTaskbook,
  inspectTaskbooks,
  inventoryTaskbookState,
  newTaskbookAuthorizationId,
  nodeTaskbookIo,
  parseClaimRecord,
  parseResultRecord,
  parseTaskbookCommand,
  submitTaskbook,
  taskbookClaimFileName,
  taskbookFileName,
  taskbookResultFileName,
  type TaskbookExecutionEvidence,
  type TaskbookIo,
} from "../src/taskbook/index.js";
import {
  cleanupExternalTempDirs,
  externalTempDir,
  projectWorkspaceFixture,
} from "./taskbook-helpers.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const AUTH_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "915f50d36e23";
const WORKSPACE_B = "915f50d36e24";
const CLAIM_CHILD = path.join(process.cwd(), "tests", "fixtures", "taskbook-claim-child.ts");

function setup(): { stateDir: string; projectRoot: string } {
  return { stateDir: externalTempDir("c2c-g2-state"), projectRoot: projectWorkspaceFixture() };
}

function submitOne(stateDir: string, projectRoot: string, title = "title", body = "body") {
  return submitTaskbook(
    { title, body },
    { workspaceId: WORKSPACE_ID, projectRoot, stateDir, nextTaskId: () => TASK_ID }
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
  throw new Error(`expected ${code}`);
}

function evidence(
  taskId: string,
  hash: string,
  claimId: string,
  authorizationId: string,
  timestamp: string,
  outputId: number | null,
  overrides: Partial<TaskbookExecutionEvidence> = {}
): TaskbookExecutionEvidence {
  return {
    taskId,
    bodySha256: hash,
    claimId,
    authorizationId,
    iteration: 1,
    executionTimestamp: timestamp,
    outputId,
    recorded: true,
    outputRecorded: outputId !== null,
    outputAvailable: outputId !== null,
    exitCode: outputId === null ? null : 0,
    ...overrides,
  };
}

function runClaimChild(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", CLAIM_CHILD, ...args], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", () => resolve());
  });
}

describe("Gate 2 lifecycle", () => {
  it("accepts only standalone Do/Read in Personal Taskbook context", () => {
    expect(parseTaskbookCommand(" Do ")).toBe("Do");
    expect(parseTaskbookCommand("READ")).toBe("Read");
    expect(parseTaskbookCommand("Do something")).toBeNull();
    expect(parseTaskbookCommand("Do", { personalTaskbookContext: false })).toBeNull();
    expect(parseTaskbookCommand("quoted Do")).toBeNull();
  });

  it("claims one task, persists exact sidecars, and exposes body only locally", () => {
    const { stateDir, projectRoot } = setup();
    const receipt = submitOne(stateDir, projectRoot, "first", "body-first");
    const result = inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot, stateDir });
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.body).toBe("body-first");

    const claimed = claimTaskbook({
      workspaceId: WORKSPACE_ID,
      projectRoot,
      stateDir,
      taskId: receipt.taskId,
      bodySha256: receipt.bodySha256,
      authorizationId: AUTH_ID,
      harness: "vitest-harness",
    });
    expect(claimed.body).toBe("body-first");
    const root = path.join(stateDir, "tasks", WORKSPACE_ID);
    const claimText = fs.readFileSync(path.join(root, taskbookClaimFileName(receipt.taskId)), "utf8");
    expect(Object.keys(JSON.parse(claimText) as object).sort()).toEqual(
      ["authorizationId", "authorizedAt", "bodySha256", "claimId", "claimedAt", "harness", "taskId", "version"].sort()
    );
    expect(parseClaimRecord(claimText).claimId).toBe(claimed.claim.claimId);
    expect(inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot, stateDir }).pending).toHaveLength(0);
    expect(inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot, stateDir }).unfinished).toHaveLength(1);
  });

  it("requires evidence linkage and prevents authorization replay after terminal completion", () => {
    const { stateDir, projectRoot } = setup();
    const receipt = submitOne(stateDir, projectRoot, "first", "body-first");
    const claimed = claimTaskbook({
      workspaceId: WORKSPACE_ID,
      projectRoot,
      stateDir,
      taskId: receipt.taskId,
      bodySha256: receipt.bodySha256,
      authorizationId: AUTH_ID,
      harness: "vitest-harness",
    });
    const executionTimestamp = new Date().toISOString();
    const result = finishTaskbook({
      workspaceId: WORKSPACE_ID,
      projectRoot,
      stateDir,
      taskId: receipt.taskId,
      claimId: claimed.claim.claimId,
      authorizationId: AUTH_ID,
      bodySha256: receipt.bodySha256,
      status: "succeeded",
      executionTimestamp,
      outputId: 7,
      evidence: evidence(receipt.taskId, receipt.bodySha256, claimed.claim.claimId, AUTH_ID, executionTimestamp, 7),
    });
    expect(result.status).toBe("succeeded");
    const root = path.join(stateDir, "tasks", WORKSPACE_ID);
    expect(parseResultRecord(fs.readFileSync(path.join(root, taskbookResultFileName(receipt.taskId)), "utf8")).outputId).toBe(7);

    submitTaskbook(
      { title: "second", body: "body-second" },
      { workspaceId: WORKSPACE_ID, projectRoot, stateDir, nextTaskId: () => "33333333-3333-4333-8333-333333333333" }
    );
    expectTaskbookError(
      () =>
        claimTaskbook({
          workspaceId: WORKSPACE_ID,
          projectRoot,
          stateDir,
          taskId: "33333333-3333-4333-8333-333333333333",
          bodySha256: bodySha256("body-second"),
          authorizationId: AUTH_ID,
          harness: "vitest-harness",
        }),
      "AUTHORIZATION_REUSED"
    );
  });

  it("leaves a failed or blocked task terminal and allows the next fresh Do", () => {
    const { stateDir, projectRoot } = setup();
    const first = submitOne(stateDir, projectRoot, "first", "body-first");
    const secondId = "33333333-3333-4333-8333-333333333333";
    submitTaskbook(
      { title: "second", body: "body-second" },
      { workspaceId: WORKSPACE_ID, projectRoot, stateDir, nextTaskId: () => secondId }
    );
    const claimed = claimTaskbook({
      workspaceId: WORKSPACE_ID,
      projectRoot,
      stateDir,
      taskId: first.taskId,
      bodySha256: first.bodySha256,
      authorizationId: AUTH_ID,
      harness: "vitest-harness",
    });
    const executionTimestamp = new Date().toISOString();
    finishTaskbook({
      workspaceId: WORKSPACE_ID,
      projectRoot,
      stateDir,
      taskId: first.taskId,
      claimId: claimed.claim.claimId,
      authorizationId: AUTH_ID,
      bodySha256: first.bodySha256,
      status: "blocked",
      executionTimestamp,
      outputId: null,
      evidence: evidence(first.taskId, first.bodySha256, claimed.claim.claimId, AUTH_ID, executionTimestamp, null, {
        outputRecorded: false,
        outputAvailable: false,
        exitCode: null,
        reason: "unsafe scope",
      }),
    });
    const next = inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot, stateDir });
    expect(next.pending.map((task) => task.taskId)).toEqual([secondId]);
    expect(next.all.find((task) => task.taskId === first.taskId)?.status).toBe("blocked");
  });

  it("serializes independent Harness claims across processes", async () => {
    const { stateDir, projectRoot } = setup();
    const receipt = submitOne(stateDir, projectRoot);
    const resultA = path.join(stateDir, "claim-a.json");
    const resultB = path.join(stateDir, "claim-b.json");
    const args = (auth: string, resultFile: string): string[] => [
      stateDir,
      projectRoot,
      WORKSPACE_ID,
      receipt.taskId,
      receipt.bodySha256,
      auth,
      resultFile,
    ];
    await Promise.all([
      runClaimChild(args(AUTH_ID, resultA)),
      runClaimChild(args("33333333-3333-4333-8333-333333333333", resultB)),
    ]);
    const results = [resultA, resultB].map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as { ok: boolean; code?: string });
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.code === "UNFINISHED_TASK" || result.code === "BUSY")).toHaveLength(1);
    expect(inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot, stateDir }).unfinished).toHaveLength(1);
  }, 30_000);

  it("fails closed on malformed and orphaned sidecars", () => {
    const { stateDir, projectRoot } = setup();
    const receipt = submitOne(stateDir, projectRoot);
    const root = path.join(stateDir, "tasks", WORKSPACE_ID);
    fs.writeFileSync(path.join(root, taskbookClaimFileName(receipt.taskId)), "{}");
    expectTaskbookError(
      () => inventoryTaskbookState(nodeTaskbookIo, root),
      "STORAGE_ERROR",
      "MALFORMED_CLAIM"
    );
  });

  it("does not convert a partial claim write into a runnable task", () => {
    const { stateDir, projectRoot } = setup();
    const receipt = submitOne(stateDir, projectRoot);
    const io: TaskbookIo = {
      ...nodeTaskbookIo,
      writeAll: () => {
        throw Object.assign(new Error("injected"), { code: "EIO" });
      },
    };
    expectTaskbookError(
      () =>
        claimTaskbook({
          workspaceId: WORKSPACE_ID,
          projectRoot,
          stateDir,
          io,
          taskId: receipt.taskId,
          bodySha256: receipt.bodySha256,
          authorizationId: AUTH_ID,
          harness: "vitest-harness",
        }),
      "STORAGE_ERROR"
    );
    expectTaskbookError(
      () => inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot, stateDir }),
      "STORAGE_ERROR",
      "MALFORMED_CLAIM"
    );
  });

  it("rejects a non-next candidate and a body hash changed after inspection", () => {
    const { stateDir, projectRoot } = setup();
    const first = submitOne(stateDir, projectRoot, "first", "body-first");
    const secondId = "33333333-3333-4333-8333-333333333333";
    const second = submitTaskbook(
      { title: "second", body: "body-second" },
      { workspaceId: WORKSPACE_ID, projectRoot, stateDir, nextTaskId: () => secondId }
    );

    expectTaskbookError(
      () =>
        claimTaskbook({
          workspaceId: WORKSPACE_ID,
          projectRoot,
          stateDir,
          taskId: second.taskId,
          bodySha256: second.bodySha256,
          authorizationId: AUTH_ID,
          harness: "vitest-harness",
        }),
      "TASK_NOT_ELIGIBLE",
      "NOT_NEXT"
    );

    const envelopePath = path.join(stateDir, "tasks", WORKSPACE_ID, taskbookFileName(first.taskId));
    const changedBody = "body-first-changed";
    const originalEnvelope = JSON.parse(fs.readFileSync(envelopePath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(envelopePath, JSON.stringify({ ...originalEnvelope, body: changedBody }));
    expectTaskbookError(
      () =>
        claimTaskbook({
          workspaceId: WORKSPACE_ID,
          projectRoot,
          stateDir,
          taskId: first.taskId,
          bodySha256: first.bodySha256,
          authorizationId: "44444444-4444-4444-8444-444444444444",
          harness: "vitest-harness",
        }),
      "TASK_NOT_ELIGIBLE",
      "BODY_CHANGED"
    );
    expect(inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot, stateDir }).unfinished).toHaveLength(0);
  });

  it("keeps another workspace's candidate invisible and unclaimable", () => {
    const { stateDir, projectRoot } = setup();
    const otherProject = projectWorkspaceFixture();
    const receipt = submitOne(stateDir, projectRoot);

    expect(inspectTaskbooks({ workspaceId: WORKSPACE_B, projectRoot: otherProject, stateDir }).pending).toHaveLength(0);
    expectTaskbookError(
      () =>
        claimTaskbook({
          workspaceId: WORKSPACE_B,
          projectRoot: otherProject,
          stateDir,
          taskId: receipt.taskId,
          bodySha256: receipt.bodySha256,
          authorizationId: AUTH_ID,
          harness: "wrong-workspace",
        }),
      "TASK_NOT_ELIGIBLE",
      "EMPTY_QUEUE"
    );
    expect(inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot, stateDir }).pending).toHaveLength(1);
  });

  it("fails closed on a genuinely orphaned claim sidecar", () => {
    const { stateDir, projectRoot } = setup();
    submitOne(stateDir, projectRoot);
    const root = path.join(stateDir, "tasks", WORKSPACE_ID);
    const orphanTaskId = "55555555-5555-4555-8555-555555555555";
    fs.writeFileSync(
      path.join(root, taskbookClaimFileName(orphanTaskId)),
      JSON.stringify({
        version: 1,
        taskId: orphanTaskId,
        claimId: "66666666-6666-4666-8666-666666666666",
        authorizationId: "77777777-7777-4777-8777-777777777777",
        bodySha256: bodySha256("orphan"),
        harness: "fixture",
        authorizedAt: "2026-09-20T00:00:00.000Z",
        claimedAt: "2026-09-20T00:00:01.000Z",
      })
    );
    expectTaskbookError(
      () => inventoryTaskbookState(nodeTaskbookIo, root),
      "STORAGE_ERROR",
      "ORPHAN_LIFECYCLE_RECORD"
    );
  });

  it("does not report a claim or finish success when the sidecar close fails", () => {
    const { stateDir, projectRoot } = setup();
    const receipt = submitOne(stateDir, projectRoot);
    const closeFailIo: TaskbookIo = {
      ...nodeTaskbookIo,
      close: () => {
        throw Object.assign(new Error("injected close failure"), { code: "EIO" });
      },
    };
    expectTaskbookError(
      () =>
        claimTaskbook({
          workspaceId: WORKSPACE_ID,
          projectRoot,
          stateDir,
          io: closeFailIo,
          taskId: receipt.taskId,
          bodySha256: receipt.bodySha256,
          authorizationId: AUTH_ID,
          harness: "close-fail",
        }),
      "STORAGE_ERROR",
      "EIO"
    );
    const claimed = inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot, stateDir }).unfinished[0];
    expect(claimed?.taskId).toBe(receipt.taskId);

    const claimText = fs.readFileSync(
      path.join(stateDir, "tasks", WORKSPACE_ID, taskbookClaimFileName(receipt.taskId)),
      "utf8"
    );
    const claim = parseClaimRecord(claimText);
    const executionTimestamp = new Date().toISOString();
    expectTaskbookError(
      () =>
        finishTaskbook({
          workspaceId: WORKSPACE_ID,
          projectRoot,
          stateDir,
          io: closeFailIo,
          taskId: receipt.taskId,
          claimId: claim.claimId,
          authorizationId: claim.authorizationId,
          bodySha256: receipt.bodySha256,
          status: "blocked",
          executionTimestamp,
          outputId: null,
          evidence: evidence(receipt.taskId, receipt.bodySha256, claim.claimId, claim.authorizationId, executionTimestamp, null, {
            outputRecorded: false,
            outputAvailable: false,
            exitCode: null,
            reason: "close failure fixture",
          }),
        }),
      "STORAGE_ERROR",
      "EIO"
    );
    expect(inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot, stateDir }).all[0]?.status).toBe("blocked");
  });

  it("rejects a finish when the lifecycle entry quota is already full", () => {
    const { stateDir, projectRoot } = setup();
    const receipt = submitOne(stateDir, projectRoot);
    const claimed = claimTaskbook({
      workspaceId: WORKSPACE_ID,
      projectRoot,
      stateDir,
      taskId: receipt.taskId,
      bodySha256: receipt.bodySha256,
      authorizationId: AUTH_ID,
      harness: "capacity-fixture",
    });
    const root = path.join(stateDir, "tasks", WORKSPACE_ID);
    for (let index = 0; index < 1022; index += 1) {
      fs.writeFileSync(path.join(root, `filler-${index}.bin`), "x");
    }
    expect(inventoryTaskbookState(nodeTaskbookIo, root).entries).toBe(1024);
    const executionTimestamp = new Date().toISOString();
    expectTaskbookError(
      () =>
        finishTaskbook({
          workspaceId: WORKSPACE_ID,
          projectRoot,
          stateDir,
          taskId: receipt.taskId,
          claimId: claimed.claim.claimId,
          authorizationId: AUTH_ID,
          bodySha256: receipt.bodySha256,
          status: "blocked",
          executionTimestamp,
          outputId: null,
          evidence: evidence(receipt.taskId, receipt.bodySha256, claimed.claim.claimId, AUTH_ID, executionTimestamp, null, {
            outputRecorded: false,
            outputAvailable: false,
            exitCode: null,
            reason: "entry cap fixture",
          }),
        }),
      "LIMIT_EXCEEDED",
      "ENTRY_CAP"
    );
    expect(fs.existsSync(path.join(root, taskbookResultFileName(receipt.taskId)))).toBe(false);
  });

  it("rejects evidence that does not match the claimed task identity", () => {
    const { stateDir, projectRoot } = setup();
    const receipt = submitOne(stateDir, projectRoot);
    const claimed = claimTaskbook({
      workspaceId: WORKSPACE_ID,
      projectRoot,
      stateDir,
      taskId: receipt.taskId,
      bodySha256: receipt.bodySha256,
      authorizationId: AUTH_ID,
      harness: "evidence-fixture",
    });
    const executionTimestamp = new Date().toISOString();
    expectTaskbookError(
      () =>
        finishTaskbook({
          workspaceId: WORKSPACE_ID,
          projectRoot,
          stateDir,
          taskId: receipt.taskId,
          claimId: claimed.claim.claimId,
          authorizationId: AUTH_ID,
          bodySha256: receipt.bodySha256,
          status: "blocked",
          executionTimestamp,
          outputId: null,
          evidence: evidence(
            "88888888-8888-4888-8888-888888888888",
            receipt.bodySha256,
            claimed.claim.claimId,
            AUTH_ID,
            executionTimestamp,
            null,
            { outputRecorded: false, outputAvailable: false, exitCode: null, reason: "identity mismatch" }
          ),
        }),
      "EVIDENCE_INVALID",
      "IDENTITY_MISMATCH"
    );
    expect(inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot, stateDir }).unfinished).toHaveLength(1);
  });
});

afterAll(() => cleanupExternalTempDirs());
