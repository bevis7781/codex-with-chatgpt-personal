import { afterEach, describe, expect, it, vi } from "vitest";
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
    vi.restoreAllMocks();
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  async function startObservedBridge(label: string) {
    dirs.push(isolateStateDir());
    const root = makeTmpDir(label);
    dirs.push(root);
    write(root, "project.txt", "identity probe fixture\n");
    const auth = path.join(makeTmpDir(`${label}-auth`), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });
    const runtime = readRuntimeState(bridge.workspace.id);
    if (!runtime) throw new Error("test bridge runtime was not persisted");
    return { bridge, runtime };
  }

  function denyRecordedPidProbe(runtime: RuntimeState) {
    const realKill = process.kill.bind(process);
    return vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === runtime.pid && signal === 0) {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      }
      return realKill(pid, signal);
    });
  }

  function requestUrl(input: RequestInfo | URL): URL {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  }

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

  it("uses one authenticated loopback identity probe when PID observation is unknown", async () => {
    const { bridge, runtime } = await startObservedBridge("obs-pid-unknown-match");
    const before = readRuntimeState(bridge.workspace.id);
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      requests.push({ path: url.pathname, init });
      return realFetch(input, init);
    });
    const killSpy = denyRecordedPidProbe(runtime);

    try {
      const observation = await findBridgeObservation(bridge.workspace.id, bridge.workspace.root);
      expect(observation.state).toBe("healthy");
      expect(requests.map(({ path }) => path)).toEqual(["/health", "/admin/info"]);
      expect(requests[1]?.init?.redirect).toBe("error");
      expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe(`Bearer ${runtime.adminToken}`);
      expect(readRuntimeState(bridge.workspace.id)).toEqual(before);

      const stillServing = await realFetch(`http://127.0.0.1:${bridge.port}/health`);
      expect(stillServing.ok).toBe(true);
      expect(await stillServing.json()).toMatchObject({ workspaceId: bridge.workspace.id, status: "ok" });
    } finally {
      killSpy.mockRestore();
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });

  it("keeps PID-unknown status fail-closed when authenticated admin service is omitted", async () => {
    const { bridge, runtime } = await startObservedBridge("obs-admin-service-omitted");
    const before = readRuntimeState(bridge.workspace.id);
    const requests: Array<{ path: string; method: string }> = [];
    let healthCorrect = false;
    let adminServiceOmitted = false;
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      requests.push({ path: url.pathname, method: init?.method ?? "GET" });
      const response = await realFetch(input, init);
      if (!response.ok) return response;
      if (url.pathname === "/health") {
        const health = (await response.clone().json()) as Record<string, unknown>;
        healthCorrect =
          health.service === runtime.service &&
          health.version === runtime.version &&
          health.status === "ok" &&
          health.workspaceId === runtime.workspaceId;
        return response;
      }
      if (url.pathname !== "/admin/info") return response;
      const info = (await response.json()) as Record<string, unknown>;
      delete info.service;
      adminServiceOmitted = !Object.prototype.hasOwnProperty.call(info, "service");
      return new Response(JSON.stringify(info), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const killSpy = denyRecordedPidProbe(runtime);

    try {
      const observation = await findBridgeObservation(bridge.workspace.id, bridge.workspace.root);
      expect(healthCorrect).toBe(true);
      expect(adminServiceOmitted).toBe(true);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("pid_unknown");
      expect(requests).toEqual([
        { path: "/health", method: "GET" },
        { path: "/admin/info", method: "GET" },
      ]);
      expect(readRuntimeState(bridge.workspace.id)).toEqual(before);

      const stillServing = await realFetch(`http://127.0.0.1:${bridge.port}/health`);
      expect(stillServing.ok).toBe(true);
      expect(await stillServing.json()).toMatchObject({ workspaceId: bridge.workspace.id, status: "ok" });
    } finally {
      killSpy.mockRestore();
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });

  it.each([
    { field: "service", value: "foreign-service" },
    { field: "version", value: "0.1.0" },
    { field: "workspaceId", value: "000000000000" },
    { field: "workspaceRoot", value: path.parse(process.cwd()).root },
    { field: "pid", value: 1 },
    { field: "port", value: 1 },
    { field: "startedAt", value: "2000-01-01T00:00:00.000Z" },
  ])("keeps PID-unknown status fail-closed when authenticated admin $field mismatches", async ({ field, value }) => {
    const { bridge, runtime } = await startObservedBridge(`obs-admin-mismatch-${field}`);
    const before = readRuntimeState(bridge.workspace.id);
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      const response = await realFetch(input, init);
      if (url.pathname !== "/admin/info" || !response.ok) return response;
      const info = (await response.json()) as Record<string, unknown>;
      info[field] = value;
      return new Response(JSON.stringify(info), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const killSpy = denyRecordedPidProbe(runtime);

    try {
      const observation = await findBridgeObservation(bridge.workspace.id, bridge.workspace.root);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("pid_unknown");
      expect(readRuntimeState(bridge.workspace.id)).toEqual(before);
    } finally {
      killSpy.mockRestore();
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });

  it.each(["wrong-token", "unreachable"])("keeps PID-unknown status when admin identity is %s", async (failure) => {
    const { bridge, runtime } = await startObservedBridge(`obs-admin-${failure}`);
    const realFetch = globalThis.fetch.bind(globalThis);
    const paths: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      paths.push(url.pathname);
      if (url.pathname === "/admin/info" && failure === "unreachable") {
        throw new TypeError("simulated unreachable admin endpoint");
      }
      if (url.pathname === "/admin/info" && failure === "wrong-token") {
        const headers = new Headers(init?.headers);
        headers.set("authorization", "Bearer wrong-token");
        return realFetch(input, { ...init, headers });
      }
      return realFetch(input, init);
    });
    const killSpy = denyRecordedPidProbe(runtime);

    try {
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("pid_unknown");
      expect(paths).toEqual(["/health", "/admin/info"]);
    } finally {
      killSpy.mockRestore();
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });

  it("does not use the admin fallback when PID absence is definite", async () => {
    const { bridge, runtime } = await startObservedBridge("obs-pid-missing");
    const paths: string[] = [];
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      paths.push(requestUrl(input).pathname);
      return realFetch(input, init);
    });
    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === runtime.pid && signal === 0) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      return realKill(pid, signal);
    });

    try {
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("pid_unknown");
      expect(paths).toEqual(["/health"]);
    } finally {
      killSpy.mockRestore();
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });

  it("does not use the admin fallback when the public health identity is foreign", async () => {
    const { bridge, runtime } = await startObservedBridge("obs-health-foreign");
    const paths: string[] = [];
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      paths.push(url.pathname);
      const response = await realFetch(input, init);
      if (url.pathname !== "/health" || !response.ok) return response;
      const health = (await response.json()) as Record<string, unknown>;
      health.service = "foreign-service";
      return new Response(JSON.stringify(health), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const killSpy = denyRecordedPidProbe(runtime);

    try {
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("unknown");
      expect(paths).toEqual(["/health"]);
    } finally {
      killSpy.mockRestore();
      fetchSpy.mockRestore();
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
