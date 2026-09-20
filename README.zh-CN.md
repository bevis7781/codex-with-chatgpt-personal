# Codex with ChatGPT Personal Fork

[English](README.md) | **简体中文**

> ChatGPT 负责思考，Codex 负责干活。

这是 [`XiaoDuoYa/codex-with-chatgpt`](https://github.com/XiaoDuoYa/codex-with-chatgpt)
的 **Personal Fork**。它保留上游“ChatGPT 负责推理和审查、本地 Codex Harness
负责执行”的思路，并加入了受边界约束的 V0.1 Taskbook 工作流。

## 解决什么问题

ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的 API 额度做
规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，Codex 只负责
执行。不用 API Key、不搞逆向代理——官方网页 + 受控 MCP 桥接。

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
4. 新机器第一次配置前，运行 `node bin/c2c.js prefs set --named-zone <你的 Cloudflare 域名> --json`，
   保存本机固定域名默认区域；这个偏好只保存在本机，不写入项目或公开源码。
5. 在已经绑定的 C2C Skill 上对 Codex 说 **`配置`**。它会安静完成本地准备，
   然后只给你一份连接器表单：Name、Description、Server URL、Authentication = OAuth。
6. 你自己创建连接器；等你说连接器已经创建并准备授权后，Codex 才生成新的一次性
   配对码。你报告授权成功后流程就结束，不会自动操作 ChatGPT 浏览器、创建/删除连接器、
   创建 Project/聊天或强制做连通性测试。
7. 如果需要让 Web ChatGPT 提交 Taskbook，显式授权 `taskbook.submit`。在已经安装并
   明确绑定当前工作区的 Personal Taskbook 上下文中，之后的独立 `Do` / `Read` 会自动
   使用本地 Rule；普通对话里提到这些词不会触发它。

## 一段话安装（纯小白专用）

不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的编码
Agent（Codex），然后去倒杯咖啡：

```text
请帮我完整安装并配置 Codex with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/bevis7781/codex-with-chatgpt-personal 克隆到
   ~/codex-with-chatgpt-personal（已存在就 git pull 更新）。
3. 构建：在该目录里执行 corepack pnpm install 和 corepack pnpm build。
4. 安装 Skill：运行 `node bin/c2c.js skill install --json`。它会自动安装 C2C Skill
   和 Personal Taskbook 入口并填好本地路径，不要手动修改 `AGENTS.md` 或复制 Rule。
5. 新机器第一次配置前，运行 `node bin/c2c.js prefs set --named-zone <你的 Cloudflare 域名> --json`，
   保存本机固定域名默认区域；这个偏好只保存在本机，不写入项目或公开源码。
6. 首次配置：在已经绑定的 C2C Skill 上执行 Personal-first `配置` 流程。
   本地准备完成后，只把连接器的 Name、Description、Server URL、
   Authentication = OAuth 四项交给我，我自己创建连接器。
7. 等我说连接器已创建并准备授权后，再生成新的配对码交给我；授权完成后停止，
   不要自动打开 ChatGPT、建 Project/聊天或做文件读取测试。
8. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作；完成后给我短的 Project 连接器路由说明。
```

**更新**：Skill 每天自动检查一次 GitHub，有新版本会自动更新并继续任务，
无需任何操作；也可以随时对 Codex 说"更新 Codex with ChatGPT"。

## 安装 → Personal 配置 → 使用（手动版）

1. 安装 Skill：在 checkout 中运行 `node bin/c2c.js skill install`，它会同时安装 C2C
   Skill 和明确的 Personal Taskbook 入口。
2. 在新机器上先用 `c2c prefs set --named-zone <你的 Cloudflare 域名> --json` 保存一次本地
   Personal 固定域名默认区域；然后在已绑定的 C2C Skill 上对 Codex 说：**"配置"**。
   Personal 配置不会再让你选择临时/固定地址，也不会再次询问域名。
3. 填写 Codex 给出的四项连接器字段。等你报告连接器准备授权后，输入 Codex 新生成的
   配对码；授权完成后即可正常使用：**"使用 Codex with ChatGPT，帮我实现 XXX。"**
   在已绑定的 Personal Taskbook 对话中，独立 `Read` 只查看，独立 `Do` 最多执行一个
   符合条件的任务后停止。

说明书到此结束。你不需要知道 MCP、Tunnel、端口、localhost 是什么。新工作区会自动使用
保存的固定域名默认区域；你自己用 Codex 给出的四项字段创建并授权连接器，之后 Codex 会给出
Project 路由说明并停止：

```
Name: Codex with ChatGPT · <workspace>
Description: Securely connect ChatGPT to the current Codex workspace for planning and review.
Server URL: <Codex 提供的 Server URL>
Authentication: OAuth

授权完成后，Codex 提供 Project 连接器路由说明并停止。
```

你可能需要自己输入连接器字段、使用新的配对码完成授权，以及在固定公网连接需要时登录 Cloudflare。Project 创建和连接器验证由你自行决定，Personal-first 配置不会强制执行。

### 可选的固定域名

默认公网地址是临时的，桥重启后会变。Codex 会删掉这个项目的 ChatGPT 插件再按新地址加回去。

Personal-first 配置会自动使用本机保存的固定域名默认区域，为新工作区生成类似 `c2c-<项目>.你的域名` 的地址；不会再让你选择临时/固定地址，也不会再次询问域名。如果确实需要 Cloudflare 授权，只要求你完成这一次登录。固定域名配置失败时会如实报告，不会在 Personal 路径中静默切换临时地址。显式 `c2c tunnel choose` 仍保留，供兼容或有意选择临时/固定地址时使用。

凭证放在系统目录，不进项目。

## 工作原理

```
             ┌───────────────────────────┐
             │      ChatGPT 网页版       │
             │   推理 / 规划 / 审查      │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
              数据面    │          │ 控制面（消息 < 1 KB）
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   仅监听本机回环地址
             │  受控 MCP           │   OAuth 2.1 + 一次性配对码
             │  OAuth + 配对       │   Cloudflare Quick Tunnel
             │  Tunnel 管理        │
             └──────────┬──────────┘
                        │  受控访问
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │     本地工作区      │◀─────────│    Codex Harness    │
             └─────────────────────┘ 编辑/git │  Shell / 测试 / 修复 │
                                              └─────────────────────┘
```

- **控制面（Computer Use）**：Codex 与 ChatGPT 之间只交换极小的结构化 `[C2C]`
  状态消息——`INIT → PLAN → EXECUTED → REVIEW → DONE`。绝不粘贴 diff、日志
  或文件内容。
- **数据面（MCP）**：ChatGPT 通过现有只读的工作区、diff、测试和证据工具按需
  读取内容。拥有显式 `taskbook.submit` scope 时，还可以把 `title + body` 提交到
  工作区范围内的 C2C 任务状态；这不会写入项目文件或运行命令。
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
- **模型永远接触不到长期凭据**：唯一会出现在浏览器里的秘密是一次性配对码
  （5 分钟有效、限 5 次尝试、限速、用后即毁）。

完整威胁模型：[docs/security.md](docs/security.md)

## 开发者

```bash
pnpm install
pnpm build          # 产出 dist/，暴露 c2c 命令
pnpm test           # vitest 测试套件（路径安全、OAuth、配对、MCP 端到端）

c2c setup           # 一条命令：Bridge + 隧道 + 配对码
c2c skill install   # 安装/更新 C2C 与 Personal Taskbook Skill
c2c sandbox-allow   # 把本地设置目录加入 Codex 沙箱白名单（macOS / Windows）
c2c status / doctor / pair / unpair / logs / stop
```

环境要求：Node.js >= 20、git；公网连接需要 `cloudflared`
（自动检测，Skill 会替你安装）。

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
  tunnel/     TunnelProvider 抽象 + Cloudflare Quick Tunnel
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
