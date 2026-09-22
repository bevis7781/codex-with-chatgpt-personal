import { spawnSync } from "node:child_process";
import path from "node:path";
import { readSecureMcpBytes, resolveSecureMcpPaths, SecureMcpError, writeSecureMcpBytes } from "./paths.js";

const PROTECT_SCRIPT = [
  "$value = [Console]::In.ReadToEnd()",
  "$bytes = [Text.Encoding]::UTF8.GetBytes($value)",
  "Add-Type -AssemblyName System.Security",
  "$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Convert]::ToBase64String($protected)",
].join("; ");

const UNPROTECT_SCRIPT = [
  "$value = [Console]::In.ReadToEnd()",
  "Add-Type -AssemblyName System.Security",
  "$bytes = [Convert]::FromBase64String($value.Trim())",
  "$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Convert]::ToBase64String($plain)",
].join("; ");

function runPowerShell(script: string, input: string): string {
  if (process.platform !== "win32") throw new SecureMcpError("SECURE_MCP_WINDOWS_ONLY", "CurrentUser DPAPI is only available on Windows.");
  const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.error || !result.stdout?.trim()) {
    throw new SecureMcpError("SECURE_MCP_DPAPI_FAILED", "CurrentUser runtime-key protection failed.");
  }
  return result.stdout.trim();
}

export function protectCurrentUserSecret(secret: string): Buffer {
  if (!secret) throw new SecureMcpError("SECURE_MCP_KEY_EMPTY", "Runtime key cannot be empty.");
  return Buffer.from(runPowerShell(PROTECT_SCRIPT, secret), "base64");
}

export function unprotectCurrentUserSecret(ciphertext: Buffer): string {
  if (ciphertext.length === 0) throw new SecureMcpError("SECURE_MCP_KEY_MISSING", "Runtime-key ciphertext is empty.");
  const encoded = runPowerShell(UNPROTECT_SCRIPT, ciphertext.toString("base64"));
  const plain = Buffer.from(encoded, "base64").toString("utf8");
  if (!plain) throw new SecureMcpError("SECURE_MCP_DPAPI_FAILED", "CurrentUser runtime-key decryption returned an empty value.");
  return plain;
}

export function setRuntimeKey(secret: string, stateDir?: string): void {
  const paths = resolveSecureMcpPaths(stateDir);
  const ciphertext = protectCurrentUserSecret(secret);
  try {
    writeSecureMcpBytes(paths.runtimeKeyFile, ciphertext);
  } finally {
    ciphertext.fill(0);
  }
}

export function readRuntimeKey(stateDir?: string): string {
  const paths = resolveSecureMcpPaths(stateDir);
  const ciphertext = readSecureMcpBytes(paths.runtimeKeyFile);
  if (!ciphertext) throw new SecureMcpError("SECURE_MCP_KEY_MISSING", "No protected Secure MCP runtime key is configured.");
  try {
    return unprotectCurrentUserSecret(ciphertext);
  } finally {
    ciphertext.fill(0);
  }
}

export function runtimeKeyStatus(stateDir?: string): { configured: boolean; decryptable: boolean; protection: string } {
  const paths = resolveSecureMcpPaths(stateDir);
  const ciphertext = readSecureMcpBytes(paths.runtimeKeyFile);
  if (!ciphertext) return { configured: false, decryptable: false, protection: "windows-current-user-dpapi" };
  try {
    const secret = unprotectCurrentUserSecret(ciphertext);
    return { configured: Boolean(secret), decryptable: true, protection: "windows-current-user-dpapi" };
  } catch {
    return { configured: true, decryptable: false, protection: "windows-current-user-dpapi" };
  } finally {
    ciphertext.fill(0);
  }
}

/** Non-echoing local prompt used only by the explicit key command. */
export async function readHiddenSecret(prompt: string, opts: { echoNewline?: boolean } = {}): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("SECURE_MCP_KEY_INPUT_REQUIRES_TTY");
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("SECURE_MCP_KEY_INPUT_CANCELLED"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          if (opts.echoNewline !== false) process.stdout.write("\n");
          const result = value;
          value = "";
          resolve(result);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else if (char >= " ") {
          value += char;
        }
      }
    };
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}
