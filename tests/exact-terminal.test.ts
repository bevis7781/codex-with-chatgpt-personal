// @ts-nocheck -- tests exercise the pinned JavaScript helper directly.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  helperDigest,
  invariantEnvironmentDigest,
  runOperation,
  verifyEvidence,
  verifyRetryEvidence,
} from "../scripts/exact-terminal.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(argv, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-exact-terminal-"));
  roots.push(root);
  const environmentPolicy = options.environmentPolicy ?? [
    { name: "PATH", mode: "context" },
    { name: "SYSTEMROOT", mode: "context" },
    { name: "WINDIR", mode: "context" },
  ];
  return {
    spec: {
      version: 3,
      workspaceId: "915f50d36e23",
      taskId: "d5546382-b7de-485e-8432-ef793b7fb64d",
      claimId: "ee5569a8-7b46-44a5-8126-389e92df5704",
      iteration: 1,
      nonce: crypto.randomBytes(16).toString("hex"),
      executable: options.executable ?? process.execPath,
      argv,
      cwd: root,
      environmentPolicy,
      invariantEnvironmentSha256: invariantEnvironmentDigest(environmentPolicy),
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
    process.env.C2C_EXACT_RELEVANT = "ordinary-private-context-value";
    process.env.C2C_EXACT_UNRELATED = "first-unbound-value";
    const policy = [
      { name: "C2C_EXACT_RELEVANT", mode: "context" },
      { name: "PATH", mode: "context" },
      { name: "SYSTEMROOT", mode: "context" },
      { name: "WINDIR", mode: "context" },
    ];
    const { spec, dir } = fixture(["-e", "process.stdout.write(JSON.stringify({relevant:process.env.C2C_EXACT_RELEVANT,unrelated:process.env.C2C_EXACT_UNRELATED??null}))"], { environmentPolicy: policy });
    process.env.C2C_EXACT_UNRELATED = "changed-unbound-value";
    expect(invariantEnvironmentDigest(policy)).toBe(spec.invariantEnvironmentSha256);
    await runOperation(spec, dir, helperDigest());
    const result = verifyEvidence(spec, dir, helperDigest());
    expect(result.verdict).toBe("VERIFIED");
    expect(JSON.parse(Buffer.from(result.evidence.stdout.base64, "base64").toString())).toEqual({ relevant: "ordinary-private-context-value", unrelated: null });
    expect(result.evidence.environmentEvidence.contextPresent).toEqual(["C2C_EXACT_RELEVANT", "PATH", "SYSTEMROOT", "WINDIR"].filter((name) => process.env[name] !== undefined));
    expect(JSON.stringify(result.evidence.environmentEvidence)).not.toContain("ordinary-private-context-value");
    expect(JSON.stringify(result.evidence.environmentEvidence)).not.toContain("changed-unbound-value");
    process.env.C2C_EXACT_RELEVANT = "changed-bound-value";
    expect(verifyEvidence(spec, dir, helperDigest()).verdict).toBe("VERIFIED");
    const secondDir = path.join(path.dirname(dir), "second-evidence");
    await runOperation(spec, secondDir, helperDigest());
    const retry = verifyRetryEvidence(spec, dir, secondDir, helperDigest());
    expect(retry.verdict).toBe("VERIFIED");
    expect(retry.contextEnvironment.ordinary.sha256).not.toBe(retry.contextEnvironment.retry.sha256);
    expect(retry.contextEnvironment.ordinary.present).toContain("C2C_EXACT_RELEVANT");
    expect(retry.contextEnvironment.retry.present).toContain("C2C_EXACT_RELEVANT");
  } finally {
    if (relevantBefore === undefined) delete process.env.C2C_EXACT_RELEVANT;
    else process.env.C2C_EXACT_RELEVANT = relevantBefore;
    if (unrelatedBefore === undefined) delete process.env.C2C_EXACT_UNRELATED;
    else process.env.C2C_EXACT_UNRELATED = unrelatedBefore;
  }
});

it("rejects an unsorted, duplicate, overbroad, or undeclared environment policy", async () => {
  const { spec, dir } = fixture(["-e", "process.exit(0)"]);
  const entry = (name, mode = "context") => ({ name, mode });
  for (const environmentPolicy of [
    [entry("PATH"), entry("PATH")],
    [entry("WINDIR"), entry("PATH")],
    Array.from({ length: 49 }, (_, i) => entry(`KEY_${i}`)),
    [entry("PATH", "ambient")],
    [{ name: "PATH", mode: "context", value: "must-not-be-embedded" }],
  ]) {
    await expect(runOperation({ ...spec, environmentPolicy }, dir, helperDigest())).rejects.toThrow();
  }
  expect(fs.existsSync(dir)).toBe(false);
});

it("fails before launch when an invariant environment value changes", async () => {
  const prior = process.env.C2C_EXACT_INVARIANT;
  try {
    process.env.C2C_EXACT_INVARIANT = "invariant-value-at-spec-creation";
    const policy = [
      { name: "C2C_EXACT_CONTEXT", mode: "context" },
      { name: "C2C_EXACT_INVARIANT", mode: "invariant" },
    ];
    const { spec, dir } = fixture(["-e", "process.exit(0)"], { environmentPolicy: policy });
    process.env.C2C_EXACT_INVARIANT = "different-invariant-value";
    await expect(runOperation(spec, dir, helperDigest())).rejects.toThrow("INVARIANT_ENVIRONMENT_MISMATCH");
    expect(fs.existsSync(dir)).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.C2C_EXACT_INVARIANT;
    else process.env.C2C_EXACT_INVARIANT = prior;
  }
});

it("rejects retry evidence made with an expanded context policy", async () => {
  const { spec, dir } = fixture(["-e", "process.exit(0)"]);
  await runOperation(spec, dir, helperDigest());
  const expandedPolicy = [
    ...spec.environmentPolicy,
    { name: "USERNAME", mode: "context" },
  ].sort((left, right) => left.name.localeCompare(right.name));
  const expandedSpec = {
    ...spec,
    environmentPolicy: expandedPolicy,
    invariantEnvironmentSha256: invariantEnvironmentDigest(expandedPolicy),
  };
  const retryDir = path.join(path.dirname(dir), "expanded-policy-evidence");
  await runOperation(expandedSpec, retryDir, helperDigest());
  expect(verifyRetryEvidence(spec, dir, retryDir, helperDigest())).toMatchObject({
    verdict: "UNKNOWN",
    reason: "ORDINARY_OR_RETRY_EVIDENCE_UNKNOWN",
  });
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
