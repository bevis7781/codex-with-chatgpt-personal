# Codex with ChatGPT Personal Fork

[English](README.md) | **简体中文**

> ChatGPT 负责思考，Codex 负责干活。

这是 [`XiaoDuoYa/codex-with-chatgpt`](https://github.com/XiaoDuoYa/codex-with-chatgpt)
的 **Personal Fork**。它保留上游“ChatGPT 负责推理和审查、本地 Codex Harness
负责执行”的思路，同时沿着自己的 Personal 产品方向演进。上游项目仍是本 Fork
的代码谱系和明确的审查参考，但不决定 Personal 产品方向。本 Fork 加入了受边界
约束的 V0.1 Taskbook 工作流。

## 解决什么问题

ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的 API 额度做
规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，使用网页订阅而
不是推理/API 计费 key。Secure MCP 只在本机使用一个受限的 Runtime API key
（仅 Tunnel Read + Use）；它受 Windows CurrentUser 保护，不进入项目、Taskbook、
参数或日志，也不会交给模型。不搞逆向代理——官方网页 + 受控 MCP 桥接。

## 这是什么

把 ChatGPT 网页版变成 Codex 编码会话的"规划与审查大脑"，而执行权完全保留在
Codex 手里。你的仓库永远不会被上传——ChatGPT 通过安全的、OAuth 保护的 MCP
连接按需读取工作区内容；如果明确授予 `taskbook.submit`，它也只能提交受边界
约束的 Taskbook，不会直接修改项目或运行命令。

## V0.1 Taskbook 工作流

1. Web ChatGPT 在明确授权独立的 `taskbook.submit` scope 后，通过
   `submit_taskbook` 提交 `title + body`。
2. C2C 把不透明的任务存入工作区范围内的状态，不写入项目文件，不允许调用方
   选择工作区或路径，也不会启动进程或自动执行。
3. 用户在本地发送一次独立的 `Do`。
4. 本地 Harness 最多领取并执行一个符合条件的任务，记录验证和证据，然后停止。
5. Web ChatGPT 可以通过现有只读工具独立审查真实 diff、测试和执行证据。

`Web submit → local Do → one-task execution → evidence → Web audit`

远程权限刻意保持狭窄：没有通用的 `write_file`、删除、Shell 或 exec 工具，调用方
不能选择项目路径或工作区。`taskbook.submit` 是独立的显式变更 scope，不属于默认
读取权限；提交任务本身永远不会自动执行。

## 安装与配置这个 Fork

1. 克隆本仓库：`https://github.com/bevis7781/codex-with-chatgpt-personal.git`。
2. 在 checkout 中执行 `corepack pnpm install` 和 `corepack pnpm build`。
3. 运行 `node bin/c2c.js skill install`，它会把 C2C Skill 和独立的
   Personal Taskbook Skill 自动安装到本地 Codex Skill 目录；`c2c setup` 对已有安装
   也会安全地重复这一步。
4. 从本机已批准的发布目录导入官方 `tunnel-client` v0.0.14：
   `node bin/c2c.js secure-mcp runtime import --source <本机发布目录>`。
5. 运行 `node bin/c2c.js secure-mcp key set` 输入隐藏的 Restricted Runtime API key，
   再为当前工作区登记一个永久 Tunnel：
   `node bin/c2c.js secure-mcp register --tunnel-id tunnel_<32 位小写十六进制>`。
6. 在已经绑定的 C2C Skill 上对 Codex 说 **`配置`**。它会安静验证 Secure MCP，
   然后只把仍需你在 Platform/App/OAuth 中完成的一次性动作告诉你。首次接入完成后，
   重启恢复只需双击 `C2C-Connect-All.cmd`。
7. 如果需要让 Web ChatGPT 提交 Taskbook，显式授权 `taskbook.submit`。在已经安装并
   明确绑定当前工作区的 Personal Taskbook 上下文中，之后的独立 `Do` / `Read` 会自动
   使用本地 Rule；普通对话里提到这些词不会触发它。

## OpenAI Secure MCP Personal 传输

Personal 默认使用官方 OpenAI Secure MCP。状态只保存在绑定的 D-021 本机状态根下；
每个启用工作区登记一个稳定永久 `tunnel_id`。运行时 key 必须是仅有 Tunnels Read + Use
权限的 Restricted Runtime API key，由隐藏输入命令写成 Windows CurrentUser DPAPI 密文，
不会进入项目、Taskbook、参数、日志或证据。控制面代理必须显式配置且不得带凭据；MCP、OAuth
和 Harpoon 回环流量保持直连。

`status-all` 只读，`connect-all` 有界且幂等，人工重连时提供有界的进度提示；
`disconnect-all` 只停止能证明归属的本地运行时。Secure MCP 失败不会静默切换
Cloudflare；Named/Quick 仅保留为显式 legacy 路径。最终黑盒验收已通过：
多工作区 Secure MCP/connect-all、完整 Windows 重启和既有 Chat 恢复均已核验；
远程 submit 仍不会执行，直到独立本地 `Do`，且一次独立 `Do` 恰好授权一次已接受的执行。

## 一段话安装（纯小白专用）

不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的编码
Agent（Codex），然后去倒杯咖啡：

```text
请帮我完整安装并配置 Codex with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 20；Secure MCP 路径不安装 cloudflared。
2. 下载：把 https://github.com/bevis7781/codex-with-chatgpt-personal 克隆到
   ~/codex-with-chatgpt-personal（已存在就 git pull 更新）。
3. 构建：在该目录里执行 corepack pnpm install 和 corepack pnpm build。
4. 安装 Skill：运行 `node bin/c2c.js skill install --json`。它会自动安装 C2C Skill
   和 Personal Taskbook 入口并填好本地路径，不要手动修改 `AGENTS.md` 或复制 Rule。
5. 导入批准的本机 `tunnel-client` v0.0.14，运行隐藏输入的
   `node bin/c2c.js secure-mcp key set`，不要把 Runtime key 发给 Agent。
6. 在 Platform 为当前工作区创建/选择永久 Tunnel，然后登记
   `node bin/c2c.js secure-mcp register --tunnel-id tunnel_<32 位小写十六进制>`。
7. 首次配置：在已经绑定的 C2C Skill 上执行 Personal-first `配置` 流程。
   本地准备完成后，只把仍需你完成的一次性 Platform/App/OAuth 动作交给你。
8. 授权完成后停止，不要自动打开 ChatGPT、建 Project/聊天或做文件读取测试；
   重启恢复使用 `C2C-Connect-All.cmd`，不使用 Cloudflare 静默兜底。
```

**更新**：Skill 会在支持的工作流开始时按缓存策略每天最多检查一次 GitHub 更新，
并在有新版本时自行更新；这是 Skill/工作流检查，不是常驻的 Windows 后台更新服务。
也可以随时对 Codex 说"更新 Codex with ChatGPT"。

## Personal 配置完成后的使用（手动版）

完成上面的安装和一次性接入后：

1. 如果配置还未完成，在已经绑定的 C2C Skill 上对 Codex 说：**"配置"**。
   Personal 配置不会询问 Cloudflare 临时/固定地址。
2. 完成 Codex 给出的一次性 Platform/App/OAuth 动作；需要配对码时，等你报告连接器准备授权
   后输入 Codex 新生成的配对码；授权完成后即可正常使用：**"使用 Codex with ChatGPT，帮我实现 XXX。"**
   在已绑定的 Personal Taskbook 对话中，独立 `Read` 只查看，独立 `Do` 最多执行一个
   符合条件的任务后停止。

首次授权完成后，重启只需运行 `C2C-Connect-All.cmd`；它只使用本机登记，不接受额外参数，
也不执行 Taskbook。Personal-first 路径不会自动创建 Project/聊天、驱动浏览器或强制验证连接器。
一次性 Platform/OAuth 动作的字段如下：

```
Name: Codex with ChatGPT · <workspace>
Description: Securely connect ChatGPT to the current Codex workspace for planning and review.
Tunnel: <在 ChatGPT 中选择的永久 Tunnel>
Authentication: OAuth

授权完成后，Codex 提供 Project 连接器路由说明并停止。
```

你可能需要自己选择永久 Tunnel、完成一次性 App/OAuth 授权并输入新配对码。Project 创建和连接器
验证由你自行决定，Personal-first 配置不会强制执行。

### 显式 legacy Cloudflare 路径

Cloudflare Named/Quick 仅在操作者明确选择 legacy setup 或 `c2c tunnel` 命令时保留；
Personal `配置`、Secure MCP 修复和 `C2C-Connect-All.cmd` 都不会选择它，也不会把 Secure MCP
失败静默切换过去。

凭证放在系统目录，不进项目。

## 工作原理

```
             ┌───────────────────────────┐
             │      ChatGPT 网页版       │
             │    推理 / 规划 / 审查      │
             └─────────────┬─────────────┘
                           │ OpenAI Secure MCP 永久 Tunnel
                           │（Personal 默认数据面）
                           ▼
             ┌───────────────────────────┐
             │   本机回环 C2C Bridge      │
             │ 受控 MCP 读取工具 +        │
             │ 受边界约束的 taskbook.submit│
             └─────────────┬─────────────┘
                           │ 受控工作区访问
                           ▼
             ┌─────────────────────┐    ┌────────────────────────┐
             │     本地工作区      │◀──▶│    Codex Harness        │
             └─────────────────────┘    │ 独立本地 Do → 授权一个  │
                                        │ Taskbook 任务            │
                                        └────────────────────────┘
```

- **Personal 数据面**：ChatGPT 通过 OpenAI Secure MCP 永久 Tunnel 到达本机回环
  C2C Bridge。Bridge 提供受控的只读工具；拥有显式 `taskbook.submit` scope 时，
  还可以提交受边界约束的 `title + body`，但不会写入项目文件或运行命令。
- **执行边界**：本地 Codex Harness 负责项目编辑、git、Shell、测试和修复。独立本地
  `Do` 最多授权执行一个符合条件的 Taskbook；提交本身永远不会启动执行。
- **兼容路径**：Cloudflare Named/Quick 仅在明确选择 legacy 操作时保留，不是 Personal 默认。
- **独立审查**：Codex 执行完毕后，ChatGPT 通过 MCP 亲自检查真实的 git diff
  和测试记录——绝不因为 Codex 说"测试全过"就直接相信。

## 安全模型（简版）

- **远程权限刻意狭窄**：服务端根本不存在通用写文件/删除/Shell/exec 类工具，
  调用方也不能选择项目路径或工作区；任何提示注入都无法启用它们。
- **Taskbook 提交显式且不执行**：`taskbook.submit` 不属于默认读取 scope；提交只
  会把有边界的文本放入工作区状态，永远不会启动执行。
- **一个工作区 = 一道边界**：每个令牌绑定单一工作区；路径校验基于规范化
  realpath（symlink、`../`、绝对路径逃逸全部被拦截并有测试覆盖）。
- **敏感文件永不外泄**：`.env*`、密钥、SSH、各类凭据默认拒绝
  （`.env.example` 放行）；`.c2cignore` 可追加自定义规则。
- **知道 URL 不等于有权限**：公网 MCP 端点强制 OAuth 2.1（PKCE S256、动态
  客户端注册、refresh token 轮换）。无令牌：401；令牌属于别的工作区：403。
- **凭据留在本机且有边界**：受限 Runtime API key 受 CurrentUser 保护，只用于 Secure MCP
  Tunnel Read + Use，模型不会收到它。唯一有意输入 ChatGPT 的秘密是一次性配对码
  （5 分钟有效、限 5 次尝试、限速、用后即毁）。

完整威胁模型：[docs/security.md](docs/security.md)

## 开发者

```bash
pnpm install
pnpm build          # 产出 dist/，暴露 c2c 命令
pnpm test           # vitest 测试套件（路径安全、OAuth、配对、MCP 端到端）

c2c setup           # 默认 Secure-MCP-first；仅明确需要时加 --legacy-cloudflare
c2c skill install   # 安装/更新 C2C 与 Personal Taskbook Skill
c2c sandbox-allow   # 把本地设置目录加入 Codex 沙箱白名单（macOS / Windows）
c2c status / doctor / pair / unpair / logs / stop
```

环境要求：Node.js >= 20、git，以及用户明确选择的官方 `tunnel-client` v0.0.14
本机发布材料；Cloudflare 只保留为显式 legacy 路径。

文档：[架构](docs/architecture.md) · [协议](docs/protocol.md) ·
[安全](docs/security.md) · [故障排查](docs/troubleshooting.md)

## 目录结构

```
src/
  bridge/     本机回环 HTTP 服务、端口自动恢复、管理 API
  mcp/        只读审查工具 + 受边界约束的 Taskbook 提交
  auth/       OAuth 2.1（PKCE、动态注册、refresh 轮换、吊销）
  pairing/    一次性配对码（CSPRNG、TTL、限速）
  workspace/  路径收敛、敏感文件策略、搜索、git
  secure-mcp/ 状态、登记、受保护 key、受控运行时和 connect-all
  tunnel/     TunnelProvider 抽象 + 显式 legacy Cloudflare Tunnel
  execution/  审查闭环所需的执行记录
  process/    守护进程生命周期
  cli/        c2c 命令行
skill/        Codex Skill（真正的 UX 层）
tests/        单元 + 集成测试
docs/         架构 / 协议 / 安全 / 故障排查
```

## V0.1 支持范围与边界

V0.1 已在当前 Windows/Codex Harness 路径上验证，包括受边界约束的本地
Taskbook 工作流。便携 Rule 已提供，但不会自动声称其他 Harness 或平台也已验证。
本项目不声称对任意外部副作用提供 exactly-once 保证；不支持或未知的 NTFS
reparse 类型仍在已验证的 V0.1 威胁模型之外。

**非官方社区项目，与 OpenAI 无关联，未获其背书。**

## 许可证

[MIT](LICENSE)
