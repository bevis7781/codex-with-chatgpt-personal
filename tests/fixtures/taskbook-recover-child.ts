import fs from "node:fs";
import {
  TASKBOOK_LIFECYCLE_CAPABILITY,
  recoverTaskbook,
} from "../../src/taskbook/index.js";

const [stateDir, projectRoot, workspaceId, recoveryAuthorizationId, readyFile, releaseFile, resultFile] = process.argv.slice(2);
if (!stateDir || !projectRoot || !workspaceId || !recoveryAuthorizationId || !readyFile || !releaseFile || !resultFile) {
  process.exit(2);
}

const result = await recoverTaskbook(
  { stateDir, projectRoot, workspaceId, recoveryAuthorizationId },
  () => {
    fs.writeFileSync(readyFile, "locked");
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(releaseFile)) Atomics.wait(waitCell, 0, 0, 50);
    return { classification: "none" };
  },
  async () => ({
    evidence: "authenticated-loopback-admin-info",
    observedAt: new Date().toISOString(),
    runtime: {
      service: "c2c-bridge",
      version: "0.1.1",
      workspaceId,
      workspaceRoot: projectRoot,
      pid: process.pid,
      port: 14369,
      startedAt: "2026-09-23T00:00:00.000Z",
    },
    capability: TASKBOOK_LIFECYCLE_CAPABILITY,
  })
);
fs.writeFileSync(resultFile, JSON.stringify(result));
