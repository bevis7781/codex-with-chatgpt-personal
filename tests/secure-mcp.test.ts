import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupExternalTempDirs,
  externalTempDir,
  projectWorkspaceFixture,
} from "./taskbook-helpers.js";
import { readSecureMcpConfig, writeSecureMcpConfig } from "../src/secure-mcp/config.js";
import {
  redactControlPlaneProxy,
  secureMcpChildEnv,
  validateControlPlaneProxy,
  validateLoopbackMcpUrl,
} from "../src/secure-mcp/proxy.js";
import {
  registerSecureMcpWorkspace,
  readSecureMcpRegistry,
  setSecureMcpWorkspaceEnabled,
} from "../src/secure-mcp/registry.js";
import { resolveSecureMcpPaths } from "../src/secure-mcp/paths.js";
import { readRuntimeKey, runtimeKeyStatus, setRuntimeKey } from "../src/secure-mcp/secrets.js";
import { importManagedRuntime, verifyManagedBinary } from "../src/secure-mcp/managed-client.js";
import {
  connectAll,
  disconnectAll,
  type NativeCommandRunner,
} from "../src/secure-mcp/runtime.js";
import { startBridge } from "../src/bridge/server.js";

const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
const officialRelease = process.env.C2C_APPROVED_TUNNEL_CLIENT_DIR;
const previousStateDir = process.env.C2C_STATE_DIR;

describe("OpenAI Secure MCP local state", () => {
  it("keeps config, registry, and runtime-key paths below the supplied state root", () => {
    const stateDir = externalTempDir("c2c-secure-state");
    const paths = resolveSecureMcpPaths(stateDir);
    expect(paths.root.startsWith(path.resolve(stateDir))).toBe(true);
    expect(paths.configFile.startsWith(paths.root)).toBe(true);
    expect(paths.runtimeKeyFile.startsWith(paths.root)).toBe(true);
  });

  it("isolates malformed registry entries and rejects state inside a project", () => {
    const stateDir = externalTempDir("c2c-secure-registry-isolation");
    const workspaceRoot = projectWorkspaceFixture();
    const record = registerSecureMcpWorkspace({ workspaceRoot, tunnelId, stateDir });
    const paths = resolveSecureMcpPaths(stateDir);
    fs.writeFileSync(
      path.join(paths.registryDir, "ffffffffffff.json"),
      JSON.stringify({ ...record, workspaceId: "ffffffffffff" }),
      "utf8"
    );
    fs.mkdirSync(path.join(paths.registryDir, "unexpected"));

    const snapshot = readSecureMcpRegistry(stateDir);
    expect(snapshot.records).toEqual([record]);
    expect(snapshot.invalid).toEqual([
      { file: "ffffffffffff.json", error: "INVALID_RECORD" },
      { file: "unexpected", error: "UNEXPECTED_ENTRY" },
    ]);
    expect(() => registerSecureMcpWorkspace({
      workspaceRoot,
      tunnelId: "tunnel_abcdefabcdefabcdefabcdefabcdefab",
      stateDir: path.join(workspaceRoot, "local-state"),
    })).toThrow("Secure MCP state cannot be inside the project workspace.");
  });

  it("rejects a reparse-point state root instead of following it", () => {
    const parent = externalTempDir("c2c-secure-reparse-parent");
    const target = externalTempDir("c2c-secure-reparse-target");
    const link = path.join(parent, "state-link");
    try {
      fs.symlinkSync(target, link, "junction");
    } catch {
      return;
    }
    expect(() => resolveSecureMcpPaths(link)).toThrow("bound C2C state root is not a regular directory");
  });

  it("round-trips one canonical workspace and isolates the disabled state", () => {
    const stateDir = externalTempDir("c2c-secure-registry");
    const workspaceRoot = projectWorkspaceFixture();
    const record = registerSecureMcpWorkspace({ workspaceRoot, tunnelId, stateDir });
    expect(record.workspaceId).toHaveLength(12);
    expect(readSecureMcpRegistry(stateDir).records).toEqual([record]);
    const disabled = setSecureMcpWorkspaceEnabled({ workspaceRoot, enabled: false, stateDir });
    expect(disabled.enabled).toBe(false);
    expect(readSecureMcpRegistry(stateDir).records[0]?.enabled).toBe(false);
    expect(() => registerSecureMcpWorkspace({ workspaceRoot: projectWorkspaceFixture(), tunnelId, stateDir })).toThrow(
      "SECURE_MCP_TUNNEL_ALREADY_REGISTERED"
    );
  });

  it("rejects proxy credentials and removes ambient proxy variables from the child", () => {
    expect(() => validateControlPlaneProxy("http://user:secret@example.test:8080")).toThrow(
      "SECURE_MCP_PROXY_CREDENTIALS_FORBIDDEN"
    );
    const config = writeSecureMcpConfig(
      { ...readSecureMcpConfig(externalTempDir("c2c-secure-proxy")), controlPlaneProxy: "http://proxy.test:8080" },
      externalTempDir("c2c-secure-proxy-config")
    );
    const env = secureMcpChildEnv(
      {
        ...process.env,
        HTTP_PROXY: "http://ambient.invalid",
        HTTPS_PROXY: "http://ambient.invalid",
        CLOUDFLARE_API_TOKEN: "cloudflare-secret",
        C2C_STATE_DIR: "C:\\foreign-state",
        HARPOON_REMOTE_URL: "https://remote.invalid",
        MCP_SERVER_URL: "http://127.0.0.1:1/foreign",
        TUNNEL_CLIENT_PROFILE: "foreign-profile",
      },
      { runtimeKey: "redacted-runtime-key", mcpServerUrl: "http://127.0.0.1:54321/mcp", config }
    );
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(env.C2C_STATE_DIR).toBeUndefined();
    expect(env.HARPOON_REMOTE_URL).toBeUndefined();
    expect(env.TUNNEL_CLIENT_PROFILE).toBeUndefined();
    expect(env.CONTROL_PLANE_HTTP_PROXY).toBe("http://proxy.test:8080");
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect(redactControlPlaneProxy("http://proxy.test:8080")).toBe("http://proxy.test:8080");
    expect(env.MCP_SERVER_URL).toBe("http://127.0.0.1:54321/mcp");
    expect(env.HARPOON_ALLOW_PLAINTEXT_HTTP).toBe("true");
    expect(JSON.stringify(env)).not.toContain("ambient.invalid");
    expect(JSON.stringify(env)).not.toContain("cloudflare-secret");
    expect(() => validateLoopbackMcpUrl("https://127.0.0.1:54321/mcp")).toThrow();
    expect(() => validateLoopbackMcpUrl("http://127.0.0.1:54321/other")).toThrow();
    expect(() => validateLoopbackMcpUrl("http://127.0.0.1/mcp")).toThrow();
  });

  it("uses CurrentUser DPAPI for runtime key storage on Windows", () => {
    if (process.platform !== "win32") return;
    const stateDir = externalTempDir("c2c-secure-key");
    const secret = "runtime-key-test-value";
    setRuntimeKey(secret, stateDir);
    const paths = resolveSecureMcpPaths(stateDir);
    const atRest = fs.readFileSync(paths.runtimeKeyFile);
    expect(atRest.toString("utf8")).not.toContain(secret);
    expect(runtimeKeyStatus(stateDir)).toMatchObject({ configured: true, decryptable: true });
    expect(readRuntimeKey(stateDir)).toBe(secret);
  });

  it("rotates the protected key and fails closed after ciphertext corruption", () => {
    if (process.platform !== "win32") return;
    const stateDir = externalTempDir("c2c-secure-key-rotation");
    setRuntimeKey("old-runtime-key", stateDir);
    const paths = resolveSecureMcpPaths(stateDir);
    const oldCiphertext = fs.readFileSync(paths.runtimeKeyFile);
    setRuntimeKey("new-runtime-key", stateDir);
    const newCiphertext = fs.readFileSync(paths.runtimeKeyFile);
    expect(newCiphertext.equals(oldCiphertext)).toBe(false);
    expect(newCiphertext.toString("utf8")).not.toContain("new-runtime-key");
    expect(readRuntimeKey(stateDir)).toBe("new-runtime-key");

    fs.writeFileSync(paths.runtimeKeyFile, Buffer.from("not-dpapi-ciphertext"));
    expect(runtimeKeyStatus(stateDir)).toMatchObject({ configured: true, decryptable: false });
    expect(() => readRuntimeKey(stateDir)).toThrow();
  });

  it("accepts only the approved official managed binary when the local release is present", () => {
    if (process.platform !== "win32") return;
    if (!officialRelease) return;
    const binary = path.join(officialRelease, "tunnel-client.exe");
    if (!fs.existsSync(binary)) return;
    expect(verifyManagedBinary(binary).sha256).toBe(
      "fcc85a69ec0ad82518e4f8964f60c45e31787957782a0fc9c1b0c44e82d61b9b"
    );
  });

  it("does not accept an arbitrary executable as the managed runtime", () => {
    expect(() => verifyManagedBinary(process.execPath)).toThrow("Managed tunnel-client is not the approved v0.0.14 release.");
  });

  it("reuses a healthy dynamic runtime, propagates the loopback target, and refuses target mismatch", async () => {
    if (!officialRelease || process.platform !== "win32" || !fs.existsSync(path.join(officialRelease, "tunnel-client.exe"))) return;
    const stateDir = externalTempDir("c2c-secure-lifecycle");
    process.env.C2C_STATE_DIR = stateDir;
    const workspaceRoot = projectWorkspaceFixture();
    const record = registerSecureMcpWorkspace({ workspaceRoot, tunnelId, stateDir });
    const bridge = await startBridge({ workspaceRoot, port: 0, localOnly: true });
    let mcpServerUrl = "";
    let connected = false;
    let mismatch = false;
    let statusFailure = false;
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const paths = resolveSecureMcpPaths(stateDir);
    const runner: NativeCommandRunner = {
      run(_binary, args, options) {
        calls.push({ args: [...args], env: { ...options.env } });
        if (args[0] !== "runtimes") return { status: 1, stdout: "", stderr: "unsupported" };
        if (args[1] === "status") {
          if (statusFailure) return { status: 1, stdout: "", stderr: "unexpected status failure" };
          if (!connected) {
            return {
              status: 1,
              stdout: "",
              stderr: `alias c2c-${record.workspaceId} is not known; run create or connect first`,
            };
          }
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "ready",
              alias: "c2c-" + record.workspaceId,
              workspace_id: record.workspaceId,
              pid: process.pid,
              tunnel_id: record.tunnelId,
              mcp_server_url: mismatch ? "http://127.0.0.1:6553/mcp" : mcpServerUrl,
              healthy: true,
              ready: true,
              binary_path: paths.managedClientBin,
              control_plane_poll_health: "healthy",
            }),
            stderr: "",
          };
        }
        if (args[1] === "connect") {
          connected = true;
          return { status: 0, stdout: JSON.stringify({ state: "running" }), stderr: "" };
        }
        if (args[1] === "stop") {
          connected = false;
          return { status: 0, stdout: JSON.stringify({ state: "stopped" }), stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "unsupported" };
      },
    };

    try {
      setRuntimeKey("lifecycle-runtime-key", stateDir);
      importManagedRuntime({ sourceDir: officialRelease, stateDir });
      expect(importManagedRuntime({ sourceDir: officialRelease, stateDir }).sha256).toBe(
        "fcc85a69ec0ad82518e4f8964f60c45e31787957782a0fc9c1b0c44e82d61b9b"
      );
      mcpServerUrl = `http://127.0.0.1:${bridge.port}/mcp`;

      const first = await connectAll({ stateDir, runner, timeoutMs: 5_000, pollMs: 20 });
      expect(first.ok).toBe(true);
      expect(first.results).toMatchObject([{ status: "PASS", bridge: { state: "healthy", port: bridge.port } }]);
      const firstConnectCount = calls.filter((call) => call.args[1] === "connect").length;
      expect(firstConnectCount).toBe(1);
      const connectCall = calls.find((call) => call.args[1] === "connect");
      expect(connectCall?.args).toContain("http://127.0.0.1:" + bridge.port + "/mcp");
      expect(connectCall?.args).not.toContain("lifecycle-runtime-key");
      expect(connectCall?.env.C2C_SECURE_MCP_RUNTIME_KEY).toBe("lifecycle-runtime-key");
      expect(connectCall?.env.MCP_SERVER_URL).toBe(mcpServerUrl);
      expect(connectCall?.env.NO_PROXY).toContain("127.0.0.1");

      const second = await connectAll({ stateDir, runner, timeoutMs: 5_000, pollMs: 20 });
      expect(second.ok).toBe(true);
      expect(calls.filter((call) => call.args[1] === "connect")).toHaveLength(1);

      statusFailure = true;
      const unexpectedStatusFailure = await connectAll({ stateDir, runner, timeoutMs: 5_000, pollMs: 20 });
      expect(unexpectedStatusFailure.ok).toBe(false);
      expect(unexpectedStatusFailure.results[0]).toMatchObject({
        status: "FAIL",
        reasonCode: "SECURE_MCP_RUNTIME_STATUS_FAILED",
      });
      statusFailure = false;

      mismatch = true;
      const refused = await connectAll({ stateDir, runner, timeoutMs: 5_000, pollMs: 20 });
      expect(refused.ok).toBe(false);
      expect(refused.results[0]).toMatchObject({ status: "FAIL", reasonCode: "SECURE_MCP_RUNTIME_TARGET_CHANGED" });
      expect(calls.filter((call) => call.args[1] === "stop")).toHaveLength(0);
      mismatch = false;
    } finally {
      await bridge.close();
      const disconnected = await disconnectAll({ stateDir, runner, timeoutMs: 5_000 });
      expect(disconnected.ok).toBe(true);
      delete process.env.C2C_STATE_DIR;
    }
  }, 30_000);

  it("keeps the launcher fixed and separate from Taskbook lifecycle", () => {
    const wrapper = fs.readFileSync(path.join(process.cwd(), "C2C-Connect-All.cmd"), "utf8");
    expect(wrapper).toContain("connect-all");
    expect(wrapper).not.toContain("%*");
    expect(wrapper.toLowerCase()).not.toContain("taskbook");
    expect(wrapper.toLowerCase()).not.toContain("powershell");
  });
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

afterAll(() => cleanupExternalTempDirs());
