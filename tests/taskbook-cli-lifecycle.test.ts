import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { appendExecutionRecord } from "../src/execution/records.js";
import { encodeTaskbookEvidenceNote, submitTaskbook } from "../src/taskbook/index.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { Workspace } from "../src/workspace/manager.js";
import { startBridge } from "../src/bridge/server.js";
import { cleanupExternalTempDirs, externalTempDir, projectWorkspaceFixture } from "./taskbook-helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(repoRoot, "src", "cli", "index.ts");
const TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AUTH_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AUTH_ID_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RECOVERY_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

interface Fixture {
  stateDir: string;
  projectRoot: string;
  workspace: Workspace;
}

function fixture(prefix: string): Fixture {
  const stateDir = externalTempDir(prefix);
  const projectRoot = projectWorkspaceFixture();
  const workspace = new Workspace(projectRoot);
  return { stateDir, projectRoot, workspace };
}

function runCli(stateDir: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, C2C_STATE_DIR: stateDir },
    encoding: "utf8",
    windowsHide: true,
  });
}

interface AsyncCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCliAsync(stateDir: string, args: string[]): Promise<AsyncCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
      cwd: repoRoot,
      env: { ...process.env, C2C_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function startBoundTestBridge(f: Fixture): Promise<() => Promise<void>> {
  const previousStateDir = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = f.stateDir;
  try {
    const bridge = await startBridge({
      workspaceRoot: f.projectRoot,
      port: 0,
      localOnly: true,
      persistRuntime: true,
    });
    return async () => {
      try {
        await bridge.close();
      } finally {
        if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
        else process.env.C2C_STATE_DIR = previousStateDir;
      }
    };
  } catch (error) {
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    throw error;
  }
}

function submit(f: Fixture, taskId = TASK_ID) {
  return submitTaskbook(
    { title: "CLI lifecycle", body: `body-${taskId}` },
    {
      stateDir: f.stateDir,
      projectRoot: f.projectRoot,
      workspaceId: f.workspace.id,
      nextTaskId: () => taskId,
    }
  );
}

function readExecutionRecords(f: Fixture): Array<Record<string, unknown>> {
  const file = path.join(f.stateDir, "executions", `${f.workspace.id}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readOutputIndex(f: Fixture): { items: Array<Record<string, unknown>> } {
  const file = path.join(f.stateDir, "execution-outputs", f.workspace.id, "index.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as { items: Array<Record<string, unknown>> };
}

describe("Taskbook CLI lifecycle against real execution stores", () => {
  it("supports compact inspect JSON without claiming or hiding the pending body", () => {
    const f = fixture("c2c-g2-cli-compact-inspect");
    const receipt = submit(f);

    const legacy = runCli(f.stateDir, [
      "taskbook",
      "inspect",
      "--workspace",
      f.projectRoot,
      "--json",
    ]);
    expect(legacy.status).toBe(0);
    const legacyPayload = JSON.parse(legacy.stdout) as {
      pending: Array<Record<string, unknown>>;
      all: Array<Record<string, unknown>>;
    };
    expect(legacyPayload.pending[0]?.body).toBe(`body-${TASK_ID}`);
    expect(legacyPayload.all[0]?.body).toBe(`body-${TASK_ID}`);

    const compact = runCli(f.stateDir, [
      "taskbook",
      "inspect",
      "--workspace",
      f.projectRoot,
      "--json",
      "--compact-json",
    ]);
    expect(compact.status).toBe(0);
    const compactPayload = JSON.parse(compact.stdout) as {
      ok: boolean;
      workspaceId: string;
      pending: Array<Record<string, unknown>>;
      all: Array<Record<string, unknown>>;
      unfinished: unknown[];
    };
    expect(compactPayload).toMatchObject({ ok: true, workspaceId: f.workspace.id, unfinished: [] });
    expect(compactPayload.pending[0]?.body).toBe(`body-${TASK_ID}`);
    expect(compactPayload.all).toHaveLength(1);
    expect(compactPayload.all[0]).not.toHaveProperty("body");
    expect(compactPayload.all[0]).toMatchObject({
      taskId: receipt.taskId,
      createdAt: expect.any(String),
      title: "CLI lifecycle",
      bodySha256: receipt.bodySha256,
      status: "pending",
      claimId: null,
      result: null,
    });

    const invalid = runCli(f.stateDir, [
      "taskbook",
      "inspect",
      "--workspace",
      f.projectRoot,
      "--compact-json",
    ]);
    expect(invalid.status).toBe(1);
    expect(`${invalid.stdout}\n${invalid.stderr}`).toContain("--compact-json requires --json");

    const taskDir = path.join(f.stateDir, "tasks", f.workspace.id);
    expect(fs.readdirSync(taskDir)).toEqual([`${receipt.taskId}.json`]);
    expect(readExecutionRecords(f)).toEqual([]);
  });

  it("claims, records, reads back, and finishes through separate CLI processes", () => {
    const f = fixture("c2c-g2-cli-positive");
    const receipt = submit(f);
    const claim = runCli(f.stateDir, [
      "taskbook",
      "claim",
      "--workspace",
      f.projectRoot,
      "--task",
      receipt.taskId,
      "--body-sha256",
      receipt.bodySha256,
      "--authorization-id",
      AUTH_ID,
      "--harness",
      "real-cli-test",
      "--json",
    ]);
    expect(claim.status).toBe(0);
    const claimed = JSON.parse(claim.stdout) as { claim: { claimId: string } };
    const claimId = claimed.claim.claimId;

    const captured = path.join(f.stateDir, "captured-test-output.txt");
    fs.writeFileSync(captured, "real CLI output\n");
    const record = runCli(f.stateDir, [
      "record",
      "--workspace",
      f.projectRoot,
      "--task",
      receipt.taskId,
      "--iteration",
      "1",
      "--changed-files",
      "src/example.ts",
      "--tests",
      "real CLI fixture passed",
      "--exit-status",
      "ok",
      "--taskbook-body-sha256",
      receipt.bodySha256,
      "--taskbook-claim-id",
      claimId,
      "--taskbook-authorization-id",
      AUTH_ID,
      "--command",
      "pnpm test",
      "--output-file",
      captured,
      "--exit-code",
      "0",
    ]);
    expect(record.status).toBe(0);

    const records = readExecutionRecords(f);
    expect(records).toHaveLength(1);
    const execution = records[0];
    const outputId = execution.outputId as number;
    expect(execution.taskId).toBe(receipt.taskId);
    expect(execution.iteration).toBe(1);
    expect(execution.exitStatus).toBe("ok");
    expect(typeof execution.timestamp).toBe("string");
    expect(outputId).toBeGreaterThan(0);
    expect(readOutputIndex(f).items).toEqual([
      expect.objectContaining({ id: outputId, taskId: receipt.taskId, iteration: 1, exitCode: 0, allowed: true }),
    ]);

    const finish = runCli(f.stateDir, [
      "taskbook",
      "finish",
      "--workspace",
      f.projectRoot,
      "--task",
      receipt.taskId,
      "--claim-id",
      claimId,
      "--authorization-id",
      AUTH_ID,
      "--body-sha256",
      receipt.bodySha256,
      "--status",
      "succeeded",
      "--execution-timestamp",
      String(execution.timestamp),
      "--output-id",
      String(outputId),
      "--json",
    ]);
    expect(finish.status).toBe(0);
    expect(JSON.parse(finish.stdout)).toMatchObject({ ok: true, result: { status: "succeeded", taskId: receipt.taskId } });
  });

  it("rejects a CLI succeeded finish when the real execution record failed", () => {
    const f = fixture("c2c-g2-cli-failed-record");
    const receipt = submit(f);
    const claim = runCli(f.stateDir, [
      "taskbook",
      "claim",
      "--workspace",
      f.projectRoot,
      "--task",
      receipt.taskId,
      "--body-sha256",
      receipt.bodySha256,
      "--authorization-id",
      AUTH_ID,
      "--harness",
      "real-cli-negative",
      "--json",
    ]);
    expect(claim.status).toBe(0);
    const claimId = (JSON.parse(claim.stdout) as { claim: { claimId: string } }).claim.claimId;
    const captured = path.join(f.stateDir, "failed-output.txt");
    fs.writeFileSync(captured, "failed CLI output\n");
    expect(
      runCli(f.stateDir, [
        "record",
        "--workspace",
        f.projectRoot,
        "--task",
        receipt.taskId,
        "--iteration",
        "1",
        "--exit-status",
        "failed",
        "--taskbook-body-sha256",
        receipt.bodySha256,
        "--taskbook-claim-id",
        claimId,
        "--taskbook-authorization-id",
        AUTH_ID,
        "--command",
        "pnpm test",
        "--output-file",
        captured,
        "--exit-code",
        "1",
      ]).status
    ).toBe(0);
    const execution = readExecutionRecords(f)[0];
    const wrongOutputId = runCli(f.stateDir, [
      "taskbook",
      "finish",
      "--workspace",
      f.projectRoot,
      "--task",
      receipt.taskId,
      "--claim-id",
      claimId,
      "--authorization-id",
      AUTH_ID,
      "--body-sha256",
      receipt.bodySha256,
      "--status",
      "succeeded",
      "--execution-timestamp",
      String(execution.timestamp),
      "--output-id",
      String(Number(execution.outputId) + 1),
      "--json",
    ]);
    expect(wrongOutputId.status).toBe(1);
    expect(wrongOutputId.stdout).toContain("No read-back execution record");
    const finish = runCli(f.stateDir, [
      "taskbook",
      "finish",
      "--workspace",
      f.projectRoot,
      "--task",
      receipt.taskId,
      "--claim-id",
      claimId,
      "--authorization-id",
      AUTH_ID,
      "--body-sha256",
      receipt.bodySha256,
      "--status",
      "succeeded",
      "--execution-timestamp",
      String(execution.timestamp),
      "--output-id",
      String(execution.outputId),
      "--json",
    ]);
    expect(finish.status).toBe(1);
    expect(JSON.parse(finish.stdout)).toMatchObject({ ok: false });
    expect(finish.stdout).toContain("exitStatus ok");
    expect(readExecutionRecords(f)).toHaveLength(1);
  });

  it("rejects a real CLI claim when authorization-id is omitted", () => {
    const f = fixture("c2c-g2-cli-authorization-required");
    const receipt = submit(f);
    const claim = runCli(f.stateDir, [
      "taskbook",
      "claim",
      "--workspace",
      f.projectRoot,
      "--task",
      receipt.taskId,
      "--body-sha256",
      receipt.bodySha256,
      "--json",
    ]);
    expect(claim.status).toBe(1);
    expect(`${claim.stdout}\n${claim.stderr}`).toContain("required option '--authorization-id <id>'");
    const taskDir = path.join(f.stateDir, "tasks", f.workspace.id);
    expect(fs.readdirSync(taskDir)).toEqual([`${receipt.taskId}.json`]);
  });

  it("rejects a real execution record whose output metadata names another task", () => {
    const f = fixture("c2c-g2-cli-output-link");
    const receipt = submit(f);
    const claim = runCli(f.stateDir, [
      "taskbook",
      "claim",
      "--workspace",
      f.projectRoot,
      "--task",
      receipt.taskId,
      "--body-sha256",
      receipt.bodySha256,
      "--authorization-id",
      AUTH_ID,
      "--harness",
      "output-link-negative",
      "--json",
    ]);
    expect(claim.status).toBe(0);
    const claimId = (JSON.parse(claim.stdout) as { claim: { claimId: string } }).claim.claimId;

    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = f.stateDir;
    let outputId: number;
    const timestamp = new Date().toISOString();
    try {
      const output = saveExecutionOutput(f.workspace.id, {
        command: "pnpm test",
        raw: "foreign task output",
        exitCode: 0,
        taskId: TASK_ID_B,
        iteration: 1,
      });
      outputId = output.id;
      appendExecutionRecord(f.workspace.id, {
        taskId: receipt.taskId,
        iteration: 1,
        changedFiles: 0,
        tests: "foreign metadata fixture",
        exitStatus: "ok",
        timestamp,
        notes: encodeTaskbookEvidenceNote({
          bodySha256: receipt.bodySha256,
          claimId,
          authorizationId: AUTH_ID,
        }),
        outputId,
        outputAvailable: true,
      });
    } finally {
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }

    const finish = runCli(f.stateDir, [
      "taskbook",
      "finish",
      "--workspace",
      f.projectRoot,
      "--task",
      receipt.taskId,
      "--claim-id",
      claimId,
      "--authorization-id",
      AUTH_ID,
      "--body-sha256",
      receipt.bodySha256,
      "--status",
      "succeeded",
      "--execution-timestamp",
      timestamp,
      "--output-id",
      String(outputId),
      "--json",
    ]);
    expect(finish.status).toBe(1);
    expect(finish.stdout).toContain("metadata does not match");
  });

  it("black-box recovers a crash after claim with no evidence and permits only a fresh later Do", async () => {
    const f = fixture("c2c-g2-recover-before-record");
    const first = submit(f);
    const firstClaim = runCli(f.stateDir, [
      "taskbook", "claim", "--workspace", f.projectRoot, "--task", first.taskId,
      "--body-sha256", first.bodySha256, "--authorization-id", AUTH_ID, "--json",
    ]);
    expect(firstClaim.status).toBe(0);
    const claimId = (JSON.parse(firstClaim.stdout) as { claim: { claimId: string } }).claim.claimId;
    const secondReceipt = submit(f, TASK_ID_B);

    const blockedDo = runCli(f.stateDir, [
      "taskbook", "claim", "--workspace", f.projectRoot, "--task", TASK_ID_B,
      "--body-sha256", secondReceipt.bodySha256, "--authorization-id", AUTH_ID_2, "--json",
    ]);
    expect(blockedDo.status).toBe(1);
    expect(blockedDo.stdout).toContain("UNFINISHED_TASK");

    const residual = path.join(f.projectRoot, "orphaned-project-residue.bin");
    const residueBytes = Buffer.from([0, 9, 10, 13, 255]);
    fs.writeFileSync(residual, residueBytes);
    const before = fs.readFileSync(residual);
    const closeBridge = await startBoundTestBridge(f);
    let recovered: AsyncCliResult;
    try {
      recovered = await runCliAsync(f.stateDir, [
      "taskbook", "recover", "--workspace", f.projectRoot,
      "--recovery-authorization-id", RECOVERY_ID, "--json",
      ]);
    } finally {
      await closeBridge();
    }
    expect(recovered.status).toBe(0);
    const payload = JSON.parse(recovered.stdout) as { outcome: string; result: Record<string, unknown> };
    expect(payload).toMatchObject({
      ok: true,
      outcome: "recovered",
      result: {
        taskId: first.taskId,
        claimId,
        status: "blocked",
        terminalOrigin: "recovery-abandon",
        evidenceState: "no-linked-evidence",
        executionTimestamp: null,
        outputId: null,
      },
    });
    expect(fs.readFileSync(residual)).toEqual(before);
    expect(readExecutionRecords(f)).toEqual([]);
    expect(fs.readdirSync(path.join(f.stateDir, "tasks", f.workspace.id)).filter((name) => name.endsWith(".result.json"))).toHaveLength(1);

    const nextClaim = runCli(f.stateDir, [
      "taskbook", "claim", "--workspace", f.projectRoot, "--task", TASK_ID_B,
      "--body-sha256", secondReceipt.bodySha256, "--authorization-id", "99999999-9999-4999-8999-999999999999", "--json",
    ]);
    expect(nextClaim.status).toBe(0);
  });

  it("black-box closes a crash after complete linked execution evidence without rerunning work", async () => {
    const f = fixture("c2c-g2-recover-after-record");
    const receipt = submit(f);
    const claim = runCli(f.stateDir, [
      "taskbook", "claim", "--workspace", f.projectRoot, "--task", receipt.taskId,
      "--body-sha256", receipt.bodySha256, "--authorization-id", AUTH_ID, "--json",
    ]);
    expect(claim.status).toBe(0);
    const claimId = (JSON.parse(claim.stdout) as { claim: { claimId: string } }).claim.claimId;
    const captured = path.join(f.stateDir, "captured-recovery-output.txt");
    fs.writeFileSync(captured, "one actual test run\n");
    const record = runCli(f.stateDir, [
      "record", "--workspace", f.projectRoot, "--task", receipt.taskId, "--iteration", "1",
      "--changed-files", "src/taskbook/lifecycle.ts", "--tests", "one actual test run",
      "--exit-status", "ok", "--taskbook-body-sha256", receipt.bodySha256,
      "--taskbook-claim-id", claimId, "--taskbook-authorization-id", AUTH_ID,
      "--command", "pnpm test --runInBand", "--output-file", captured, "--exit-code", "0",
    ]);
    expect(record.status).toBe(0);
    const originalRecords = readExecutionRecords(f);
    expect(originalRecords).toHaveLength(1);
    const original = originalRecords[0]!;
    const outputId = original.outputId as number;

    const closeBridge = await startBoundTestBridge(f);
    let recovered: AsyncCliResult;
    try {
      recovered = await runCliAsync(f.stateDir, [
      "taskbook", "recover", "--workspace", f.projectRoot,
      "--recovery-authorization-id", RECOVERY_ID, "--json",
      ]);
    } finally {
      await closeBridge();
    }
    expect(recovered.status).toBe(0);
    const payload = JSON.parse(recovered.stdout) as { result: Record<string, unknown> };
    expect(payload.result).toMatchObject({
      taskId: receipt.taskId,
      bodySha256: receipt.bodySha256,
      claimId,
      status: "succeeded",
      terminalOrigin: "recovery-closeout",
      executionTimestamp: original.timestamp,
      outputId,
    });
    expect(readExecutionRecords(f)).toEqual(originalRecords);
    expect(readOutputIndex(f).items).toHaveLength(1);
  });

  it("black-box abandons Runner-shaped residual files without changing their bytes", async () => {
    const f = fixture("c2c-g2-recover-runner-residue");
    const receipt = submit(f);
    const claim = runCli(f.stateDir, [
      "taskbook", "claim", "--workspace", f.projectRoot, "--task", receipt.taskId,
      "--body-sha256", receipt.bodySha256, "--authorization-id", AUTH_ID, "--json",
    ]);
    expect(claim.status).toBe(0);
    const sourceResidue = path.join(f.projectRoot, "src", "unfinished-recovery.ts");
    const reportResidue = path.join(f.projectRoot, "test-report.log");
    fs.mkdirSync(path.dirname(sourceResidue), { recursive: true });
    fs.writeFileSync(sourceResidue, "partial implementation bytes\n");
    fs.writeFileSync(reportResidue, Buffer.from([0, 4, 8, 255]));
    const beforeSource = fs.readFileSync(sourceResidue);
    const beforeReport = fs.readFileSync(reportResidue);
    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = f.stateDir;
    try {
      appendExecutionRecord(f.workspace.id, {
        taskId: receipt.taskId,
        iteration: 1,
        changedFiles: ["src/unfinished-recovery.ts", "test-report.log"],
        tests: "residual unlinked report",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      });
    } finally {
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
    expect(readExecutionRecords(f)).toHaveLength(1);

    const closeBridge = await startBoundTestBridge(f);
    let recovered: AsyncCliResult;
    try {
      recovered = await runCliAsync(f.stateDir, [
      "taskbook", "recover", "--workspace", f.projectRoot,
      "--recovery-authorization-id", RECOVERY_ID, "--json",
      ]);
    } finally {
      await closeBridge();
    }
    expect(recovered.status).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      outcome: "recovered",
      result: { status: "blocked", terminalOrigin: "recovery-abandon", reasonCode: "no-linked-evidence" },
    });
    expect(fs.readFileSync(sourceResidue)).toEqual(beforeSource);
    expect(fs.readFileSync(reportResidue)).toEqual(beforeReport);
    expect(recovered.stdout).not.toContain("unfinished-recovery.ts");
    expect(recovered.stdout).not.toContain("test-report.log");

    const next = submit(f, TASK_ID_B);
    const nextClaim = runCli(f.stateDir, [
      "taskbook", "claim", "--workspace", f.projectRoot, "--task", next.taskId,
      "--body-sha256", next.bodySha256, "--authorization-id", AUTH_ID_2, "--json",
    ]);
    expect(nextClaim.status).toBe(0);
  });
});

afterAll(() => cleanupExternalTempDirs());
