import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  TaskbookError,
  TASKBOOK_LIFECYCLE_CAPABILITY,
  bodySha256,
  claimTaskbook,
  encodeTaskbookEvidenceNote,
  finishTaskbook,
  inspectTaskbookRecoveryEvidence,
  inspectTaskbooks,
  parseResultRecord,
  parseTaskbookCommand,
  recoverTaskbook,
  recordTaskbookExecution,
  serializeResultRecord,
  submitTaskbook,
  taskbookClaimFileName,
  taskbookResultFileName,
  type TaskbookLifecycleCapabilityAdvertisement,
  type TaskbookExecutionEvidence,
  type BoundTaskbookLifecycleCapability,
} from "../src/taskbook/index.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { cleanupExternalTempDirs, externalTempDir, projectWorkspaceFixture } from "./taskbook-helpers.js";

const WORKSPACE_ID = "915f50d36e23";
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const AUTH_ID = "22222222-2222-4222-8222-222222222222";
const RECOVERY_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_TASK_ID = "44444444-4444-4444-8444-444444444444";
const RECOVER_CHILD = path.join(process.cwd(), "tests", "fixtures", "taskbook-recover-child.ts");

interface Fixture {
  stateDir: string;
  projectRoot: string;
  receipt: ReturnType<typeof submitTaskbook>;
  claim: ReturnType<typeof claimTaskbook>;
}

function fixture(prefix = "c2c-recovery"): Fixture {
  const stateDir = externalTempDir(prefix);
  const projectRoot = projectWorkspaceFixture();
  const receipt = submitTaskbook(
    { title: "recovery fixture title", body: "recovery fixture body" },
    { workspaceId: WORKSPACE_ID, projectRoot, stateDir, nextTaskId: () => TASK_ID }
  );
  const claim = claimTaskbook({
    workspaceId: WORKSPACE_ID,
    projectRoot,
    stateDir,
    taskId: receipt.taskId,
    bodySha256: receipt.bodySha256,
    authorizationId: AUTH_ID,
    authorizedAt: "2026-09-23T00:00:00.000Z",
    harness: "recovery-test",
  });
  return { stateDir, projectRoot, receipt, claim };
}

function capabilityProof(
  projectRoot: string,
  workspaceId = WORKSPACE_ID,
  capability: BoundTaskbookLifecycleCapability["capability"] = TASKBOOK_LIFECYCLE_CAPABILITY
): BoundTaskbookLifecycleCapability {
  return {
    evidence: "authenticated-loopback-admin-info",
    observedAt: new Date().toISOString(),
    runtime: {
      service: "c2c-bridge",
      version: "0.1.1",
      workspaceId,
      workspaceRoot: projectRoot,
      pid: process.pid,
      port: 14369,
      startedAt: "2026-09-23T00:00:00.000Z",
    },
    capability,
  };
}

function capabilityReader(
  projectRoot: string,
  workspaceId = WORKSPACE_ID,
  capability: BoundTaskbookLifecycleCapability["capability"] = TASKBOOK_LIFECYCLE_CAPABILITY
) {
  return async () => capabilityProof(projectRoot, workspaceId, capability);
}

function snapshotTaskRoot(f: Fixture): Map<string, Buffer> {
  const root = path.join(f.stateDir, "tasks", WORKSPACE_ID);
  return new Map(fs.readdirSync(root).sort().map((name) => [name, fs.readFileSync(path.join(root, name))]));
}

function recovery(f: Fixture, recoveryAuthorizationId = RECOVERY_ID, classification: "none" | "incomplete" | "ambiguous" = "none") {
  return recoverTaskbook(
    {
      workspaceId: WORKSPACE_ID,
      projectRoot: f.projectRoot,
      stateDir: f.stateDir,
      recoveryAuthorizationId,
    },
    () => ({ classification }),
    capabilityReader(f.projectRoot)
  );
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

async function expectTaskbookErrorAsync(run: () => Promise<unknown>, detail?: string): Promise<TaskbookError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(TaskbookError);
    if (detail) expect((error as TaskbookError).detail).toBe(detail);
    return error as TaskbookError;
  }
  throw new Error("expected TaskbookError");
}

function withStateDir<T>(stateDir: string, run: () => T): T {
  const old = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;
  try {
    return run();
  } finally {
    if (old === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = old;
  }
}

function addLinkedExecution(f: Fixture, overrides: Partial<{
  bodySha256: string;
  claimId: string;
  authorizationId: string;
  exitStatus: string;
  outputId: number | undefined;
  outputAvailable: boolean;
  timestamp: string;
}> = {}) {
  return withStateDir(f.stateDir, () => {
    const timestamp = overrides.timestamp ?? "2026-09-23T00:01:00.000Z";
    const output = saveExecutionOutput(WORKSPACE_ID, {
      command: "pnpm test",
      raw: "actual recorded output\n",
      exitCode: overrides.exitStatus === "failed" ? 1 : 0,
      taskId: f.receipt.taskId,
      iteration: 1,
    });
    const outputId = overrides.outputId === undefined ? output.id : overrides.outputId;
    appendExecutionRecord(WORKSPACE_ID, {
      taskId: f.receipt.taskId,
      iteration: 1,
      changedFiles: ["src/taskbook/lifecycle.ts"],
      tests: "linked fixture",
      exitStatus: overrides.exitStatus ?? "ok",
      timestamp,
      notes: encodeTaskbookEvidenceNote({
        bodySha256: overrides.bodySha256 ?? f.receipt.bodySha256,
        claimId: overrides.claimId ?? f.claim.claim.claimId,
        authorizationId: overrides.authorizationId ?? AUTH_ID,
      }),
      outputId,
      outputAvailable: overrides.outputAvailable ?? true,
    });
    return { timestamp, outputId: output.id };
  });
}

describe("Personal Taskbook Recover", () => {
  it("recognizes only an exact standalone Recover event and preserves Do/Read distinctions", () => {
    expect(parseTaskbookCommand(" Recover ")).toBe("Recover");
    expect(parseTaskbookCommand("DO")).toBe("Do");
    expect(parseTaskbookCommand("Read")).toBe("Read");
    expect(parseTaskbookCommand("Recover the previous task")).toBeNull();
    expect(parseTaskbookCommand("Recover", { personalTaskbookContext: false })).toBeNull();
    expect(parseTaskbookCommand("Reconnecting...")).toBeNull();
    expect(parseTaskbookCommand("stream retry")).toBeNull();
  });

  it("abandons a claim without linked evidence exactly once and preserves project bytes", async () => {
    const f = fixture();
    const residue = path.join(f.projectRoot, "residual.bin");
    const bytes = Buffer.from([0, 1, 2, 255, 13, 10]);
    fs.writeFileSync(residue, bytes);
    const before = fs.readFileSync(residue);

    const first = await recovery(f);
    expect(first.outcome).toBe("recovered");
    if (first.outcome !== "recovered") throw new Error("expected recovered result");
    expect(first.result).toMatchObject({
      version: 2,
      taskId: TASK_ID,
      bodySha256: f.receipt.bodySha256,
      claimId: f.claim.claim.claimId,
      status: "blocked",
      recoveryAuthorizationId: RECOVERY_ID,
      terminalOrigin: "recovery-abandon",
      evidenceState: "no-linked-evidence",
      executionTimestamp: null,
      outputId: null,
      reasonCode: "no-linked-evidence",
    });
    expect(fs.readFileSync(residue)).toEqual(before);
    const resultPath = path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookResultFileName(TASK_ID));
    const persisted = fs.readFileSync(resultPath, "utf8");
    expect(parseResultRecord(persisted)).toEqual(first.result);
    expect(persisted).not.toContain("recovery fixture title");
    expect(persisted).not.toContain("recovery fixture body");
    expect(inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir }).unfinished).toEqual([]);

    const beforeDuplicate = fs.readFileSync(resultPath);
    expect((await recovery(f)).outcome).toBe("no-target");
    expect(fs.readFileSync(resultPath)).toEqual(beforeDuplicate);
  });

  it("closes out one complete linked success using its original timestamp and output id", async () => {
    const f = fixture();
    const evidence = addLinkedExecution(f);
    const observed: string[] = [];
    const result = await recoverTaskbook(
      { workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir, recoveryAuthorizationId: RECOVERY_ID },
      (task) => withStateDir(f.stateDir, () => {
        observed.push(task.taskId);
        return inspectTaskbookRecoveryEvidence(WORKSPACE_ID, task);
      }),
      capabilityReader(f.projectRoot)
    );
    expect(observed).toEqual([TASK_ID]);
    expect(result.outcome).toBe("recovered");
    if (result.outcome !== "recovered") throw new Error("expected recovered result");
    expect(result.result).toMatchObject({
      status: "succeeded",
      terminalOrigin: "recovery-closeout",
      evidenceState: "complete-linked-execution",
      executionTimestamp: evidence.timestamp,
      outputId: evidence.outputId,
      reasonCode: "recovered-succeeded",
    });
  });

  it.each(["failed", "blocked"] as const)("maps one uniquely linked %s execution without rerunning it", async (status) => {
    const f = fixture();
    addLinkedExecution(f, { exitStatus: status });
    const result = await recoverTaskbook(
      { workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir, recoveryAuthorizationId: RECOVERY_ID },
      (task) => withStateDir(f.stateDir, () => inspectTaskbookRecoveryEvidence(WORKSPACE_ID, task)),
      capabilityReader(f.projectRoot)
    );
    expect(result.outcome).toBe("recovered");
    if (result.outcome !== "recovered") throw new Error("expected recovered result");
    expect(result.result).toMatchObject({ status, terminalOrigin: "recovery-closeout", reasonCode: `recovered-${status}` });
  });

  it("does not recover success when the linked output is missing or unavailable", async () => {
    const f = fixture();
    addLinkedExecution(f, { outputId: 999, outputAvailable: true });
    const result = await recoverTaskbook(
      { workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir, recoveryAuthorizationId: RECOVERY_ID },
      (task) => withStateDir(f.stateDir, () => inspectTaskbookRecoveryEvidence(WORKSPACE_ID, task)),
      capabilityReader(f.projectRoot)
    );
    expect(result.outcome).toBe("recovered");
    if (result.outcome !== "recovered") throw new Error("expected recovered result");
    expect(result.result).toMatchObject({ status: "blocked", terminalOrigin: "recovery-abandon", reasonCode: "incomplete-linked-evidence" });
  });

  it("refuses Result V2 persistence unless a fresh capability proves the same Bridge binding", async () => {
    const otherRoot = projectWorkspaceFixture();
    const unsupported = {
      schemaId: "c2c.taskbook.lifecycle-capability.v1",
      readableResultVersions: [1],
    } satisfies TaskbookLifecycleCapabilityAdvertisement;
    const scenarios: Array<{
      label: string;
      proof: (root: string) => BoundTaskbookLifecycleCapability | null;
    }> = [
      { label: "no live runtime proof", proof: () => null },
      { label: "old reader capability despite equal package version", proof: (root) => capabilityProof(root, WORKSPACE_ID, unsupported) },
      { label: "different workspace", proof: (root) => capabilityProof(root, "915f50d36e24") },
      { label: "different workspace root", proof: () => capabilityProof(otherRoot) },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const f = fixture(`c2c-recovery-capability-${index}`);
      const before = snapshotTaskRoot(f);
      const error = await expectTaskbookErrorAsync(() => recoverTaskbook(
        { workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir, recoveryAuthorizationId: RECOVERY_ID },
        () => ({ classification: "none" }),
        async () => scenario.proof(f.projectRoot)
      ));
      expect(error.code).toBe("UPGRADE_REQUIRED");
      expect(error.detail).toBe("UNSUPPORTED_LIFECYCLE_RESULT_VERSION");
      expect(snapshotTaskRoot(f)).toEqual(before);
      expect(inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir }).unfinished).toHaveLength(1);
      expect(fs.existsSync(path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookResultFileName(TASK_ID)))).toBe(false);
    }
  });

  it.each([
    ["body hash", { bodySha256: bodySha256("wrong body") }],
    ["claim id", { claimId: "55555555-5555-4555-8555-555555555555" }],
    ["original authorization id", { authorizationId: "66666666-6666-4666-8666-666666666666" }],
  ])("abandons when linked evidence has a wrong %s", (_label, override) => {
    const f = fixture();
    addLinkedExecution(f, override);
    const result = withStateDir(f.stateDir, () => inspectTaskbookRecoveryEvidence(WORKSPACE_ID, {
      taskId: f.receipt.taskId,
      envelope: { version: 1, createdAt: "2026-09-23T00:00:00.000Z", title: "", body: "" },
      bodySha256: f.receipt.bodySha256,
      claim: f.claim.claim,
      result: null,
    }));
    expect(result.classification).toBe("incomplete");
  });

  it("treats multiple exact linked records as ambiguous instead of choosing one", () => {
    const f = fixture();
    addLinkedExecution(f);
    addLinkedExecution(f, { timestamp: "2026-09-23T00:02:00.000Z" });
    const task = inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir }).all[0]!;
    const stateTask = {
      taskId: task.taskId,
      envelope: { version: 1 as const, createdAt: task.createdAt, title: task.title, body: task.body },
      bodySha256: task.bodySha256,
      claim: f.claim.claim,
      result: null,
    };
    expect(withStateDir(f.stateDir, () => inspectTaskbookRecoveryEvidence(WORKSPACE_ID, stateTask).classification)).toBe("ambiguous");
  });

  it("does not mutate state when no unfinished claim exists", async () => {
    const stateDir = externalTempDir("c2c-recovery-no-target");
    const projectRoot = projectWorkspaceFixture();
    const receipt = submitTaskbook(
      { title: "pending only", body: "pending body" },
      { workspaceId: WORKSPACE_ID, projectRoot, stateDir, nextTaskId: () => TASK_ID }
    );
    const taskRoot = path.join(stateDir, "tasks", WORKSPACE_ID);
    const before = fs.readdirSync(taskRoot).sort();
    let inspected = false;
    const result = await recoverTaskbook(
      { workspaceId: WORKSPACE_ID, projectRoot, stateDir, recoveryAuthorizationId: RECOVERY_ID },
      () => {
        inspected = true;
        return { classification: "none" };
      },
      capabilityReader(projectRoot)
    );
    expect(result).toEqual({ outcome: "no-target" });
    expect(inspected).toBe(false);
    expect(fs.readdirSync(taskRoot).sort()).toEqual(before);
    expect(fs.existsSync(path.join(taskRoot, taskbookClaimFileName(receipt.taskId)))).toBe(false);
  });

  it("fails closed on corrupt lifecycle inventory", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookClaimFileName(SECOND_TASK_ID)), "{}");
    await expectTaskbookErrorAsync(() => recovery(f), "MALFORMED_CLAIM");
    expect(fs.existsSync(path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookResultFileName(TASK_ID)))).toBe(false);
  });

  it("rejects late linked records after Recover or normal finish", async () => {
    const recovered = fixture("c2c-recovery-late-record");
    await recovery(recovered);
    let persisted = false;
    expectTaskbookError(
      () => recordTaskbookExecution({
        workspaceId: WORKSPACE_ID,
        projectRoot: recovered.projectRoot,
        stateDir: recovered.stateDir,
        taskId: TASK_ID,
        bodySha256: recovered.receipt.bodySha256,
        claimId: recovered.claim.claim.claimId,
        authorizationId: AUTH_ID,
      }, () => { persisted = true; }),
      "TERMINAL_OR_UNCLAIMED"
    );
    expect(persisted).toBe(false);

    const finished = fixture("c2c-recovery-late-finish");
    const executionTimestamp = "2026-09-23T00:03:00.000Z";
    const terminalEvidence: TaskbookExecutionEvidence = {
      taskId: TASK_ID,
      bodySha256: finished.receipt.bodySha256,
      claimId: finished.claim.claim.claimId,
      authorizationId: AUTH_ID,
      iteration: 1,
      executionTimestamp,
      outputId: null,
      recorded: true,
      outputRecorded: false,
      outputAvailable: false,
      exitCode: null,
      reason: "finished before late record",
    };
    finishTaskbook({
      workspaceId: WORKSPACE_ID,
      projectRoot: finished.projectRoot,
      stateDir: finished.stateDir,
      taskId: TASK_ID,
      claimId: finished.claim.claim.claimId,
      authorizationId: AUTH_ID,
      bodySha256: finished.receipt.bodySha256,
      status: "blocked",
      executionTimestamp,
      outputId: null,
      evidence: terminalEvidence,
    });
    expectTaskbookError(
      () => recordTaskbookExecution({
        workspaceId: WORKSPACE_ID,
        projectRoot: finished.projectRoot,
        stateDir: finished.stateDir,
        taskId: TASK_ID,
        bodySha256: finished.receipt.bodySha256,
        claimId: finished.claim.claim.claimId,
        authorizationId: AUTH_ID,
      }, () => { persisted = true; }),
      "TERMINAL_OR_UNCLAIMED"
    );
    expect(persisted).toBe(false);
  });

  it("makes record-first evidence visible to Recover and Recover-first reject the late record", async () => {
    const recordFirst = fixture("c2c-recovery-record-first");
    const persisted = withStateDir(recordFirst.stateDir, () => {
      const timestamp = "2026-09-23T00:06:00.000Z";
      return recordTaskbookExecution({
        workspaceId: WORKSPACE_ID,
        projectRoot: recordFirst.projectRoot,
        stateDir: recordFirst.stateDir,
        taskId: TASK_ID,
        bodySha256: recordFirst.receipt.bodySha256,
        claimId: recordFirst.claim.claim.claimId,
        authorizationId: AUTH_ID,
      }, () => {
        const output = saveExecutionOutput(WORKSPACE_ID, {
          command: "pnpm test",
          raw: "actual linked output\n",
          exitCode: 0,
          taskId: TASK_ID,
          iteration: 1,
        });
        appendExecutionRecord(WORKSPACE_ID, {
          taskId: TASK_ID,
          iteration: 1,
          changedFiles: ["src/taskbook/lifecycle.ts"],
          tests: "one linked execution",
          exitStatus: "ok",
          timestamp,
          notes: encodeTaskbookEvidenceNote({
            bodySha256: recordFirst.receipt.bodySha256,
            claimId: recordFirst.claim.claim.claimId,
            authorizationId: AUTH_ID,
          }),
          outputId: output.id,
          outputAvailable: true,
        });
        return { timestamp, outputId: output.id };
      });
    });
    const recovered = await recoverTaskbook(
      { workspaceId: WORKSPACE_ID, projectRoot: recordFirst.projectRoot, stateDir: recordFirst.stateDir, recoveryAuthorizationId: RECOVERY_ID },
      (task) => withStateDir(recordFirst.stateDir, () => inspectTaskbookRecoveryEvidence(WORKSPACE_ID, task)),
      capabilityReader(recordFirst.projectRoot)
    );
    expect(recovered.outcome).toBe("recovered");
    if (recovered.outcome !== "recovered") throw new Error("expected recovered result");
    expect(recovered.result).toMatchObject({ status: "succeeded", executionTimestamp: persisted.timestamp, outputId: persisted.outputId });

    const recoverFirst = fixture("c2c-recovery-recover-first");
    await recovery(recoverFirst);
    expectTaskbookError(() => recordTaskbookExecution({
      workspaceId: WORKSPACE_ID,
      projectRoot: recoverFirst.projectRoot,
      stateDir: recoverFirst.stateDir,
      taskId: TASK_ID,
      bodySha256: recoverFirst.receipt.bodySha256,
      claimId: recoverFirst.claim.claim.claimId,
      authorizationId: AUTH_ID,
    }, () => "must not persist"), "TERMINAL_OR_UNCLAIMED");
  });

  it("serializes cross-process Recover against linked record and finish writers", async () => {
    const f = fixture("c2c-recovery-cross-process");
    const readyFile = path.join(f.stateDir, "recover-ready");
    const releaseFile = path.join(f.stateDir, "recover-release");
    const resultFile = path.join(f.stateDir, "recover-result.json");
    const child = spawn(process.execPath, [
      "--import", "tsx/esm", RECOVER_CHILD, f.stateDir, f.projectRoot, WORKSPACE_ID,
      RECOVERY_ID, readyFile, releaseFile, resultFile,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, C2C_STATE_DIR: f.stateDir },
      stdio: "ignore",
      windowsHide: true,
    });
    const childExit = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (fs.existsSync(readyFile)) { ready = true; break; }
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(ready).toBe(true);

      let recordPersisted = false;
      const recordError = expectTaskbookError(() => recordTaskbookExecution({
        workspaceId: WORKSPACE_ID,
        projectRoot: f.projectRoot,
        stateDir: f.stateDir,
        taskId: TASK_ID,
        bodySha256: f.receipt.bodySha256,
        claimId: f.claim.claim.claimId,
        authorizationId: AUTH_ID,
      }, () => { recordPersisted = true; }));
      expect(recordError.code).toBe("BUSY");
      expect(recordPersisted).toBe(false);

      const timestamp = "2026-09-23T00:07:00.000Z";
      const finishError = expectTaskbookError(() => finishTaskbook({
        workspaceId: WORKSPACE_ID,
        projectRoot: f.projectRoot,
        stateDir: f.stateDir,
        taskId: TASK_ID,
        claimId: f.claim.claim.claimId,
        authorizationId: AUTH_ID,
        bodySha256: f.receipt.bodySha256,
        status: "blocked",
        executionTimestamp: timestamp,
        outputId: null,
        evidence: {
          taskId: TASK_ID,
          bodySha256: f.receipt.bodySha256,
          claimId: f.claim.claim.claimId,
          authorizationId: AUTH_ID,
          iteration: 1,
          executionTimestamp: timestamp,
          outputId: null,
          recorded: true,
          outputRecorded: false,
          outputAvailable: false,
          exitCode: null,
          reason: "cross process lock fixture",
        },
      }));
      expect(finishError.code).toBe("BUSY");
    } finally {
      fs.writeFileSync(releaseFile, "release");
    }

    expect(await childExit).toBe(0);
    const childResult = JSON.parse(fs.readFileSync(resultFile, "utf8")) as { outcome: string; result?: { status: string } };
    expect(childResult).toMatchObject({ outcome: "recovered", result: { status: "blocked" } });
    const taskRoot = path.join(f.stateDir, "tasks", WORKSPACE_ID);
    expect(fs.readdirSync(taskRoot).filter((name) => name.endsWith(".result.json"))).toHaveLength(1);
  }, 30_000);

  it("keeps finish and Recover to one terminal result, and keeps historical Result V1 readable", async () => {
    const f = fixture();
    const executionTimestamp = "2026-09-23T00:05:00.000Z";
    const finished = finishTaskbook({
      workspaceId: WORKSPACE_ID,
      projectRoot: f.projectRoot,
      stateDir: f.stateDir,
      taskId: TASK_ID,
      claimId: f.claim.claim.claimId,
      authorizationId: AUTH_ID,
      bodySha256: f.receipt.bodySha256,
      status: "blocked",
      executionTimestamp,
      outputId: null,
      evidence: {
        taskId: TASK_ID,
        bodySha256: f.receipt.bodySha256,
        claimId: f.claim.claim.claimId,
        authorizationId: AUTH_ID,
        iteration: 1,
        executionTimestamp,
        outputId: null,
        recorded: true,
        outputRecorded: false,
        outputAvailable: false,
        exitCode: null,
        reason: "finish won",
      },
    });
    expect(finished.version).toBe(1);
    expect(parseResultRecord(serializeResultRecord(finished))).toEqual(finished);
    let inspected = false;
    expect((await recoverTaskbook(
      { workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir, recoveryAuthorizationId: RECOVERY_ID },
      () => { inspected = true; return { classification: "none" }; },
      capabilityReader(f.projectRoot)
    )).outcome).toBe("no-target");
    expect(inspected).toBe(false);
    const taskRoot = path.join(f.stateDir, "tasks", WORKSPACE_ID);
    expect(fs.readdirSync(taskRoot).filter((name) => name.endsWith(".result.json"))).toHaveLength(1);
  });

  it("treats a repeated recovery authorization as consumed while inventorying history", async () => {
    const first = fixture("c2c-recovery-auth-history-a");
    await recovery(first);
    submitTaskbook(
      { title: "second task", body: "second body" },
      { workspaceId: WORKSPACE_ID, projectRoot: first.projectRoot, stateDir: first.stateDir, nextTaskId: () => SECOND_TASK_ID }
    );
    const secondClaim = claimTaskbook({
      workspaceId: WORKSPACE_ID,
      projectRoot: first.projectRoot,
      stateDir: first.stateDir,
      taskId: SECOND_TASK_ID,
      bodySha256: bodySha256("second body"),
      authorizationId: "77777777-7777-4777-8777-777777777777",
      harness: "second-do",
    });
    expect(secondClaim.taskId).toBe(SECOND_TASK_ID);
    await expectTaskbookErrorAsync(() => recoverTaskbook(
      { workspaceId: WORKSPACE_ID, projectRoot: first.projectRoot, stateDir: first.stateDir, recoveryAuthorizationId: RECOVERY_ID },
      () => ({ classification: "none" }),
      capabilityReader(first.projectRoot)
    ));
  });

  it("cannot recover another workspace's unfinished claim", async () => {
    const f = fixture();
    const otherRoot = projectWorkspaceFixture();
    const result = await recoverTaskbook(
      { workspaceId: "915f50d36e24", projectRoot: otherRoot, stateDir: f.stateDir, recoveryAuthorizationId: RECOVERY_ID },
      () => ({ classification: "none" }),
      capabilityReader(otherRoot, "915f50d36e24")
    );
    expect(result).toEqual({ outcome: "no-target" });
    expect(inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir }).unfinished).toHaveLength(1);
  });

  it("strictly rejects unknown or inconsistent recovery-result fields", async () => {
    const f = fixture();
    const recovered = await recovery(f);
    if (recovered.outcome !== "recovered") throw new Error("expected recovered result");
    const valid = { ...recovered.result };
    expect(parseResultRecord(JSON.stringify(valid))).toEqual(valid);
    expect(() => parseResultRecord(JSON.stringify({ ...valid, extra: "x" }))).toThrow();
    expect(() => parseResultRecord(JSON.stringify({ ...valid, terminalOrigin: "recovery-guess" }))).toThrow();
    expect(() => parseResultRecord(JSON.stringify({ ...valid, executionTimestamp: "not-a-time" }))).toThrow();
    expect(() => parseResultRecord(JSON.stringify({ ...valid, reasonCode: "ambiguous-linked-evidence" }))).toThrow();
    expect(() => parseResultRecord(JSON.stringify({
      ...valid,
      status: "succeeded",
      terminalOrigin: "recovery-closeout",
      evidenceState: "complete-linked-execution",
      executionTimestamp: "2026-09-23T00:01:00.000Z",
      outputId: null,
      reasonCode: "recovered-succeeded",
    }))).toThrow();
  });

  it("classifies a future lifecycle result as upgrade-required while retaining corruption errors for supported versions", () => {
    const future = JSON.stringify({
      version: 3,
      taskId: TASK_ID,
      bodySha256: "a".repeat(64),
      claimId: AUTH_ID,
      status: "blocked",
      finishedAt: "2026-09-23T00:00:00.000Z",
      recoveryAuthorizationId: RECOVERY_ID,
      terminalOrigin: "recovery-abandon",
      evidenceState: "no-linked-evidence",
      executionTimestamp: null,
      outputId: null,
      reasonCode: "no-linked-evidence",
    });
    const unsupported = expectTaskbookError(() => parseResultRecord(future));
    expect(unsupported.code).toBe("UPGRADE_REQUIRED");
    expect(unsupported.detail).toBe("UNSUPPORTED_LIFECYCLE_RESULT_VERSION");
    expect(() => parseResultRecord(JSON.stringify({ version: 2, taskId: TASK_ID, extra: "x" }))).toThrow();

    const f = fixture("c2c-recovery-future-result-inventory");
    const resultPath = path.join(f.stateDir, "tasks", WORKSPACE_ID, taskbookResultFileName(TASK_ID));
    fs.writeFileSync(resultPath, future, { flag: "wx" });
    const inventoryError = expectTaskbookError(() => inspectTaskbooks({
      workspaceId: WORKSPACE_ID,
      projectRoot: f.projectRoot,
      stateDir: f.stateDir,
    }));
    expect(inventoryError.code).toBe("UPGRADE_REQUIRED");
    expect(inventoryError.detail).toBe("UNSUPPORTED_LIFECYCLE_RESULT_VERSION");
  });
});

afterAll(() => cleanupExternalTempDirs());
