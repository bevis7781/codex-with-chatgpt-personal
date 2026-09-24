#!/usr/bin/env node
// Local Taskbook evidence helper. The reviewed SHA-256 is supplied by the caller.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const HEX = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKSPACE_ID = /^[0-9a-f]{12}$/;
const NONCE = /^[0-9a-f]{32}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_EVIDENCE_BYTES = 200_000;
const SCHEMA = "c2c.exact-terminal.v3";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validateEnvironmentPolicy(policy) {
  if (!Array.isArray(policy) || policy.length < 1 || policy.length > 48 ||
      policy.some((entry) => !exactKeys(entry, ["name", "mode"]) ||
        typeof entry.name !== "string" || !ENV_NAME.test(entry.name) ||
        (entry.mode !== "invariant" && entry.mode !== "context"))) {
    throw new Error("INVALID_ENVIRONMENT_POLICY");
  }
  const names = policy.map(({ name }) => name);
  if (names.join("\0") !== [...new Set(names)].sort().join("\0")) {
    throw new Error("INVALID_ENVIRONMENT_POLICY");
  }
}

function relevantEnvironment(policy, env = process.env) {
  validateEnvironmentPolicy(policy);
  const invariantEntries = [];
  const contextEntries = [];
  const childEnv = {};
  for (const { name, mode } of policy) {
    const matches = Object.keys(env).filter((key) => key.toUpperCase() === name);
    if (new Set(matches.map((key) => env[key])).size > 1) throw new Error("AMBIGUOUS_ENVIRONMENT_KEY");
    const value = matches.length === 0 ? null : env[matches[0]];
    if (value !== null && typeof value !== "string") throw new Error("INVALID_ENVIRONMENT");
    if (value !== null) childEnv[name] = value;
    (mode === "invariant" ? invariantEntries : contextEntries).push([name, value]);
  }
  return {
    childEnv,
    invariantSha256: sha256(JSON.stringify(invariantEntries)),
    contextSha256: sha256(JSON.stringify(contextEntries)),
    contextPresent: contextEntries.filter(([, value]) => value !== null).map(([name]) => name),
  };
}

export function invariantEnvironmentDigest(policy, env = process.env) {
  return relevantEnvironment(policy, env).invariantSha256;
}

export function helperDigest() {
  return sha256(fs.readFileSync(HERE));
}

function parseSpec(value) {
  if (!exactKeys(value, ["version", "workspaceId", "taskId", "claimId", "iteration", "nonce", "executable", "argv", "cwd", "environmentPolicy", "invariantEnvironmentSha256", "maxOutputBytes", "timeoutMs"]) ||
      value.version !== 3 || typeof value.workspaceId !== "string" || !WORKSPACE_ID.test(value.workspaceId) ||
      typeof value.taskId !== "string" || !UUID_V4.test(value.taskId) ||
      typeof value.claimId !== "string" || !UUID_V4.test(value.claimId) ||
      !Number.isSafeInteger(value.iteration) || value.iteration < 1 ||
      typeof value.nonce !== "string" || !NONCE.test(value.nonce) ||
      typeof value.executable !== "string" || !path.isAbsolute(value.executable) ||
      !Array.isArray(value.argv) || value.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      typeof value.cwd !== "string" || !path.isAbsolute(value.cwd) ||
      typeof value.invariantEnvironmentSha256 !== "string" || !HEX.test(value.invariantEnvironmentSha256) ||
      !Number.isInteger(value.maxOutputBytes) || value.maxOutputBytes < 1 || value.maxOutputBytes > 65_536 ||
      !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 120_000 ||
      value.executable.includes("\0") || value.cwd.includes("\0")) throw new Error("INVALID_OPERATION_SPEC");
  validateEnvironmentPolicy(value.environmentPolicy);
  return value;
}

function readSpec(specPath) {
  const stat = fs.lstatSync(specPath);
  if (!stat.isFile() || stat.size > 100_000) throw new Error("INVALID_OPERATION_SPEC_FILE");
  return parseSpec(JSON.parse(fs.readFileSync(specPath, "utf8")));
}

export function operationDigest(spec) {
  const parsed = parseSpec(spec);
  return sha256(JSON.stringify({
    version: parsed.version,
    workspaceId: parsed.workspaceId,
    taskId: parsed.taskId,
    claimId: parsed.claimId,
    iteration: parsed.iteration,
    nonce: parsed.nonce,
    executable: parsed.executable,
    argv: [...parsed.argv],
    cwd: parsed.cwd,
    environmentPolicy: parsed.environmentPolicy.map(({ name, mode }) => ({ name, mode })),
    invariantEnvironmentSha256: parsed.invariantEnvironmentSha256,
    maxOutputBytes: parsed.maxOutputBytes,
    timeoutMs: parsed.timeoutMs,
  }));
}

function immutableSpec(value) {
  const parsed = parseSpec(value);
  const snapshot = {
    version: parsed.version,
    workspaceId: parsed.workspaceId,
    taskId: parsed.taskId,
    claimId: parsed.claimId,
    iteration: parsed.iteration,
    nonce: parsed.nonce,
    executable: parsed.executable,
    argv: Object.freeze([...parsed.argv]),
    cwd: parsed.cwd,
    environmentPolicy: Object.freeze(parsed.environmentPolicy.map(({ name, mode }) => Object.freeze({ name, mode }))),
    invariantEnvironmentSha256: parsed.invariantEnvironmentSha256,
    maxOutputBytes: parsed.maxOutputBytes,
    timeoutMs: parsed.timeoutMs,
  };
  return Object.freeze(snapshot);
}

function environmentPolicyDigest(policy) {
  return sha256(JSON.stringify(policy.map(({ name, mode }) => ({ name, mode }))));
}

function validEnvironmentEvidence(value, spec) {
  if (!exactKeys(value, ["invariantSha256", "contextSha256", "contextPresent"]) ||
      value.invariantSha256 !== spec.invariantEnvironmentSha256 ||
      typeof value.contextSha256 !== "string" || !HEX.test(value.contextSha256) ||
      !Array.isArray(value.contextPresent)) return false;
  const contextNames = spec.environmentPolicy.filter(({ mode }) => mode === "context").map(({ name }) => name);
  return value.contextPresent.every((name, index) => typeof name === "string" &&
    contextNames.includes(name) && (index === 0 || value.contextPresent[index - 1] < name)) &&
    value.contextPresent.length <= contextNames.length;
}

function collector(maxBytes) {
  let captured = Buffer.alloc(0);
  let total = 0;
  return {
    add(chunk) {
      total += chunk.length;
      if (captured.length < maxBytes) captured = Buffer.concat([captured, chunk.subarray(0, maxBytes - captured.length)]);
    },
    result() {
      return { base64: captured.toString("base64"), bytesCaptured: captured.length, bytesTotal: total, truncated: total > captured.length };
    },
  };
}

export async function runOperation(spec, evidenceDir, expectedHelperSha256) {
  const operation = immutableSpec(spec);
  if (typeof expectedHelperSha256 !== "string" || !HEX.test(expectedHelperSha256) || helperDigest() !== expectedHelperSha256) {
    throw new Error("HELPER_PIN_MISMATCH");
  }
  const environment = relevantEnvironment(operation.environmentPolicy);
  if (environment.invariantSha256 !== operation.invariantEnvironmentSha256) throw new Error("INVARIANT_ENVIRONMENT_MISMATCH");
  if (!path.isAbsolute(evidenceDir)) throw new Error("INVALID_EVIDENCE_PATH");
  if (!fs.statSync(operation.cwd).isDirectory()) throw new Error("INVALID_CWD");
  fs.mkdirSync(evidenceDir, { recursive: false, mode: 0o700 });

  const stdout = collector(operation.maxOutputBytes);
  const stderr = collector(operation.maxOutputBytes);
  const terminal = await new Promise((resolve) => {
    let child;
    let launchError = null;
    let timedOut = false;
    let timer;
    try {
      child = spawn(operation.executable, operation.argv, { cwd: operation.cwd, env: environment.childEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ kind: "launch_error", exitCode: null, signal: null, errorCode: String(error?.code ?? "SPAWN_THROW").slice(0, 80) });
      return;
    }
    child.stdout.on("data", (chunk) => stdout.add(chunk));
    child.stderr.on("data", (chunk) => stderr.add(chunk));
    child.on("error", (error) => { launchError = String(error?.code ?? "SPAWN_ERROR").slice(0, 80); });
    timer = setTimeout(() => { timedOut = true; child.kill(); }, operation.timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (launchError !== null) resolve({ kind: "launch_error", exitCode: null, signal: null, errorCode: launchError });
      else if (timedOut) resolve({ kind: "unknown", exitCode: null, signal: null, errorCode: "TIMEOUT" });
      else if (signal !== null) resolve({ kind: "signal", exitCode: null, signal, errorCode: null });
      else if (Number.isInteger(code)) resolve({ kind: "exit", exitCode: code, signal: null, errorCode: null });
      else resolve({ kind: "unknown", exitCode: null, signal: null, errorCode: "NO_TERMINAL_STATUS" });
    });
  });

  const evidence = {
    schema: SCHEMA,
    operationSha256: operationDigest(operation),
    helperSha256: expectedHelperSha256,
    binding: { workspaceId: operation.workspaceId, taskId: operation.taskId, claimId: operation.claimId, iteration: operation.iteration, nonce: operation.nonce },
    environmentPolicySha256: environmentPolicyDigest(operation.environmentPolicy),
    environmentEvidence: {
      invariantSha256: environment.invariantSha256,
      contextSha256: environment.contextSha256,
      contextPresent: environment.contextPresent,
    },
    terminal,
    stdout: stdout.result(),
    stderr: stderr.result(),
  };
  fs.writeFileSync(path.join(evidenceDir, "terminal.json"), JSON.stringify(evidence) + "\n", { flag: "wx", mode: 0o600 });
  return evidence;
}

function validOutput(value, max) {
  if (!exactKeys(value, ["base64", "bytesCaptured", "bytesTotal", "truncated"]) ||
      typeof value.base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64) ||
      !Number.isInteger(value.bytesCaptured) || !Number.isInteger(value.bytesTotal) ||
      value.bytesCaptured < 0 || value.bytesCaptured > max || value.bytesTotal < value.bytesCaptured ||
      typeof value.truncated !== "boolean" || value.truncated !== (value.bytesTotal > value.bytesCaptured)) return false;
  const decoded = Buffer.from(value.base64, "base64");
  return decoded.length === value.bytesCaptured && decoded.toString("base64") === value.base64;
}

function validTerminal(value) {
  if (!exactKeys(value, ["kind", "exitCode", "signal", "errorCode"])) return false;
  if (value.kind === "exit") return Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.signal === null && value.errorCode === null;
  if (value.kind === "signal") return value.exitCode === null && typeof value.signal === "string" && /^SIG[A-Z0-9]+$/.test(value.signal) && value.errorCode === null;
  if (value.kind === "launch_error" || value.kind === "unknown") return value.exitCode === null && value.signal === null && typeof value.errorCode === "string" && value.errorCode.length > 0 && value.errorCode.length <= 80;
  return false;
}

export function verifyEvidence(spec, evidenceDir, expectedHelperSha256) {
  try {
    const operation = immutableSpec(spec);
    if (typeof expectedHelperSha256 !== "string" || !HEX.test(expectedHelperSha256) || helperDigest() !== expectedHelperSha256) throw new Error("HELPER_PIN_MISMATCH");
    if (!path.isAbsolute(evidenceDir) || !fs.lstatSync(evidenceDir).isDirectory()) throw new Error("INVALID_EVIDENCE_PATH");
    const names = fs.readdirSync(evidenceDir);
    if (names.length !== 1 || names[0] !== "terminal.json") throw new Error("MISSING_OR_DUPLICATE_EVIDENCE");
    const evidencePath = path.join(evidenceDir, names[0]);
    const stat = fs.lstatSync(evidencePath);
    if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) throw new Error("INVALID_EVIDENCE_FILE");
    const raw = fs.readFileSync(evidencePath, "utf8");
    const evidence = JSON.parse(raw);
    if (raw !== JSON.stringify(evidence) + "\n" ||
        !exactKeys(evidence, ["schema", "operationSha256", "helperSha256", "binding", "environmentPolicySha256", "environmentEvidence", "terminal", "stdout", "stderr"]) ||
        evidence.schema !== SCHEMA || evidence.operationSha256 !== operationDigest(operation) ||
        !exactKeys(evidence.binding, ["workspaceId", "taskId", "claimId", "iteration", "nonce"]) ||
        evidence.binding.workspaceId !== operation.workspaceId || evidence.binding.taskId !== operation.taskId ||
        evidence.binding.claimId !== operation.claimId || evidence.binding.iteration !== operation.iteration ||
        evidence.binding.nonce !== operation.nonce ||
        evidence.helperSha256 !== expectedHelperSha256 ||
        evidence.environmentPolicySha256 !== environmentPolicyDigest(operation.environmentPolicy) ||
        !validEnvironmentEvidence(evidence.environmentEvidence, operation) ||
        !validTerminal(evidence.terminal) || !validOutput(evidence.stdout, operation.maxOutputBytes) ||
        !validOutput(evidence.stderr, operation.maxOutputBytes)) throw new Error("MALFORMED_OR_MISMATCHED_EVIDENCE");
    return { verdict: evidence.terminal.kind === "unknown" ? "UNKNOWN" : "VERIFIED", evidence };
  } catch (error) {
    return { verdict: "UNKNOWN", reason: String(error?.message ?? error).slice(0, 100) };
  }
}

export function verifyRetryEvidence(spec, ordinaryEvidenceDir, retryEvidenceDir, expectedHelperSha256) {
  const ordinary = verifyEvidence(spec, ordinaryEvidenceDir, expectedHelperSha256);
  const retry = verifyEvidence(spec, retryEvidenceDir, expectedHelperSha256);
  if (ordinary.verdict !== "VERIFIED" || retry.verdict !== "VERIFIED") {
    return { verdict: "UNKNOWN", reason: "ORDINARY_OR_RETRY_EVIDENCE_UNKNOWN" };
  }
  const first = ordinary.evidence;
  const second = retry.evidence;
  if (first.operationSha256 !== second.operationSha256 || first.helperSha256 !== second.helperSha256 ||
      JSON.stringify(first.binding) !== JSON.stringify(second.binding) ||
      first.environmentPolicySha256 !== second.environmentPolicySha256 ||
      first.environmentEvidence.invariantSha256 !== second.environmentEvidence.invariantSha256) {
    return { verdict: "UNKNOWN", reason: "RETRY_OPERATION_MISMATCH" };
  }
  return {
    verdict: "VERIFIED",
    operationSha256: first.operationSha256,
    helperSha256: first.helperSha256,
    binding: first.binding,
    environmentPolicySha256: first.environmentPolicySha256,
    invariantEnvironmentSha256: first.environmentEvidence.invariantSha256,
    contextEnvironment: {
      ordinary: { sha256: first.environmentEvidence.contextSha256, present: first.environmentEvidence.contextPresent },
      retry: { sha256: second.environmentEvidence.contextSha256, present: second.environmentEvidence.contextPresent },
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === HERE) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "verify-retry") {
      if (args.length !== 5 || args.some((arg) => !arg)) throw new Error("USAGE");
      const [action, specPath, ordinaryDir, retryDir, pin] = args;
      const spec = readSpec(specPath);
      const result = verifyRetryEvidence(spec, ordinaryDir, retryDir, pin);
      process.stdout.write(JSON.stringify(result) + "\n");
      if (result.verdict !== "VERIFIED") process.exitCode = 2;
    } else {
      const [action, specPath, evidenceDir, pin] = args;
      if (!action || !specPath || !evidenceDir || !pin || args.length !== 4) throw new Error("USAGE");
      const spec = readSpec(specPath);
      if (action === "run") {
      await runOperation(spec, evidenceDir, pin);
      // This line is informational. The terminal authority is terminal.json.
      process.stdout.write("EVIDENCE_WRITTEN\n");
      } else if (action === "verify") {
        const result = verifyEvidence(spec, evidenceDir, pin);
        process.stdout.write(JSON.stringify(result) + "\n");
        if (result.verdict !== "VERIFIED") process.exitCode = 2;
      } else throw new Error("USAGE");
    }
  } catch (error) {
    process.stderr.write(String(error?.message ?? error).slice(0, 120) + "\n");
    process.exitCode = 2;
  }
}
