# Codex with ChatGPT Personal Fork

> ChatGPT thinks. Codex works.
> ChatGPT 负责思考，Codex 负责干活。

This repository is a **Personal Fork** of [`XiaoDuoYa/codex-with-chatgpt`](https://github.com/XiaoDuoYa/codex-with-chatgpt). It keeps the upstream idea—ChatGPT reasons and reviews while the local Codex Harness executes—while following its own Personal product direction. The upstream project remains this fork's code lineage and an explicit review reference, not the authority for Personal product decisions. This fork adds a bounded V0.1 Taskbook workflow.

## Choose between upstream and this Personal Fork

Choose upstream for its simpler, read-only ChatGPT ↔ Codex planning and review path when you do not need the Personal operating contract. Choose this Personal Fork when you need persistent per-workspace OpenAI Secure MCP, one bounded recovery action for enabled workspaces after a reboot, or Web-to-local Taskbook submission with local execution authorization.

| Decision | Upstream project | This Personal Fork |
| --- | --- | --- |
| Intended use | Read-only ChatGPT ↔ Codex planning and review | The Personal Secure MCP and Taskbook operating path |
| Operating style | Use the upstream planning/review workflow | Web ChatGPT plans and reviews; the local Codex Harness executes |
| Restart and multiple workspaces | Follow the upstream project's documented setup and recovery flow | Each enabled workspace has persistent Secure MCP state; one explicit `C2C-Connect-All.cmd` action reconnects enabled workspaces after reboot |
| Web → local Taskbook | Not part of this simpler read-only path | Web submission queues bounded task text locally and never executes it |
| Execution authorization | No local Taskbook execution step in this path | One standalone local `Do` authorizes at most one eligible task |

> [!IMPORTANT]
> **遇到问题？** 请先向 Codex 发送 **「更新 Codex with ChatGPT」** 并重试。更新到最新版本可以解决大多数已知问题。  
> **Having trouble?** First ask Codex to **“Update Codex with ChatGPT”** and try again. Updating to the latest version resolves most known issues.

## The problem · 解决什么问题

**中文** — ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的
API 额度做规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，
使用网页订阅而不是推理/API 计费 key。Secure MCP 只在本机使用一个受限的
Runtime API key（仅 Tunnel Read + Use）；它受 Windows CurrentUser 保护，不进入
项目、Taskbook、参数或日志，也不会交给模型。不搞逆向代理——官方网页 + 受控 MCP 桥接。

**EN** — ChatGPT Plus/Pro web quota sits idle while your coding agent burns
scarce API/Codex tokens on planning and review. This project moves the
thinking to the web subscription you already pay for; ChatGPT reasoning does
not use an inference/API billing key. Secure MCP uses a restricted local
Runtime API key only for Tunnel **Read + Use**. Windows CurrentUser protects
that key; it is not a project file, Taskbook field, argv/log value, or admin
key, and it is never exposed to the model. No reverse proxy — official web UI
plus a guarded MCP bridge.

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

## OpenAI Secure MCP Personal transport

The Personal default is the official OpenAI Secure MCP transport. Its state is
kept below the machine's bound D-021 C2C state root; a workspace registration
contains only a canonical workspace identity and one stable permanent
`tunnel_id`. The approved local `tunnel-client` v0.0.14 is imported and
integrity-checked before launch.

The runtime key is a restricted Runtime API key with Tunnels **Read + Use**
only. It is entered through the hidden local key command and stored as
Windows CurrentUser DPAPI ciphertext. It is never a project file, Taskbook,
argv value, log, or admin key. An explicit credential-free control-plane proxy
may be configured; loopback MCP and OAuth stay direct.

After onboarding, `C2C-Connect-All.cmd` is the bounded, one-shot reboot
recovery action. It accepts no workspace, path, process, or arbitrary command
arguments, operates only on enabled local registrations, and never inspects or
executes Taskbooks. While reconnecting for a human, it provides bounded
progress feedback. Secure MCP failures do not silently fall back to
Cloudflare; the retained Cloudflare Named/Quick path is available only through
an explicit legacy command.

The final black-box acceptance is complete: multi-workspace Secure
MCP/connect-all, a full Windows reboot, and recovery of established Chats were
verified. Remote submit remains non-executing until standalone local `Do`; one
standalone `Do` authorized exactly one accepted execution.

See [docs/secure-mcp.md](docs/secure-mcp.md) for local setup and the final
black-box acceptance boundary.

## Install and setup this fork

1. Clone this repository: `https://github.com/bevis7781/codex-with-chatgpt-personal.git`.
2. In the checkout, run `corepack pnpm install` and `corepack pnpm build`.
3. Run `node bin/c2c.js skill install`; it installs the C2C Skill and the
   dedicated Personal Taskbook Skill into the local Codex Skill directory.
   `c2c setup` repeats this step safely for existing installations.
4. Import the approved local official runtime once:
   `node bin/c2c.js secure-mcp runtime import --source <local release directory>`.
5. Configure the hidden local Runtime API key with
   `node bin/c2c.js secure-mcp key set`, then register one permanent Tunnel for
   the current workspace with
   `node bin/c2c.js secure-mcp register --tunnel-id tunnel_<32 lowercase hex>`.
6. In the already bound C2C Skill context, tell Codex **`配置`**. It quietly
   verifies Secure MCP, then gives only the one-time Platform/App/OAuth handoff
   you still need. After onboarding, run `C2C-Connect-All.cmd` after a reboot.
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

1. 环境自检：需要 git 和 Node.js ≥ 20；Secure MCP 路径不安装 cloudflared。
2. 下载：把 https://github.com/bevis7781/codex-with-chatgpt-personal 克隆到
   ~/codex-with-chatgpt-personal（已存在就 git pull 更新）。
3. 构建：在该目录里执行 corepack pnpm install 和 corepack pnpm build。
4. 安装 Skill：运行 `node bin/c2c.js skill install --json`。它会自动安装
   C2C Skill 和 Personal Taskbook 入口并填好本地路径，不要手动修改
   `AGENTS.md` 或复制 Rule 文件。
5. 导入批准的本机 `tunnel-client` v0.0.14，并运行隐藏输入的
   `node bin/c2c.js secure-mcp key set`；不要把 Runtime key 发给 Agent。
6. 在 Platform 为当前工作区创建/选择永久 Tunnel，然后登记
   `node bin/c2c.js secure-mcp register --tunnel-id tunnel_<32 位小写十六进制>`。
7. 首次配置：在已经绑定的 C2C Skill 上执行 Personal-first `配置` 流程。
   本地准备完成后，只把仍需你完成的一次性 Platform/App/OAuth 动作交给你。
8. 等你报告授权完成后停止，不要自动打开 ChatGPT、建 Project/chat 或做文件读取测试；
   重启恢复使用 `C2C-Connect-All.cmd`，不使用 Cloudflare 静默兜底。
```


**EN** — Don't know git, Node, or terminals? You don't need to. Copy the
paragraph below, paste it to your coding agent (Codex), and go grab a coffee:

```text
Please install and configure "Codex with ChatGPT" for me, fully automatically.
I am a non-technical user — do everything yourself:

1. Check the environment: git and Node.js >= 20 must be available. The Secure
   MCP path does not install cloudflared.
2. Download: clone https://github.com/bevis7781/codex-with-chatgpt-personal into
   ~/codex-with-chatgpt-personal (if it already exists, git pull to update).
3. Build: inside that folder run `corepack pnpm install` then `corepack pnpm build`.
4. Install the Skills: run `node bin/c2c.js skill install --json`. This
   installs both the C2C Skill and the Personal Taskbook entry point and fills
   local paths automatically; do not edit `AGENTS.md` or copy the Rule by hand.
5. Import the approved local `tunnel-client` v0.0.14 release and configure the
   hidden Runtime API key with `node bin/c2c.js secure-mcp key set`.
6. Create/select one permanent OpenAI Tunnel for the workspace, then run
   `node bin/c2c.js secure-mcp register --tunnel-id tunnel_<32 lowercase hex>`.
7. First-time setup: in the already bound C2C Skill context, run the
   Personal-first `配置` flow. It gives me only the one-time Platform/App/OAuth
   action still required; I perform that action myself.
8. After I report authorization, stop; do not drive the ChatGPT browser, create
   a Project/chat, or run a file-read smoke test. Reboot recovery is the fixed
   `C2C-Connect-All.cmd` wrapper. If anything breaks, use the Secure MCP status
   and bounded repair commands; do not silently switch to Cloudflare.
```


**Updates · 更新** — At the start of supported workflows, the managed Skill
performs a cached daily GitHub update check and can update itself when a new
version is available. This is a Skill/workflow check, not a background Windows
updater service. You can also say "更新 Codex with ChatGPT" anytime. / Skill
会在支持的工作流开始时按缓存策略每天最多检查一次 GitHub 更新，并在有新版本
时自行更新；这是 Skill/工作流检查，不是常驻的 Windows 后台更新服务。也可以
随时对 Codex 说"更新 Codex with ChatGPT"。

---

*The sections below are in English. 以下详细内容为英文，中文完整版见
[README.zh-CN.md](README.zh-CN.md)。*

## Use after Personal setup (manual)

After the one-time install and onboarding above:

1. In an already bound C2C Skill context, tell Codex **"配置"** if setup is
   not complete. Personal setup does not ask you to choose Cloudflare.
2. Complete only the one-time Platform/App/OAuth action Codex gives you. When
   that action is ready to authorize, use the fresh pairing code if requested.
3. After authorization, use Codex normally: **"Use Codex with ChatGPT to
   implement XXX."** For a bound Personal Taskbook conversation, standalone
   `Read` is view-only and standalone `Do` runs at most one eligible task before
   stopping.

After onboarding, run `C2C-Connect-All.cmd` once after a reboot; it uses only
local registrations and forwards no arguments. The Personal-first path does not
automatically create a ChatGPT Project or chat, drive the browser, or force
connector verification.

```
Name: Codex with ChatGPT · <workspace>
Description: Securely connect ChatGPT to the current Codex workspace for planning and review.
Tunnel: <the registered permanent Tunnel selected in ChatGPT>
Authentication: OAuth

After authorization, Codex provides the Project routing instruction and stops.
```

The only steps that may need you are selecting the permanent Tunnel and
authorizing the one-time App/OAuth flow. Project creation and connector
verification are left to you and are not forced by the Personal-first setup
path.

### Explicit legacy Cloudflare path

Cloudflare Named/Quick remains available only when an operator deliberately
selects the legacy setup/`c2c tunnel` commands. It is not selected by Personal
`配置`, Secure MCP recovery, or `C2C-Connect-All.cmd`, and Secure MCP failures
never fall back to it.

Credentials stay in the OS app state directory, not in the project.

## How it works

```
              ┌───────────────────────────┐
              │       ChatGPT Web         │
              │  Reason / Plan / Review   │
              └─────────────┬─────────────┘
                            │ OpenAI Secure MCP permanent Tunnel
                            │ (Personal default data plane)
                            ▼
              ┌───────────────────────────┐
              │   loopback C2C Bridge      │
              │ guarded MCP read tools +   │
              │ bounded taskbook.submit   │
              └─────────────┬─────────────┘
                            │ guarded workspace access
                            ▼
              ┌─────────────────────┐    ┌────────────────────────┐
              │   Local Workspace   │◀──▶│    Codex Harness        │
              └─────────────────────┘    │ standalone local Do →  │
                                         │ authorize one task     │
                                         └────────────────────────┘
```

- **Personal data plane**: ChatGPT uses the permanent OpenAI Secure MCP Tunnel
  to reach the loopback C2C Bridge. The Bridge exposes guarded read tools and,
  with the explicit `taskbook.submit` scope, bounded `title + body` submission;
  it never writes project files or executes commands.
- **Execution boundary**: The local Codex Harness owns project edits, git,
  shells, tests, and fixes. A standalone local `Do` authorizes at most one
  eligible Taskbook execution; submission alone never starts it.
- **Legacy compatibility**: Cloudflare Named/Quick remains available only for
  explicitly selected legacy operation. It is not the Personal default.
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
- **Credentials stay local and bounded**: the restricted Runtime API key is
  CurrentUser-protected and used only for Secure MCP Tunnel Read + Use; the
  model never receives it. The only secret intentionally entered into ChatGPT
  is a one-time pairing code (5-minute TTL, 5 attempts, rate-limited, destroyed
  on use).

Full threat model: [docs/security.md](docs/security.md)

## For developers

```bash
pnpm install
pnpm build          # -> dist/, exposes the `c2c` bin
pnpm test           # vitest suite (path security, OAuth, pairing, MCP e2e)

c2c setup           # Secure-MCP-first; add --legacy-cloudflare only explicitly
c2c skill install   # install/update the C2C and Personal Taskbook Skills
c2c sandbox-allow   # whitelist the settings dir in Codex (macOS + Windows)
c2c status / doctor / pair / unpair / logs / stop
```

Requirements: Node.js >= 20, git, and a user-approved local official
`tunnel-client` v0.0.14 release for Secure MCP. Cloudflare is legacy-only.

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
  secure-mcp/ state, registry, protected key, managed runtime, and connect-all
  tunnel/     TunnelProvider abstraction + explicit legacy Cloudflare Tunnel
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
