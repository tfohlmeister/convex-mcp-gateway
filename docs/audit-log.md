# Audit log

Every `tools/call` produces one row in the component's `audit` table.
The row records who called what, when, with which arguments, and what
the gateway decided. The audit pipeline is independent from the
dispatch outcome: a failed audit insert never alters the response the
caller sees.

## What gets written

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"audit">` | Convex row id |
| `_creationTime` | `number` | ms since epoch, written by Convex |
| `toolName` | `string` | Registered tool name (indexed) |
| `toolKind` | `"query" \| "mutation" \| "action"` | |
| `args` | `any` | Caller args, or `null` if `metadata.auditArgs === false` on the tool |
| `outcome` | `"allowed" \| "denied" \| "error"` | (indexed) |
| `identitySubject` | `string \| null` | Caller's `identity.subject` resolved by the host's `/mcp/` `httpAction`, or null for anonymous |
| `durationMs` | `number` | Wall-clock time from dispatch start to finish |
| `errorCode` | `number` (optional) | JSON-RPC code on `denied` / `error` outcomes |
| `errorMessage` | `string` (optional) | Human-readable reason; omitted for error outcomes when the tool sets `metadata.auditErrorMessage: false` |

Two indexes are pre-built: `by_toolName` and `by_outcome`. The query
helper iterates them; you don't need to add your own.

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
