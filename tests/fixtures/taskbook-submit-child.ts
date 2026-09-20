import fs from "node:fs";
import { submitTaskbook } from "../../src/taskbook/index.js";

/**
 * Real, independent child process used for R1 cross-process concurrency
 * evidence. Invoked with:
 *   node --import tsx/esm tests/fixtures/taskbook-submit-child.ts \
 *     <stateDir> <projectRoot> <workspaceId> <title> <body> <resultFile> [delayMs]
 *
 * Writes { ok: true, receipt } or { ok: false, code } to <resultFile>. This is a
 * TEST fixture only; production Taskbook code never spawns processes.
 */
const [stateDir, projectRoot, workspaceId, title, body, resultFile, delayRaw] = process.argv.slice(2);
const delayMs = Number.parseInt(delayRaw ?? "0", 10);

function writeResult(value: unknown): void {
  fs.writeFileSync(resultFile, JSON.stringify(value), "utf8");
}

async function main(): Promise<void> {
  if (Number.isFinite(delayMs) && delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  try {
    const receipt = submitTaskbook({ title, body }, { workspaceId, projectRoot, stateDir });
    writeResult({ ok: true, receipt });
  } catch (error) {
    writeResult({ ok: false, code: (error as { code?: string }).code ?? "UNKNOWN" });
  }
}

void main();
