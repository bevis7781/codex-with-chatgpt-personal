import fs from "node:fs";
import { claimTaskbook } from "../../src/taskbook/index.js";

const [stateDir, projectRoot, workspaceId, taskId, bodySha256, authorizationId, resultFile] = process.argv.slice(2);

function main(): void {
  try {
    const claim = claimTaskbook({
      stateDir,
      projectRoot,
      workspaceId,
      taskId,
      bodySha256,
      authorizationId,
      harness: "independent-child",
    });
    fs.writeFileSync(resultFile, JSON.stringify({ ok: true, claim }), "utf8");
  } catch (error) {
    fs.writeFileSync(
      resultFile,
      JSON.stringify({ ok: false, code: (error as { code?: string }).code ?? "UNKNOWN" }),
      "utf8"
    );
  }
}

main();
