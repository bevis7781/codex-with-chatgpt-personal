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
3. Run `node bin/c2c.js skill install`; it installs the C2C Skill and the
   dedicated Personal Taskbook Skill into the local Codex Skill directory.
   `c2c setup` repeats this step safely for existing installations.
4. On a new machine, set the local Named Tunnel zone once with
   `node bin/c2c.js prefs set --named-zone <your Cloudflare zone> --json`.
   This preference stays on the machine and is not a public project default.
5. In the already bound C2C Skill context, tell Codex **`配置`**. It quietly
   prepares the local workspace, then gives you one compact connector form:
   Name, Description, Server URL, and Authentication = OAuth.
6. Create the connector yourself. When it is ready to authorize, Codex gives
   you a fresh one-time pairing code; after you report authorization success it
   stops and gives the short Project routing instruction. The Personal-first
   path does not drive the ChatGPT browser, create/delete connectors, create a
   Project/chat, or force a smoke test.
7. If Web ChatGPT should submit Taskbooks, explicitly authorize
   `taskbook.submit`. In the installed, explicitly bound Personal Taskbook
   context, standalone `Do` / `Read` then use the local Rule automatically;
   ordinary mentions in unrelated conversations do not activate it.

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
4. 安装 Skill：运行 `node bin/c2c.js skill install --json`。它会自动安装
   C2C Skill 和 Personal Taskbook 入口并填好本地路径，不要手动修改
   `AGENTS.md` 或复制 Rule 文件。
5. 新机器第一次配置前，运行 `node bin/c2c.js prefs set --named-zone <你的 Cloudflare 域名> --json`
   保存本机固定域名默认区域；这个偏好只保存在本机，不写入项目或公开源码。
6. 首次配置：在已经绑定的 C2C Skill 上执行 Personal-first `配置` 流程。
   本地准备完成后，只把连接器的 Name、Description、Server URL、
   Authentication = OAuth 四项交给我，我自己创建连接器。
7. 等我说连接器已创建并准备授权后，再生成新的配对码交给我；授权完成后
   停止，不要自动打开 ChatGPT、建 Project/chat 或做文件读取测试。
8. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作；完成后给我短的 Project 连接器路由说明。
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
4. Install the Skills: run `node bin/c2c.js skill install --json`. This
   installs both the C2C Skill and the Personal Taskbook entry point and fills
   local paths automatically; do not edit `AGENTS.md` or copy the Rule by hand.
5. On a new machine, save the local Named Tunnel zone once with
   `node bin/c2c.js prefs set --named-zone <your Cloudflare zone> --json`.
   Keep this preference local; do not put it in the project or public source.
6. First-time setup: in the already bound C2C Skill context, run the
   Personal-first `配置` flow. After local preparation, give me only the
   connector fields Name, Description, Server URL, and Authentication = OAuth;
   I will create the connector myself.
7. After I report that the connector is ready to authorize, generate a fresh
   pairing code and give it to me. After authorization, stop; do not drive the
   ChatGPT browser, create a Project/chat, or run a file-read smoke test.
8. Only interrupt me for logins (ChatGPT / Cloudflare), CAPTCHAs or 2FA, and
   give me exactly ONE action at a time. Finish with the short Project routing
   instruction. If anything breaks, use the existing repair path on demand.
```


**Updates · 更新** — The Skill checks GitHub once a day and updates itself when a
new version is released; no action needed. You can also say "更新 Codex with ChatGPT"
anytime. / Skill 每天自动检查一次 GitHub，有新版本会自动更新，无需任何操作；
也可以随时对 Codex 说"更新 Codex with ChatGPT"。

---

*The sections below are in English. 以下详细内容为英文，中文完整版见
[README.zh-CN.md](README.zh-CN.md)。*

## Install → Personal setup → Use (manual)

1. Install the Skills: from the checkout run `node bin/c2c.js skill install`.
   This installs the C2C Skill and the explicit Personal Taskbook entry point.
2. On a new machine, set the local Named Tunnel zone once with
   `c2c prefs set --named-zone <your Cloudflare zone> --json`. In the bound C2C
   Skill context, tell Codex: **"配置"**. Personal setup does not ask you to
   choose Quick vs Named or ask for the domain again.
3. Fill the four connector fields Codex gives you. When you report that the
   connector is ready to authorize, use the fresh pairing code Codex provides.
4. After authorization, use Codex normally: **"Use Codex with ChatGPT to
   implement XXX."** For a bound Personal Taskbook conversation, standalone
   `Read` is view-only and standalone `Do` runs at most one eligible task before
   stopping.

That's the whole manual. You don't need to know what MCP, tunnels, ports or
localhost are. You create the connector with the four fields shown by Codex;
Codex handles local preparation, automatically uses the saved Named zone for a
new workspace, then stops after your authorization report.

```
Name: Codex with ChatGPT · <workspace>
Description: Securely connect ChatGPT to the current Codex workspace for planning and review.
Server URL: <the Server URL Codex provides>
Authentication: OAuth

After authorization, Codex provides the Project routing instruction and stops.
```

The only steps that may need you are entering the connector fields, authorizing
it with the fresh pairing code, and logging into Cloudflare if Named setup
requires it. Project creation and connector verification are left to you and
are not forced by the Personal-first setup path.

### Optional stable hostname

The default public address is a temporary Cloudflare URL. It changes when the
bridge restarts, and Codex repairs ChatGPT by deleting that workspace's
connector and adding it again.

Personal-first setup automatically uses the locally saved Named Tunnel zone for
a new workspace and derives a hostname such as `c2c-<project>.your-domain.com`;
it does not ask you to choose Quick vs Named or ask for the domain again. If
Cloudflare authentication is required, Codex asks only for that login. A Named
setup failure is reported truthfully and does not silently switch the Personal
path to Quick. The explicit `c2c tunnel choose` command remains available for
legacy or deliberate Quick/Named choices.

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
c2c skill install   # install/update the C2C and Personal Taskbook Skills
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
