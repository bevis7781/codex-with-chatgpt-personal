import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { inventoryWorkspaceTaskRoot, nodeTaskbookIo, parseEnvelope } from "../src/taskbook/index.js";
import { cleanupExternalTempDirs, externalTempDir, writeTextFile } from "./taskbook-helpers.js";

/**
 * Phase D1/D2 — restart parsing, persistence recognition and no automatic
 * execution side effects from a Taskbook submission.
 */

let stateDir: string;
let project: string;
let bridge: Bridge;

const ORIGINAL_STATE_ENV = process.env.C2C_STATE_DIR;

beforeAll(() => {
  stateDir = externalTempDir("c2c-tb-restart-state");
  project = externalTempDir("c2c-tb-restart-project");
  writeTextFile(path.join(project, "src", "index.ts"), "export const answer = 42;\n");
  writeTextFile(path.join(project, "README.md"), "# fixture project\n");
  process.env.C2C_STATE_DIR = stateDir;
});

afterAll(() => {
  if (ORIGINAL_STATE_ENV === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = ORIGINAL_STATE_ENV;
  cleanupExternalTempDirs();
});

function taskRoot(bridge: Bridge): string {
  return path.join(stateDir, "tasks", bridge.workspace.id);
}

function projectFingerprint(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`D:${childRel}\n`);
        walk(absolute, childRel);
      } else if (entry.isFile()) {
        hash.update(`F:${childRel}:`);
        hash.update(fs.readFileSync(absolute));
        hash.update("\n");
      }
    }
  };
  walk(root, "");
  return hash.digest("hex");
}

async function callTool(base: string, token: string, args: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_taskbook", arguments: args } }),
  });
  const json = (await response.json()) as {
    result?: { structuredContent?: Record<string, unknown>; isError?: boolean; content?: { text?: string }[] };
  };
  if (json.result?.isError) throw new Error(json.result.content?.[0]?.text ?? "submit failed");
  return json.result?.structuredContent ?? {};
}

async function listToolNames(base: string, token: string): Promise<string[]> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const json = (await response.json()) as { result?: { tools?: { name: string }[] } };
  return (json.result?.tools ?? []).map((tool) => tool.name);
}

describe("D1 restart / persistence parsing", () => {
  it("recognizes persisted state after a restart and keeps no remote read surface", async () => {
    bridge = await startBridge({
      workspaceRoot: project,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(stateDir, "auth-restart.json"),
    });
    const token = bridge.authStore.issueTokens({ clientId: "restart", scopes: ["taskbook.submit"] }).accessToken;
    const base = bridge.localBaseUrl();

    const projectBefore = projectFingerprint(project);
    const first = await callTool(base, token, { title: "restart-1", body: "body one" });
    const firstFile = path.join(taskRoot(bridge), `${String(first.taskId)}.json`);
    expect(fs.existsSync(firstFile)).toBe(true);
    const firstEnvelope = parseEnvelope(fs.readFileSync(firstFile, "utf8"));
    expect(firstEnvelope.title).toBe("restart-1");
    expect(firstEnvelope.version).toBe(1);

    // Close the bridge (and with it the store) — the state must survive on disk.
    await bridge.close();

    // Reconstruct on the same state root and workspace.
    bridge = await startBridge({
      workspaceRoot: project,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(stateDir, "auth-restart.json"),
    });
    const base2 = bridge.localBaseUrl();
    const token2 = bridge.authStore.issueTokens({ clientId: "restart-2", scopes: ["taskbook.submit"] }).accessToken;

    const inventoryAfterRestart = inventoryWorkspaceTaskRoot(nodeTaskbookIo, taskRoot(bridge));
    expect(inventoryAfterRestart.pending).toBe(1);
    expect(inventoryAfterRestart.entries).toBe(1);
    expect(inventoryAfterRestart.storageBytes).toBe(fs.statSync(firstFile).size);

    // A later submission observes the prior pending/storage correctly.
    const second = await callTool(base2, token2, { title: "restart-2", body: "body two" });
    const secondFile = path.join(taskRoot(bridge), `${String(second.taskId)}.json`);
    const inventoryFinal = inventoryWorkspaceTaskRoot(nodeTaskbookIo, taskRoot(bridge));
    expect(inventoryFinal.pending).toBe(2);
    expect(inventoryFinal.entries).toBe(2);
    expect(inventoryFinal.storageBytes).toBe(fs.statSync(firstFile).size + fs.statSync(secondFile).size);

    // No remote Taskbook read surface was added.
    const names = await listToolNames(base2, token2);
    for (const forbidden of ["read_taskbook", "list_taskbooks", "get_taskbook", "delete_taskbook", "claim_taskbook"]) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toContain("submit_taskbook");
    expect(names.length).toBe(10);

    // D2: the submission never modified the project workspace.
    expect(projectFingerprint(project)).toBe(projectBefore);
  }, 60_000);
});

describe("D2 no automatic execution", () => {
  it("creates no execution record, lifecycle field or child process", async () => {
    const executionsDir = path.join(stateDir, "executions");
    const before = fs.existsSync(executionsDir) ? fs.readdirSync(executionsDir) : [];
    const token = bridge.authStore.issueTokens({ clientId: "no-exec", scopes: ["taskbook.submit"] }).accessToken;
    const receipt = await callTool(bridge.localBaseUrl(), token, { title: "no-exec", body: "body" });

    const after = fs.existsSync(executionsDir) ? fs.readdirSync(executionsDir) : [];
    expect(after).toEqual(before);

    const envelope = JSON.parse(
      fs.readFileSync(path.join(taskRoot(bridge), `${String(receipt.taskId)}.json`), "utf8")
    ) as Record<string, unknown>;
    // No lifecycle/claim/status field is persisted; status is receipt-only.
    expect(Object.keys(envelope).sort()).toEqual(["body", "createdAt", "title", "version"]);
    expect(Object.prototype.hasOwnProperty.call(envelope, "status")).toBe(false);
  });

  it("keeps the production Taskbook modules free of process spawning", () => {
    const dir = path.join(process.cwd(), "src", "taskbook");
    const sources = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ name, source: fs.readFileSync(path.join(dir, name), "utf8") }));
    expect(sources.length).toBeGreaterThan(0);
    for (const { name, source } of sources) {
      for (const forbidden of ["child_process", "spawnSync", "spawn(", "execSync", "execFileSync", "fork("]) {
        expect(source, `${name} must not use ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
