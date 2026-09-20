import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  installPersonalTaskbookSkills,
  PERSONAL_TASKBOOK_MANAGED_MARKER,
  PERSONAL_TASKBOOK_SKILL_DIR,
} from "../src/skill/personal-taskbook.js";
import { cleanupExternalTempDirs, externalTempDir, projectWorkspaceFixture } from "./taskbook-helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(repoRoot, "src", "cli", "index.ts");

const previousCodexHome = process.env.CODEX_HOME;
const previousStateDir = process.env.C2C_STATE_DIR;

function runCli(codexHome: string, stateDir: string, cwd: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome, C2C_STATE_DIR: stateDir },
    encoding: "utf8",
    windowsHide: true,
  });
}

function installedFile(codexHome: string, relative: string): string {
  return path.join(codexHome, "skills", relative);
}

describe("Personal Taskbook Skill setup", () => {
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
    expect(publicRule).not.toMatch(/[A-Z]:[\\/]/);

    expect(installedMain).toContain(repoRoot.replace(/\\/g, "/"));
    expect(installedMain).not.toContain("<ACTUAL_CHECKOUT_PATH>");
    expect(installedRule).toContain(stateDir.replace(/\\/g, "/"));
    expect(installedRule).toContain("$workspace = (Resolve-Path .).Path");
    expect(installedRule).not.toContain("<C2C_STATE_DIR>");
    expect(installedPersonal).toContain("name: codex-with-chatgpt-personal-taskbook");
    expect(installedPersonal).toContain(PERSONAL_TASKBOOK_MANAGED_MARKER);
    expect(installedPersonal).toContain("Do not use this skill for");
    expect(installedPersonal).toContain("unbound workspaces");
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
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

afterAll(() => cleanupExternalTempDirs());
