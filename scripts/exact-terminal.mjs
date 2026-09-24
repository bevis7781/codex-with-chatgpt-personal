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
const SCHEMA = "c2c.exact-terminal.v2";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validateAllowlist(allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length < 1 || allowlist.length > 48 ||
      allowlist.some((key) => typeof key !== "string" || !ENV_NAME.test(key)) ||
      allowlist.join("\0") !== [...new Set(allowlist)].sort().join("\0")) {
    throw new Error("INVALID_ENVIRONMENT_ALLOWLIST");
  }
}

function relevantEnvironment(allowlist, env = process.env) {
  validateAllowlist(allowlist);
  const entries = [];
  const childEnv = {};
  for (const name of allowlist) {
    const matches = Object.keys(env).filter((key) => key.toUpperCase() === name);
    if (new Set(matches.map((key) => env[key])).size > 1) throw new Error("AMBIGUOUS_ENVIRONMENT_KEY");
    const value = matches.length === 0 ? null : env[matches[0]];
    if (value !== null && typeof value !== "string") throw new Error("INVALID_ENVIRONMENT");
    entries.push([name, value]);
    if (value !== null) childEnv[name] = value;
  }
  return { entries, childEnv };
}

export function environmentDigest(allowlist, env = process.env) {
  return sha256(JSON.stringify(relevantEnvironment(allowlist, env).entries));
}

export function helperDigest() {
  return sha256(fs.readFileSync(HERE));
}

function parseSpec(value) {
  if (!exactKeys(value, ["version", "workspaceId", "taskId", "claimId", "iteration", "nonce", "executable", "argv", "cwd", "environmentAllowlist", "environmentSha256", "maxOutputBytes", "timeoutMs"]) ||
      value.version !== 2 || typeof value.workspaceId !== "string" || !WORKSPACE_ID.test(value.workspaceId) ||
      typeof value.taskId !== "string" || !UUID_V4.test(value.taskId) ||
      typeof value.claimId !== "string" || !UUID_V4.test(value.claimId) ||
      !Number.isSafeInteger(value.iteration) || value.iteration < 1 ||
      typeof value.nonce !== "string" || !NONCE.test(value.nonce) ||
      typeof value.executable !== "string" || !path.isAbsolute(value.executable) ||
      !Array.isArray(value.argv) || value.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      typeof value.cwd !== "string" || !path.isAbsolute(value.cwd) ||
      typeof value.environmentSha256 !== "string" || !HEX.test(value.environmentSha256) ||
      !Number.isInteger(value.maxOutputBytes) || value.maxOutputBytes < 1 || value.maxOutputBytes > 65_536 ||
      !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 120_000 ||
      value.executable.includes("\0") || value.cwd.includes("\0")) throw new Error("INVALID_OPERATION_SPEC");
  validateAllowlist(value.environmentAllowlist);
  return value;
}

function readSpec(specPath) {
  const stat = fs.lstatSync(specPath);
  if (!stat.isFile() || stat.size > 100_000) throw new Error("INVALID_OPERATION_SPEC_FILE");
  return parseSpec(JSON.parse(fs.readFileSync(specPath, "utf8")));
}

export function operationDigest(spec) {
  return sha256(JSON.stringify(parseSpec(spec)));
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
  parseSpec(spec);
  if (typeof expectedHelperSha256 !== "string" || !HEX.test(expectedHelperSha256) || helperDigest() !== expectedHelperSha256) {
    throw new Error("HELPER_PIN_MISMATCH");
  }
  const { childEnv } = relevantEnvironment(spec.environmentAllowlist);
  if (environmentDigest(spec.environmentAllowlist) !== spec.environmentSha256) throw new Error("ENVIRONMENT_MISMATCH");
  if (!path.isAbsolute(evidenceDir)) throw new Error("INVALID_EVIDENCE_PATH");
  if (!fs.statSync(spec.cwd).isDirectory()) throw new Error("INVALID_CWD");
  fs.mkdirSync(evidenceDir, { recursive: false, mode: 0o700 });

  const stdout = collector(spec.maxOutputBytes);
  const stderr = collector(spec.maxOutputBytes);
  const terminal = await new Promise((resolve) => {
    let child;
    let launchError = null;
    let timedOut = false;
    let timer;
    try {
      child = spawn(spec.executable, spec.argv, { cwd: spec.cwd, env: childEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ kind: "launch_error", exitCode: null, signal: null, errorCode: String(error?.code ?? "SPAWN_THROW").slice(0, 80) });
      return;
    }
    child.stdout.on("data", (chunk) => stdout.add(chunk));
    child.stderr.on("data", (chunk) => stderr.add(chunk));
    child.on("error", (error) => { launchError = String(error?.code ?? "SPAWN_ERROR").slice(0, 80); });
    timer = setTimeout(() => { timedOut = true; child.kill(); }, spec.timeoutMs);
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
    operationSha256: operationDigest(spec),
    helperSha256: expectedHelperSha256,
    binding: { workspaceId: spec.workspaceId, taskId: spec.taskId, claimId: spec.claimId, iteration: spec.iteration, nonce: spec.nonce },
    environmentAllowlist: spec.environmentAllowlist,
    environmentSha256: spec.environmentSha256,
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
    parseSpec(spec);
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
        !exactKeys(evidence, ["schema", "operationSha256", "helperSha256", "binding", "environmentAllowlist", "environmentSha256", "terminal", "stdout", "stderr"]) ||
        evidence.schema !== SCHEMA || evidence.operationSha256 !== operationDigest(spec) ||
        !exactKeys(evidence.binding, ["workspaceId", "taskId", "claimId", "iteration", "nonce"]) ||
        evidence.binding.workspaceId !== spec.workspaceId || evidence.binding.taskId !== spec.taskId ||
        evidence.binding.claimId !== spec.claimId || evidence.binding.iteration !== spec.iteration ||
        evidence.binding.nonce !== spec.nonce ||
        !Array.isArray(evidence.environmentAllowlist) ||
        evidence.environmentAllowlist.join("\0") !== spec.environmentAllowlist.join("\0") ||
        evidence.helperSha256 !== expectedHelperSha256 || evidence.environmentSha256 !== spec.environmentSha256 ||
        !validTerminal(evidence.terminal) || !validOutput(evidence.stdout, spec.maxOutputBytes) ||
        !validOutput(evidence.stderr, spec.maxOutputBytes)) throw new Error("MALFORMED_OR_MISMATCHED_EVIDENCE");
    return { verdict: evidence.terminal.kind === "unknown" ? "UNKNOWN" : "VERIFIED", evidence };
  } catch (error) {
    return { verdict: "UNKNOWN", reason: String(error?.message ?? error).slice(0, 100) };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === HERE) {
  const [action, specPath, evidenceDir, pin] = process.argv.slice(2);
  try {
    if (!action || !specPath || !evidenceDir || !pin || process.argv.length !== 6) throw new Error("USAGE");
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
  } catch (error) {
    process.stderr.write(String(error?.message ?? error).slice(0, 120) + "\n");
    process.exitCode = 2;
  }
}
