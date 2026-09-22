# Local Taskbook Harness

The remote `submit_taskbook` tool only persists an opaque four-field envelope
in workspace-scoped C2C state. It never starts a process or writes the project.
Gate 2 is local and is deliberately split into three commands:

The `c2c` lines below are shorthand for the repository-local invocation shown
later; no global installation is required or implied.

```text
c2c taskbook inspect --json --compact-json
c2c taskbook claim --task <id> --body-sha256 <hash> --authorization-id <uuid> --harness <label>
c2c taskbook finish --task <id> --claim-id <uuid> --authorization-id <uuid> \
  --body-sha256 <hash> --status succeeded --execution-timestamp <timestamp> --output-id <id>
```

`inspect` is the optional Read path. It takes a complete locked snapshot and
does not reserve anything. A Harness creates one authorization UUID for each
standalone local `Do`, selects one pending task in `createdAt`/UUID order,
reviews its body under the ordinary project safety rules, and then calls
`claim`. Body text may describe paths or commands for the requested work, but
it cannot choose the bound workspace identity, `C2C_STATE_DIR`, task identity,
sidecar/status destination, or authorization. The CLI never interprets body
text as an automatic command.

For routine machine inspection, use `taskbook inspect --json --compact-json`.
Compact JSON keeps the full body in `pending[]` for local review, omits only
the duplicate `body` property from historical `all[]` items, and preserves
the existing metadata. Plain `--json` remains backward-compatible; the
`--compact-json` flag is valid only together with `--json`.

`Read` is optional and never reserves a task. A standalone `Do` authorizes the
current Harness to check and execute at most one eligible task; it needs no
second confirmation. If an unfinished claim exists or a response/result is
ambiguous, stop for local investigation instead of retrying or selecting
another task. `Do` never loops into a second task.

Claims and terminal results are create-new sidecars beside the immutable
`<taskId>.json` envelope. Every sidecar is bounded, strictly parsed, linked to
the envelope hash, and included in the existing storage and entry quotas. One
unfinished claim blocks another Do for that workspace. A failed or lost finish
does not make the task pending again; local investigation is required.

Execution evidence reuses the existing execution record/output stores. The
record must be read back with iteration `1` and a bounded note linking the body
hash, claim ID, and authorization ID before `finish` can write a result. A
successful result requires the execution record to have `exitStatus ok`, an
allowed output record with exit code `0`, and matching output metadata for the
same task and iteration; a failed or blocked result may omit output only with a
recorded reason.

The normal C2C setup installs the portable Rule as the dedicated
`codex-with-chatgpt-personal-taskbook` Skill and fills its trusted checkout and
state paths. It is enabled only when the Harness explicitly operates in that
Personal Taskbook context for the current bound workspace; it is not triggered
by ordinary mentions of `Do` or `Read`. Re-running `c2c skill install` is safe
for updates. From this checkout, the local CLI uses the same state root as the
bridge and every lifecycle step passes the same `--workspace`:

```powershell
$repo = (Resolve-Path .).Path
$workspace = "<the already-bound project root>"
$env:C2C_STATE_DIR = "<the same C2C state directory used by the bridge>"
node (Join-Path $repo "bin\c2c.js") skill install --json
Get-Content (Join-Path $repo "skill\PERSONAL-TASKBOOK.md") -Raw

node (Join-Path $repo "bin\c2c.js") taskbook claim `
  --workspace $workspace --task <taskId> --body-sha256 <bodySha256> `
  --authorization-id <authorizationId> --harness <label> --json

node (Join-Path $repo "bin\c2c.js") record `
  --workspace $workspace --task <taskId> --iteration 1 `
  --changed-files "src/a.ts,src/b.ts" --tests "23 passed" --exit-status ok `
  --taskbook-body-sha256 <bodySha256> --taskbook-claim-id <claimId> `
  --taskbook-authorization-id <authorizationId> `
  --command "pnpm test" --output-file <captured-output-file> --exit-code 0

node (Join-Path $repo "bin\c2c.js") taskbook finish `
  --workspace $workspace --task <taskId> --claim-id <claimId> `
  --authorization-id <authorizationId> --body-sha256 <bodySha256> `
  --status succeeded --execution-timestamp <record.timestamp> `
  --output-id <record.outputId> --json
```

Do not use `npm -g`, `pnpm -g`, or a separate global `c2c` installation. For a
failed or blocked result without output, record a bounded reason and use
`--output-id null`.

This is machine-ready local behavior. A real user Do, an actual project
change, and a remote read-only audit remain required for Gate 3 acceptance.

## Gate 3 live E2E acceptance checklist

A real Gate 3 acceptance run is complete only when the same Taskbook has
evidence that:

1. Web ChatGPT submitted it through `submit_taskbook` and received the compact receipt.
2. It exists only as pending C2C task state; submission caused no project modification or execution.
3. The user sent one real standalone local `Do` in the enabled Personal Taskbook Harness context.
4. The local Harness inspected current state, checked task safety and scope, and claimed exactly the next eligible task with one fresh `authorizationId`.
5. The Harness performed only that task, producing a real project diff and real verification output.
6. Execution evidence was recorded and read back with the same `taskId`, `bodySha256`, `claimId`, `authorizationId`, and iteration `1`.
7. The Taskbook was finished exactly once as `succeeded`, `failed`, or `blocked` according to the real evidence.
8. Web ChatGPT independently audited the resulting Git diff and execution evidence through the read-only C2C tools.
9. The Harness stopped after that one task; no automatic next-task execution or retry occurred.

If an unfinished claim, corrupt or changed task state, candidate or hash
mismatch, ambiguous or lost claim/finish result, or verification/evidence
mismatch is found, stop and fail closed without retrying or selecting a
substitute task.

Final acceptance must compare the post-run product-file state against the preserved pre-run baseline and confirm that only the Taskbook-authorized target changed.
