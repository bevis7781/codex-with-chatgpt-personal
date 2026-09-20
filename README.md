# Codex with ChatGPT Personal Fork

> ChatGPT thinks. Codex works.
> ChatGPT 负责思考，Codex 负责干活。

This repository is a **Personal Fork** of [`XiaoDuoYa/codex-with-chatgpt`](https://github.com/XiaoDuoYa/codex-with-chatgpt). It keeps the upstream idea—ChatGPT reasons and reviews while the local Codex Harness executes—and adds a bounded V0.1 Taskbook workflow.

> [!IMPORTANT]
> **遇到问题？** 请先向 Codex 发送 **「更新 Codex with ChatGPT」** 并重试。更新到最新版本可以解决大多数已知问题。  
> **Having trouble?** First ask Codex to **“Update Codex with ChatGPT”** and try again. Updating to the latest version resolves most known issues.

## The problem · 解决什么问题

**中文** — ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的
API 额度做规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，
Codex 只负责执行。不用 API Key、不搞逆向代理——官方网页 + 受控 MCP 桥接。

**EN** — ChatGPT Plus/Pro web quota sits idle while your coding agent burns
scarce API/Codex tokens on planning and review. This project moves the
thinking to the subscription you already pay for; Codex only executes.
No API keys, no reverse proxy — official web UI plus a guarded MCP bridge.

## What it is · 这是什么

**中文** — 把 ChatGPT 网页版变成 Codex 编码会话的"规划与审查大脑"，执行权
完全保留在 Codex 手里。你的仓库永远不会被上传：ChatGPT 通过安全的、OAuth
保护的 MCP 连接按需读取工作区内容；如明确授予 `taskbook.submit`，它也只能
提交一个受边界约束的 Taskbook，不会直接修改项目或运行命令。

**EN** — Use the ChatGPT web app as the planning and review brain for your
Codex coding sessions, while Codex keeps full ownership of execution. Your
repository is never uploaded: ChatGPT reads exactly what it needs through a
secure, OAuth-protected MCP connection to your current workspace. An explicit
`taskbook.submit` grant can queue bounded task text, but cannot write project
files or run commands.

Detailed docs below are in English · 详细中文文档见 **[README.zh-CN.md](README.zh-CN.md)**

## V0.1 Taskbook workflow

The fork adds one deliberately narrow path from Web ChatGPT to the local
Harness:

1. Web ChatGPT submits `title + body` through `submit_taskbook` when the
   separate `taskbook.submit` scope has been explicitly authorized.
2. C2C stores the opaque task in workspace-scoped state; submission does not
   write project files, choose a workspace or path, start a process, or execute
   the task.
3. The user sends one standalone local `Do`.
4. The local Harness claims and executes at most one eligible task, records
   verification and evidence, then stops.
5. Web ChatGPT can independently audit the resulting diff, tests, and evidence
   through the existing read-only tools.

`Web submit → local Do → one-task execution → evidence → Web audit`

Remote authority remains intentionally narrow: there is no generic
`write_file`, delete, shell, or exec tool, and callers cannot select the
project path or workspace. Task submission is explicit, separate from default
read scopes, and never auto-executes.

## Install and setup this fork

1. Clone this repository: `https://github.com/bevis7781/codex-with-chatgpt-personal.git`.
2. In the checkout, run `corepack pnpm install` and `corepack pnpm build`.
3. Configure the workspace connector through the existing C2C setup and
   pairing flow.
4. If Web ChatGPT should submit Taskbooks, explicitly authorize
   `taskbook.submit` and load the repository-local
   `skill/PERSONAL-TASKBOOK.md` in a supported local Harness for `Do` / `Read`.

## One-paste install · 一段话安装

**中文** — 不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的
编码 Agent（Codex），然后去倒杯咖啡：

```text
请帮我完整安装并配置 Codex with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/bevis7781/codex-with-chatgpt-personal 克隆到
   ~/codex-with-chatgpt-personal（已存在就 git pull 更新）。
3. 构建：在该目录里执行 corepack pnpm install 和 corepack pnpm build。
4. 安装 Skill：把仓库里的 skill/SKILL.md 复制到
   ~/.codex/skills/codex-with-chatgpt/SKILL.md，并把文件中
   "The codex-with-chatgpt checkout lives at:" 那一行的路径改成实际克隆路径。
5. 首次配置：按 SKILL.md 里的 first-time setup 流程执行
  （运行 c2c setup，用内置浏览器打开 ChatGPT 配置连接器并输入配对码）。
   全程只用内置浏览器，禁止打开任何第三方浏览器。
6. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作。
7. 完成后给我看 ✓ 清单，并确认文件读取测试通过。我不懂 MCP、OAuth、
   Tunnel、端口这些词，不要向我解释；出了问题先自己修。
```


**EN** — Don't know git, Node, or terminals? You don't need to. Copy the
paragraph below, paste it to your coding agent (Codex), and go grab a coffee:

```text
Please install and configure "Codex with ChatGPT" for me, fully automatically.
I am a non-technical user — do everything yourself:

1. Check the environment: git and Node.js >= 20 must be available. Install
   anything missing yourself (macOS: Homebrew, Windows: winget). Also install
   cloudflared.
2. Download: clone https://github.com/bevis7781/codex-with-chatgpt-personal into
   ~/codex-with-chatgpt-personal (if it already exists, git pull to update).
3. Build: inside that folder run `corepack pnpm install` then `corepack pnpm build`.
4. Install the Skill: copy skill/SKILL.md to
   ~/.codex/skills/codex-with-chatgpt/SKILL.md, and update the line
   "The codex-with-chatgpt checkout lives at:" to the actual clone path.
5. First-time setup: follow the SKILL.md "first-time setup" workflow
   (run c2c setup, configure the ChatGPT connector in the BUILT-IN browser,
   enter the pairing code). Never open a third-party browser.
6. Only interrupt me for logins (ChatGPT / Cloudflare), CAPTCHAs or 2FA —
   and give me exactly ONE action at a time.
7. When done, show me the ✓ checklist and confirm the file-read test passed.
   I don't know what MCP, OAuth, tunnels or ports are. Don't explain them.
   If anything breaks, fix it yourself first.
```


**Updates · 更新** — The Skill checks GitHub once a day and updates itself when a
new version is released; no action needed. You can also say "更新 Codex with ChatGPT"
anytime. / Skill 每天自动检查一次 GitHub，有新版本会自动更新，无需任何操作；
也可以随时对 Codex 说"更新 Codex with ChatGPT"。

---

*The sections below are in English. 以下详细内容为英文，中文完整版见
[README.zh-CN.md](README.zh-CN.md)。*

## Install → Setup → Use (manual)

1. Install the Codex Skill: copy `skill/` to `~/.codex/skills/codex-with-chatgpt/`.
2. Tell Codex: **"Set up Codex with ChatGPT."** (中文: "使用 Codex with ChatGPT 完成首次配置。")
3. Use Codex normally: **"Use Codex with ChatGPT to implement XXX."**

That's the whole manual. You don't need to know what MCP, OAuth, tunnels,
ports or localhost are — Codex configures everything automatically and you
just see:

```
Codex with ChatGPT

✓ Project detected
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ File read test passed

Ready.
```

The only steps that may need you: logging into ChatGPT (and, if you want a
stable hostname, logging into Cloudflare once). A **new** workspace also asks
you to create a ChatGPT Project (collection) once — pick **project-only
memory**, name it after the workspace. If the sidebar has no Projects row,
hover **Chats**, open the … menu, and choose **Organize by project**. Codex
then saves that collection link and starts chats from that page. Existing
workspaces that already have a C2C chat stay on the old one-conversation
style until you ask to switch.

### Optional stable hostname

The default public address is a temporary Cloudflare URL. It changes when the
bridge restarts, and Codex repairs ChatGPT by deleting that workspace's
connector and adding it again.

If you have a Cloudflare account and a domain already on Cloudflare, first-time
setup (and the next coding session, once) will ask whether you want a stable
hostname such as `c2c-<project>.your-domain.com`. That path opens a browser so
you can authorize Cloudflare. After that, the ChatGPT connector keeps working
across restarts. If you skip it, or the login fails, Codex stays on the temporary
address — same features, just a slower repair.

Credentials stay in the OS app state directory, not in the project.

## How it works

```
             ┌───────────────────────────┐
             │       ChatGPT Web         │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane (<1 KB messages)
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   loopback-only HTTP server
             │  guarded MCP       │   OAuth 2.1 + one-time pairing code
             │  OAuth + Pairing    │   Cloudflare Quick Tunnel
             │  Tunnel Manager     │
             └──────────┬──────────┘
                        │  guarded access
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │   Local Workspace   │◀─────────│    Codex Harness    │
             └─────────────────────┘ edit/git │ shell / tests / fix │
                                              └─────────────────────┘
```

- **Control plane (Computer Use)**: Codex and ChatGPT exchange tiny structured
  `[C2C]` state messages — `INIT → PLAN → EXECUTED → REVIEW → DONE`. No diffs,
  no logs, no file bodies are ever pasted.
- **Data plane (MCP)**: ChatGPT pulls what it needs through the existing
  read-only workspace, diff, test, and evidence tools. With the explicit
  `taskbook.submit` scope, it may also submit `title + body` into workspace-
  scoped C2C task state; that mutation never writes project files or executes
  commands.
- **Independent review**: after Codex executes, ChatGPT inspects the actual
  git diff and test records through MCP — it never trusts "all tests passed"
  claims blindly.

## Security model (short version)

- **Remote authority is deliberately narrow**: generic write/delete/shell/exec
  tools simply do not exist on the server, and callers cannot choose a project
  path or workspace. No prompt injection can enable them.
- **Taskbook submission is explicit and non-executing**: `taskbook.submit` is
  separate from default read scopes; submitting a task only queues bounded text
  in workspace-scoped state and never starts execution.
- **One workspace = one boundary**: every token is bound to a single workspace;
  path containment uses canonical realpaths (symlink/`../`/absolute-path escapes
  are all blocked and tested).
- **Sensitive files never leave**: `.env*`, keys, SSH, credentials are denied by
  default (`.env.example` allowed); `.c2cignore` adds your own rules.
- **Knowing the URL grants nothing**: the public MCP endpoint requires OAuth 2.1
  (PKCE S256, dynamic client registration, rotating refresh tokens). Without a
  token: 401. Wrong workspace: 403.
- **The model never sees long-lived credentials**: the only secret that ever
  touches a browser is a one-time pairing code (5-minute TTL, 5 attempts,
  rate-limited, destroyed on use).

Full threat model: [docs/security.md](docs/security.md)

## For developers

```bash
pnpm install
pnpm build          # -> dist/, exposes the `c2c` bin
pnpm test           # vitest suite (path security, OAuth, pairing, MCP e2e)

c2c setup           # bridge + tunnel + pairing code, all in one
c2c sandbox-allow   # whitelist the settings dir in Codex (macOS + Windows)
c2c status / doctor / pair / unpair / logs / stop
```

Requirements: Node.js >= 20, git. `cloudflared` for the public connection
(auto-detected; the Skill installs it for you).

Docs: [architecture](docs/architecture.md) · [protocol](docs/protocol.md) ·
[security](docs/security.md) · [troubleshooting](docs/troubleshooting.md)

## Project layout

```
src/
  bridge/     loopback HTTP server, port recovery, admin API
  mcp/        read-only audit tools plus bounded Taskbook submission
  auth/       OAuth 2.1 (PKCE, DCR, refresh rotation, revocation)
  pairing/    one-time pairing codes (CSPRNG, TTL, rate limits)
  workspace/  path containment, sensitive-file policy, search, git
  tunnel/     TunnelProvider abstraction + Cloudflare Quick/Named Tunnel
  execution/  execution records for the review loop
  process/    daemon lifecycle
  cli/        the c2c CLI
skill/        the Codex Skill (the real UX layer)
tests/        unit + integration tests
docs/         architecture / protocol / security / troubleshooting
```

## V0.1 support & boundaries

V0.1 is verified on the current Windows/Codex Harness path, including the
bounded local Taskbook workflow. The portable Rule exists, but other Harnesses
and platforms are not automatically claimed as verified. This project makes
no claim of exactly-once arbitrary external side effects, and unsupported or
unknown NTFS reparse types remain outside the verified V0.1 threat model.

**Unofficial community project. Not affiliated with or endorsed by OpenAI.**

## License

[MIT](LICENSE)

## Star History

<a href="https://www.star-history.com/?repos=xiaoduoya%2Fcodex-with-chatgpt&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=xiaoduoya/codex-with-chatgpt&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=xiaoduoya/codex-with-chatgpt&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=xiaoduoya/codex-with-chatgpt&type=date&legend=top-left" />
 </picture>
</a>
