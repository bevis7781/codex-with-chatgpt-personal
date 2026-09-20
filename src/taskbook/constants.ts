/**
 * Frozen Gate 1 Taskbook constants (Q2–Q5, R1–R3).
 *
 * These values are part of the frozen contract; do not change them without a
 * Controller decision.
 */

/** Q2: initial supported envelope format identifier. */
export const ENVELOPE_VERSION = 1 as const;

/** Q4: per-authenticated-workspace limits. All byte limits are UTF-8 byte limits. */
export const MAX_TITLE_BYTES = 512;
export const MAX_BODY_BYTES = 262144;
export const MAX_PENDING = 32;
export const MAX_TOTAL_STORAGE_BYTES = 134217728;
export const MAX_INVENTORY_ENTRIES = 1024;

/**
 * Worst-case JSON string expansion, in serialized bytes per accepted UTF-8 byte.
 *
 * `JSON.stringify` never emits more than six ASCII bytes for one UTF-16 code
 * unit: characters that have a short escape (`"`, `\`, `\b`, `\f`, `\n`, `\r`,
 * `\t`) become two bytes, and every other control character or lone surrogate
 * becomes a six-byte `\uXXXX` escape. Conversely every UTF-16 code unit of a
 * JavaScript string is worth at least one UTF-8 byte (a lone surrogate is three
 * bytes, a surrogate pair is four bytes for two code units, a BMP character is
 * one to three). So the serialized JSON text of a string of N UTF-8 bytes is at
 * most 6 * N bytes, and this factor dominates every accept/reject boundary.
 */
export const JSON_MAX_BYTES_PER_UTF8_BYTE = 6;

/**
 * Exact byte count of the serialized envelope that is *not* string content:
 * `{"version":1,"createdAt":"<26-byte ISO-8601 UTC>","title":,"body":}` plus the
 * four quote characters that delimit the two empty strings.
 *
 * Measured: `serializeEnvelope({version:1,createdAt:"...",title:"",body:""})`
 * is exactly 73 bytes, and `createdAt` is a fixed-length 26-character ISO-8601
 * UTC timestamp in every envelope this build can produce or accept.
 */
export const ENVELOPE_FIXED_OVERHEAD_BYTES = 73;

/**
 * Upper bound for the serialized form of any *valid* Q2 envelope.
 *
 * Used only as a cheap read filter during inventory: a canonical file larger
 * than this can never deserialize into an accepted envelope, so its bytes are
 * never read (they still count towards storage and the entry ceiling). Because
 * this bound dominates JSON escaping growth, a valid pending record can never
 * be silently skipped and mistaken for a non-pending file.
 */
export const MAX_ENVELOPE_BYTES =
  ENVELOPE_FIXED_OVERHEAD_BYTES + JSON_MAX_BYTES_PER_UTF8_BYTE * (MAX_TITLE_BYTES + MAX_BODY_BYTES);

/** Q3: fixed extension for persisted Taskbook files. */
export const TASKBOOK_FILE_EXTENSION = ".json";

/** Gate 2 lifecycle sidecars. They are direct children beside the immutable envelope. */
export const CLAIM_FILE_SUFFIX = ".claim.json";
export const RESULT_FILE_SUFFIX = ".result.json";
export const LIFECYCLE_VERSION = 1 as const;
export const MAX_LIFECYCLE_BYTES = 4096;

/** Q5/Q6: the only status a Gate 1 record can carry. */
export const TASKBOOK_STATUS_PENDING = "pending" as const;

/** State layout below the canonical C2C state root. */
export const TASKS_ROOT_NAME = "tasks";
export const LOCK_NAMESPACE_NAME = "taskbook-locks";
export const LOCK_SUFFIX = ".lock";

/** Bounded number of UUID attempts before failing closed on repeated collision. */
export const MAX_UUID_ATTEMPTS = 8;
