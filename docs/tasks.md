# MCP Tasks

Opt-in support for the `io.modelcontextprotocol/tasks` extension on the
modern (2026-07-28) protocol path: a client invokes a tool as a
**task-augmented `tools/call`**, immediately receives a task handle, and
polls `tasks/get` for the outcome. No long-lived connection is involved,
which is exactly what a request-scoped Convex `httpAction` can deliver.

## Enabling tasks

Two opt-ins, both required:

1. Register the tool with `taskSupport: true`. Only such tools accept a
   task request; the catalog advertises them as
   `execution: { taskSupport: "optional" }`.
2. Configure the `tasks` option of `handleMcpRequest`. Without it the
   capability is never advertised and every task method answers as an
   unknown method.

`taskSupport: true` cannot be combined with `metadata.auditArgs`
(`false` or `{ redact }`): a task stores the caller's arguments verbatim
in the component's task row for the whole retention window, because
execution needs them, so honouring redaction in the audit row while
persisting the same values beside it would be a false promise.
Registration fails with an explanatory error instead.

```ts
// convex/mcp.ts
defineMcpMutation({
  name: "invoices_recount",
  fn: api.invoices.recount,
  args: {},
  taskSupport: true,
});

// convex/http.ts
gateway.handleMcpRequest(ctx, request, {
  authorize,
  tools,
  tasks: {}, // built-in executor; see below for workflow integration
});
```

## Wire contract

- `tools/call` with `params.task` (an object; optional numeric `ttlMs`)
  returns `resultType: "task"` with
  `task: { taskId, toolName, status, createdAt, updatedAt, expiresAt, pollIntervalMs }`
  instead of running the tool inline. The client must declare the
  `io.modelcontextprotocol/tasks` capability in its per-request
  `clientCapabilities`.
- `tasks/get` (`params.taskId`, mirrored in `Mcp-Name`) polls the task.
  A completed task carries `result`; a failed one carries
  `error: { code, message }`; an `input_required` one carries
  `inputRequests`.

  `result` is the **`CallToolResult` the same call would have returned
  synchronously**: the text-JSON `content` block, `structuredContent` when
  the tool declares an `outputSchema`, and `isError`. A client renders and
  validates it exactly as it would a `tools/call` response, and the
  example suite asserts the two match for the same tool and arguments:
  same `structuredContent`, same `isError`, same content-block types, and
  the same parsed text. Only whitespace differs. The task path serializes
  compactly on purpose, because the synchronous path's two-space indent
  multiplies structured data (a 256 KiB value reached 98x when the
  envelope was pretty-printed), and the compact form is bounded at 3x by
  construction.

  The envelope is **derived when the task is read**, not stored. The row
  keeps the tool's value once, plus two flags recorded at completion time
  (whether the call reported an error, and whether the tool advertises an
  `outputSchema`). Storing the envelope instead would keep the value twice
  over, pretty-printed as text and again as `structuredContent`: measured
  on a moderately nested value that is legal under the 256 KiB cap, that
  is roughly a 7x inflation, so the tool would commit its writes and the
  client would then be told the call failed, for a result the same tool
  returns fine inline. Deriving also means a host executor gets the same
  wire shape without hand-building it.

  That parity also decides which failures are which. A tool that ran and
  reported an error is a **completed** task whose result carries
  `isError: true`, following the split in MCP 2025-06-18 §tools/call: the
  model can read the message and retry. Reporting a business error as
  `failed` would give a task-run tool a different contract from the same
  tool called inline.

  `failed` is reserved for the task never producing a result at all: an
  unknown tool, a tool whose kind changed since creation, a tool no longer
  eligible for task execution, a dispatch that never ran, an executor that
  could not start, a result too large to store, and a tool that needs an
  authenticated caller when the row has none. That last one is the single
  place the task path is deliberately **stricter** than the inline one,
  where the same condition surfaces as a tool result: a queued call cannot
  re-challenge the caller, so it fails rather than reporting a refusal as
  a call that ran.
- `tasks/update` (`params.taskId`, mirrored in `Mcp-Name`) takes exactly
  one of:
  - `action: "cancel"`: cancels a non-terminal task. Idempotent; a task
    that already completed or failed answers with an error because its
    outcome must stay observable.
  - `inputResponses`: MRTR-shaped answers
    (`{ key: { action: "accept" | "decline" | "cancel", content? } }`)
    for an `input_required` task, plus `inputRound` echoed from the
    task descriptor. Keys must exactly match the `inputRequests`;
    re-sending the same responses is idempotent; responses that all
    carry `action: "cancel"` cancel the task. The `inputRound` binds an
    answer to the round that asked for it: a workflow may re-ask the
    same question (a new round with the same keys), and a stale retry of
    an earlier round is rejected rather than mistaken for the new
    answer. A submission must name the pending round: once a round has
    been asked, omitting `inputRound` is itself rejected as stale, and a
    malformed one is rejected outright rather than treated as absent. The
    descriptor carries `inputRound` on every status once a round has been
    asked, not only while input is pending, so a client that lost its
    copy can always recover it with `tasks/get`.
- Statuses: `working` → `input_required` ⇄ `working` →
  `completed` | `failed` | `cancelled`. Terminal states never change; a
  cancel that races ahead of completion wins.

Task methods exist only on the modern path. A legacy request that
carries `params.task` is rejected loudly (never run synchronously as a
silent fallback), and legacy `tasks/*` methods are unknown methods.

## Ownership and privacy

Tasks require an authenticated caller. Every owner-facing read or update
is bound to the subject that created the task; unknown ids, foreign
owners, and expired tasks are all answered identically
(`-32602 Unknown task`), so a task's existence never leaks across
callers or tenants. Task ids are 128-bit random values generated
server-side, defense in depth on top of the owner binding.

### Deferred execution runs with the identity captured at creation

A task snapshots the resolved caller (`subject` + claims) at creation
and injects it into `identityArg` tools, and re-runs the host's
`authorize` for the tool only at creation, not at execution. So a
deferred task executes with the creator's identity as it was when the
task was created, which stays valid until the task's TTL even if the
caller's token expired or their access was revoked in between. If you
need to stop a revoked subject's pending work, call
`gateway.cancelPendingTasksForOwner(ctx, subject)` when you process the
revocation: it cancels every live task that subject owns (and returns
their ids so you can also cancel any durable execution). Choose a task
TTL (`tasks.retentionMs`, or the per-call `ttlMs`) short enough that the
revocation window you can tolerate is bounded even without an explicit
cancel.

### One task table, shared across mounts

The task table is component-owned, so it is shared by every
`handleMcpRequest` mount on the same component, independent of which
mount's catalog a task was created through. That is deliberate, it lets
a durable execution started on one mount be finalized from anywhere,
but it means a `tasks/update` only resumes a host-executed task if it
reaches a mount whose `tasks.onInputResponses` hook can act on it.
Sending the update to a different mount stores the responses durably and
returns success (with a warning in the deployment log), but the paused
workflow is not resumed. Keep a task's create and update traffic on the
same mount, or give every task-enabled mount equivalent hooks.

### Scoping tasks to a mount

Ownership alone is not enough when the gateway is mounted more than once.
`authorize` runs when a task is created and never again on `tasks/get` /
`tasks/update`, so a caller permitted on a mount with a broad tool set can
start a privileged task there and collect its **result** through a mount
whose policy would have refused the tool, bypassing that policy without
any bug in it. The 128-bit random task id is the only other barrier, and
ids leak (logs, proxies, the `Mcp-Name` header).

Set `tasks.scope` per mount to close it:

```ts
// convex/http.ts
gateway.handleMcpRequest(ctx, request, {
  authorize: broadPolicy,
  tools,
  tasks: { scope: "main" },
});

gateway.handleMcpRequest(ctx, request, {
  authorize: partnerPolicy,
  tools,
  tasks: { scope: "partner" },
});
```

The scope is stored on the row and must match on every owner-facing read
or update; a mismatch is answered exactly like an unknown task id, so
scoping never reveals that another mount's task exists. The match is
required in **both** directions, a scoped row is invisible to an
unscoped mount, and an unscoped row is invisible to a scoped one.

Leaving `scope` unset keeps the pre-scope behaviour, so a single-mount
host needs no migration. If you adopt it later, note the second direction
above: tasks created before the change carry no scope and stay visible
only to an unscoped mount until they expire. Adopt it during a quiet
window, or accept that in-flight tasks finish unobservably.

`gateway.cancelPendingTasksForOwner(ctx, subject)` deliberately ignores
scope by default and sweeps every mount, because a revocation is about
the subject rather than one mount. Pass a third `scope` argument to narrow
it, and note that a narrowed sweep which cancels nothing while the
subject does have rows is logged as a probable wrong scope, since
`cancelled: 0` otherwise reads as "nothing was pending" while the revoked
subject's tasks stay armed until their TTL.

A sealed `requestState` is bound to the tool, the caller, and the
arguments, **not** to the mount. Two mounts that share `mrtr.secret`
therefore both accept the same continuation, and because their task rows
are scope-isolated, each will own its own task for that chain. The
side effect stays single (both runs receive the same chain key in
`mrtrArgs`), but "one chain, one handle" holds per mount rather than
globally. Give mounts with distinct scopes distinct `mrtr.secret` values if
you want a continuation to be non-transferable between them.

`scope: ""` is rejected at the mount: stored verbatim it would be a third
namespace, unreachable from both scoped and unscoped mounts, which is what
`process.env.MOUNT_ID ?? ""` would silently produce. A scope mismatch on a
task the caller does own is logged server-side (the wire answer stays
identical to an unknown id), so a half-configured pair of mounts is
diagnosable instead of silently answering "unknown task" forever.

Note also that all mounts of one component share a single tool registry
and a single catalog fingerprint. Mounts must pass the **same** `tools`
array and differ only in their `tasks` / `authorize` / identity options;
two divergent catalogs would re-sync against each other on every modern
request, and a tool that is registered could answer `-32602` to a
concurrent call.

### Tools with an MRTR `beforeCall` hook

A tool can be both MRTR-gated and task-capable. The host-side hook runs
**at task-creation time**, before any durable row exists, so the two
negotiation channels never collide:

- The hook returns an `inputRequired()` → the call answers with the
  ordinary MRTR `input_required` envelope (`requestState`) and **no task
  is created**. The client negotiates over `requestState` as usual.
- The hook returns `completeCall()` (e.g. a declined confirmation) → that
  result is returned directly, again with no task.
- The hook returns `null` (approved) → the task row is created and the
  handle is returned. Once a task exists, further input rounds belong to
  the task's own `input_required` state (`requireTaskInput` +
  `tasks/update`), not to `requestState`.

So a task-augmented MRTR tool negotiates synchronously first and only
then becomes a task. The task inherits the MRTR chain's idempotency key,
which is what the executor injects into the tool's `mrtrArgs`.

**Creating a task claims the chain.** An MRTR chain resolves exactly once
(see [architecture.md](./architecture.md#stateless-multi-round-trips-mrtr)), and
creating a task *is* a resolution, it returns a handle instead of
dispatching, and once the row exists the executor runs the tool with no
further gate. So the gateway claims the chain with
`resolution: "dispatched"` before the row is created, exactly as it would
for a synchronous dispatch. A continuation of a chain that another branch
already settled is refused and creates nothing.

**A replayed continuation returns the same handle.** Re-sending a
continuation whose response was lost is legitimate, and it reaches task
creation again with the same chain key. Rather than mint a sibling task,
the component returns the task that key already owns: one handle, one TTL,
one audit trail, and normally no second `execute` call.

Details worth knowing:

- The lookup is bound to owner, scope, tool, execution model, and MRTR
  approval, so a key can never surface somebody else's task and never
  folds a request into a row created under different terms.
- An **expired** row is not reused (the handle would answer like an
  unknown id), but a **terminal** one is: a cancelled, failed, or completed
  task is the outcome of this very request, and inserting a new row would
  re-run a tool whose task the owner had just cancelled.
- If the original request created the row but died before its host
  executor started (the `execute` throw *and* its compensating `failTask`
  both failed), the replay starts execution instead of assuming the
  original did, otherwise the client would poll a handle nothing ever
  advances. The row records a start marker so the normal case still starts
  exactly once.
- Reuse writes no audit row, so it is logged instead; a replay storm is
  visible in the deployment log rather than nowhere.
- If the start failed *and* was recorded (the ordinary case: the client got
  `-32603 Task failed to start` and the row is `failed`), replaying the
  continuation reuses that failed row and answers with a task handle whose
  status is `failed`, the outcome of this request, but a different
  response *shape* from the error the client first saw. A chain whose task
  failed to start cannot be revived; start a new call without
  `requestState`.

## Execution models

### Built-in executor (default)

With `tasks: {}` the gateway schedules the registered tool function via
the Convex scheduler immediately after creating the task row, then
completes or fails the task with the same error sanitization as a
synchronous `tools/call` (only a deliberate `ConvexError` reaches the
polling client verbatim). Convex scheduled functions are durable across
deploys and restarts, and the scheduled action invokes the tool at most
once, so this executor never re-runs a tool by itself. There are no
retries and no `input_required` rounds.

The invocation goes through the same `dispatch.runTool` path as a
synchronous call, so a task-run tool gets identical identity injection and
error sanitization, and produces the same `entryType: "tool"` audit row.
(Redaction is moot on this path: `taskSupport` is incompatible with
`metadata.auditArgs`, so a task-run tool always audits its args verbatim.) The `entryType: "task"` lifecycle
rows are bookkeeping *around* that call, not a substitute for it.

A tool's own idempotency key is still worth persisting here. The obvious
case is a tool reached on both the task and synchronous paths, which sees
the same key either way, so an insert-if-absent keyed on it dedupes them
(see **Idempotency** below). The subtler one is that a replayed
task-augmented continuation normally reuses its task rather than creating
a second one, but not across two mounts with different `tasks.scope`
values, where each mount legitimately owns its own task row for that
chain. There, the shared key is what keeps the side effect single.

### Host executor (`@convex-dev/workflow`)

Hosts that need retry policy, delays, multi-step orchestration, or
`input_required` rounds supply `tasks.execute` and own durable
execution. `@convex-dev/workflow` (Workpool underneath) is the intended
fit: it provides durable step execution, retries, and cancellation. A
published Convex component *can* embed another component (workflow
itself nests workpool as a child component), but this gateway
deliberately does not bundle workflow: it would force workflow's tables
and peer dependencies on every host, including the majority that never
enable tasks. Instead the host mounts workflow next to the gateway and
wires it in:

```ts
// convex/convex.config.ts
app.use(mcpGateway);
app.use(workflow);

// convex/http.ts
gateway.handleMcpRequest(ctx, request, {
  authorize,
  tools,
  tasks: {
    execute: async (ctx, task) => {
      await workflowManager.start(
        ctx,
        internal.reports.generateWorkflow,
        // Thread the whole snapshot: the idempotency key MUST reach the
        // steps that perform side effects.
        { task },
      );
    },
    onInputResponses: async (ctx, event) => {
      // Resume the paused workflow, e.g. via a signal or by re-reading
      // gateway.getTask(ctx, event.taskId).
    },
    onCancel: async (ctx, event) => {
      // Cancel the workflow run for event.taskId.
    },
  },
});
```

The example app ships this exact shape without the workflow dependency:
the `/mcp-host-tasks/` mount in
[example/convex/http.ts](../example/convex/http.ts) pauses
`invoices_bulkMarkPaid` for confirmation via `requireTaskInput`, resumes
in `onInputResponses` (completing with the tool's own value, which the
gateway wraps on read), sets its own `tasks.scope` so its
tasks cannot be driven from the other mount, and keys the side effect on
the task's idempotency key in
[example/convex/invoices.ts](../example/convex/invoices.ts)
(`bulkMarkPaidTask` + the `taskExecutions` table).

**Check what the trusted APIs return.** `requireTaskInput`,
`completeTask`, and `failTask` all report outcomes rather than throwing.
`requireTaskInput` answering anything but `"updated"` means the task never
entered `input_required`, so nothing will ever ask the owner and nothing
will ever run, throw from `execute` (the gateway then fails the task and
returns a clean error) instead of returning normally, which would leave
the client polling `working` until the TTL. `completeTask` answering
`"result_too_large"` means your work committed but the task was **failed**
because the result could not be stored; `"not_found"` means the row
expired underneath you. In both cases the client sees something other than
what happened, so log it.

**Starting durable execution is not transactional with task creation.**
The task row is committed first, then `execute` runs in the same HTTP
action. A throw is handled (the gateway fails the task, or hands back the
handle if `execute` had already advanced it), but the action being killed
outright, timeout, deploy, isolate death, is not: the row stays
`working` until its TTL with nothing started. Keep `execute` short and
prefer a single `ctx.runMutation` that enqueues the real work, so the
window is as small as possible. The built-in executor has no such window:
it is scheduled inside the creating mutation.

**Hooks are at-least-once and must be idempotent.** A hook that throws
is logged and the client's update still succeeds (the state is already
durably committed). The retry path is wire-driven: an idempotent repeat
of the same `tasks/update` (re-sent responses, repeated cancel)
re-fires the corresponding hook, so a resume or cancel notification
that failed once is not lost forever. Resuming the same workflow twice
or cancelling an already-cancelled run must therefore be safe.

Inside the workflow, finalize through the trusted gateway APIs:

- `gateway.completeTask(ctx, taskId, value, flags?)`. Pass your tool's own
  value, not a `CallToolResult`: the gateway derives the envelope on read,
  so both executors converge on one wire shape. `flags.isError` marks a
  call that ran and reported a failure; whether the envelope carries
  `structuredContent` is read from the tool's own registration rather than
  passed here, so a host cannot leave `tools/list` advertising an
  `outputSchema` that `tasks/get` then fails to honour.
- `gateway.failTask(ctx, taskId, { code, message }, auditErrorMessage?)`.
  For the task *itself* failing: `failed` tells a client the call never
  produced a result, and it cannot act on a message it is told to
  disregard. A tool that ran and failed (a validation error, a quota
  refusal) should `completeTask` with `isError: true` instead.

  A **declined confirmation is neither.** The negotiation succeeded and its
  outcome was negative, so the example completes the task with a plain
  result and no `isError`, matching how the synchronous MRTR path reports
  the same decline via `completeCall`. Note the consequence for auditing: a
  completion that is not marked as an error records `outcome: "allowed"`,
  so if you need declines distinguishable in the audit log, record that
  yourself, exactly as you would on the synchronous path where a decline
  never reaches the audit at all.
- `gateway.requireTaskInput(ctx, taskId, inputRequests)` to pause for
  MRTR-shaped input; the accepted responses come back through
  `onInputResponses` (and stay readable on the row via
  `gateway.getTask`). Host-executed tasks only: the built-in executor
  runs once and could never resume, so component-executed tasks answer
  `"unsupported_executor"`.

A cancel that lands first wins: `completeTask` / `failTask` on a
cancelled task return `"conflict"` and change nothing.

**Idempotency.** Workpool retries and duplicate client updates mean a
workflow step can run more than once. Every task carries one stable
`idempotencyKey` (also passed to `execute`); a tool with side effects
must persist it around the effect (insert-if-absent keyed on it) so a
retry recognizes prior work.

A task created from a verified MRTR continuation inherits that chain's
idempotency key instead of minting a new one. That is what lets a
replayed continuation be answered with the task it already created rather
than a sibling, and what keeps the side effect single in the one case
where a sibling is still legitimate (two mounts with different
`tasks.scope`). For a tool that reserves `mrtrArgs`, the built-in executor
injects the task row's key into the declared argument, exactly as the
synchronous MRTR path does.

## Retention and size limits

- Retention: default 24 hours per task, clamped to
  [1 minute, 7 days]; the host default is `tasks.retentionMs`, a client
  may request a shorter `ttlMs` per call. Expired tasks answer like
  unknown ids; `gateway.pruneTasks(ctx)` drains them from a cron.
- The TTL is an **execution deadline**, not only a retention window.
  Expiry makes a task unobservable to its owner and makes the trusted
  finalizers answer `not_found`, and the prune deletes expired rows
  whatever their status, including a `working` one. Pick a `ttlMs` that
  covers the tool's worst-case runtime plus however long the client may
  take to answer an `input_required` round; the lifecycle audit rows
  (never pruned here) stay as the record either way.
- A task result is readable only until the task expires: `tasks/get`
  serves `completed` / `failed` outcomes inside the retention window and
  answers like an unknown id after it. That same window is the
  revocation window described above, so shortening it to bound revocation
  also shortens how long a client may take to collect its result.
- Per-owner cap: **256 live tasks**, where live means `working` or
  `input_required`. A 257th task-augmented call is rejected until one of
  them settles or expires.

  This is a **concurrency** bound and nothing more. A task stops counting
  the moment it reaches `completed` / `failed` / `cancelled`, while its
  row, and its stored arguments and result, persist until the TTL. So a
  caller that loops short tasks stays under the cap indefinitely: it will
  hold one live task at a time and any number of retained ones. The cap
  will never be the thing that stops it.

  The two levers for volume are therefore `tasks.retentionMs` (how long
  each settled row is kept: up to 64 KiB of arguments plus 256 KiB of
  result, plus its audit rows) and rate limiting in front of the gateway.
  The caller is authenticated and has already passed `authorize` by the
  time a task exists, so "too many requests" belongs there rather than in
  a component table.
- Serialized sizes: task arguments ≤ 64 KiB, `inputRequests` /
  `inputResponses` ≤ 64 KiB, results ≤ 256 KiB, and the stored caller
  snapshot ≤ 8 KiB (a fat-claims JWT is rejected at creation). Values
  that nest past a fixed depth are rejected rather than risking a stack
  overflow. An oversized result fails the task (the client sees a clear
  error) instead of storing a row the transport could never deliver;
  `completeTask` reports that as `"result_too_large"` so the caller knows
  its committed work is not what the client will see. The 256 KiB applies
  to the tool's own value, which is exactly what the row stores: the
  `CallToolResult` is derived on read, so nothing inflates the row between
  the check and the write, and the per-task budget stays inside Convex's
  1 MiB document limit (256 + 64 + 64 + 64 + 8 KiB).

## Audit

Every state-changing lifecycle transition writes an `entryType: "task"`
audit row (`create`, `input`, `cancel`, `complete`, `fail`) carrying the
task id, tool name, owner subject, and the task's age at that transition
(`durationMs`, `0` on `create`, it is an age, not an operation latency),
never task payloads. Idempotent no-ops (`already_cancelled`, a duplicate
submission) deliberately write nothing. Pruning a task that never reached
a terminal state writes the `fail` row it never got, so the trail always
shows how a task ended rather than stopping at `create`. Polling
(`tasks/get`) is not audited.

A **component-executed** run additionally writes the ordinary
`entryType: "tool"` row, because it dispatches through the same
`dispatch.runTool` path as a synchronous call, same identity attribution
and same error-text policy. That row carries the arguments verbatim;
redaction is not available here, since `taskSupport` is incompatible with
`metadata.auditArgs` (see **Enabling tasks**). Filter with
`gateway.listAuditEntries(ctx, { entryType: "task" })` or `{ taskId }`;
[audit-log.md](./audit-log.md) documents the row shape and the
`entryType` discriminator.
