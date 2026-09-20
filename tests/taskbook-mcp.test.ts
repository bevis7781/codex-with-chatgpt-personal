import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { TaskbookError, nodeTaskbookIo, submitTaskbook } from "../src/taskbook/index.js";
import { makeAuditCapture } from "./taskbook-audit-capture.js";
import { cleanupExternalTempDirs, externalTempDir, writeTextFile } from "./taskbook-helpers.js";

/**
 * Phase C — remote submit_taskbook surface over real bridge + OAuth + Streamable
 * HTTP, plus receipt, authorization, sanitized errors, audit and isolation.
 */

const REDIRECT_URI = "http://127.0.0.1:19999/callback";
const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";

let stateDir: string;
let projectA: string;
let projectB: string;
let bridgeA: Bridge;
let bridgeB: Bridge;
let baseA: string;
let baseB: string;
let audit: ReturnType<typeof makeAuditCapture>;

const ORIGINAL_STATE_ENV = process.env.C2C_STATE_DIR;

beforeAll(async () => {
  stateDir = externalTempDir("c2c-tb-mcp-state");
  projectA = externalTempDir("c2c-tb-mcp-project-a");
  projectB = externalTempDir("c2c-tb-mcp-project-b");
  writeTextFile(path.join(projectA, "a.txt"), "project A content\n");
  writeTextFile(path.join(projectB, "b.txt"), "project B content\n");
  // Taskbook state must live outside the repository for R2-safe evidence.
  process.env.C2C_STATE_DIR = stateDir;

  audit = makeAuditCapture();
  bridgeA = await startBridge({
    workspaceRoot: projectA,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(stateDir, "auth-a.json"),
    logger: audit.logger,
  });
  bridgeB = await startBridge({
    workspaceRoot: projectB,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(stateDir, "auth-b.json"),
    logger: audit.logger,
  });
  baseA = bridgeA.localBaseUrl();
  baseB = bridgeB.localBaseUrl();
});

afterAll(async () => {
  await bridgeA.close();
  await bridgeB.close();
  if (ORIGINAL_STATE_ENV === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = ORIGINAL_STATE_ENV;
  cleanupExternalTempDirs();
});

function taskRoot(bridge: Bridge): string {
  return path.join(stateDir, "tasks", bridge.workspace.id);
}

function readTaskFiles(bridge: Bridge): string[] {
  const root = taskRoot(bridge);
  return fs.existsSync(root) ? fs.readdirSync(root) : [];
}

async function registerClient(base: string): Promise<string> {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Taskbook-Test", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function authorizeWithScope(
  base: string,
  bridge: Bridge,
  clientId: string,
  scope: string
): Promise<{ code: string | null; verifier: string }> {
  const { createHash, randomBytes } = await import("node:crypto");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const pairing = bridge.pairing.create();

  const url = new URL(`${base}/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", scope);

  const pageResponse = await fetch(url, { redirect: "manual" });
  const html = await pageResponse.text();
  expect(pageResponse.status).toBe(200);
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  expect(requestId).toBeTruthy();

  const post = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId as string, pairing_code: pairing.code }),
    redirect: "manual",
  });
  const location = post.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  return { code, verifier };
}

async function exchangeToken(
  base: string,
  clientId: string,
  code: string,
  verifier: string
): Promise<Record<string, string>> {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, string>;
}

async function submitViaFlow(base: string, bridge: Bridge, scope: string): Promise<Record<string, string>> {
  const clientId = await registerClient(base);
  const { code, verifier } = await authorizeWithScope(base, bridge, clientId, scope);
  expect(code).toBeTruthy();
  return exchangeToken(base, clientId, code as string, verifier);
}

interface McpCallResult {
  status: number;
  json: {
    result?: { structuredContent?: Record<string, unknown>; content?: { text?: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  text: string;
}

async function callTool(token: string | null, name: string, args: unknown, base = baseA): Promise<McpCallResult> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await response.text();
  let json: McpCallResult["json"] = {};
  try {
    json = JSON.parse(text) as McpCallResult["json"];
  } catch {
    /* non-JSON (transport-level) response */
  }
  return { status: response.status, json, text };
}

async function listTools(token: string | null, base = baseA): Promise<string[]> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const json = (await response.json()) as { result?: { tools?: { name: string; annotations?: Record<string, unknown> }[] } };
  return (json.result?.tools ?? []).map((tool) => tool.name);
}

function submitOnlyToken(bridge: Bridge): string {
  return bridge.authStore.issueTokens({ clientId: "submit-only", scopes: ["taskbook.submit"] }).accessToken;
}

function readOnlyToken(bridge: Bridge): string {
  return bridge.authStore.issueTokens({ clientId: "read-only", scopes: ["workspace.read"] }).accessToken;
}

describe("C1 tool surface", () => {
  it("exposes exactly ten tools: the original nine plus one mutation tool", async () => {
    const token = readOnlyToken(bridgeA);
    const names = (await listTools(token)).sort();
    expect(names).toEqual(
      [
        "execution_output",
        "execution_summary",
        "git_diff",
        "git_status",
        "list_directory",
        "read_file",
        "search_workspace",
        "submit_taskbook",
        "test_status",
        "workspace_info",
      ].sort()
    );
    expect(names.length).toBe(10);
    expect(names.filter((name) => name === "submit_taskbook")).toHaveLength(1);
    for (const forbidden of ["read_taskbook", "list_taskbooks", "delete_taskbook", "get_taskbook", "claim_taskbook"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("C7 real loopback submission", () => {
  it("submits through explicit taskbook.submit consent and matches receipt/file/envelope/hash", async () => {
    const token = await submitViaFlow(baseA, bridgeA, "taskbook.submit");
    const scope = String(token.scope ?? "");
    expect(scope.split(/\s+/).filter(Boolean)).toEqual(["taskbook.submit"]);

    const title = "Loopback title";
    const body = "# Loopback body\n\npath-like C:\\\\x\\\\y.json\njson-like {\"version\":2}";
    const before = readTaskFiles(bridgeA);

    const call = await callTool(token.access_token, "submit_taskbook", { title, body });
    expect(call.status).toBe(200);
    expect(call.json.result?.isError).toBeFalsy();
    const receipt = call.json.result?.structuredContent as Record<string, unknown>;
    expect(Object.keys(receipt).sort()).toEqual(["bodySha256", "createdAt", "status", "taskId"]);
    expect(receipt.status).toBe("pending");

    const after = readTaskFiles(bridgeA).filter((name) => !before.includes(name));
    expect(after).toEqual([`${String(receipt.taskId)}.json`]);

    const file = path.join(taskRoot(bridgeA), `${String(receipt.taskId)}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const envelope = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(envelope.version).toBe(1);
    expect(envelope.createdAt).toBe(receipt.createdAt);
    expect(envelope.title).toBe(title);
    expect(envelope.body).toBe(body);
    const { createHash } = await import("node:crypto");
    expect(receipt.bodySha256).toBe(createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex"));

    // Storage lives outside both project workspaces.
    expect(file.startsWith(projectA)).toBe(false);
    expect(fs.readdirSync(projectA)).toEqual(["a.txt"]);
  });

  it("keeps the response free of body/title/path echoes", async () => {
    const token = submitOnlyToken(bridgeA);
    const body = "UNIQUE-BODY-MARKER-9f3a";
    const call = await callTool(token, "submit_taskbook", { title: "UNIQUE-TITLE-MARKER", body });
    const payload = JSON.stringify(call.json);
    expect(payload).not.toContain("UNIQUE-BODY-MARKER-9f3a");
    expect(payload).not.toContain("UNIQUE-TITLE-MARKER");
    expect(payload).not.toContain(stateDir);
    expect(payload).not.toContain(projectA);
  });
});

describe("C3 authorization", () => {
  it("rejects a read-only token with FORBIDDEN", async () => {
    const call = await callTool(readOnlyToken(bridgeA), "submit_taskbook", { title: "t", body: "b" });
    expect(call.json.result?.isError).toBe(true);
    expect(call.text).toContain("FORBIDDEN");
    expect(call.text).not.toContain(stateDir);
  });

  it("accepts a submit-only token and keeps read tools denied", async () => {
    const token = submitOnlyToken(bridgeA);
    const submitted = await callTool(token, "submit_taskbook", { title: "submit-only", body: "b" });
    expect(submitted.json.result?.isError).toBeFalsy();

    const read = await callTool(token, "read_file", { path: "a.txt" });
    expect(read.json.result?.isError).toBe(true);
    expect(read.text).toContain("INSUFFICIENT_SCOPE");
    expect(read.text).not.toContain("project A content");
  });

  it("keeps the existing HTTP auth behavior: no token -> 401, foreign workspace -> 403", async () => {
    const anonymous = await callTool(null, "submit_taskbook", { title: "t", body: "b" });
    expect(anonymous.status).toBe(401);

    const foreign = bridgeA.authStore.issueTokens({
      clientId: "foreign",
      scopes: ["taskbook.submit"],
      workspaceId: "ffffffffffff",
    }).accessToken;
    const rejected = await callTool(foreign, "submit_taskbook", { title: "t", body: "b" });
    expect(rejected.status).toBe(403);
  });
});

describe("C2 caller metadata cannot steer state", () => {
  it("ignores extra caller fields and keeps destination/identity local", async () => {
    const token = submitOnlyToken(bridgeA);
    const beforeA = readTaskFiles(bridgeA);
    const beforeB = readTaskFiles(bridgeB);

    const call = await callTool(token, "submit_taskbook", {
      title: "steer attempt",
      body: "steer body",
      workspace: bridgeB.workspace.id,
      path: path.join(projectB, "evil.json"),
      filename: "evil.json",
      taskId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      status: "claimed",
      command: "rm -rf /",
    });
    expect(call.json.result?.isError).toBeFalsy();
    const receipt = call.json.result?.structuredContent as Record<string, unknown>;

    expect(receipt.taskId).not.toBe("ffffffff-ffff-4fff-8fff-ffffffffffff");
    expect(receipt.status).toBe("pending");
    const newInA = readTaskFiles(bridgeA).filter((name) => !beforeA.includes(name));
    expect(newInA).toEqual([`${String(receipt.taskId)}.json`]);
    expect(readTaskFiles(bridgeB)).toEqual(beforeB);
    expect(fs.existsSync(path.join(projectB, "evil.json"))).toBe(false);
    expect(fs.readdirSync(projectA)).toEqual(["a.txt"]);
  });
});

describe("C5 sanitized errors", () => {
  it("maps business failures to short sanitized codes without paths or exception text", async () => {
    const token = submitOnlyToken(bridgeA);
    const oversized = await callTool(token, "submit_taskbook", { title: "t", body: "x".repeat(262145) });
    expect(oversized.json.result?.isError).toBe(true);
    expect(oversized.text).toContain("LIMIT_EXCEEDED");
    expect(oversized.text).not.toContain(stateDir);
    expect(oversized.text).not.toContain("ENOENT");
    expect(oversized.text).not.toContain("at Object");

    // A hostile topology failure (fake secret in the target path) must not leak.
    const secretTarget = path.join(externalTempDir("c2c-tb-secret"), "SECRET-TOKEN-abc123.txt");
    fs.symlinkSync(secretTarget, path.join(taskRoot(bridgeA), "hostile-link"), "file");
    const hostile = await callTool(token, "submit_taskbook", { title: "t", body: "b" });
    expect(hostile.json.result?.isError).toBe(true);
    expect(hostile.text).toContain("STORAGE_ERROR");
    expect(hostile.text).not.toContain("SECRET-TOKEN-abc123");
    expect(hostile.text).not.toContain(stateDir);
    fs.unlinkSync(path.join(taskRoot(bridgeA), "hostile-link"));
  });
});

describe("C6 audit", () => {
  it("emits only allowlisted metadata and never caller text", async () => {
    audit.reset();
    const token = submitOnlyToken(bridgeA);
    const title = "AUDIT-TITLE-PLAINTEXT";
    const body = "AUDIT-BODY-PLAINTEXT c2c_at_fake_token_value";
    const call = await callTool(token, "submit_taskbook", { title, body });
    expect(call.json.result?.isError).toBeFalsy();

    const success = audit.events.find((event) => event.payload.result === "success");
    expect(success).toBeTruthy();
    const payload = success?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual(
      ["bodyBytes", "bodySha256", "code", "event", "result", "taskId", "timestamp", "titleBytes", "workspaceId"].sort()
    );
    expect(payload.code).toBe("OK");
    expect(payload.workspaceId).toBe(bridgeA.workspace.id);
    expect(payload.titleBytes).toBe(Buffer.byteLength(title, "utf8"));
    expect(payload.bodyBytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(payload.bodySha256).toMatch(/^[0-9a-f]{64}$/);

    const serialized = JSON.stringify(audit.events.map((event) => event.payload));
    expect(serialized).not.toContain(title);
    expect(serialized).not.toContain("AUDIT-BODY-PLAINTEXT");
    expect(serialized).not.toContain("c2c_at_fake_token_value");
    expect(serialized).not.toContain(stateDir);
    expect(serialized).not.toContain(projectA);
  });

  it("does not fabricate a task id for an authorization failure", async () => {
    audit.reset();
    await callTool(readOnlyToken(bridgeA), "submit_taskbook", { title: "t", body: "b" });
    const failure = audit.events.find((event) => event.payload.code === "FORBIDDEN");
    expect(failure).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(failure?.payload ?? {}, "taskId")).toBe(false);
  });

  it("does not reverse or duplicate a success when logging throws", async () => {
    const before = readTaskFiles(bridgeA).length;
    const token = submitOnlyToken(bridgeA);
    const previous = audit.logger.info;
    audit.logger.info = () => {
      throw new Error("logger exploded");
    };
    let call: McpCallResult;
    try {
      call = await callTool(token, "submit_taskbook", { title: "logger-fail", body: "b" });
    } finally {
      audit.logger.info = previous;
    }
    expect(call.json.result?.isError).toBeFalsy();
    expect(readTaskFiles(bridgeA).length).toBe(before + 1);
  });
});

describe("C8 workspace isolation", () => {
  it("keeps each submission under its own authenticated workspace task root", async () => {
    const beforeA = readTaskFiles(bridgeA);
    const beforeB = readTaskFiles(bridgeB);

    const tokenB = bridgeB.authStore.issueTokens({ clientId: "submit-b", scopes: ["taskbook.submit"] }).accessToken;
    const callB = await callTool(tokenB, "submit_taskbook", { title: "b-only", body: "b" }, baseB);
    expect(callB.json.result?.isError).toBeFalsy();
    const receiptB = callB.json.result?.structuredContent as Record<string, unknown>;

    expect(readTaskFiles(bridgeB).filter((name) => !beforeB.includes(name))).toEqual([`${String(receiptB.taskId)}.json`]);
    expect(readTaskFiles(bridgeA)).toEqual(beforeA);
    expect(bridgeA.workspace.id).not.toBe(bridgeB.workspace.id);

    // A's token is not accepted against B (separate auth stores -> unknown token).
    const tokenA = bridgeA.authStore.issueTokens({ clientId: "submit-a", scopes: ["taskbook.submit"] }).accessToken;
    const afterB = readTaskFiles(bridgeB);
    const cross = await callTool(tokenA, "submit_taskbook", { title: "cross", body: "b" }, baseB);
    expect([401, 403]).toContain(cross.status);
    expect(readTaskFiles(bridgeB)).toEqual(afterB);

    // A token bound to another workspace is rejected by the existing workspace binding.
    const boundToA = bridgeB.authStore.issueTokens({
      clientId: "bound-to-a",
      scopes: ["taskbook.submit"],
      workspaceId: bridgeA.workspace.id,
    }).accessToken;
    const bound = await callTool(boundToA, "submit_taskbook", { title: "bound", body: "b" }, baseB);
    expect(bound.status).toBe(403);
    expect(readTaskFiles(bridgeB)).toEqual(afterB);

    // Taskbook storage touches neither project workspace.
    expect(fs.readdirSync(projectA)).toEqual(["a.txt"]);
    expect(fs.readdirSync(projectB)).toEqual(["b.txt"]);
  });
});

/**
 * Repair B — every submission attempt produces exactly one Q6 audit result.
 *
 * Pre-repair, `prepareSubmission` threw before the store's audit path, so
 * invalid types and over-limit title/body returned a business failure with no
 * Taskbook audit at all. These regressions run against the store directly and
 * through the real MCP surface.
 */

const ALLOWED_AUDIT_KEYS = [
  "event",
  "result",
  "code",
  "workspaceId",
  "timestamp",
  "taskId",
  "titleBytes",
  "bodyBytes",
  "bodySha256",
];

describe("C6b pre-admission audit — exactly one result per attempt", () => {
  let auditState: string;

  beforeAll(() => {
    auditState = externalTempDir("c2c-tb-audit-state");
  });

  const MARKER_TITLE = "AUDIT-MARKER-TITLE-PLAINTEXT";
  const MARKER_BODY = "AUDIT-MARKER-BODY-PLAINTEXT c2c_at_FAKE_TOKEN_123";

  function submit(input: { title: unknown; body: unknown }, extra: Record<string, unknown> = {}) {
    return submitTaskbook(input, {
      workspaceId: bridgeA.workspace.id,
      projectRoot: projectA,
      stateDir: auditState,
      logger: audit.logger,
      ...extra,
    });
  }

  /** Only the Q6 Taskbook events; the bridge logger may emit unrelated lines. */
  function taskbookAudits(): { payload: Record<string, unknown> }[] {
    return audit.events.filter((event) => event.payload.event === "taskbook.submit");
  }

  function catchTaskbookError(fn: () => unknown): TaskbookError {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(TaskbookError);
      return error as TaskbookError;
    }
    throw new Error("expected a TaskbookError");
  }

  /** No audit payload may ever carry caller plaintext, secrets or local paths. */
  function expectAuditOutputSafe(): void {
    const serialized = JSON.stringify(audit.events.map((event) => event.payload));
    for (const forbidden of [
      MARKER_TITLE,
      "AUDIT-MARKER-BODY-PLAINTEXT",
      "c2c_at_FAKE_TOKEN_123",
      auditState,
      projectA,
      stateDir,
      "AUDIT-MARKER",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // No envelope-shaped keys and no raw persisted document.
    expect(serialized).not.toContain("createdAt");
    expect(serialized).not.toContain("envelope");
  }

  /** Every audit payload stays inside the Q6 allowlist. */
  function expectAllowlistOnly(): void {
    for (const event of audit.events) {
      for (const key of Object.keys(event.payload)) {
        expect(ALLOWED_AUDIT_KEYS).toContain(key);
      }
    }
  }

  it("records exactly one INVALID_INPUT audit for a non-string title", () => {
    audit.reset();
    const error = catchTaskbookError(() => submit({ title: 123, body: MARKER_BODY }));
    expect(error.code).toBe("INVALID_INPUT");

    const events = taskbookAudits();
    expect(events).toHaveLength(1);
    const payload = events[0].payload;
    expect(payload.result).toBe("failure");
    expect(payload.code).toBe("INVALID_INPUT");
    expect(payload.workspaceId).toBe(bridgeA.workspace.id);
    expect(typeof payload.timestamp).toBe("string");
    expect(Object.prototype.hasOwnProperty.call(payload, "taskId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, "titleBytes")).toBe(false);
    expect(payload.bodyBytes).toBe(Buffer.byteLength(MARKER_BODY, "utf8"));
    expectAuditOutputSafe();
    expectAllowlistOnly();
  });

  it("records exactly one INVALID_INPUT audit for a non-string body", () => {
    audit.reset();
    const error = catchTaskbookError(() => submit({ title: MARKER_TITLE, body: { nested: "object" } }));
    expect(error.code).toBe("INVALID_INPUT");

    const events = taskbookAudits();
    expect(events).toHaveLength(1);
    const payload = events[0].payload;
    expect(payload.result).toBe("failure");
    expect(payload.code).toBe("INVALID_INPUT");
    expect(payload.titleBytes).toBe(Buffer.byteLength(MARKER_TITLE, "utf8"));
    expect(Object.prototype.hasOwnProperty.call(payload, "bodyBytes")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, "bodySha256")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, "taskId")).toBe(false);
    expectAuditOutputSafe();
    expectAllowlistOnly();
  });

  it("records exactly one LIMIT_EXCEEDED audit for a 513-byte title", () => {
    audit.reset();
    const error = catchTaskbookError(() => submit({ title: "t".repeat(513), body: "b" }));
    expect(error.code).toBe("LIMIT_EXCEEDED");

    const events = taskbookAudits();
    expect(events).toHaveLength(1);
    const payload = events[0].payload;
    expect(payload.result).toBe("failure");
    expect(payload.code).toBe("LIMIT_EXCEEDED");
    expect(payload.titleBytes).toBe(513);
    expect(Object.prototype.hasOwnProperty.call(payload, "taskId")).toBe(false);
    expectAuditOutputSafe();
    expectAllowlistOnly();
  });

  it("records exactly one LIMIT_EXCEEDED audit for a 262145-byte body", () => {
    audit.reset();
    const error = catchTaskbookError(() => submit({ title: "t", body: "x".repeat(262145) }));
    expect(error.code).toBe("LIMIT_EXCEEDED");

    const events = taskbookAudits();
    expect(events).toHaveLength(1);
    const payload = events[0].payload;
    expect(payload.result).toBe("failure");
    expect(payload.code).toBe("LIMIT_EXCEEDED");
    expect(payload.bodyBytes).toBe(262145);
    expect(Object.prototype.hasOwnProperty.call(payload, "taskId")).toBe(false);
    expectAuditOutputSafe();
    expectAllowlistOnly();
  });

  it("records exactly one failure audit for a filesystem admission failure", () => {
    audit.reset();
    const io = {
      ...nodeTaskbookIo,
      readDirBounded: () => {
        throw Object.assign(new Error("injected enumeration failure"), { code: "EIO" });
      },
    };
    const error = catchTaskbookError(() => submit({ title: "fs-fail", body: "fs-fail-body" }, { io }));
    expect(error.code).toBe("STORAGE_ERROR");

    const events = taskbookAudits();
    expect(events).toHaveLength(1);
    const payload = events[0].payload;
    expect(payload.result).toBe("failure");
    expect(payload.code).toBe("STORAGE_ERROR");
    expect(payload.titleBytes).toBe(Buffer.byteLength("fs-fail", "utf8"));
    expect(payload.bodyBytes).toBe(Buffer.byteLength("fs-fail-body", "utf8"));
    expect(payload.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.prototype.hasOwnProperty.call(payload, "taskId")).toBe(false);
    expectAuditOutputSafe();
    expectAllowlistOnly();
  });

  it("records exactly one success audit for a successful submission", () => {
    audit.reset();
    const receipt = submit({ title: MARKER_TITLE, body: MARKER_BODY });

    const events = taskbookAudits();
    expect(events).toHaveLength(1);
    const payload = events[0].payload;
    expect(payload.result).toBe("success");
    expect(payload.code).toBe("OK");
    expect(payload.taskId).toBe(receipt.taskId);
    expect(payload.titleBytes).toBe(Buffer.byteLength(MARKER_TITLE, "utf8"));
    expect(payload.bodyBytes).toBe(Buffer.byteLength(MARKER_BODY, "utf8"));
    expect(payload.bodySha256).toBe(receipt.bodySha256);
    expectAuditOutputSafe();
    expectAllowlistOnly();
  });

  it("keeps the original pre-admission failure when the audit logger throws", () => {
    audit.reset();
    let calls = 0;
    const previous = audit.logger.info;
    audit.logger.info = () => {
      calls += 1;
      throw new Error("logger exploded");
    };
    const error = (() => {
      try {
        return catchTaskbookError(() => submit({ title: 123, body: "b" }));
      } finally {
        audit.logger.info = previous;
      }
    })();

    expect(error.code).toBe("INVALID_INPUT");
    // Exactly one audit attempt: the failure is never re-emitted or duplicated.
    expect(calls).toBe(1);
  });

  it("keeps a success and does not duplicate the audit when the logger throws after persistence", () => {
    audit.reset();
    let calls = 0;
    const previous = audit.logger.info;
    audit.logger.info = () => {
      calls += 1;
      throw new Error("logger exploded");
    };
    const receipt = (() => {
      try {
        return submit({ title: MARKER_TITLE, body: MARKER_BODY });
      } finally {
        audit.logger.info = previous;
      }
    })();

    expect(receipt.status).toBe("pending");
    expect(calls).toBe(1);
    const file = path.join(auditState, "tasks", bridgeA.workspace.id, `${receipt.taskId}.json`);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("does not duplicate the audit when the MCP layer surfaces a store failure", async () => {
    audit.reset();
    const call = await callTool(submitOnlyToken(bridgeA), "submit_taskbook", {
      title: "mcp-limits",
      body: "x".repeat(262145),
    });
    expect(call.json.result?.isError).toBe(true);
    expect(call.text).toContain("LIMIT_EXCEEDED");

    const events = taskbookAudits();
    expect(events).toHaveLength(1);
    expect(events[0].payload.result).toBe("failure");
    expect(events[0].payload.code).toBe("LIMIT_EXCEEDED");
    expect(Object.prototype.hasOwnProperty.call(events[0].payload, "taskId")).toBe(false);
    expectAuditOutputSafe();
    expectAllowlistOnly();
  });
});
