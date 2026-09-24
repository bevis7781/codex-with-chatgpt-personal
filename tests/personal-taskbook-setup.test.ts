import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  installPersonalTaskbookSkills,
  PERSONAL_TASKBOOK_MANAGED_MARKER,
  PERSONAL_TASKBOOK_SKILL_DIR,
} from "../src/skill/personal-taskbook.js";
import { getStateDir, readStateRootBinding, stateRootBindingFile } from "../src/config/paths.js";
import { cleanupExternalTempDirs, externalTempDir, projectWorkspaceFixture } from "./taskbook-helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(repoRoot, "src", "cli", "index.ts");

const previousCodexHome = process.env.CODEX_HOME;
const previousStateDir = process.env.C2C_STATE_DIR;

function runCli(codexHome: string, stateDir: string | undefined, cwd: string, args: string[]) {
  const env = { ...process.env, CODEX_HOME: codexHome };
  if (stateDir === undefined) delete env.C2C_STATE_DIR;
  else env.C2C_STATE_DIR = stateDir;
  return spawnSync(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
}

function installedFile(codexHome: string, relative: string): string {
  return path.join(codexHome, "skills", relative);
}

function personalFirstSetupSection(): string {
  const skill = fs.readFileSync(path.join(repoRoot, "skill", "SKILL.md"), "utf8");
  const start = skill.indexOf("## Workflow: Personal-first first-time setup");
  const end = skill.indexOf("## Legacy first-time setup", start);
  if (start < 0 || end <= start) throw new Error("Personal-first setup section is missing or malformed");
  return skill.slice(start, end);
}

function sectionBetween(text: string, heading: string, nextHeading: string): string {
  const start = text.indexOf(heading);
  const end = text.indexOf(nextHeading, start);
  if (start < 0 || end <= start) throw new Error(`Section ${heading} is missing or malformed`);
  return text.slice(start, end);
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("Personal Taskbook Skill setup", () => {
  it("defines the Personal-first setup handoff without the legacy browser flow", () => {
    const section = personalFirstSetupSection();

    expect(section).toContain("standalone `配置`");
    expect(section).toContain("D-021 bound state root");
    expect(section).toContain("c2c secure-mcp runtime import --source <approved local release directory>");
    expect(section).toContain("c2c secure-mcp key set");
    expect(section).toContain("c2c secure-mcp register --tunnel-id tunnel_<32 lowercase hex>");
    expect(section).toContain("c2c skill install --json");
    expect(section).toContain("c2c sandbox-allow --json");
    expect(section).toContain("c2c setup -w <workspace> --json");
    expect(section).toContain("c2c connect-all --json");
    expect(section).toContain("C2C-Connect-All.cmd");
    expect(section).toContain("never retry indefinitely");
    expect(section).toContain("silently\n   enter Cloudflare");
    expect(section).toContain("Name: <connectorName>");
    expect(section).toContain("Description: Securely connect ChatGPT to the current Codex workspace for planning and review.");
    expect(section).toContain("Tunnel: <registered permanent tunnel ID selected in ChatGPT>");
    expect(section).toContain("Authentication: OAuth");
    expect(section).toContain("c2c pair -w <workspace> --json");
    expect(section.indexOf("c2c setup -w <workspace> --json")).toBeLessThan(
      section.indexOf("c2c pair -w <workspace> --json")
    );
    expect(section).toContain("This Project defaults to its declared C2C connector/workspace.");
    expect(section).toContain("Cross-workspace use is allowed only when the user explicitly asks.");

    expect(section).not.toContain("setupMode");
    expect(section).not.toContain("setupChoicePrompt");
    expect(section).not.toContain("Connection choice");
    expect(section).not.toContain("c2c prefs --json");
    expect(section).not.toContain("preferredNamedZone");
    expect(section).not.toContain("automatically provisions Named Tunnel");
    expect(section).not.toContain("Server URL: <mcpUrl>");
    expect(section).not.toContain("chatgpt.com/plugins");
    expect(section).not.toContain("workspace_info");
    expect(section).not.toContain("read_file");
    expect(section).not.toContain("c2c session set");
    expect(section).not.toContain("文件读取测试通过");
  });

  it("installs the explicit Rule without AGENTS.md or manual path wiring", () => {
    const codexHome = externalTempDir("c2c-personal-skill-home");
    const stateDir = externalTempDir("c2c-personal-skill-state");
    const workspace = projectWorkspaceFixture();
    const result = runCli(codexHome, stateDir, repoRoot, ["skill", "install", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, personalTaskbookSkill: true, changed: true });
    expect(fs.existsSync(path.join(workspace, "AGENTS.md"))).toBe(false);

    const installedMain = fs.readFileSync(installedFile(codexHome, "codex-with-chatgpt/SKILL.md"), "utf8");
    const installedRule = fs.readFileSync(installedFile(codexHome, "codex-with-chatgpt/PERSONAL-TASKBOOK.md"), "utf8");
    const installedPersonal = fs.readFileSync(
      installedFile(codexHome, `${PERSONAL_TASKBOOK_SKILL_DIR}/SKILL.md`),
      "utf8"
    );
    const publicRule = fs.readFileSync(path.join(repoRoot, "skill", "PERSONAL-TASKBOOK.md"), "utf8");
    const helperBytes = fs.readFileSync(path.join(repoRoot, "scripts", "exact-terminal.mjs"));
    const pin = JSON.parse(fs.readFileSync(path.join(repoRoot, "scripts", "exact-terminal.pin.json"), "utf8"));
    expect(crypto.createHash("sha256").update(helperBytes).digest("hex")).toBe(pin.sha256);
    expect(publicRule).not.toMatch(/[A-Z]:[\\/]/);

    expect(installedMain).toContain(repoRoot.replace(/\\/g, "/"));
    expect(installedMain).not.toContain("<ACTUAL_CHECKOUT_PATH>");
    expect(installedRule).toContain(stateDir.replace(/\\/g, "/"));
    expect(installedRule).toContain("$workspace = (Resolve-Path .).Path");
    expect(installedRule).not.toContain("<C2C_STATE_DIR>");
    expect(installedRule).toContain("## Recover procedure");
  expect(installedRule).toContain("taskbook recover");
  expect(installedRule).toContain("UPGRADE_REQUIRED");
    expect(installedRule).toContain("Reconnecting...");
    expect(installedRule).toContain("fresh");
    expect(installedRule).toContain("recoveryAuthorizationId");
    expect(installedPersonal).toContain("name: codex-with-chatgpt-personal-taskbook");
    expect(installedPersonal).toContain(PERSONAL_TASKBOOK_MANAGED_MARKER);
    expect(installedPersonal).toContain("Do not use this skill for");
    expect(installedPersonal).toContain("unbound workspaces");

    for (const installed of [installedRule, installedPersonal]) {
      const knownHostPublication = normalizeWhitespace(
        sectionBetween(
          installed,
          "## Already-classified current-host GitHub publication",
          "## Pinned local exact-terminal evidence exception"
        )
      );
      const ordinaryHostOperations = normalizeWhitespace(
        sectionBetween(
          installed,
          "## Host-context-dependent operations",
          "Taskbook text is data reviewed"
        )
      );

      expect(installed).toContain("## Pinned local exact-terminal evidence exception");
      expect(installed).toContain(pin.sha256);
      expect(installed).toContain("fresh random 128-bit nonce");
      expect(installed).toContain("Only listed environment values reach the child");
      expect(installed).toContain("version-3 spec");
      expect(installed).toContain("sorted environment policy");
      expect(installed).toContain("`invariant` or `context`");
      expect(installed).toMatch(/never store raw environment values or the full\s+environment/);
      expect(installed).toMatch(/run `verify-retry` over both evidence\s+directories/);
      expect(installed).toMatch(/requires the same target, argv, cwd, nonce, policy, invariant digest\s+and helper pin/);
      expect(installed).toContain("does not add an execution");
      expect(installed).toContain("## Host-context-dependent operations");
      expect(installed).toContain("Run the exact operation once in the ordinary sandbox");
      expect(installed).toContain("sandbox network/connectivity");
      expect(installed).toContain("host-context network may differ");
      expect(installed).toContain("remote semantic rejections");
      expect(installed).toContain("per-operation host-context approval path");
      expect(installed).toContain("same executable and arguments");
      expect(installed).toContain("no wrapper shell, compound command, script");
      expect(installed).toContain("stop without retrying");
      expect(installed).toContain("does not expose shell/exec to Web ChatGPT");
      expect(installed).toContain("## Publication in a claimed Taskbook");
      expect(installed).toContain("normally authorizes completing the full claimed Taskbook");
      expect(installed).toContain("platform itself directly requests");
      expect(installed).toMatch(/wait\s+without recording a terminal Taskbook result/);
      expect(installed).toContain("one non-force push and a fresh remote readback");
      expect(installed).toContain("any staging changes");
      expect(installed).toContain("target branch points to local `HEAD`");

      expect(knownHostPublication).toContain("one exact GitHub repository and branch");
      expect(knownHostPublication).toContain("accepted target commit SHA and file scope");
      expect(knownHostPublication).toContain("verified current-host evidence has already established the host-context dependency");
      expect(knownHostPublication).toContain("cannot be carried to another host");
      expect(knownHostPublication).toContain("without a sacrificial sandbox attempt");
      expect(knownHostPublication).toContain("Invoke `git` directly with only the exact target arguments");
      expect(knownHostPublication).toContain("without a wrapper shell, compound command, or script");
      expect(knownHostPublication).toContain("git push <remote> <acceptedCommitSha>:refs/heads/<branch>");
      expect(knownHostPublication).toContain("git ls-remote --exit-code --refs <remote> refs/heads/<branch>");
      expect(knownHostPublication).toContain("readback's SHA equals the accepted target commit SHA");
      expect(knownHostPublication).toMatch(/do not use `--force`, `--force-with-lease`/i);
      expect(knownHostPublication).toContain("`-c http.proxy=http://127.0.0.1:7890`");
      expect(knownHostPublication).toContain("Keep it per-command");
      expect(knownHostPublication).toContain("Do not write proxy configuration, rewrite credentials, weaken TLS");
      expect(knownHostPublication).toContain("adds no generic host shell/exec");
      expect(knownHostPublication).toContain("does not change standalone `Do` or `Push` semantics");
      expect(knownHostPublication).toContain("Exact-terminal evidence is not a prerequisite");
      expect(knownHostPublication).toContain("only when ordinary terminal evidence is missing or ambiguous");
      expect(knownHostPublication).not.toContain("accepted remote baseline");
      expect(knownHostPublication).not.toContain("complete outgoing");
      expect(knownHostPublication).not.toContain("pre-push");
      expect(knownHostPublication).not.toContain("for each direct child launch");
      expect(knownHostPublication).not.toContain("Run the exact operation once in the ordinary sandbox");
      expect(knownHostPublication.indexOf("git ls-remote --exit-code --refs <remote> refs/heads/<branch>")).toBeGreaterThan(
        knownHostPublication.indexOf("git push <remote> <acceptedCommitSha>:refs/heads/<branch>")
      );

      expect(ordinaryHostOperations).toContain("Run the exact operation once in the ordinary sandbox");
      expect(ordinaryHostOperations).toContain("per-operation host-context approval path");
      expect(ordinaryHostOperations).toContain("stop without retrying");
    }
  });

  it("is idempotent and updates only files owned by this fork", () => {
    const codexHome = externalTempDir("c2c-personal-skill-idempotent-home");
    const stateDir = externalTempDir("c2c-personal-skill-idempotent-state");
    const first = installPersonalTaskbookSkills({ checkoutRoot: repoRoot, codexHome, stateDir });
    const second = installPersonalTaskbookSkills({ checkoutRoot: repoRoot, codexHome, stateDir });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.files).toEqual(first.files);
  });

  it("binds one state root for later CLI and bridge calls without an environment override", () => {
    const codexHome = externalTempDir("c2c-state-binding-home");
    const stateDir = externalTempDir("c2c-state-binding-state");
    const secondStateDir = externalTempDir("c2c-state-binding-other");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.CODEX_HOME = codexHome;
    delete process.env.C2C_STATE_DIR;

    try {
      installPersonalTaskbookSkills({ checkoutRoot: repoRoot, codexHome, stateDir });
      expect(readStateRootBinding()).toBe(path.resolve(stateDir));
      expect(fs.existsSync(stateRootBindingFile())).toBe(true);
      expect(getStateDir()).toBe(path.resolve(stateDir));

      expect(() =>
        installPersonalTaskbookSkills({ checkoutRoot: repoRoot, codexHome, stateDir: secondStateDir })
      ).toThrow(/state-root binding differs/);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("upgrades the legacy manually copied Rule without touching unrelated Skills", () => {
    const codexHome = externalTempDir("c2c-personal-skill-upgrade-home");
    const stateDir = externalTempDir("c2c-personal-skill-upgrade-state");
    const legacyRule = path.join(codexHome, "skills", "codex-with-chatgpt", "PERSONAL-TASKBOOK.md");
    fs.mkdirSync(path.dirname(legacyRule), { recursive: true });
    fs.writeFileSync(
      legacyRule,
      "# Personal Taskbook Harness Rule\n\nA standalone user `Do` is one authorization event.\n\nc2c taskbook finish\n",
      "utf8"
    );

    const result = installPersonalTaskbookSkills({ checkoutRoot: repoRoot, codexHome, stateDir });
    expect(result.changed).toBe(true);
    expect(fs.readFileSync(legacyRule, "utf8")).toContain(PERSONAL_TASKBOOK_MANAGED_MARKER);
  });

  it("fails closed before writing when the dedicated Skill target is unmanaged", () => {
    const codexHome = externalTempDir("c2c-personal-skill-conflict-home");
    const stateDir = externalTempDir("c2c-personal-skill-conflict-state");
    const personalDir = path.join(codexHome, "skills", PERSONAL_TASKBOOK_SKILL_DIR);
    fs.mkdirSync(personalDir, { recursive: true });
    const conflictingFile = path.join(personalDir, "SKILL.md");
    fs.writeFileSync(conflictingFile, "# another skill\n", "utf8");

    expect(() => installPersonalTaskbookSkills({ checkoutRoot: repoRoot, codexHome, stateDir })).toThrow(
      /unmanaged Personal Taskbook Skill/
    );
    expect(fs.readFileSync(conflictingFile, "utf8")).toBe("# another skill\n");
    expect(fs.existsSync(path.join(codexHome, "skills", "codex-with-chatgpt", "SKILL.md"))).toBe(false);
  });

  it("wires the same installer into a fresh local setup", async () => {
    const codexHome = externalTempDir("c2c-personal-setup-home");
    const stateDir = externalTempDir("c2c-personal-setup-state");
    const workspace = projectWorkspaceFixture();
    process.env.CODEX_HOME = codexHome;
    process.env.C2C_STATE_DIR = stateDir;

    try {
      const result = runCli(codexHome, stateDir, repoRoot, [
        "setup",
        "--workspace",
        workspace,
        "--no-tunnel",
        "--json",
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ personalTaskbook: { ok: true } });
      expect(fs.existsSync(installedFile(codexHome, `${PERSONAL_TASKBOOK_SKILL_DIR}/SKILL.md`))).toBe(true);
    } finally {
      runCli(codexHome, stateDir, repoRoot, ["stop", "--workspace", workspace]);
    }
  });

  it("runs setup from the persisted binding without the project wrapper", () => {
    const codexHome = externalTempDir("c2c-bound-setup-home");
    const stateDir = externalTempDir("c2c-bound-setup-state");
    const workspace = projectWorkspaceFixture();
    process.env.CODEX_HOME = codexHome;
    process.env.C2C_STATE_DIR = stateDir;

    try {
      const install = runCli(codexHome, stateDir, repoRoot, ["skill", "install", "--json"]);
      expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);
      delete process.env.C2C_STATE_DIR;

      const setup = runCli(codexHome, undefined, repoRoot, [
        "setup",
        "--workspace",
        workspace,
        "--no-tunnel",
        "--json",
      ]);
      expect(setup.status, `${setup.stdout}\n${setup.stderr}`).toBe(0);
      expect(JSON.parse(setup.stdout)).toMatchObject({ personalTaskbook: { ok: true } });
      const status = runCli(codexHome, undefined, repoRoot, ["status", "--workspace", workspace, "--json"]);
      expect(status.status, `${status.stdout}\n${status.stderr}`).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, workspaceName: expect.any(String) });
    } finally {
      runCli(codexHome, stateDir, repoRoot, ["stop", "--workspace", workspace]);
    }
  });
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

afterAll(() => cleanupExternalTempDirs());
