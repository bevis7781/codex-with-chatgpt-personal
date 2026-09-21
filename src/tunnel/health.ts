import { isCloudflareNetworkBlocked } from "./errors.js";

const NODE_HEALTH_NETWORK_CODES = new Set(["EACCES", "EPERM", "ENOTFOUND", "EAI_AGAIN"]);
const NODE_HEALTH_NETWORK_CODE_RE = /\b(?:EACCES|EPERM|ENOTFOUND|EAI_AGAIN)\b/;

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
};

/**
 * Recognize only explicit Node permission/name-resolution failures from a
 * public health fetch. The caller supplies the Named + running context.
 */
export function isCloudflareHealthProbeNetworkError(error: unknown): boolean {
  if (isCloudflareNetworkBlocked(error)) return true;

  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (isCloudflareNetworkBlocked(current)) return true;
    const value = current as ErrorLike;
    if (typeof value.code === "string" && NODE_HEALTH_NETWORK_CODES.has(value.code.toUpperCase())) return true;
    if (typeof value.message === "string" && NODE_HEALTH_NETWORK_CODE_RE.test(value.message)) return true;
    if (value.cause !== undefined) pending.push(value.cause);
  }
  return false;
}
