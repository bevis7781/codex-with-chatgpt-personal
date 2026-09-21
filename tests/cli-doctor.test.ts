import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeRuntimeState } from "../src/bridge/runtime.js";
import { isCloudflareHealthProbeNetworkError } from "../src/tunnel/health.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(repoRoot, "src", "cli", "index.ts");
const previousStateDir = process.env.C2C_STATE_DIR;
const testDirs: string[] = [];

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", ...args], {
      cwd: repoRoot,
      env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

afterEach(() => {
  while (testDirs.length) cleanup(testDirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("Named public health probe classification", () => {
  it.each(["EACCES", "EPERM", "ENOTFOUND", "EAI_AGAIN"])(
    "recognizes fetch TypeError cause code %s",
    (code) => {
      const cause = Object.assign(new Error(`network failure: ${code}`), { code });
      expect(isCloudflareHealthProbeNetworkError(new TypeError("fetch failed", { cause }))).toBe(true);
    }
  );

  it.each([
    new Error("HTTP 500"),
    new Error("HTTP 401"),
    new Error("unexpected health probe failure"),
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  ])("does not classify non-permission or unknown errors: %s", (error) => {
    expect(isCloudflareHealthProbeNetworkError(error)).toBe(false);
  });
});

describe("doctor Named health probe control flow", () => {
  it("reports the existing Cloudflare code without starting or repairing a running Named tunnel", async () => {
    const stateDir = isolateStateDir();
    testDirs.push(stateDir);
    const workspaceRoot = makeTmpDir("doctor-health-workspace");
    const codexHome = makeTmpDir("doctor-health-codex-home");
    const preloadDir = makeTmpDir("doctor-health-preload");
    testDirs.push(workspaceRoot, codexHome, preloadDir);
    write(workspaceRoot, "project.txt", "doctor health fixture\n");
    const workspace = new Workspace(workspaceRoot);
    const requests: string[] = [];
    const publicUrl = "https://named-health.test";
    let port = 0;

    const server = http.createServer((request, response) => {
      const route = request.url ?? "/";
      requests.push(`${request.method ?? "GET"} ${route}`);
      if (route === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok" }));
        return;
      }
      if (route === "/mcp") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (route === "/admin/info") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            workspaceRoot: workspace.root,
            port,
            publicUrl,
            tunnel: { running: true, url: publicUrl, provider: "cloudflare-named" },
            tokenCount: 1,
            pairingActive: false,
            pid: process.pid,
            startedAt: new Date().toISOString(),
          })
        );
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not bind to a TCP port");
    port = address.port;

    writeTunnelState({
      workspaceId: workspace.id,
      preference: "named",
      provider: "cloudflare-named",
      tunnelName: "c2c-doctor-health",
      tunnelId: "11111111-2222-4333-8444-555555555555",
      hostname: "named-health.test",
    });
    writeRuntimeState({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      port,
      adminToken: "doctor-test-token",
      publicUrl,
      startedAt: new Date().toISOString(),
    });

    const preload = path.join(preloadDir, "fetch-failure.mjs");
    fs.writeFileSync(
      preload,
      `const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url === ${JSON.stringify(`${publicUrl}/health`)}) {
    const cause = Object.assign(new Error("getaddrinfo EACCES named-health.test"), { code: "EACCES" });
    throw new TypeError("fetch failed", { cause });
  }
  return originalFetch(input, init);
};
`
    );
    try {
      const result = await runCli(
        [
          "--import",
          pathToFileURL(preload).href,
          cliEntry,
          "doctor",
          "--workspace",
          workspaceRoot,
          "--json",
        ],
        { ...process.env, CODEX_HOME: codexHome, C2C_STATE_DIR: stateDir }
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).not.toBe("");
      const payload = JSON.parse(result.stdout) as {
        report: Record<string, { ok: boolean; code?: string; detail?: string }>;
        namedRepair: { needed: boolean };
        chatgptRepair: { needed: boolean };
      };
      expect(payload.report.tunnel).toMatchObject({
        ok: false,
        code: "CLOUDFLARE_NETWORK_BLOCKED",
        detail: "CLOUDFLARE_NETWORK_BLOCKED",
      });
      expect(payload.namedRepair).toEqual({ needed: false });
      expect(payload.chatgptRepair.needed).toBe(false);
      expect(requests.some((request) => request.endsWith("/admin/tunnel/start"))).toBe(false);
      expect(requests.some((request) => request.endsWith("/admin/pairing"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
