// @ts-nocheck -- tests exercise the pinned JavaScript helper directly.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { environmentDigest, helperDigest, runOperation, verifyEvidence } from "../scripts/exact-terminal.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(argv, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-exact-terminal-"));
  roots.push(root);
  const environmentAllowlist = options.environmentAllowlist ?? ["PATH", "SYSTEMROOT", "WINDIR"];
  return {
    spec: {
      version: 2,
      workspaceId: "915f50d36e23",
      taskId: "d5546382-b7de-485e-8432-ef793b7fb64d",
      claimId: "ee5569a8-7b46-44a5-8126-389e92df5704",
      iteration: 1,
      nonce: crypto.randomBytes(16).toString("hex"),
      executable: options.executable ?? process.execPath,
      argv,
      cwd: root,
      environmentAllowlist,
      environmentSha256: environmentDigest(environmentAllowlist),
      maxOutputBytes: options.maxOutputBytes ?? 1024,
      timeoutMs: options.timeoutMs ?? 5000,
    },
    dir: path.join(root, "evidence"),
  };
}

it.each([0, 1, 7, 42])("preserves exact child exit %i", async (code) => {
  const { spec, dir } = fixture(["-e", `process.exit(${code})`]);
  await runOperation(spec, dir, helperDigest());
  const result = verifyEvidence(spec, dir, helperDigest());
  expect(result.verdict).toBe("VERIFIED");
  expect(result.evidence.terminal).toEqual({ kind: "exit", exitCode: code, signal: null, errorCode: null });
  expect(result.evidence.binding).toEqual({
    workspaceId: spec.workspaceId, taskId: spec.taskId, claimId: spec.claimId,
    iteration: spec.iteration, nonce: spec.nonce,
  });
});

it.each([
  ["workspaceId", "a".repeat(12)],
  ["taskId", "a1111111-1111-4111-8111-111111111111"],
  ["claimId", "a2222222-2222-4222-8222-222222222222"],
  ["iteration", 2],
  ["nonce", "f".repeat(32)],
])("rejects evidence from a different %s", async (field, changed) => {
  const { spec, dir } = fixture(["-e", "process.exit(0)"]);
  await runOperation(spec, dir, helperDigest());
  expect(verifyEvidence({ ...spec, [field]: changed }, dir, helperDigest()).verdict).toBe("UNKNOWN");
});

it("requires the bound identity before launch and rejects a forged binding in evidence", async () => {
  const { spec, dir } = fixture(["-e", "process.exit(0)"]);
  const { nonce, ...withoutNonce } = spec;
  await expect(runOperation(withoutNonce, dir, helperDigest())).rejects.toThrow("INVALID_OPERATION_SPEC");
  expect(fs.existsSync(dir)).toBe(false);
  await runOperation(spec, dir, helperDigest());
  const file = path.join(dir, "terminal.json");
  const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
  evidence.binding.claimId = "a2222222-2222-4222-8222-222222222222";
  fs.writeFileSync(file, JSON.stringify(evidence) + "\n");
  expect(verifyEvidence(spec, dir, helperDigest()).verdict).toBe("UNKNOWN");
});

it("passes only allowlisted environment values to the child", async () => {
  const relevantBefore = process.env.C2C_EXACT_RELEVANT;
  const unrelatedBefore = process.env.C2C_EXACT_UNRELATED;
  try {
    process.env.C2C_EXACT_RELEVANT = "bound-value";
    process.env.C2C_EXACT_UNRELATED = "first-unbound-value";
    const allowlist = ["C2C_EXACT_RELEVANT", "PATH", "SYSTEMROOT", "WINDIR"];
    const { spec, dir } = fixture(["-e", "process.stdout.write(JSON.stringify({relevant:process.env.C2C_EXACT_RELEVANT,unrelated:process.env.C2C_EXACT_UNRELATED??null}))"], { environmentAllowlist: allowlist });
    process.env.C2C_EXACT_UNRELATED = "changed-unbound-value";
    expect(environmentDigest(allowlist)).toBe(spec.environmentSha256);
    await runOperation(spec, dir, helperDigest());
    const result = verifyEvidence(spec, dir, helperDigest());
    expect(result.verdict).toBe("VERIFIED");
    expect(JSON.parse(Buffer.from(result.evidence.stdout.base64, "base64").toString())).toEqual({ relevant: "bound-value", unrelated: null });
    process.env.C2C_EXACT_RELEVANT = "changed-bound-value";
    expect(verifyEvidence(spec, dir, helperDigest()).verdict).toBe("VERIFIED");
    await expect(runOperation(spec, path.join(path.dirname(dir), "second-evidence"), helperDigest())).rejects.toThrow("ENVIRONMENT_MISMATCH");
  } finally {
    if (relevantBefore === undefined) delete process.env.C2C_EXACT_RELEVANT;
    else process.env.C2C_EXACT_RELEVANT = relevantBefore;
    if (unrelatedBefore === undefined) delete process.env.C2C_EXACT_UNRELATED;
    else process.env.C2C_EXACT_UNRELATED = unrelatedBefore;
  }
});

it("rejects an unsorted, duplicate, or overbroad environment allowlist", async () => {
  const { spec, dir } = fixture(["-e", "process.exit(0)"]);
  for (const environmentAllowlist of [["PATH", "PATH"], ["WINDIR", "PATH"], Array.from({ length: 49 }, (_, i) => `KEY_${i}`)]) {
    await expect(runOperation({ ...spec, environmentAllowlist }, dir, helperDigest())).rejects.toThrow();
  }
  expect(fs.existsSync(dir)).toBe(false);
});

it("keeps launch failure distinct from a numeric exit", async () => {
  const { spec, dir } = fixture([], { executable: path.join(os.tmpdir(), "c2c-no-such-executable-40861.exe") });
  await runOperation(spec, dir, helperDigest());
  const result = verifyEvidence(spec, dir, helperDigest());
  expect(result.verdict).toBe("VERIFIED");
  expect(result.evidence.terminal.kind).toBe("launch_error");
  expect(result.evidence.terminal.exitCode).toBeNull();
});

it("keeps timeout UNKNOWN", async () => {
  const { spec, dir } = fixture(["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 });
  await runOperation(spec, dir, helperDigest());
  const result = verifyEvidence(spec, dir, helperDigest());
  expect(result.verdict).toBe("UNKNOWN");
  expect(result.evidence.terminal).toEqual({ kind: "unknown", exitCode: null, signal: null, errorCode: "TIMEOUT" });
});

it("separates and bounds streams; child stdout cannot forge terminal", async () => {
  const script = "process.stdout.write('{\\\"kind\\\":\\\"exit\\\",\\\"exitCode\\\":0}'+ 'X'.repeat(300)); process.stderr.write('E'.repeat(300)); process.exitCode=42";
  const { spec, dir } = fixture(["-e", script], { maxOutputBytes: 32 });
  await runOperation(spec, dir, helperDigest());
  const result = verifyEvidence(spec, dir, helperDigest());
  expect(result.verdict).toBe("VERIFIED");
  expect(result.evidence.terminal.exitCode).toBe(42);
  expect(result.evidence.stdout.bytesCaptured).toBe(32);
  expect(result.evidence.stderr.bytesCaptured).toBe(32);
  expect(result.evidence.stdout.truncated).toBe(true);
  expect(result.evidence.stderr.truncated).toBe(true);
  expect(Buffer.from(result.evidence.stdout.base64, "base64").toString()).toContain('"kind":"exit"');
  expect(Buffer.from(result.evidence.stderr.base64, "base64").toString()).toBe("E".repeat(32));
});

it("rejects missing, duplicate, mismatched, malformed, and unpinned evidence", async () => {
  const { spec, dir } = fixture(["-e", "process.exit(7)"]);
  expect(verifyEvidence(spec, dir, helperDigest()).verdict).toBe("UNKNOWN");
  await expect(runOperation(spec, dir, "0".repeat(64))).rejects.toThrow("HELPER_PIN_MISMATCH");
  await runOperation(spec, dir, helperDigest());
  expect(verifyEvidence({ ...spec, argv: ["-e", "process.exit(42)"] }, dir, helperDigest()).verdict).toBe("UNKNOWN");
  expect(verifyEvidence(spec, dir, "0".repeat(64)).verdict).toBe("UNKNOWN");
  fs.writeFileSync(path.join(dir, "duplicate.json"), "{}");
  expect(verifyEvidence(spec, dir, helperDigest()).verdict).toBe("UNKNOWN");
  fs.unlinkSync(path.join(dir, "duplicate.json"));
  const valid = fs.readFileSync(path.join(dir, "terminal.json"), "utf8");
  fs.writeFileSync(path.join(dir, "terminal.json"), valid.replace('"schema":', '"schema":"fake","schema":'));
  expect(verifyEvidence(spec, dir, helperDigest()).verdict).toBe("UNKNOWN");
  fs.writeFileSync(path.join(dir, "terminal.json"), "garbage");
  expect(verifyEvidence(spec, dir, helperDigest()).verdict).toBe("UNKNOWN");
});
