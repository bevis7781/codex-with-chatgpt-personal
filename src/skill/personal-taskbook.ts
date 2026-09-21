import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCodexHome } from "../config/sandbox-allow.js";
import { bindStateRoot, getStateDir } from "../config/paths.js";

export const PERSONAL_TASKBOOK_SKILL_DIR = "codex-with-chatgpt-personal-taskbook";
export const PERSONAL_TASKBOOK_MANAGED_MARKER =
  "<!-- Managed source for the Codex with ChatGPT Personal Taskbook skill. -->";

export interface PersonalTaskbookInstallOptions {
  checkoutRoot?: string;
  codexHome?: string;
  stateDir?: string;
}

export interface PersonalTaskbookInstallResult {
  ok: true;
  changed: boolean;
  checkoutRoot: string;
  codexHome: string;
  files: string[];
}

interface InstallFile {
  destination: string;
  content: string;
  managed: boolean;
}

/**
 * Return the checkout containing this source file in both src/ and dist/ builds.
 * The public source never contains a machine-specific checkout path.
 */
export function resolveCheckoutRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Install the C2C Skill and the explicit Personal Taskbook entry point.
 *
 * The operation is deliberately local and idempotent. It preflights every
 * target before writing so a conflicting personal-taskbook skill cannot leave
 * a half-updated installation behind. Symlink targets are rejected instead of
 * being followed.
 */
export function installPersonalTaskbookSkills(
  options: PersonalTaskbookInstallOptions = {}
): PersonalTaskbookInstallResult {
  const checkoutRoot = path.resolve(options.checkoutRoot ?? resolveCheckoutRoot());
  const codexHome = path.resolve(options.codexHome ?? getCodexHome());
  const stateDir = path.resolve(options.stateDir ?? getStateDir());
  const sourceSkill = path.join(checkoutRoot, "skill", "SKILL.md");
  const sourceRule = path.join(checkoutRoot, "skill", "PERSONAL-TASKBOOK.md");

  const skillSource = readRequiredSource(sourceSkill);
  const ruleSource = readRequiredSource(sourceRule);
  if (!ruleSource.includes(PERSONAL_TASKBOOK_MANAGED_MARKER)) {
    throw new Error("skill/PERSONAL-TASKBOOK.md is missing its managed-source marker.");
  }

  const renderedSkill = renderTemplate(skillSource, checkoutRoot, stateDir);
  const renderedRule = renderTemplate(ruleSource, checkoutRoot, stateDir);
  const mainSkillDir = path.join(codexHome, "skills", "codex-with-chatgpt");
  const personalSkillDir = path.join(codexHome, "skills", PERSONAL_TASKBOOK_SKILL_DIR);
  const files: InstallFile[] = [
    {
      destination: path.join(mainSkillDir, "SKILL.md"),
      content: renderedSkill,
      managed: false,
    },
    {
      destination: path.join(mainSkillDir, "PERSONAL-TASKBOOK.md"),
      content: renderedRule,
      managed: true,
    },
    {
      destination: path.join(personalSkillDir, "SKILL.md"),
      content: renderedRule,
      managed: true,
    },
  ];

  for (const file of files) preflightTarget(file);
  // Bind the state root before writing managed Skill files so a later CLI or
  // bridge invocation without an environment override resolves identically.
  bindStateRoot(stateDir, codexHome);
  for (const file of files) ensureParentDirectory(file.destination);

  let changed = false;
  for (const file of files) {
    if (writeIfChanged(file.destination, file.content)) changed = true;
  }

  return {
    ok: true,
    changed,
    checkoutRoot,
    codexHome,
    files: files.map((file) => file.destination),
  };
}

function readRequiredSource(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Personal Taskbook skill source is unavailable: ${file} (${(error as Error).message})`);
  }
}

function renderTemplate(source: string, checkoutRoot: string, stateDir: string): string {
  return source
    .replaceAll("<ACTUAL_CHECKOUT_PATH>", toPortablePath(checkoutRoot))
    .replaceAll("<C2C_STATE_DIR>", toPortablePath(stateDir));
}

function toPortablePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function preflightTarget(file: InstallFile): void {
  const parent = path.dirname(file.destination);
  preflightDirectory(parent);
  if (!fs.existsSync(file.destination)) return;

  const stat = fs.lstatSync(file.destination);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to write through a symbolic link: ${file.destination}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to replace a non-file Skill target: ${file.destination}`);
  }

  if (file.managed) {
    const existing = fs.readFileSync(file.destination, "utf8");
    if (!isOwnedPersonalTaskbookRule(existing)) {
      throw new Error(`Refusing to overwrite an unmanaged Personal Taskbook Skill: ${file.destination}`);
    }
  }
}

function isOwnedPersonalTaskbookRule(content: string): boolean {
  if (content.includes(PERSONAL_TASKBOOK_MANAGED_MARKER)) return true;
  // Upgrade the pre-installer Rule that the public docs previously asked
  // existing users to copy by hand, while still rejecting unrelated skills.
  return (
    content.includes("# Personal Taskbook Harness Rule") &&
    content.includes("A standalone user `Do` is one authorization event") &&
    content.includes("c2c taskbook finish")
  );
}

function preflightDirectory(directory: string): void {
  let current = path.resolve(directory);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (fs.existsSync(current) && !fs.lstatSync(current).isDirectory()) {
    throw new Error(`Refusing to use a non-directory Skill parent: ${current}`);
  }
}

function ensureParentDirectory(file: string): void {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true });
  if (!fs.lstatSync(parent).isDirectory()) {
    throw new Error(`Skill parent is not a directory: ${parent}`);
  }
}

function writeIfChanged(file: string, content: string): boolean {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return false;
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  return true;
}
