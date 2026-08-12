# Audit log

Every `tools/call` produces one row in the component's `audit` table,
and so does every resource operation and every task lifecycle
transition. The row records who called what, when, and what the gateway
decided — plus the arguments, for tool rows. The audit pipeline is
independent from the dispatch outcome: a failed audit insert never
alters the response the caller sees.

`entryType` discriminates the three kinds of row, and the columns that
apply depend on it:

| `entryType` | Written by | Key columns |
|---|---|---|
| `"tool"` | `dispatch.runTool` (and `dispatch.recordAuthDenial` for host-side denials) | `toolName`, `toolKind`, `args` |
| `"resource"` | the host's HTTP handler, per resource operation | `resourceUri`, `resourceOperation` |
| `"task"` | the component's task lifecycle mutations | `taskId`, `taskOperation`, `toolName` |

## What gets written

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"audit">` | Convex row id |
| `_creationTime` | `number` | ms since epoch, written by Convex |
| `entryType` | `"tool" \| "resource" \| "task"` | (indexed) Optional only for rows written before it existed |
| `toolName` | `string` (optional) | Registered tool name (indexed). Also set on task rows, naming the tool the task runs |
| `toolKind` | `"query" \| "mutation" \| "action"` (optional) | Tool rows |
| `resourceUri` | `string` (optional) | Resource rows (indexed) |
| `resourceOperation` | `"list" \| "read" \| "templates" \| "subscribe" \| "unsubscribe"` (optional) | Resource rows |
| `taskId` | `string` (optional) | Task rows (indexed) |
| `taskOperation` | `"create" \| "input" \| "cancel" \| "complete" \| "fail"` (optional) | Task rows |
| `args` | `any` | Caller args on tool rows, or `null` if `metadata.auditArgs === false`. Always `null` on resource and task rows |
| `outcome` | `"allowed" \| "denied" \| "error"` | (indexed) |
| `identitySubject` | `string \| null` | Caller's `identity.subject` resolved by the host's `/mcp/` `httpAction`, or null for anonymous. On task rows, the task's owner |
| `durationMs` | `number` | Tool and resource rows: wall-clock time from dispatch start to finish. Task rows: the task's **age** at that transition (`0` on `create`), not an operation latency |
| `errorCode` | `number` (optional) | JSON-RPC code on `denied` / `error` outcomes |
| `errorMessage` | `string` (optional) | Human-readable reason; omitted for error outcomes when the tool sets `metadata.auditErrorMessage: false` |

Five indexes are pre-built: `by_toolName`, `by_resourceUri`, `by_taskId`,
`by_entryType`, and `by_outcome`. The query helper iterates them; you
don't need to add your own.

## Task rows

A task-augmented `tools/call` writes one `entryType: "task"` row per
state-changing transition — `create`, `input`, `cancel`, `complete`,
`fail` — carrying the task id, tool name, owner subject and the task's
age, and **never** task payloads (`args`, `result`,
`inputRequests` / `inputResponses` are all absent). Idempotent no-ops
(a repeated cancel, a duplicate input submission) deliberately write
nothing. Polling with `tasks/get` is not audited. Pruning a task that
never reached a terminal state writes the `fail` row it never got, so
the trail always shows how a task ended instead of stopping at `create`.

These rows are bookkeeping *around* the execution, not a record of it.
A task run by the built-in executor dispatches through the same
`dispatch.runTool` path as a synchronous call, so it **also** writes the
ordinary `entryType: "tool"` row — same identity attribution, same
argument recording, same error-text policy. A host-executed task
(`tasks.execute`) runs the work in the host's own durable execution, so
only the lifecycle rows exist for it unless the host audits its steps
itself. See [tasks.md](./tasks.md).

## What does NOT get written

- **Unknown-tool calls.** Anonymous callers can spam arbitrary tool
  names with arbitrary args; auditing them would let a drive-by
  attacker grow the table without bound. The gateway returns
  `-32602 Unknown tool` and skips the audit insert.
- **`tools/list` requests.** Listing is read-only and high-frequency;
  auditing it would dominate the table.
- **`initialize` and other JSON-RPC methods.** Same reasoning.

- **The injected caller argument.** For a tool that declares
  `identityArg`, the gateway injects the resolved caller
  (`{ subject, claims }`) server-side. That argument is stripped before
  the audit write, so the caller and its (potentially sensitive) claims
  never land in `args`. The caller's subject is still recorded in the
  dedicated `identitySubject` column.

If you need request-level observability beyond `tools/call`, layer your
own logging in front of the gateway's HTTP route (or wait for the
roadmap item that adds an opt-in request log).

## Reading the log

The `McpGateway` client exposes a thin wrapper:

```ts
import { McpGateway } from "convex-mcp-gateway";
import { components } from "./_generated/api.js";
import { query } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);

export const recentAudit = query({
  args: {},
  handler: async (ctx) => {
    return await gateway.listAuditEntries(ctx, { limit: 50 });
  },
});
```

Filters:

```ts
gateway.listAuditEntries(ctx, { toolName: "invoices_markPaid", limit: 100 });
gateway.listAuditEntries(ctx, { outcome: "denied", limit: 100 });
gateway.listAuditEntries(ctx, { entryType: "task", limit: 100 });
gateway.listAuditEntries(ctx, { taskId, limit: 20 });
gateway.listAuditEntries(ctx, { resourceUri: "invoices://summary" });
gateway.listAuditEntries(ctx, {
  toolName: "invoices_markPaid",
  outcome: "error",
  limit: 50,
});
```

Results are returned newest first. `limit` defaults to 100 and is
capped at 1000 server-side. With both `toolName` and `outcome` set, the
query iterates the `by_toolName` index until `limit` matching rows are
collected, so it doesn't silently miss matches even when most recent
entries are the wrong outcome.

## Redacting secret arguments

If a tool's argument schema can carry credentials or PII, the
`metadata.auditArgs` setting controls what reaches the log. Three modes,
all declarative (functions can't be transmitted to Convex):

```ts
// 1. Default: store args verbatim. (omit metadata.auditArgs)
defineMcpMutation({
  name: "invoices_markPaid",
  fn: api.invoices.markPaid,
  args: { id: v.id("invoices") },
}),

// 2. Drop args entirely (audit row still records caller, outcome, duration).
defineMcpMutation({
  name: "secrets_import",
  fn: api.secrets.import,
  args: { blob: v.string() },
  metadata: { auditArgs: false },
}),

// 3. Field-level redaction. Each entry is a dotted path: top-level
//    keys like "password" redact the matching property; nested paths
//    like "credentials.token" walk into nested objects and redact at
//    the leaf. Arrays and missing intermediate keys are passed
//    through unchanged (no insertion).
defineMcpMutation({
  name: "users_create",
  fn: api.users.create,
  args: {
    email: v.string(),
    password: v.string(),
    credentials: v.optional(v.object({ token: v.string() })),
  },
  metadata: {
    auditArgs: { redact: ["password", "credentials.token"] },
  },
}),
```

For shape-preserving transformation (e.g. truncate a long string,
hash a PII field), use `auditArgs: false` and write a richer summary
into your own table.

**`auditArgs` is incompatible with `taskSupport`.** A task stores the
caller's arguments verbatim in the component's task row for the whole
retention window, because deferred execution needs them. Redacting the
audit row while persisting the same values in the row next to it would be
a false promise, so registering a tool with both `taskSupport: true` and
`metadata.auditArgs` (`false` or `{ redact }`) fails with an explanatory
error. Pick one: a tool whose arguments must not be retained cannot be a
task.

## Redacting error messages

Tool errors are stored verbosely by default so operators can diagnose
failures. If a tool can throw messages containing credentials or other
sensitive values, set `metadata.auditErrorMessage` to `false`. The audit row
still records `outcome: "error"` and `errorCode`, but omits `errorMessage`:

```ts
defineMcpMutation({
  name: "secrets_import",
  fn: api.secrets.import,
  args: { blob: v.string() },
  metadata: { auditErrorMessage: false },
}),
```

This controls audit-table persistence only. The original exception still
reaches the Convex deployment log and any configured log stream.

The MCP caller never saw that text to begin with: unexpected throws reach
it as `Tool execution failed` (tools) or `Resource read failed`
(resources), and a throwing authorize callback as `Authorization check
failed`. Only a deliberate `ConvexError` is passed through verbatim. So
the audit row and the deployment log are the two places the full text
exists, and this option removes one of them.

## Retention / pruning

The component does not prune the audit table on its own; the host
schedules a periodic prune via `gateway.pruneAuditEntries`. Each
call deletes up to ~200 rows in one mutation (bounded to stay
inside Convex's per-mutation read/write limits) and returns the
deleted count, so the caller loops until it returns `0`:

```ts
// convex/audit.ts
import { internalMutation } from "./_generated/server.js";
import { McpGateway } from "convex-mcp-gateway";
import { components } from "./_generated/api.js";

const gateway = new McpGateway(components.mcpGateway);

export const runPrune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const RETAIN_30_DAYS = 30 * 24 * 60 * 60 * 1000;
    let total = 0;
    // Drain until pruneAuditEntries returns 0.
    for (;;) {
      const n = await gateway.pruneAuditEntries(ctx, RETAIN_30_DAYS);
      total += n;
      if (n === 0) break;
    }
    console.info(`audit cleanup: pruned ${total} entries`);
    return total;
  },
});
```

Schedule it with `convex/crons.ts`:

```ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();
crons.daily(
  "audit cleanup",
  { hourUTC: 3, minuteUTC: 0 },
  internal.audit.runPrune,
);
export default crons;
```

If a single cron tick can't drain the backlog (very busy
deployment, long retention window followed by aggressive shortening),
chain a follow-up via `ctx.scheduler.runAfter(0, internal.audit.runPrune, {})`
inside the loop above. The per-call batch is fixed; calling more
often is the right knob.

## Privacy considerations

- **Identity propagation**: `identitySubject` is the JWT `sub` claim.
  If your IdP rotates subjects, audit rows are tied to the value at
  time of write. They are not refreshed.
- **Anonymous calls**: stored as `identitySubject: null`. There is no
  IP, user-agent, or request fingerprint. If you need those, log them
  in front of the gateway.
- **Read access**: `gateway.listAuditEntries` is exposed only through
  whatever query you wrap it in. Hide it from public Convex queries
  (use `internalQuery` or a query that gates on `ctx.auth`) before
  going to production. The component itself does not enforce read
  authorization on the audit table.
- **GDPR / right-to-erasure**: subjects can request deletion of their
  audit history. Until a public delete API ships, run a one-off pruning
  query keyed on `identitySubject`.
