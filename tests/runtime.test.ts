import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import {
  findBridgeObservation,
  findLiveBridge,
  probeBridge,
  readRuntimeState,
  writeRuntimeState,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { ensureBridge, stopBridge } from "../src/process/daemon.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

function stubRuntime(workspaceId: string, workspaceRoot: string, pid: number, port: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    workspaceRoot,
    pid,
    port,
    adminToken: "test-token",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

describe("findBridgeObservation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("treats a missing runtime file as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-missing");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("runtime_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("treats a dead pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-dead");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, 999_999_999, 1));
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("pid_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("does not treat a live pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-unknown");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, child.pid, 1));
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("probe_failed");
      expect(await findLiveBridge(workspace.id)).toBeNull();
      await expect(ensureBridge(root)).rejects.toThrow(/uncertain/);
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("reports healthy when the local bridge answers", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-live");
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir("obs-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });
    try {
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("healthy");
      expect(await findLiveBridge(bridge.workspace.id)).not.toBeNull();
    } finally {
      await bridge.close();
    }
  });

  it("recovers only a dead target runtime when its port serves another workspace", async () => {
    dirs.push(isolateStateDir());
    const targetRoot = makeTmpDir("obs-stale-target");
    const otherRoot = makeTmpDir("obs-stale-other");
    dirs.push(targetRoot, otherRoot);
    write(targetRoot, "target.txt", "target");
    write(otherRoot, "other.txt", "other");
    const otherAuth = path.join(makeTmpDir("obs-stale-other-auth"), "store.json");
    dirs.push(path.dirname(otherAuth));
    const otherBridge = await startBridge({
      workspaceRoot: otherRoot,
      port: 0,
      persistRuntime: true,
      authStoreFile: otherAuth,
    });
    let targetStarted = false;
    try {
      const target = new Workspace(targetRoot);
      const otherBefore = readRuntimeState(otherBridge.workspace.id);
      if (!otherBefore) throw new Error("other runtime was not persisted");
      writeRuntimeState(stubRuntime(target.id, target.root, 999_999_999, otherBridge.port));

      const observation = await findBridgeObservation(target.id);
      expect(observation.state).toBe("stale");
      if (observation.state === "stale") {
        expect(observation.reason).toBe("pid_missing_workspace_mismatch");
        expect(observation.otherWorkspaceId).toBe(otherBridge.workspace.id);
      }

      const result = await ensureBridge(targetRoot, { port: otherBridge.port });
      targetStarted = result.spawned;
      expect(result.spawned).toBe(true);
      expect(result.runtime.port).not.toBe(otherBridge.port);
      expect(await probeBridge(otherBridge.port)).toMatchObject({
        service: SERVICE_NAME,
        workspaceId: otherBridge.workspace.id,
        status: "ok",
      });
      expect(readRuntimeState(otherBridge.workspace.id)).toEqual(otherBefore);
      expect(readRuntimeState(target.id)?.pid).not.toBe(999_999_999);
    } finally {
      if (targetStarted) await stopBridge(targetRoot);
      await otherBridge.close();
    }
  });

  it("keeps a live target pid blocked when the port serves another workspace", async () => {
    dirs.push(isolateStateDir());
    const targetRoot = makeTmpDir("obs-live-mismatch-target");
    const otherRoot = makeTmpDir("obs-live-mismatch-other");
    dirs.push(targetRoot, otherRoot);
    write(targetRoot, "target.txt", "target");
    write(otherRoot, "other.txt", "other");
    const otherBridge = await startBridge({ workspaceRoot: otherRoot, port: 0, persistRuntime: false });
    try {
      const target = new Workspace(targetRoot);
      const runtime = stubRuntime(target.id, target.root, process.pid, otherBridge.port);
      writeRuntimeState(runtime);
      const observation = await findBridgeObservation(target.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("workspace_mismatch");
      await expect(ensureBridge(targetRoot)).rejects.toThrow(/uncertain/);
      expect(readRuntimeState(target.id)).toEqual(runtime);
    } finally {
      await otherBridge.close();
    }
  });

  it("keeps an unknown target pid blocked when the port serves another workspace", async () => {
    dirs.push(isolateStateDir());
    const targetRoot = makeTmpDir("obs-unknown-mismatch-target");
    const otherRoot = makeTmpDir("obs-unknown-mismatch-other");
    dirs.push(targetRoot, otherRoot);
    write(targetRoot, "target.txt", "target");
    write(otherRoot, "other.txt", "other");
    const otherBridge = await startBridge({ workspaceRoot: otherRoot, port: 0, persistRuntime: false });
    try {
      const target = new Workspace(targetRoot);
      const runtime = stubRuntime(target.id, target.root, 0, otherBridge.port);
      writeRuntimeState(runtime);
      const observation = await findBridgeObservation(target.id);
      expect(observation.state).toBe("unknown");
      await expect(ensureBridge(targetRoot)).rejects.toThrow(/uncertain/);
      expect(readRuntimeState(target.id)).toEqual(runtime);
    } finally {
      await otherBridge.close();
    }
  });

  it("still starts when a dead runtime port is unused", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-dead-restart");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, 999_999_999, 1));
    const result = await ensureBridge(root);
    try {
      expect(result.spawned).toBe(true);
      expect(result.runtime.pid).not.toBe(999_999_999);
    } finally {
      await stopBridge(root);
    }
  });
});
