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
import { connectorNameFor, DEFAULT_CONNECTOR_NAME, writeLastEndpoint } from "../src/config/endpoint.js";
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
    const normalized = normalizeWhitespace(section);
    const taskbookRule = fs.readFileSync(path.join(repoRoot, "skill", "PERSONAL-TASKBOOK.md"), "utf8");
    const normalizedTaskbookRule = normalizeWhitespace(taskbookRule);
    const freshnessStart = section.indexOf("1. At the start of this flow");
    const freshnessEnd = section.indexOf("2. Use the already-bound local workspace", freshnessStart);
    const freshnessGuard = normalizeWhitespace(section.slice(freshnessStart, freshnessEnd));

    expect(section).toContain("standalone `配置`");
    expect(section).toContain("OpenAI Secure MCP the default");
    expect(normalized).toContain("The local Harness performs all workspace discovery and C2C commands itself");
    expect(normalized).toContain("derive a `workspaceId`");
    expect(section).toContain("Never ask the user to run `c2c workspace`");
    expect(section).toContain("surface the detected");
    expect(normalized).toContain("Ask the user only to create or select one permanent OpenAI Tunnel");
    expect(normalized).toContain("After they provide that ID, register it yourself");
    expect(section).toContain("D-021 bound state root");
    expect(freshnessStart).toBeGreaterThanOrEqual(0);
    expect(freshnessEnd).toBeGreaterThan(freshnessStart);
    expect(freshnessGuard).toContain("c2c skill install --json");
    expect(freshnessGuard).toContain("inspect its `changed` value");
    expect(freshnessGuard).toContain("If `changed=false`");
    expect(freshnessGuard).toContain("continue normal setup immediately without restarting Codex");
    expect(freshnessGuard).toContain("If `changed=true`");
    expect(freshnessGuard).toContain("Stop the current `配置` flow");
    expect(freshnessGuard).toContain(
      "fully exit and restart Codex, reopen the same workspace, and send standalone `配置` again"
    );
    expect(freshnessGuard).toContain("Do not tell the user to delete or recreate the workspace, Tunnel, App, state root, or Runtime Key");
    expect(freshnessGuard).toContain("do not clear partial C2C state");
    const skillInstallIndex = section.indexOf("c2c skill install --json");
    for (const laterSetupAction of [
      "c2c secure-mcp key status --json",
      "c2c secure-mcp register --tunnel-id",
      "c2c connect-all --json",
      "Name: <connectorName>",
      "c2c pair -w <workspace> --json",
    ]) {
      expect(skillInstallIndex).toBeLessThan(section.indexOf(laterSetupAction));
    }
    expect(section).toContain("c2c secure-mcp runtime import --source <approved local release directory>");
    expect(section).toContain("c2c secure-mcp key status --json");
    expect(section).toContain("Case A — `configured=false`");
    expect(section).toContain("Case B — `configured=true, decryptable=true`");
    expect(section).toContain("Case C — `configured=true, decryptable=false`");
    expect(section).toContain("bounded current-execution-context limitation");
    expect(section).toContain("c2c secure-mcp key set");
    expect(section).toContain("one-time");
    expect(section).toContain("hidden-input local key setup");
    expect(section).toContain("normal trusted Windows user context");
    expect(section).toContain("never invent a default or fallback key");
    expect(section).toContain("expired, invalid, corrupted, or wrong");
    expect(section).toContain("Do not run `c2c secure-mcp key set`, `replace`, or `rotate`");
    expect(normalized).toContain("do not ask the user for it or expose secret material");
    expect(section).toContain("c2c secure-mcp register --tunnel-id tunnel_<32 lowercase hex>");
    expect(section).toContain("c2c sandbox-allow --json");
    expect(section).toContain("c2c setup -w <workspace> --json");
    expect(section).toContain("c2c connect-all --json");
    expect(section).toContain("C2C-Connect-All.cmd");
    expect(normalized).toContain("only normal host-context fallback for this branch");
    expect(section).toContain("does not execute Taskbooks");
    expect(normalized).toContain("After the user reports that it completed successfully for this workspace");
    expect(section).toContain("must not recreate the Tunnel");
    expect(normalized).toContain("reset the workspace, re-enter the key, or start a new");
    expect(section.indexOf("c2c secure-mcp register --tunnel-id")).toBeLessThan(
      section.indexOf("C2C-Connect-All.cmd")
    );
    const caseC = sectionBetween(
      section,
      "**Case C — `configured=true, decryptable=false`:**",
      "- run `c2c setup -w <workspace> --json`"
    );
    expect(caseC).toContain("Do not run `c2c secure-mcp key set`, `replace`, or `rotate`");
    expect(caseC).not.toContain("c2c connect-all --json");
    expect(section).toContain("never retry indefinitely");
    expect(section).toContain("silently\n   enter Cloudflare");
    expect(section).toContain("Name: <connectorName>");
    expect(section).toContain("Description: Securely connect ChatGPT to the current Codex workspace for planning and review.");
    expect(section).toContain("Tunnel: <registered permanent tunnel ID selected in ChatGPT>");
    expect(section).toContain("Authentication: OAuth");
    expect(section).toContain("WAIT_APP_READY");
    expect(section).toContain("WAIT_PAIRING_ACCEPTED");
    expect(normalized).toContain(
      "The first `好了` after App creation means only App ready; it MUST NOT be interpreted as pairing or authorization complete."
    );
    expect(normalized).toContain("immediately run exactly one fresh `c2c pair -w <workspace> --json`");
    expect(section).toContain("Do not generate the fresh code before the App-ready report");
    expect(section.indexOf("WAIT_APP_READY")).toBeLessThan(
      section.indexOf("c2c pair -w <workspace> --json")
    );
    expect(section.indexOf("c2c pair -w <workspace> --json")).toBeLessThan(
      section.indexOf("WAIT_PAIRING_ACCEPTED")
    );
    expect(section.indexOf("WAIT_PAIRING_ACCEPTED")).toBeLessThan(
      section.indexOf("Only after pairing/authorization acceptance")
    );
    expect(section.indexOf("Only after pairing/authorization acceptance")).toBeLessThan(
      section.indexOf('This Project uses the ChatGPT App named "<connectorName>"')
    );
    expect(normalized).toContain(
      "wait for a second `好了` or another clear report that pairing/authorization was accepted."
    );
    expect(section).toContain("c2c pair -w <workspace> --json");
    expect(section.indexOf("c2c setup -w <workspace> --json")).toBeLessThan(
      section.indexOf("c2c pair -w <workspace> --json")
    );
    expect(section).toContain('This Project uses the ChatGPT App named "<connectorName>"');
    expect(section).toContain('Expected workspaceName: "<workspaceName>".');
    expect(section).toContain('Expected workspaceId: "<workspaceId>".');
    expect(section).toContain("call workspace_info and require both workspaceName and workspaceId to match");
    expect(section).toContain("If either value does not match, stop and report a routing failure");
    expect(section).toContain("use only \"<connectorName>\"");
    expect(section).toContain("Cross-workspace use is allowed only when the user explicitly asks in the current message.");
    expect(normalized).toContain("replace all three placeholders with the exact `connectorName`, `workspaceName`, and `workspaceId` from this setup's JSON");
    expect(section).toContain("The user performs the Platform/App/OAuth action themselves");
    expect(section).toContain("Do not force a connectivity test");

    expect(section).not.toContain("This Project defaults to its declared C2C connector/workspace.");
    expect(section).not.toContain("setupMode");
    expect(section).not.toContain("setupChoicePrompt");
    expect(section).not.toContain("Connection choice");
    expect(section).not.toContain("c2c prefs --json");
    expect(section).not.toContain("preferredNamedZone");
    expect(section).not.toContain("automatically provisions Named Tunnel");
    expect(section).not.toContain("Server URL: <mcpUrl>");
    expect(section).not.toContain("chatgpt.com/plugins");
    expect(section).toContain("workspace_info");
    expect(section).not.toContain("read_file");
    expect(section).not.toContain("c2c session set");
    expect(section).not.toContain("文件读取测试通过");

    expect(taskbookRule).toContain("normal Harness claim path MUST NOT pass `--authorized-at`");
    expect(normalizedTaskbookRule).toContain("C2C core generates the canonical UTC authorization timestamp");
    expect(normalizedTaskbookRule).toContain("one new lowercase UUID v4 `authorizationId`");
    expect(normalizedTaskbookRule).toContain("queue is empty or the attempt stops with an error");
    const claimCommand = taskbookRule.match(/c2c taskbook claim[\s\S]*?--harness <label>/)?.[0];
    expect(claimCommand).toBeDefined();
    expect(claimCommand).not.toContain("--authorized-at");
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
      const exactTerminal = normalizeWhitespace(
        sectionBetween(
          installed,
          "## Pinned local exact-terminal evidence exception",
          "## Recover procedure"
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
      expect(knownHostPublication).toContain("accepted local `HEAD` before publication");
      expect(knownHostPublication).toContain("push terminal status describes that command; it does not prove the remote result");
      expect(knownHostPublication).toContain("Only a fresh server readback showing the intended ref at the accepted commit proves that remote state");
      expect(knownHostPublication).toContain("`origin/main`, ahead/behind counts, and worktree cleanliness");
      expect(knownHostPublication).toContain("not universal proof of remote publication");
      expect(knownHostPublication).toContain("Require them only when the claimed Taskbook does");
      expect(knownHostPublication).toContain("If push terminal status is unknown but fresh server readback proves the accepted target SHA");
      expect(knownHostPublication).toContain("Do not invent exit code `0` or repeat a side-effecting push");
      expect(knownHostPublication).toContain("Finish only if this Taskbook's own evidence contract is otherwise met");
      expect(knownHostPublication).toContain("Missing or ambiguous readback, remote failure, or a ref/SHA mismatch blocks publication acceptance");
      expect(knownHostPublication).toContain("it never authorizes replaying the push");
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

      expect(exactTerminal).toContain("The helper is conditional, not the default entry for ordinary commands or known-host Git publication");
      expect(exactTerminal).toContain("environment allowlist, invariant validation, or controlled cross-environment comparison");
      expect(exactTerminal).toContain("Ordinary execution does not inherit the helper's environment-isolation guarantees");
      expect(exactTerminal).toContain("A side-effecting operation with lost terminal evidence must not be rerun");
      expect(exactTerminal).toContain("For each helper-backed operation, construct one immutable version-3 spec");
      expect(exactTerminal).toContain("For a genuine D-025 host-context fallback");
      expect(exactTerminal).toContain("Do not manufacture a sandbox/retry pair for the already-classified known-host Git publication path");
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

  it("returns the exact connector identity for fresh and existing local Secure MCP workspaces", async () => {
    const codexHome = externalTempDir("c2c-personal-setup-home");
    const stateDir = externalTempDir("c2c-personal-setup-state");
    const workspace = projectWorkspaceFixture();
    process.env.CODEX_HOME = codexHome;
    process.env.C2C_STATE_DIR = stateDir;

    try {
      const args = [
        "setup",
        "--workspace",
        workspace,
        "--no-tunnel",
        "--json",
      ];
      const result = runCli(codexHome, stateDir, repoRoot, args);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        ok: true,
        transport: "openai-secure-mcp",
        workspaceId: expect.any(String),
        workspaceName: expect.any(String),
        connectorName: expect.any(String),
        personalTaskbook: { ok: true },
      });
      expect(payload.connectorName).toBe(
        connectorNameFor({
          workspaceName: payload.workspaceName,
          workspaceId: payload.workspaceId,
          hadEndpointBefore: false,
        })
      );
      expect(payload.connectorName).not.toBe(DEFAULT_CONNECTOR_NAME);
      expect(fs.existsSync(installedFile(codexHome, `${PERSONAL_TASKBOOK_SKILL_DIR}/SKILL.md`))).toBe(true);

      writeLastEndpoint({ workspaceId: payload.workspaceId, port: 3708, publicUrl: null, mcpUrl: null });
      const legacy = runCli(codexHome, stateDir, repoRoot, args);
      expect(legacy.status, `${legacy.stdout}\n${legacy.stderr}`).toBe(0);
      expect(JSON.parse(legacy.stdout).connectorName).toBe(DEFAULT_CONNECTOR_NAME);

      writeLastEndpoint({
        workspaceId: payload.workspaceId,
        port: 3708,
        publicUrl: null,
        mcpUrl: null,
        connectorName: "Existing ChatGPT App",
      });
      const existing = runCli(codexHome, stateDir, repoRoot, args);
      expect(existing.status, `${existing.stdout}\n${existing.stderr}`).toBe(0);
      expect(JSON.parse(existing.stdout).connectorName).toBe("Existing ChatGPT App");
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
