import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import { readBoundTaskbookLifecycleCapability } from "../src/bridge/runtime.js";
import {
  claimTaskbook,
  inspectTaskbooks,
  recoverTaskbook,
  submitTaskbook,
} from "../src/taskbook/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanupExternalTempDirs, externalTempDir } from "./taskbook-helpers.js";

const AUTH_ID = "22222222-2222-4222-8222-222222222222";
const RECOVERY_ID = "33333333-3333-4333-8333-333333333333";

function snapshot(root: string): Map<string, Buffer> {
  return new Map(fs.readdirSync(root).sort().map((name) => [name, fs.readFileSync(path.join(root, name))]));
}

async function setup() {
  const stateDir = externalTempDir("c2c-lifecycle-capability-state");
  const projectRoot = externalTempDir("c2c-lifecycle-capability-project");
  const workspace = new Workspace(projectRoot);
  const receipt = submitTaskbook(
    { title: "capability fixture", body: "one unfinished claim" },
    { workspaceId: workspace.id, projectRoot, stateDir, nextTaskId: () => "11111111-1111-4111-8111-111111111111" }
  );
  const claim = claimTaskbook({
    workspaceId: workspace.id,
    projectRoot,
    stateDir,
    taskId: receipt.taskId,
    bodySha256: receipt.bodySha256,
    authorizationId: AUTH_ID,
    harness: "capability-test",
  });
  return { stateDir, projectRoot, workspace, receipt, claim, taskRoot: path.join(stateDir, "tasks", workspace.id) };
}

async function withBridge<T>(stateDir: string, projectRoot: string, run: () => Promise<T>): Promise<T> {
  const previousStateDir = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;
  const bridge = await startBridge({ workspaceRoot: projectRoot, port: 0, localOnly: true, persistRuntime: true });
  try {
    return await run();
  } finally {
    await bridge.close();
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
  }
}

describe("bound Bridge Taskbook lifecycle capability", () => {
  it("allows recovery only after the same bound Bridge proves Result V2 readability", async () => {
    const f = await setup();
    await withBridge(f.stateDir, f.projectRoot, async () => {
      const proof = await readBoundTaskbookLifecycleCapability(f.workspace.id, f.projectRoot);
      expect(proof?.capability?.readableResultVersions).toEqual([1, 2]);
      const recovered = await recoverTaskbook(
        {
          workspaceId: f.workspace.id,
          projectRoot: f.projectRoot,
          stateDir: f.stateDir,
          recoveryAuthorizationId: RECOVERY_ID,
        },
        () => ({ classification: "none" }),
        (binding) => readBoundTaskbookLifecycleCapability(binding.workspaceId, binding.workspaceRoot, binding.stateRoot)
      );
      expect(recovered).toMatchObject({ outcome: "recovered", result: { version: 2, status: "blocked" } });
      const inspected = inspectTaskbooks({ workspaceId: f.workspace.id, projectRoot: f.projectRoot, stateDir: f.stateDir });
      expect(inspected.unfinished).toEqual([]);
      expect(inspected.all[0]?.result).toMatchObject({ version: 2, terminalOrigin: "recovery-abandon" });
    });
  });

  it("leaves the claim and state bytes untouched when an authenticated old reader omits V2 support", async () => {
    const f = await setup();
    const before = snapshot(f.taskRoot);
    await withBridge(f.stateDir, f.projectRoot, async () => {
      const realFetch = globalThis.fetch.bind(globalThis);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const response = await realFetch(input, init);
        if (url.pathname !== "/admin/info" || !response.ok) return response;
        const info = await response.json() as Record<string, unknown>;
        delete info.taskbookLifecycle;
        return new Response(JSON.stringify(info), { status: 200, headers: { "content-type": "application/json" } });
      });
      try {
        const proof = await readBoundTaskbookLifecycleCapability(f.workspace.id, f.projectRoot);
        expect(proof).not.toBeNull();
        expect(proof?.capability).toBeNull();
        await expect(recoverTaskbook(
          {
            workspaceId: f.workspace.id,
            projectRoot: f.projectRoot,
            stateDir: f.stateDir,
            recoveryAuthorizationId: RECOVERY_ID,
          },
          () => ({ classification: "none" }),
          (binding) => readBoundTaskbookLifecycleCapability(binding.workspaceId, binding.workspaceRoot, binding.stateRoot)
        )).rejects.toMatchObject({ code: "UPGRADE_REQUIRED", detail: "UNSUPPORTED_LIFECYCLE_RESULT_VERSION" });
        expect(snapshot(f.taskRoot)).toEqual(before);
        expect(inspectTaskbooks({ workspaceId: f.workspace.id, projectRoot: f.projectRoot, stateDir: f.stateDir }).unfinished)
          .toHaveLength(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});

afterAll(() => cleanupExternalTempDirs());
