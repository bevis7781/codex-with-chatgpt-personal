import fs from "node:fs";
import path from "node:path";

/** Versioned, bounded description of the Result schemas a Bridge can read. */
export const TASKBOOK_LIFECYCLE_CAPABILITY_SCHEMA = "c2c.taskbook.lifecycle-capability.v1" as const;
const READABLE_RESULT_VERSIONS = Object.freeze([1, 2] as const);
export const MAX_SUPPORTED_TASKBOOK_RESULT_VERSION = Math.max(...READABLE_RESULT_VERSIONS);
export const TASKBOOK_LIFECYCLE_CAPABILITY = Object.freeze({
  schemaId: TASKBOOK_LIFECYCLE_CAPABILITY_SCHEMA,
  readableResultVersions: READABLE_RESULT_VERSIONS,
});

export interface TaskbookLifecycleCapabilityAdvertisement {
  schemaId: string;
  readableResultVersions: readonly number[];
}

/** Runtime provenance accompanying a capability read from authenticated /admin/info. */
export interface BoundTaskbookLifecycleCapability {
  evidence: "authenticated-loopback-admin-info";
  observedAt: string;
  runtime: {
    service: string;
    version: string;
    workspaceId: string;
    workspaceRoot: string;
    pid: number;
    port: number;
    startedAt: string;
  };
  capability: TaskbookLifecycleCapabilityAdvertisement | null;
}

export function parseTaskbookLifecycleCapabilityAdvertisement(
  value: unknown
): TaskbookLifecycleCapabilityAdvertisement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "readableResultVersions" || keys[1] !== "schemaId") return null;
  if (typeof record.schemaId !== "string" || record.schemaId.length === 0 || record.schemaId.length > 128) return null;
  if (!Array.isArray(record.readableResultVersions) || record.readableResultVersions.length === 0 || record.readableResultVersions.length > 32) {
    return null;
  }
  let previous = 0;
  for (const version of record.readableResultVersions) {
    if (!Number.isSafeInteger(version) || (version as number) <= previous) return null;
    previous = version as number;
  }
  return {
    schemaId: record.schemaId,
    readableResultVersions: [...record.readableResultVersions] as number[],
  };
}

/** Fail-closed check used immediately before persisting a versioned result. */
export function boundCapabilitySupportsResultVersion(
  proof: BoundTaskbookLifecycleCapability | null,
  resultVersion: number,
  expected: { workspaceId: string; workspaceRoot: string },
  now = Date.now()
): boolean {
  if (!proof || proof.evidence !== "authenticated-loopback-admin-info") return false;
  if (!Number.isSafeInteger(resultVersion) || resultVersion <= 0) return false;
  if (!isCanonicalTimestamp(proof.observedAt) || now - Date.parse(proof.observedAt) < 0 || now - Date.parse(proof.observedAt) > 10_000) return false;
  const runtime = proof.runtime;
  if (
    !runtime ||
    runtime.service !== "c2c-bridge" ||
    typeof runtime.version !== "string" ||
    runtime.version.length === 0 ||
    runtime.workspaceId !== expected.workspaceId ||
    !sameCanonicalRoot(runtime.workspaceRoot, expected.workspaceRoot) ||
    !Number.isSafeInteger(runtime.pid) || runtime.pid <= 0 ||
    !Number.isSafeInteger(runtime.port) || runtime.port <= 0 || runtime.port > 65535 ||
    !isCanonicalTimestamp(runtime.startedAt)
  ) {
    return false;
  }
  const advertisement = parseTaskbookLifecycleCapabilityAdvertisement(proof.capability);
  return Boolean(
    advertisement &&
      advertisement.schemaId === TASKBOOK_LIFECYCLE_CAPABILITY_SCHEMA &&
      advertisement.readableResultVersions.includes(resultVersion)
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function sameCanonicalRoot(left: string, right: string): boolean {
  try {
    const leftCanonical = fs.realpathSync.native(path.resolve(left));
    const rightCanonical = fs.realpathSync.native(path.resolve(right));
    return process.platform === "win32"
      ? leftCanonical.toLowerCase() === rightCanonical.toLowerCase()
      : leftCanonical === rightCanonical;
  } catch {
    return false;
  }
}
