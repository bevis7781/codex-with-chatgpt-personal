export const CLOUDFLARE_NETWORK_BLOCKED = "CLOUDFLARE_NETWORK_BLOCKED" as const;

export type CloudflareFailureCode = typeof CLOUDFLARE_NETWORK_BLOCKED;

const CLOUDFLARE_DNS_ENDPOINTS = new Set([
  "api.cloudflare.com",
  "region1.v2.argotunnel.com",
  "region2.v2.argotunnel.com",
]);

const DNS_LOOKUP_FAILURE = /\blookup[ \t]+([a-z0-9.-]+)(?=[ \t:]|$)[^\r\n]*\bno such host\b/gi;

function isKnownCloudflareDnsLookupFailure(message: string): boolean {
  for (const match of message.matchAll(DNS_LOOKUP_FAILURE)) {
    const hostname = match[1].replace(/\.$/, "").toLowerCase();
    if (CLOUDFLARE_DNS_ENDPOINTS.has(hostname)) return true;
  }
  return false;
}

/**
 * Keep this classifier deliberately narrow. It covers observed Cloudflare
 * endpoint connectivity failures without turning auth/config/tunnel errors
 * into a generic network diagnosis.
 */
export function isCloudflareNetworkBlockedMessage(message: string): boolean {
  return (
    /\bconnectex\b[\s\S]*(?:forbidden by its access permissions|access(?:ing)? a socket[\s\S]*forbidden)/i.test(
      message
    ) || isKnownCloudflareDnsLookupFailure(message)
  );
}

export function cloudflareFailureCode(error: unknown): CloudflareFailureCode | null {
  if (error instanceof CloudflareNetworkBlockedError) return CLOUDFLARE_NETWORK_BLOCKED;
  const message = error instanceof Error ? error.message : String(error);
  return isCloudflareNetworkBlockedMessage(message) ? CLOUDFLARE_NETWORK_BLOCKED : null;
}

export function isCloudflareNetworkBlocked(error: unknown): boolean {
  return cloudflareFailureCode(error) === CLOUDFLARE_NETWORK_BLOCKED;
}

export class CloudflareNetworkBlockedError extends Error {
  readonly code = CLOUDFLARE_NETWORK_BLOCKED;

  constructor(detail: string) {
    const normalized = detail.startsWith(`${CLOUDFLARE_NETWORK_BLOCKED}:`)
      ? detail.slice(CLOUDFLARE_NETWORK_BLOCKED.length + 1).trim()
      : detail;
    super(`${CLOUDFLARE_NETWORK_BLOCKED}: Cloudflare network access is blocked or unavailable. ${normalized}`);
    this.name = "CloudflareNetworkBlockedError";
  }
}

export function classifyCloudflareError(error: unknown): Error {
  if (error instanceof CloudflareNetworkBlockedError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return isCloudflareNetworkBlockedMessage(message)
    ? new CloudflareNetworkBlockedError(message)
    : error instanceof Error
      ? error
      : new Error(message);
}
