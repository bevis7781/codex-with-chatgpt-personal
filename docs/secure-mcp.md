# OpenAI Secure MCP Personal transport

This is the Personal default transport for new or explicitly migrated C2C
workspaces. It preserves the existing read-only MCP and explicit Taskbook
submission boundaries. Secure MCP startup never claims or executes a Taskbook.

## Local preparation

Run these commands from the checkout after the C2C state-root binding is in
place:

```powershell
node bin/c2c.js skill install --json
node bin/c2c.js secure-mcp runtime import --source <approved local tunnel-client v0.0.14 directory>
node bin/c2c.js secure-mcp key set
node bin/c2c.js secure-mcp register --tunnel-id tunnel_<32 lowercase hex>
node bin/c2c.js secure-mcp status-all --json
node bin/c2c.js connect-all --json
```

The release directory is selected locally and must contain the approved
official v0.0.14 binary plus matching provenance/checksum material. C2C copies
it below the bound D-021 state root and verifies its version and SHA-256 before
every launch.

The runtime key must be a restricted Platform Runtime API key with Tunnels
**Read + Use** only. The hidden key command stores CurrentUser-protected
ciphertext under D-021. No admin key is accepted as a runtime substitute, and
the key is never written to a project, Taskbook, argument list, log, profile,
or evidence record.

Each enabled workspace has exactly one stable permanent OpenAI Tunnel ID. C2C
does not create, delete, or rotate remote Tunnels. `register` is local and
explicit; create/select and associate the permanent Tunnel in OpenAI Platform
first. Registry roots are canonicalized and workspace IDs are recomputed on
every read.

An explicit credential-free control-plane proxy can be configured:

```powershell
node bin/c2c.js secure-mcp proxy set --url http://proxy.example:8080
node bin/c2c.js secure-mcp proxy show --json
node bin/c2c.js secure-mcp proxy clear --json
```

Only control-plane traffic uses that setting. MCP, OAuth, and Harpoon loopback
traffic remains direct, with bounded readiness checks. Unsafe proxy userinfo is
rejected rather than persisted.

## Normal recovery and lifecycle

`connect-all` is a one-shot, bounded, idempotent reconciler for enabled local
registrations. It reuses healthy Bridge/tunnel runtimes, follows dynamic local
Bridge ports, processes later workspaces after an isolated failure, and
returns per-workspace `PASS`, `BLOCKED`, or `FAIL` reason codes. It never
accepts workspace/path/process arguments and never enters Cloudflare fallback.

`status-all` is read-only. It reports identity, Bridge, runtime, managed
binary, proxy, and key status without secrets. `disconnect-all` stops only
runtime and local-only Bridge processes whose ownership and workspace identity
can be proved; it does not disable registrations or delete remote resources.

The tracked `C2C-Connect-All.cmd` wrapper invokes only the fixed local
`connect-all` entry point and forwards no `%*` arguments. Closing its console
does not stop healthy detached runtimes. Cloudflare Named/Quick remains
available only through the explicit legacy setup path; Secure MCP failure never
silently invokes it.

## Personal `配置`

Standalone Personal `配置` installs the managed Skills, verifies D-021 and the
managed client, reports missing key/Tunnel registration, and starts the current
workspace only through Secure MCP once prerequisites are present. It does not
automate OpenAI App/Tunnel creation, browser OAuth, pairing, or Project/chat
creation. A replacement App or new Chat may be needed once during migration;
that is distinct from normal reboot recovery through `C2C-Connect-All.cmd`.

## Acceptance boundary

Construction and publication are not final product acceptance. A separate
black-box run must use at least two real Personal workspaces with distinct
permanent Tunnel IDs, verify them in existing Chats, reboot Windows, run the
wrapper once without opening Codex or running per-workspace `配置`, prove the
detached runtimes and stable workspace identities recover, and perform the
explicit `taskbook.submit` pending/no-execution check. Until that run is
complete, report `FINAL BLACK-BOX ACCEPTANCE: PENDING`.
