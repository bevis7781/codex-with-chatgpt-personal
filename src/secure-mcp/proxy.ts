import type { SecureMcpConfig } from "./config.js";

const AMBIENT_PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

// The managed client must not inherit another API-key or Cloudflare mode from
// the operator's ambient shell.  Secure MCP supplies its own runtime key via
// C2C_SECURE_MCP_RUNTIME_KEY and its own profile/state directories.
const UNSAFE_AMBIENT_KEYS = [
  ...AMBIENT_PROXY_KEYS,
  "OPENAI_API_KEY",
  "CONTROL_PLANE_API_KEY",
  "ADMIN_API_KEY",
  "CLOUDFLARED_MANAGED",
  "CLOUDFLARED_TUNNEL_TOKEN",
  "CLOUDFLARED_PATH",
  "TUNNEL_CLIENT_CONFIG",
  "TUNNEL_CLIENT_PROFILE",
  "TUNNEL_CLIENT_PROFILE_FILE",
] as const;

const UNSAFE_AMBIENT_PREFIXES = [
  "CLOUDFLARE_",
  "CLOUDFLARED_",
  "CF_",
  "CONTROL_PLANE_",
  "ADMIN_",
  "MCP_",
  "HARPOON_",
  "TUNNEL_CLIENT_",
  "OPENAI_ADMIN_",
  "OPENAI_RUNTIME_",
  "RUNTIME_API_KEY",
  "C2C_",
] as const;

export function sanitizeSecureMcpEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (
      UNSAFE_AMBIENT_KEYS.includes(key as (typeof UNSAFE_AMBIENT_KEYS)[number]) ||
      UNSAFE_AMBIENT_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      delete env[key];
    }
  }
  return env;
}

export function validateControlPlaneProxy(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("SECURE_MCP_PROXY_EMPTY");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("SECURE_MCP_PROXY_INVALID");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("SECURE_MCP_PROXY_PROTOCOL");
  if (parsed.username || parsed.password) throw new Error("SECURE_MCP_PROXY_CREDENTIALS_FORBIDDEN");
  if (!parsed.hostname || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("SECURE_MCP_PROXY_INVALID");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function validateLoopbackUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SECURE_MCP_LOOPBACK_URL_INVALID");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    throw new Error("SECURE_MCP_LOOPBACK_URL_REQUIRED");
  }
  const port = Number(parsed.port);
  if (!parsed.port || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("SECURE_MCP_LOOPBACK_URL_INVALID");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("SECURE_MCP_LOOPBACK_URL_INVALID");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function validateLoopbackMcpUrl(value: string): string {
  const normalized = validateLoopbackUrl(value);
  if (new URL(normalized).pathname !== "/mcp") throw new Error("SECURE_MCP_MCP_TARGET_REQUIRED");
  return normalized;
}

export function redactControlPlaneProxy(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "<invalid-proxy>";
  }
}

export function secureMcpChildEnv(
  base: NodeJS.ProcessEnv,
  opts: { runtimeKey: string; mcpServerUrl: string; config: SecureMcpConfig }
): NodeJS.ProcessEnv {
  validateLoopbackMcpUrl(opts.mcpServerUrl);
  const env = sanitizeSecureMcpEnv(base);
  env.C2C_SECURE_MCP_RUNTIME_KEY = opts.runtimeKey;
  env.MCP_SERVER_URL = opts.mcpServerUrl;
  env.HARPOON_ALLOW_PLAINTEXT_HTTP = "true";
  env.NO_PROXY = "127.0.0.1,localhost,::1";
  env.no_proxy = env.NO_PROXY;
  if (opts.config.controlPlaneProxy) {
    env.CONTROL_PLANE_HTTP_PROXY = validateControlPlaneProxy(opts.config.controlPlaneProxy);
  } else {
    delete env.CONTROL_PLANE_HTTP_PROXY;
  }
  return env;
}

export function describeProxy(value: string | null): { configured: boolean; url: string | null } {
  return { configured: Boolean(value), url: redactControlPlaneProxy(value) };
}
