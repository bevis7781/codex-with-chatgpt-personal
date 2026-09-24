import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  TaskbookError,
  TASKBOOK_LIFECYCLE_CAPABILITY,
  MAX_INVENTORY_ENTRIES,
  MAX_LIFECYCLE_BYTES,
  MAX_TOTAL_STORAGE_BYTES,
  claimTaskbook,
  inspectTaskbooks,
  inventoryTaskbookState,
  nodeTaskbookIo,
  recoverTaskbook,
  serializeClaimRecord,
  submitTaskbook,
  type BoundTaskbookLifecycleCapability,
} from "../src/taskbook/index.js";
import { cleanupExternalTempDirs, externalTempDir, projectWorkspaceFixture } from "./taskbook-helpers.js";

const WORKSPACE_ID = "915f50d36e23";
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const AUTH_ID = "22222222-2222-4222-8222-222222222222";

function setup(prefix: string) {
  const stateDir = externalTempDir(prefix);
  const projectRoot = projectWorkspaceFixture();
  const receipt = submitTaskbook(
    { title: "reserve", body: "terminal reserve" },
    { workspaceId: WORKSPACE_ID, projectRoot, stateDir, nextTaskId: () => TASK_ID }
  );
  return { stateDir, projectRoot, receipt, root: path.join(stateDir, "tasks", WORKSPACE_ID) };
}

function capabilityReader(projectRoot: string) {
  return async (): Promise<BoundTaskbookLifecycleCapability> => ({
    evidence: "authenticated-loopback-admin-info",
    observedAt: new Date().toISOString(),
    runtime: {
      service: "c2c-bridge",
      version: "0.1.1",
      workspaceId: WORKSPACE_ID,
      workspaceRoot: projectRoot,
      pid: process.pid,
      port: 14369,
      startedAt: "2026-09-23T00:00:00.000Z",
    },
    capability: TASKBOOK_LIFECYCLE_CAPABILITY,
  });
}

function writeSparseFile(file: string, size: number): void {
  const fd = fs.openSync(file, "w");
  try {
    fs.ftruncateSync(fd, size);
  } finally {
    fs.closeSync(fd);
  }
}

function fillEntries(root: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(root, `filler-${index}.bin`), "x");
  }
}

function expectLimitExceeded(run: () => unknown, detail: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TaskbookError);
    expect(error).toMatchObject({ code: "LIMIT_EXCEEDED", detail });
    return;
  }
  throw new Error("expected LIMIT_EXCEEDED");
}

describe("Taskbook terminal capacity reserve", () => {
  it("preserves one inventory entry through an unfinished claim and submission cannot consume it", async () => {
    const f = setup("c2c-tb-reserve-entry");
    fillEntries(f.root, MAX_INVENTORY_ENTRIES - 3); // envelope + fillers = cap - claim - result
    const beforeClaim = inventoryTaskbookState(nodeTaskbookIo, f.root);
    expect(beforeClaim.entries).toBe(MAX_INVENTORY_ENTRIES - 2);
    claimTaskbook({
      workspaceId: WORKSPACE_ID,
      projectRoot: f.projectRoot,
      stateDir: f.stateDir,
      taskId: TASK_ID,
      bodySha256: f.receipt.bodySha256,
      authorizationId: AUTH_ID,
      authorizedAt: "2026-09-23T00:00:00.000Z",
      harness: "entry-reserve",
    });
    expect(inventoryTaskbookState(nodeTaskbookIo, f.root).entries).toBe(MAX_INVENTORY_ENTRIES - 1);

    expectLimitExceeded(() => submitTaskbook(
      { title: "must be rejected", body: "would consume terminal slot" },
      { workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir, nextTaskId: () => "33333333-3333-4333-8333-333333333333" }
    ), "ENTRY_CAP");
    const recovered = await recoverTaskbook(
      { workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir, recoveryAuthorizationId: "44444444-4444-4444-8444-444444444444" },
      () => ({ classification: "none" }),
      capabilityReader(f.projectRoot)
    );
    expect(recovered.outcome).toBe("recovered");
    expect(inventoryTaskbookState(nodeTaskbookIo, f.root).entries).toBe(MAX_INVENTORY_ENTRIES);
    expect(fs.readdirSync(f.root).filter((name) => name.startsWith("filler-")).length).toBe(MAX_INVENTORY_ENTRIES - 3);
  });

  it("keeps enough bytes for one terminal result while rejecting a submission at the reserve boundary", async () => {
    const f = setup("c2c-tb-reserve-bytes");
    claimTaskbook({
      workspaceId: WORKSPACE_ID,
      projectRoot: f.projectRoot,
      stateDir: f.stateDir,
      taskId: TASK_ID,
      bodySha256: f.receipt.bodySha256,
      authorizationId: AUTH_ID,
      authorizedAt: "2026-09-23T00:00:00.000Z",
      harness: "byte-reserve",
    });
    const before = inventoryTaskbookState(nodeTaskbookIo, f.root);
    writeSparseFile(path.join(f.root, "byte-boundary.bin"), MAX_TOTAL_STORAGE_BYTES - MAX_LIFECYCLE_BYTES - before.storageBytes);
    const atReserve = inventoryTaskbookState(nodeTaskbookIo, f.root);
    expect(atReserve.storageBytes).toBe(MAX_TOTAL_STORAGE_BYTES - MAX_LIFECYCLE_BYTES);

    expectLimitExceeded(() => submitTaskbook(
      { title: "must be rejected", body: "would consume terminal bytes" },
      { workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir, nextTaskId: () => "33333333-3333-4333-8333-333333333333" }
    ), "STORAGE_CAP");
    const recovered = await recoverTaskbook(
      { workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir, recoveryAuthorizationId: "44444444-4444-4444-8444-444444444444" },
      () => ({ classification: "none" }),
      capabilityReader(f.projectRoot)
    );
    expect(recovered.outcome).toBe("recovered");
    const after = inventoryTaskbookState(nodeTaskbookIo, f.root);
    expect(after.storageBytes).toBeLessThanOrEqual(MAX_TOTAL_STORAGE_BYTES);
    const resultPath = path.join(f.root, `${TASK_ID}.result.json`);
    expect(fs.statSync(resultPath).size).toBeLessThanOrEqual(MAX_LIFECYCLE_BYTES);
    expect(fs.existsSync(path.join(f.root, "byte-boundary.bin"))).toBe(true);
  });

  it("refuses to establish a claim when the future terminal byte reserve cannot be guaranteed", () => {
    const f = setup("c2c-tb-claim-reserve-fail");
    const claimBytes = Buffer.byteLength(serializeClaimRecord({
      version: 1,
      taskId: TASK_ID,
      claimId: "33333333-3333-4333-8333-333333333333",
      authorizationId: AUTH_ID,
      bodySha256: f.receipt.bodySha256,
      harness: "capacity-preflight",
      authorizedAt: "2026-09-23T00:00:00.000Z",
      claimedAt: "2026-09-23T00:00:01.000Z",
    }));
    const before = inventoryTaskbookState(nodeTaskbookIo, f.root);
    const fillerBytes = MAX_TOTAL_STORAGE_BYTES - before.storageBytes - claimBytes - MAX_LIFECYCLE_BYTES + 1;
    writeSparseFile(path.join(f.root, "byte-over-cap.bin"), fillerBytes);
    expectLimitExceeded(() => claimTaskbook({
      workspaceId: WORKSPACE_ID,
      projectRoot: f.projectRoot,
      stateDir: f.stateDir,
      taskId: TASK_ID,
      bodySha256: f.receipt.bodySha256,
      authorizationId: AUTH_ID,
      authorizedAt: "2026-09-23T00:00:00.000Z",
      harness: "capacity-preflight",
    }), "STORAGE_CAP");
    expect(fs.readdirSync(f.root).some((name) => name.endsWith(".claim.json"))).toBe(false);
  });

  it("keeps ordinary no-claim storage bounded without reserving terminal capacity", () => {
    const f = setup("c2c-tb-no-claim-reserve");
    fillEntries(f.root, MAX_INVENTORY_ENTRIES - 2);
    expect(inventoryTaskbookState(nodeTaskbookIo, f.root).entries).toBe(MAX_INVENTORY_ENTRIES - 1);
    const admitted = submitTaskbook(
      { title: "final available slot", body: "no unfinished claim" },
      { workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir, nextTaskId: () => "33333333-3333-4333-8333-333333333333" }
    );
    expect(admitted.status).toBe("pending");
    expect(inspectTaskbooks({ workspaceId: WORKSPACE_ID, projectRoot: f.projectRoot, stateDir: f.stateDir }).pending).toHaveLength(2);
    expect(MAX_LIFECYCLE_BYTES).toBeGreaterThan(0);
  });
});

afterAll(() => cleanupExternalTempDirs());
