import { afterEach, describe, expect, it, vi } from "vitest";
import type { TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { startBridge } from "../src/bridge/server.js";
import { readRuntimeState, type RuntimeState } from "../src/bridge/runtime.js";
import {
  D022_APPROVAL_REQUIRED,
  D022_RECOVERY_BLOCKED,
  captureApprovedContextCandidate,
  inspectSetupRecovery,
  readRecoveryCandidate,
  runApprovedContextRecovery,
  type ApprovedContextRecoveryOps,
  type RecoveryAdminInfo,
} from "../src/process/approved-context.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const previousStateDir = process.env.C2C_STATE_DIR;
const dirs: string[] = [];
const TUNNEL_ID = "11111111-1111-4111-8111-111111111111";

function fakeTunnel(): TunnelProvider {
  const status: TunnelStatus = { running: false, url: null, provider: "cloudflare-named" };
  return {
    name: "cloudflare-named",
    start: async () => "https://c2c-demo.example.com",
    stop: async () => undefined,
    restart: async () => "https://c2c-demo.example.com",
    status: () => status,
    getPublicUrl: () => null,
    doctor: async () => ({
      provider: "cloudflare-named",
      binaryFound: true,
      binaryPath: "cloudflared",
      running: false,
      url: null,
      problems: [],
    }),
  };
}

function info(runtime: RuntimeState, overrides: Partial<RecoveryAdminInfo> = {}): RecoveryAdminInfo {
  return {
    workspaceId: runtime.workspaceId,
    workspaceRoot: runtime.workspaceRoot,
    port: runtime.port,
    publicUrl: runtime.publicUrl,
    tunnel: { provider: "cloudflare-named", running: false, url: null },
    pid: runtime.pid,
    startedAt: runtime.startedAt,
    ...overrides,
  };
}

async function fixture() {
  const stateDir = isolateStateDir();
  dirs.push(stateDir);
  const root = makeTmpDir("d022-workspace");
  dirs.push(root);
  write(root, "hello.txt", "hello\n");
  const workspaceId = "__filled_by_workspace__";
  writeTunnelState({
    workspaceId,
    preference: "named",
    provider: "cloudflare-named",
    tunnelName: "c2c-demo",
    tunnelId: TUNNEL_ID,
    hostname: "c2c-demo.example.com",
  });
  writeLastEndpoint({
    workspaceId,
    port: 0,
    publicUrl: "https://c2c-demo.example.com",
    mcpUrl: "https://c2c-demo.example.com/mcp",
    connectorName: "Codex with ChatGPT · Demo",
  });

  // The workspace ID is derived from its canonical path, so rewrite the test
  // state after the fixture root is known.
  const { Workspace } = await import("../src/workspace/manager.js");
  const workspace = new Workspace(root);
  writeTunnelState({
    workspaceId: workspace.id,
    preference: "named",
    provider: "cloudflare-named",
    tunnelName: "c2c-demo",
    tunnelId: TUNNEL_ID,
    hostname: "c2c-demo.example.com",
  });
  writeLastEndpoint({
    workspaceId: workspace.id,
    port: 0,
    publicUrl: "https://c2c-demo.example.com",
    mcpUrl: "https://c2c-demo.example.com/mcp",
    connectorName: "Codex with ChatGPT · Demo",
  });
  const authDir = makeTmpDir("d022-auth");
  dirs.push(authDir);
  const bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    tunnelProvider: fakeTunnel(),
    persistRuntime: true,
    authStoreFile: authDir + "\\auth.json",
  });
  const runtime = readRuntimeState(workspace.id);
  if (!runtime) throw new Error("fixture runtime was not persisted");
  const candidate = await captureApprovedContextCandidate(
    root,
    new Error(
      "dial tcp 104.16.0.1:443: connectex: An attempt was made to access a socket in a way forbidden by its access permissions."
    )
  );
  if (!candidate) throw new Error("fixture did not create a D-022 candidate");
  return { root, workspaceId: workspace.id, bridge, runtime, candidate };
}

function replacementRuntime(old: RuntimeState): RuntimeState {
  return {
    ...old,
    pid: old.pid + 1,
    port: old.port + 1,
    startedAt: new Date(Date.parse(old.startedAt) + 1_000).toISOString(),
    publicUrl: null,
    adminToken: "replacement-token",
  };
}

function recoveryOps(
  oldRuntime: RuntimeState,
  root: string,
  opts: {
    replacement?: RuntimeState;
    provider?: string;
    healthyBefore?: boolean;
    failRetry?: Error;
    runtimeChangedBeforeStop?: boolean;
  } = {}
): ApprovedContextRecoveryOps & { stop: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> } {
  const replacement = opts.replacement ?? {
    ...replacementRuntime(oldRuntime),
    publicUrl: "https://c2c-demo.example.com",
  };
  const oldInfo = info(oldRuntime, {
    tunnel: opts.healthyBefore
      ? { provider: "cloudflare-named", running: true, url: "https://c2c-demo.example.com", pid: 9911 }
      : { provider: "cloudflare-named", running: false, url: null },
  });
  const newInfo = info(replacement, {
    publicUrl: "https://c2c-demo.example.com",
    tunnel: {
      provider: opts.provider ?? "cloudflare-named",
      running: true,
      url: "https://c2c-demo.example.com",
      pid: 9912,
    },
  });
  let observations = 0;
  const stop = vi.fn(async () => undefined);
  const start = vi.fn(async () => replacement);
  const retry = vi.fn(async () => {
    if (opts.failRetry) throw opts.failRetry;
    return { url: "https://c2c-demo.example.com" };
  });
  const observe = vi.fn(async () => {
    observations += 1;
    if (opts.runtimeChangedBeforeStop && observations === 1) {
      return { runtime: replacement, info: oldInfo };
    }
    if (opts.healthyBefore || observations <= 2) return { runtime: oldRuntime, info: oldInfo };
    return { runtime: replacement, info: newInfo };
  });
  return {
    observe,
    stopCurrent: stop,
    start,
    adminFetch: retry as ApprovedContextRecoveryOps["adminFetch"],
    isProcessAlive: () => true,
    stop,
    retry,
  };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) cleanup(dir);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("D-022 approved-context recovery", () => {
  it("reuses a healthy Named Bridge without restarting it", async () => {
    const f = await fixture();
    const ops = recoveryOps(f.runtime, f.root, { healthyBefore: true });
    const result = await runApprovedContextRecovery(f.root, { approved: true, ops });
    expect(result).toMatchObject({ status: "succeeded", action: "reused", retryCount: 0 });
    expect(ops.stop).not.toHaveBeenCalled();
    expect(ops.start).not.toHaveBeenCalled();
    expect(ops.retry).not.toHaveBeenCalled();
  });

  it("requires explicit approval and does not mutate the current Bridge", async () => {
    const f = await fixture();
    const ops = recoveryOps(f.runtime, f.root);
    const result = await runApprovedContextRecovery(f.root, { approved: false, ops });
    expect(result).toMatchObject({ status: "approval_required", code: D022_APPROVAL_REQUIRED });
    expect(ops.stop).not.toHaveBeenCalled();
    expect(ops.start).not.toHaveBeenCalled();
    expect(ops.retry).not.toHaveBeenCalled();
    expect(readRecoveryCandidate(f.workspaceId)?.status).toBe("pending");
  });

  it("does not reuse the same healthy-but-blocked Bridge on ordinary setup", async () => {
    const f = await fixture();
    const gate = await inspectSetupRecovery(f.root);
    expect(gate).toMatchObject({ action: "approval_required", code: D022_APPROVAL_REQUIRED });
    expect(gate.candidate).toMatchObject({ available: true, workspaceId: f.workspaceId, retryCount: 0 });
  });

  it("replaces only the diagnosed Bridge and retries the existing Named identity once", async () => {
    const f = await fixture();
    const ops = recoveryOps(f.runtime, f.root);
    const result = await runApprovedContextRecovery(f.root, { approved: true, ops });
    expect(result).toMatchObject({ status: "succeeded", action: "recovered", retryCount: 1 });
    expect(ops.stop).toHaveBeenCalledTimes(1);
    expect(ops.start).toHaveBeenCalledTimes(1);
    expect(ops.retry).toHaveBeenCalledTimes(1);
    expect(readRecoveryCandidate(f.workspaceId)).toMatchObject({ status: "succeeded", retryCount: 1 });
    expect(readRecoveryCandidate(f.workspaceId)?.identity).toMatchObject({
      tunnelId: TUNNEL_ID,
      hostname: "c2c-demo.example.com",
      endpoint: "https://c2c-demo.example.com",
      mcpUrl: "https://c2c-demo.example.com/mcp",
      stateRoot: process.env.C2C_STATE_DIR,
    });
  });

  it("blocks a failed single retry and never loops", async () => {
    const f = await fixture();
    const ops = recoveryOps(f.runtime, f.root, { failRetry: new Error("authentication failed") });
    const result = await runApprovedContextRecovery(f.root, { approved: true, ops });
    expect(result).toMatchObject({ status: "blocked", code: D022_RECOVERY_BLOCKED, retryCount: 1 });
    expect(ops.retry).toHaveBeenCalledTimes(1);
    expect(readRecoveryCandidate(f.workspaceId)).toMatchObject({ status: "blocked", retryCount: 1 });

    const second = await runApprovedContextRecovery(f.root, { approved: true, ops });
    expect(second.status).toBe("blocked");
    expect(ops.retry).toHaveBeenCalledTimes(1);
  });

  it("blocks when runtime identity changes before replacement", async () => {
    const f = await fixture();
    const ops = recoveryOps(f.runtime, f.root, { runtimeChangedBeforeStop: true });
    const result = await runApprovedContextRecovery(f.root, { approved: true, ops });
    expect(result).toMatchObject({ status: "blocked", code: D022_RECOVERY_BLOCKED });
    expect(ops.stop).not.toHaveBeenCalled();
    expect(ops.start).not.toHaveBeenCalled();
    expect(ops.retry).not.toHaveBeenCalled();
  });

  it("blocks instead of switching to Quick", async () => {
    const f = await fixture();
    const ops = recoveryOps(f.runtime, f.root, { provider: "cloudflare-quick" });
    const result = await runApprovedContextRecovery(f.root, { approved: true, ops });
    expect(result).toMatchObject({ status: "blocked", code: D022_RECOVERY_BLOCKED });
    expect(ops.retry).not.toHaveBeenCalled();
  });

  it("does not touch another workspace runtime during recovery", async () => {
    const f = await fixture();
    const otherRoot = makeTmpDir("d022-other-workspace");
    dirs.push(otherRoot);
    write(otherRoot, "other.txt", "other\n");
    const otherAuthDir = makeTmpDir("d022-other-auth");
    dirs.push(otherAuthDir);
    const otherBridge = await startBridge({
      workspaceRoot: otherRoot,
      port: 0,
      tunnelProvider: fakeTunnel(),
      persistRuntime: true,
      authStoreFile: otherAuthDir + "\\auth.json",
    });
    const otherBefore = readRuntimeState(otherBridge.workspace.id);
    try {
      const ops = recoveryOps(f.runtime, f.root);
      const result = await runApprovedContextRecovery(f.root, { approved: true, ops });
      expect(result.status).toBe("succeeded");
      expect(readRuntimeState(otherBridge.workspace.id)).toEqual(otherBefore);
    } finally {
      await otherBridge.close();
    }
  });

  it("blocks identity drift before any approved restart", async () => {
    const f = await fixture();
    writeTunnelState({
      workspaceId: f.workspaceId,
      preference: "named",
      provider: "cloudflare-named",
      tunnelName: "c2c-replaced",
      tunnelId: TUNNEL_ID,
      hostname: "c2c-replaced.example.com",
    });
    const ops = recoveryOps(f.runtime, f.root);
    const result = await runApprovedContextRecovery(f.root, { approved: true, ops });
    expect(result).toMatchObject({ status: "blocked", code: D022_RECOVERY_BLOCKED });
    expect(ops.stop).not.toHaveBeenCalled();
    expect(ops.start).not.toHaveBeenCalled();
  });

  it("rejects a malformed persisted tunnel UUID when making a candidate", async () => {
    const f = await fixture();
    writeTunnelState({
      workspaceId: f.workspaceId,
      preference: "named",
      provider: "cloudflare-named",
      tunnelName: "c2c-demo",
      tunnelId: "not-a-uuid",
      hostname: "c2c-demo.example.com",
    });
    await expect(
      captureApprovedContextCandidate(
        f.root,
        new Error("lookup api.cloudflare.com: no such host")
      )
    ).rejects.toThrow(/UUID/);
  });
});
