import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { AuthStore, DEFAULT_SCOPES, SUPPORTED_SCOPES, filterScopes } from "../src/auth/store.js";
import { makeTmpDir, cleanup, write, isolateStateDir, pkceVerifierAndChallenge } from "./helpers.js";

let root: string;
let bridge: Bridge;
let base: string;
// The pairing manager rate-limits verifications per client IP (10 per 60s). The
// scope-contract suite drives additional authorization flows, so it runs against
// its own bridge to get a fresh pairing budget without weakening any assertion.
let scopeBridge: Bridge;
let scopeBase: string;

const REDIRECT_URI = "http://127.0.0.1:19999/callback";

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("oauth-ws");
  write(root, "hello.txt", "hello oauth\n");
  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
  });
  base = bridge.localBaseUrl();
  scopeBridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth-scope"), "store.json"),
  });
  scopeBase = scopeBridge.localBaseUrl();
});

afterAll(async () => {
  await scopeBridge.close();
  await bridge.close();
  cleanup(root);
});

async function registerClient(): Promise<string> {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT-Test", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

async function authorizeWithPairing(
  clientId: string,
  challenge: string,
  pairingCode: string,
  state = "st-123"
): Promise<{ code: string | null; location: string | null; page?: string; status?: number }> {
  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "workspace.read workspace.search git.read execution.read offline_access");

  const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const html = await pageResponse.text();
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  if (!requestId) return { code: null, location: null, page: html, status: pageResponse.status };

  const postResponse = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode }),
    redirect: "manual",
  });
  if (postResponse.status !== 302) {
    return { code: null, location: null, page: await postResponse.text(), status: postResponse.status };
  }
  const location = postResponse.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  return { code, location, status: postResponse.status };
}

async function exchangeToken(
  clientId: string,
  code: string,
  verifier: string
): Promise<{ status: number; body: Record<string, string> }> {
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
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

function scopesOf(body: Record<string, string>): string[] {
  return (body.scope ?? "").split(/\s+/).filter(Boolean);
}

interface ScopeFlowResult {
  clientId: string;
  code: string | null;
  status: number;
  body: Record<string, string>;
  location: string | null;
}

async function scopeRegisterClient(): Promise<string> {
  const response = await fetch(`${scopeBase}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Scope-Test", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

async function scopeExchangeToken(
  clientId: string,
  code: string,
  verifier: string
): Promise<{ status: number; body: Record<string, string> }> {
  const response = await fetch(`${scopeBase}/oauth/token`, {
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
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

/** Drives register -> authorize(+pairing) -> token exchange for a given scope request. */
async function tokenForScope(scope: string | undefined): Promise<ScopeFlowResult> {
  const clientId = await scopeRegisterClient();
  const { verifier, challenge } = pkceVerifierAndChallenge();
  const pairing = scopeBridge.pairing.create();
  const authorized = await authorizeWithScope(clientId, challenge, scope, pairing.code);
  if (!authorized.code) {
    return { clientId, code: null, status: authorized.status, body: {}, location: authorized.location };
  }
  const token = await scopeExchangeToken(clientId, authorized.code, verifier);
  return { clientId, code: authorized.code, status: token.status, body: token.body, location: authorized.location };
}

async function authorizeWithScope(
  clientId: string,
  challenge: string,
  scope: string | undefined,
  pairingCode: string
): Promise<{ code: string | null; location: string | null; page: string; status: number }> {
  const authorizeUrl = new URL(`${scopeBase}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (scope !== undefined) authorizeUrl.searchParams.set("scope", scope);

  const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const html = await pageResponse.text();
  if (pageResponse.status !== 200) {
    return { code: null, location: pageResponse.headers.get("location"), page: html, status: pageResponse.status };
  }
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  if (!requestId) return { code: null, location: null, page: html, status: pageResponse.status };

  const postResponse = await fetch(`${scopeBase}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode }),
    redirect: "manual",
  });
  const location = postResponse.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  return { code, location, page: html, status: postResponse.status };
}

async function fetchConsentPage(scope: string | undefined): Promise<{ status: number; html: string; location: string | null }> {
  const clientId = await scopeRegisterClient();
  const { challenge } = pkceVerifierAndChallenge();
  const authorizeUrl = new URL(`${scopeBase}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (scope !== undefined) authorizeUrl.searchParams.set("scope", scope);
  const response = await fetch(authorizeUrl, { redirect: "manual" });
  return { status: response.status, html: await response.text(), location: response.headers.get("location") };
}

async function refreshWithToken(
  clientId: string,
  refreshToken: string
): Promise<{ status: number; body: Record<string, string> }> {
  const response = await fetch(`${scopeBase}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

async function connectMcpClient(token: string): Promise<Client> {
  const client = new Client({ name: "oauth-scope-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${scopeBase}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[] | undefined;
  return content?.[0]?.text ?? "";
}

describe("discovery metadata", () => {
  it("serves protected resource metadata", async () => {
    const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toContain("/mcp");
    expect(body.authorization_servers.length).toBe(1);
  });

  it("serves authorization server metadata with PKCE S256", async () => {
    const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.registration_endpoint).toContain("/oauth/register");
  });
});

describe("authorization + token flow", () => {
  it("completes the full pairing + PKCE flow and calls MCP", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code, location } = await authorizeWithPairing(clientId, challenge, pairing.code);
    expect(code).toBeTruthy();
    expect(location).toContain("state=st-123");

    const token = await exchangeToken(clientId, code!, verifier);
    expect(token.status).toBe(200);
    expect(token.body.access_token).toMatch(/^c2c_at_/);
    expect(token.body.refresh_token).toMatch(/^c2c_rt_/);
    expect(token.body.token_type).toBe("Bearer");

    // authorized MCP request
    const mcpResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.body.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(mcpResponse.status).toBe(200);
  });

  it("rejects a wrong pairing code", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    bridge.pairing.create();
    const result = await authorizeWithPairing(clientId, challenge, "AAAA-AAAA");
    expect(result.code).toBeNull();
    expect(result.status).toBe(401);
    expect(result.page).toContain("Incorrect pairing code");
  });

  it("escapes the workspace name in the pairing page", async () => {
    const xssWorkspaceRoot = makeTmpDir("oauth-html");
    write(xssWorkspaceRoot, ".c2c.json", JSON.stringify({ name: "<script>alert('xss')</script>" }));
    const xssBridge = await startBridge({
      workspaceRoot: xssWorkspaceRoot,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth-html"), "store.json"),
    });

    try {
      const xssBase = xssBridge.localBaseUrl();
      const registration = await fetch(`${xssBase}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "HTML-Test", redirect_uris: [REDIRECT_URI] }),
      });
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as { client_id: string };
      const { challenge } = pkceVerifierAndChallenge();

      const authorizeUrl = new URL(`${xssBase}/oauth/authorize`);
      authorizeUrl.searchParams.set("client_id", client.client_id);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl, { redirect: "manual" });
      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).not.toContain("<script>alert('xss')</script>");
      expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    } finally {
      await xssBridge.close();
      cleanup(xssWorkspaceRoot);
    }
  });

  it("sets browser security headers on the pairing page", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("rejects PKCE verifier mismatch", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const token = await exchangeToken(clientId, code!, "wrong-verifier-wrong-verifier-wrong");
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("invalid_grant");
  });

  it("authorization codes are one-time", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const first = await exchangeToken(clientId, code!, verifier);
    expect(first.status).toBe(200);
    const second = await exchangeToken(clientId, code!, verifier);
    expect(second.status).toBe(400);
  });

  it("requires PKCE at the authorization endpoint", async () => {
    const clientId = await registerClient();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=invalid_request");
  });

  it("rejects registration with non-https redirect uris", async () => {
    const response = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
    });
    expect(response.status).toBe(400);
  });
});

describe("token enforcement on /mcp", () => {
  const mcpCall = (token?: string): Promise<Response> =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("401 without a token, with resource metadata pointer", async () => {
    const response = await mcpCall();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("401 with an invalid token", async () => {
    const response = await mcpCall("c2c_at_totally-invalid");
    expect(response.status).toBe(401);
  });

  it("401 with an expired token", async () => {
    const expired = bridge.authStore.issueTokens({
      clientId: "test",
      scopes: ["workspace.read"],
      accessTtlMs: -1000,
    });
    const response = await mcpCall(expired.accessToken);
    expect(response.status).toBe(401);
  });

  it("403 with a token bound to another workspace", async () => {
    const foreign = bridge.authStore.issueTokens({
      clientId: "test",
      scopes: ["workspace.read"],
      workspaceId: "deadbeef0000",
    });
    const response = await mcpCall(foreign.accessToken);
    expect(response.status).toBe(403);
  });

  it("401 after revocation", async () => {
    const tokens = bridge.authStore.issueTokens({ clientId: "test", scopes: ["workspace.read"] });
    expect((await mcpCall(tokens.accessToken)).status).toBe(200);
    bridge.authStore.revokeToken(tokens.accessToken);
    expect((await mcpCall(tokens.accessToken)).status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it("rotates refresh tokens and invalidates the old one", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const initial = await exchangeToken(clientId, code!, verifier);

    const refresh = async (refreshToken: string): Promise<{ status: number; body: Record<string, string> }> => {
      const response = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, string> };
    };

    const rotated = await refresh(initial.body.refresh_token);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(initial.body.refresh_token);

    const replayed = await refresh(initial.body.refresh_token);
    expect(replayed.status).toBe(400);
  });
});

describe("scope contract: supported vs default", () => {
  it("SCOPE support matrix", () => {
    expect([...SUPPORTED_SCOPES].sort()).toEqual([...DEFAULT_SCOPES, "taskbook.submit"].sort());
    expect([...DEFAULT_SCOPES]).not.toContain("taskbook.submit");
  });

  it("advertises taskbook.submit in both discovery metadata surfaces", async () => {
    const authorizationServer = (await (
      await fetch(`${scopeBase}/.well-known/oauth-authorization-server`)
    ).json()) as { scopes_supported: string[] };
    const protectedResource = (await (
      await fetch(`${scopeBase}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as { scopes_supported: string[] };
    for (const metadata of [authorizationServer, protectedResource]) {
      expect(metadata.scopes_supported).toContain("taskbook.submit");
      for (const legacy of DEFAULT_SCOPES) expect(metadata.scopes_supported).toContain(legacy);
      expect([...metadata.scopes_supported].sort()).toEqual([...SUPPORTED_SCOPES].sort());
    }
  });

  it("omitted scope grants exactly the default five and no mutation", async () => {
    const result = await tokenForScope(undefined);
    expect(result.status).toBe(200);
    expect(scopesOf(result.body).sort()).toEqual([...DEFAULT_SCOPES].sort());
    expect(scopesOf(result.body)).not.toContain("taskbook.submit");
  });

  it("blank/whitespace scope grants exactly the default five and no mutation", async () => {
    const result = await tokenForScope("   ");
    expect(result.status).toBe(200);
    expect(scopesOf(result.body).sort()).toEqual([...DEFAULT_SCOPES].sort());
    expect(scopesOf(result.body)).not.toContain("taskbook.submit");
  });

  it("submit-only grants exactly taskbook.submit with no read/offline scope and no refresh token", async () => {
    const result = await tokenForScope("taskbook.submit");
    expect(result.status).toBe(200);
    expect(scopesOf(result.body)).toEqual(["taskbook.submit"]);
    expect(result.body.refresh_token).toBeUndefined();
    for (const unrelated of ["workspace.read", "workspace.search", "git.read", "execution.read", "offline_access"]) {
      expect(scopesOf(result.body)).not.toContain(unrelated);
    }
  });

  it("a submit-only token cannot use an existing read MCP tool and gets no file content", async () => {
    const result = await tokenForScope("taskbook.submit");
    const client = await connectMcpClient(result.body.access_token);
    try {
      const denied = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
      expect(textOf(denied)).not.toContain("hello oauth");
    } finally {
      await client.close();
    }
  });

  it("explicit subsets and mixtures grant only the requested supported scopes", async () => {
    const readOnly = await tokenForScope("workspace.read");
    expect(readOnly.status).toBe(200);
    expect(scopesOf(readOnly.body)).toEqual(["workspace.read"]);

    const mixed = await tokenForScope("workspace.read taskbook.submit");
    expect(mixed.status).toBe(200);
    expect(scopesOf(mixed.body).sort()).toEqual(["taskbook.submit", "workspace.read"].sort());
    expect(scopesOf(mixed.body)).not.toContain("workspace.search");
    expect(scopesOf(mixed.body)).not.toContain("offline_access");

    const unsupportedPlusSubmit = await tokenForScope("unknown.scope taskbook.submit");
    expect(unsupportedPlusSubmit.status).toBe(200);
    expect(scopesOf(unsupportedPlusSubmit.body)).toEqual(["taskbook.submit"]);
  });

  it("unsupported-only scope fails closed and never falls back to default/supported scopes", async () => {
    // core resolution never falls back
    expect(filterScopes("unknown.scope")).toEqual([]);
    expect(filterScopes("unknown.scope taskbook.submit")).toEqual(["taskbook.submit"]);

    const clientId = await scopeRegisterClient();
    const { challenge } = pkceVerifierAndChallenge();
    const pairing = scopeBridge.pairing.create();
    const rejected = await authorizeWithScope(clientId, challenge, "unknown.scope", pairing.code);
    // authorization rejects with invalid_scope and mints no code (hence no token)
    expect(rejected.code).toBeNull();
    expect(rejected.status).toBe(302);
    expect(rejected.location).toContain("error=invalid_scope");
    expect(rejected.location).not.toContain("code=");
    // no fallback scope was offered anywhere
    expect(rejected.page).not.toContain("Read files in this workspace");
    expect(rejected.page).not.toContain("taskbook");
  });

  it("refresh rotation preserves the original scope set and never adds taskbook.submit", async () => {
    const issued = await tokenForScope("workspace.read offline_access");
    expect(issued.status).toBe(200);
    expect(scopesOf(issued.body).sort()).toEqual(["offline_access", "workspace.read"].sort());
    expect(issued.body.refresh_token).toMatch(/^c2c_rt_/);

    const rotated = await refreshWithToken(issued.clientId, issued.body.refresh_token);
    expect(rotated.status).toBe(200);
    expect(scopesOf(rotated.body).sort()).toEqual(["offline_access", "workspace.read"].sort());
    expect(scopesOf(rotated.body)).not.toContain("taskbook.submit");

    // old refresh token stays invalidated
    const replayed = await refreshWithToken(issued.clientId, issued.body.refresh_token);
    expect(replayed.status).toBe(400);
  });
});

describe("legacy token persistence/reload", () => {
  it("keeps the pre-mutation scope set after reload and never adds taskbook.submit", () => {
    const legacyScopes = [...DEFAULT_SCOPES];
    const rawToken = "c2c_at_legacy_readonly_token";
    const hash = createHash("sha256").update(rawToken).digest("hex");
    const now = Date.now();
    const file = path.join(makeTmpDir("auth-legacy"), "legacy-workspace.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        clients: [],
        tokens: [
          {
            hash,
            kind: "access",
            clientId: "legacy-client",
            workspaceId: "legacy-workspace",
            scopes: legacyScopes,
            issuedAt: now,
            expiresAt: now + 60 * 60 * 1000,
            revoked: false,
          },
        ],
      })
    );

    const store = new AuthStore("legacy-workspace", { file });
    const verdict = store.verifyAccessToken(rawToken);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.record.scopes).toEqual(legacyScopes);
    expect(verdict.record.scopes).not.toContain("taskbook.submit");

    // A later write through the store must not normalize or upgrade the legacy record.
    store.registerClient({ clientName: "later", redirectUris: [REDIRECT_URI] });
    const reloaded = new AuthStore("legacy-workspace", { file });
    const after = reloaded.verifyAccessToken(rawToken);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.record.scopes).toEqual(legacyScopes);
    expect(after.record.scopes).not.toContain("taskbook.submit");
  });
});

describe("consent page presentation", () => {
  it("keeps read-only wording for a default read-only authorization", async () => {
    const page = await fetchConsentPage(undefined);
    expect(page.status).toBe(200);
    expect(page.html).toContain("(read-only)");
    expect(page.html).toContain("Read files in this workspace");
    expect(page.html).not.toContain("Taskbook");
    expect(page.html).not.toContain("taskbook.submit");
  });

  it("presents bounded Taskbook submission accurately for a submit-only request", async () => {
    const page = await fetchConsentPage("taskbook.submit");
    expect(page.status).toBe(200);
    expect(page.html).not.toContain("(read-only)");
    expect(page.html).toContain("Bounded Taskbook submission");
    expect(page.html).toContain("C2C task state");
    expect(page.html).toContain("does not write project files");
    expect(page.html).toContain("does not run commands");
  });

  it("does not label a mixed read + mutation request as read-only", async () => {
    const page = await fetchConsentPage("workspace.read taskbook.submit");
    expect(page.status).toBe(200);
    expect(page.html).not.toContain("(read-only)");
    expect(page.html).toContain("Read access:");
    expect(page.html).toContain("Bounded Taskbook submission");
    expect(page.html).toContain("C2C task state");
    expect(page.html).toContain("does not write project files");
    expect(page.html).toContain("does not run commands");
  });
});

describe("MCP tool surface", () => {
  it("keeps the nine read-only tools and adds exactly one Taskbook mutation tool", async () => {
    const tokens = scopeBridge.authStore.issueTokens({
      clientId: "surface-check",
      scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
    });
    const client = await connectMcpClient(tokens.accessToken);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      const readOnlyTools = [
        "execution_output",
        "execution_summary",
        "git_diff",
        "git_status",
        "list_directory",
        "read_file",
        "search_workspace",
        "test_status",
        "workspace_info",
      ];
      // Gate 1 final surface: the original nine read-only tools plus submit_taskbook.
      expect(names).toEqual([...readOnlyTools, "submit_taskbook"].sort());
      expect(names.length).toBe(10);
      for (const readTool of readOnlyTools) expect(names).toContain(readTool);
      expect(names.filter((name) => name === "submit_taskbook")).toHaveLength(1);
      // No Taskbook read/list/delete/claim surface.
      for (const forbidden of ["read_taskbook", "list_taskbooks", "get_taskbook", "delete_taskbook", "claim_taskbook"]) {
        expect(names).not.toContain(forbidden);
      }
      // A read-only scope set still cannot submit: the mutation tool is present
      // but authorization remains enforced by scope.
      const denied = await client.callTool({ name: "submit_taskbook", arguments: { title: "t", body: "b" } });
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toContain("FORBIDDEN");
    } finally {
      await client.close();
    }
  });
});
