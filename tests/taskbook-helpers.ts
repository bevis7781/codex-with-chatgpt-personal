import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Taskbook test helpers.
 *
 * Taskbook state/config fixtures deliberately live in the OS temp directory,
 * OUTSIDE the repository. The upstream `tests/helpers.ts` temp-root defaults to
 * `.tooling/test-tmp` inside the repo, which would intentionally violate R2 and
 * therefore cannot be used as Taskbook production-safety evidence.
 */

const createdRoots: string[] = [];

/** Real temp directory outside the repository. */
export function externalTempDir(prefix = "c2c-taskbook"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const real = fs.realpathSync.native(dir);
  createdRoots.push(real);
  return real;
}

/** A real directory that plays the role of a project workspace root. */
export function projectWorkspaceFixture(): string {
  return externalTempDir("c2c-taskbook-project");
}

export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export function cleanupExternalTempDirs(): void {
  for (const dir of createdRoots.splice(0, createdRoots.length)) removeDir(dir);
}

export function writeTextFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A syntactically valid canonical envelope document. */
export function envelopeText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    title: "Fixture title",
    body: "Fixture body",
    ...overrides,
  });
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

export function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Deterministic lowercase UUID v4 generator for collision/type coverage. */
export function uuidFactory(ids: string[]): () => string {
  let index = 0;
  return () => ids[Math.min(index++, ids.length - 1)];
}

/** Well-formed canonical lowercase UUID v4 values for fixtures. */
export const FIXED_UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

/** True when the platform can construct a file symlink (else the case is NOT VERIFIED). */
export function canCreateFileSymlink(): boolean {
  const root = externalTempDir("c2c-taskbook-symprobe");
  try {
    const target = path.join(root, "target");
    fs.writeFileSync(target, "x");
    fs.symlinkSync(target, path.join(root, "link"), "file");
    return true;
  } catch {
    return false;
  }
}

/** True when the platform can construct a directory junction. */
export function canCreateJunction(): boolean {
  const root = externalTempDir("c2c-taskbook-juncprobe");
  try {
    const target = path.join(root, "target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(root, "junction"), "junction");
    return true;
  } catch {
    return false;
  }
}
