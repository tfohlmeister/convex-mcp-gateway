# Getting Started

This walks you through installing the gateway, registering a tool, and
calling it over MCP. Aim: working end-to-end in under five minutes against
a local Convex backend.

## Prerequisites

- A Convex project (`npx convex dev` works against your deployment)
- Node 20+
- Optional: any spec-compliant MCP client (the official MCP Inspector
  is the easiest option; IDE plugins and agent runtimes also work) to
  talk to the gateway interactively

## 1. Install

```sh
pnpm add convex-mcp-gateway
# or: npm install / yarn add
```

## 2. Mount the component

In your host's `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import mcpGateway from "convex-mcp-gateway/convex.config";

const app = defineApp();
app.use(mcpGateway);
export default app;
```

The component owns ten Convex tables: `tools`, `resources`,
`resourceTemplates`, `config` and `audit`, plus `sessions` and
`subscriptions` for Streamable-HTTP, and `mrtrRedemptions`, `mrtrChains`
and `tasks` for the multi-round-trip and task features.

Five of them grow with traffic and want a cron, so wire up whichever
features you actually enable:

| Table | Prune with |
|---|---|
| `audit` | `gateway.pruneAuditEntries(ctx, retentionMs)` |
| `sessions` | `gateway.pruneSessions(ctx, idleMs)` |
| `subscriptions` | `gateway.pruneResourceSubscriptions(ctx)` |
| `mrtrRedemptions` + `mrtrChains` | `gateway.pruneMrtrRedemptions(ctx)` |
| `tasks` | `gateway.pruneTasks(ctx)` |

The component does **not** mount any HTTP routes of its own. The `/mcp/` endpoint and the OAuth discovery route both live
in your host's `http.ts` (steps 3 and 6 below). The reason is structural:
Convex doesn't propagate `ctx.auth` into component code, so the only place
the gateway can read the JWT-validated identity is from a host-mounted
`httpAction`.

## 3. Declare your tools

Declare the catalog once as a plain array and export it. You pass it to
`handleMcpRequest` in step 4; the gateway reconciles the registry on
each connect, so editing this list takes effect on the next `initialize`
with no mutation to run by hand.

```ts
// convex/mcp.ts
import { v } from "convex/values";
import { defineMcpQuery, defineMcpMutation } from "convex-mcp-gateway";
import { api } from "./_generated/api.js";

export const tools = [
  defineMcpQuery({
    name: "invoices_summary",
    description: "Total number of invoices. Public.",
    fn: api.invoices.summary,
    args: {},
    metadata: { public: true },
  }),
  defineMcpQuery({
    name: "invoices_list",
    description: "List invoices for the authenticated user.",
    fn: api.invoices.list,
    args: { status: v.optional(v.string()) },
  }),
  defineMcpMutation({
    name: "invoices_markPaid",
    description: "Mark an invoice as paid.",
    fn: api.invoices.markPaid,
    args: { id: v.id("invoices") },
    metadata: { roles: ["finance.admin"] },
  }),
];
```

**Naming**: tool names must match `^[a-zA-Z0-9_-]{1,64}$`, letters,
digits, underscore, hyphen, up to 64 chars. Dotted names like
`invoices.list` (mirroring Convex's `api.invoices.list` reference
style) are rejected by most MCP clients and will throw at
registration time. Use `invoices_list` instead.

**Typed return values (optional)**: pass `returns:` with a Convex
validator and the gateway advertises an MCP `outputSchema` and ships the
value as `structuredContent` alongside the text block. The validator is
type-checked against the Convex function's actual return type at compile
time:

```ts
defineMcpQuery({
  name: "invoices_summary",
  fn: api.invoices.summary,
  args: {},
  returns: v.object({ total: v.float64() }),  // ← compile-checked
}),
```

Tools without `returns:` keep their pre-existing wire format
unchanged, backwards-compatible for any registration that exists today.

**Prefer an object-rooted validator.** Only the `2026-07-28` revision
permits a non-object `outputSchema`; everything up to `2025-11-25`
requires `type: "object"` at the root, and a client validating to those
revisions rejects the entire `tools/list` response over a single
scalar-rooted schema. The gateway therefore withholds such a schema from
those clients rather than hiding every tool from them: the tool reads as
untyped there, with its value in the text block as always, and it gets
no `structuredContent` either, since that field is object-typed on those
same revisions.

`v.string()` is the obvious case. The surprising one is a **union**,
which compiles to `anyOf` and so has no root `type` even when every
branch is an object:

| `returns:` | root | advertised to a legacy client |
|---|---|---|
| `v.object({ total: v.float64() })` | `type: "object"` | yes |
| `v.record(v.string(), v.float64())` | `type: "object"` | yes |
| `v.string()`, `v.float64()` | scalar | no |
| `v.union(v.object(A), v.object(B))` | `anyOf` | no |
| `v.union(v.object(A), v.null())` | `anyOf` | no |
| `v.any()` | `{}` | no |

If you want the schema advertised to every client, keep one object at
the root and move the choice inside it, e.g.
`v.object({ result: v.union(A, B) })` or an optional field instead of a
nullable union. Modern clients get the schema either way.

**Injecting the caller identity (optional)**: a dispatched tool runs
inside the component, where `ctx.auth` is unavailable. To give a tool
the authenticated caller, declare an argument with `mcpCallerValidator`
and name it in `identityArg`. The gateway fills it server-side with the
resolved caller (`{ subject, claims }`), hides it from the advertised
schema, strips any client-supplied value (no spoofing), and rejects
unauthenticated calls as `-32001 Unauthorized`:

```ts
// convex/invoices.ts
import { mcpCallerValidator } from "convex-mcp-gateway";

export const whoami = query({
  args: { caller: mcpCallerValidator },
  handler: async (_ctx, { caller }) => ({ subject: caller.subject }),
});

// convex/mcp.ts (add to the tools array)
defineMcpQuery({
  name: "invoices_whoami",
  fn: api.invoices.whoami,
  args: { caller: mcpCallerValidator },
  identityArg: "caller", // ← gateway fills this; clients can't send it
}),
```

See [architecture.md → Identity propagation](./architecture.md#identity-propagation)
for the full data flow.

**Protocol metadata (optional)**: four fields go straight onto the tool
entry in `tools/list`, so MCP clients see them:

```ts
defineMcpQuery({
  name: "invoices_summary",
  fn: api.invoices.summary,
  args: {},
  title: "Invoice summary",                  // human-readable label
  annotations: { readOnlyHint: true },       // MCP behavior hints
  _meta: { "example.com/category": "invoices" }, // client-specific data
  securitySchemes: [{ type: "noauth" }],     // draft MCP spec, passthrough
}),
```

The gateway stores these as one `protocolMetadata` object and never
reads them. Omit a field and it does not appear on the wire.
`securitySchemes` is not yet in the stable MCP Tool specification; the
gateway passes it through unchanged for clients that track the draft.

`defineMcp{Query,Mutation,Action}` validates `args` against
`FunctionArgs<typeof fn>` at compile time. Passing the wrong validator or
the wrong function kind is a type error, not a runtime surprise.

`metadata` is host-defined free-form data. The gateway never inspects it;
your authorize callback (step 4) reads it for public/role/scope checks.
It stays server-side, unlike the four protocol fields above.

**No manual registration step.** Because step 4 passes this array to
`handleMcpRequest`, the registry is reconciled on `initialize` and again
whenever the list changes, you do not run anything by hand. The
reconcile is change-detected: the list is fingerprinted and the registry
is only rewritten when something actually changed, so an unchanged list
costs a single cheap lookup per connect, not a rewrite.

> **Upgrading.** The fingerprint now covers the protocol metadata
> fields, so the first `initialize` after this upgrade sees a changed
> fingerprint and rewrites the registry once, even if your tool list is
> unchanged. This is a single extra mutation on the first connect. No
> action is necessary.

> **Imperative alternative.** If you'd rather populate the registry from
> a mutation (dynamic/plugin catalogs), call `gateway.register(ctx,
tools)` inside an `internalMutation` and run it after deploy instead of
> passing `tools`. `register` replaces the registry atomically (tools no
> longer in the array are removed in the same mutation, so stale
> registrations can't leak across deploys); `gateway.registerTool` does
> genuine per-item upserts.

## 4. Mount `/mcp/` with your authorize callback

The gateway is **deny-by-default**. Until you mount the handler with an
`authorize` callback, nothing reaches your tools. The callback is a
regular JS function (not a registered Convex query) because Convex only
exposes `ctx.auth.getUserIdentity()` inside host-side `httpAction`s, not
inside component code.

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { McpGateway, type McpAuthorizerHandler } from "convex-mcp-gateway";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { tools } from "./mcp.js";

const gateway = new McpGateway(components.mcpGateway);

const authorize: McpAuthorizerHandler = async (ctx, args) => {
  const meta = (args.toolMetadata ?? {}) as {
    public?: boolean;
    roles?: string[];
  };
  if (meta.public) return { allowed: true };

  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return { allowed: false, reason: "Unauthorized" };

  if (meta.roles && meta.roles.length > 0) {
    const claimRoles =
      ((identity as { roles?: unknown }).roles as string[] | undefined) ?? [];
    const missing = meta.roles.filter((r) => !claimRoles.includes(r));
    if (missing.length > 0) {
      return {
        allowed: false,
        reason: `Forbidden: needs roles ${missing.join(", ")}`,
      };
    }
  }
  return { allowed: true };
};

const http = httpRouter();

const mcpHandler = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, { authorize, tools }),
);
// Mount both `/mcp/` and `/mcp`. Some MCP clients (e.g. claude.ai)
// strip the trailing slash from the configured server URL before
// POSTing, so a single-path mount silently 404s real traffic.
for (const path of ["/mcp/", "/mcp"]) {
  http.route({ path, method: "POST", handler: mcpHandler });
  http.route({ path, method: "GET", handler: mcpHandler });
  http.route({ path, method: "DELETE", handler: mcpHandler });
}

export default http;
```

`ctx.auth.getUserIdentity()` returns whatever Convex resolved from the
inbound `Authorization: Bearer ...` header against your `auth.config.ts`.
If your app already uses Clerk, Auth0, Pocket-ID or a JWT issuer, the
gateway picks up that same identity for free.

The same callback is used for both `tools/call` (it gates the dispatch)
and `tools/list` (it filters the catalog per tool with `mode: "list"`).
See [authorization.md](./authorization.md) for scope/role/argument
recipes.

> **All-private server reached by a browser client (claude.ai)?** Pass
> `requireAuth: true` in the options. With no `public` tools, anonymous
> `initialize` / `tools/list` would otherwise return 200 (empty) and the
> client never starts OAuth, it only reacts to a 401. `requireAuth`
> challenges anonymous POSTs so the login is prompted. Needs OAuth
> config (step 5). Leave it off for mixed public/private servers. Full
> rationale: [oauth.md](./oauth.md#all-private-servers-and-browser-clients-requireauth).

> **Server-level instructions.** Pass `initializeInstructions: "..."` in the
> options to populate the MCP `initialize` result's `instructions` field:
> guidance the client can hand the LLM about how to use the server as a whole,
> without bloating individual tool descriptions. Omitted from the response
> when unset, so the default `initialize` shape is unchanged. Treat it as a
> best-effort hint: clients MAY use it, some ignore it, and those that honor it
> may cap or front-truncate the text. Keep it short, lead with what matters,
> and enforce hard rules in `authorize` or your tool handler.

## 5. (Optional) Mount OAuth discovery

If you want MCP clients to discover your authorization server
automatically (no hardcoded URL on the client side), configure it via
the gateway and mount the RFC 9728 discovery route on your host's
`httpRouter`:

```ts
// convex/mcp.ts: OAuth config is stored in the DB, so set it once
// from a mutation (it changes rarely, unlike the tool list).
import { McpGateway } from "convex-mcp-gateway";
import { components } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);

export const setupOAuth = internalMutation({
  args: {},
  handler: async (ctx) => {
    await gateway.setOAuthConfig(ctx, {
      authServerUrl: "https://your-idp.example.com/",
    });
  },
});
// run once: npx convex run mcp:setupOAuth
```

```ts
// convex/http.ts (extend the router from step 4)
http.route({
  path: "/.well-known/oauth-protected-resource/mcp",
  method: "GET",
  handler: httpAction(async (ctx, request) =>
    gateway.serveProtectedResourceMetadata(ctx, request),
  ),
});
```

RFC 9728 §3.1 mandates the metadata at
`<origin>/.well-known/oauth-protected-resource<path>`, which is outside
the `/mcp/` path the handler owns. Full guide: [oauth.md](./oauth.md).

## 6. Talk to it

The gateway speaks Streamable HTTP in two eras on the same endpoint.
The walkthrough below uses the session-based one (**2025-03-26**,
**2025-06-18**, and **2025-11-25**): every client first `initialize`s to
receive a session ID, then includes it on all subsequent requests via
the `Mcp-Session-Id` header. JSON and SSE responses are both supported; the
server picks based on the client's `Accept` header.

Stateless **2026-07-28** clients skip all of that: no `initialize`, no
session ID, each request carries its own protocol metadata. See
[the 2026-07-28 section in the README](../README.md#mcp-2026-07-28-clients)
for the request contract.

```sh
# 1. Initialize and capture the session id from the response header.
SESSION=$(curl -sSD - -X POST "$CONVEX_SITE_URL/mcp/" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  | tee /dev/stderr | awk '/^[Mm]cp-[Ss]ession-[Ii]d:/ {print $2}' | tr -d '\r')

# 2. Use the session for everything else.
curl -sS -X POST "$CONVEX_SITE_URL/mcp/" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3. (Optional) DELETE explicitly when you're done.
curl -X DELETE "$CONVEX_SITE_URL/mcp/" -H "mcp-session-id: $SESSION"
```

Anonymous callers see only the public tools (`metadata.public: true` in
the authorize callback above). Authenticated callers get the full catalog
they are allowed to invoke. Calling a private tool without a Bearer
returns HTTP 401 with a `WWW-Authenticate` header pointing at your
discovery endpoint, exactly what MCP clients expect.

Spec-compliant MCP clients handle the session handshake automatically;
you only configure the URL.

## Local development

The repo ships a `pnpm local:start` script that downloads a pinned
`convex-local-backend` binary (no Docker), runs it on `127.0.0.1:3310/3311`
with public test credentials, and writes a matching `.env.local`. Useful
when you want to iterate without touching a real deployment:

```sh
pnpm local:start                      # in one shell
# in another shell:
npx convex dev --once
# No registration step: the example's /mcp/ mount declares `tools`, so
# the registry syncs on the initialize below.
SESSION=$(curl -sSD - -X POST http://127.0.0.1:3311/mcp/ \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  | awk '/^[Mm]cp-[Ss]ession-[Ii]d:/ {print $2}' | tr -d '\r')
curl http://127.0.0.1:3311/mcp/ \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## Troubleshooting: circular type error from your tool list

If `npx convex dev` or `tsc` fails with errors like:

```text
_generated/api.d.ts: error TS2502: 'api' is referenced directly or indirectly in its own type annotation.
_generated/api.d.ts: error TS2615: Type of property 'mcp' circularly references itself in mapped type ...
mcp.ts: error TS7022: 'tools' implicitly has type 'any' because it does not have a type annotation and is referenced directly or indirectly in its own initializer.
```

you've hit a Convex codegen circularity, not a bug in your tools and not
a type-safety hole. It happens whenever you **export** a value from a
file under `convex/` whose **inferred type reads `api.*`**, because
Convex's generated `api` type already includes that same module. Your
`tools` array is a classic trigger: each `defineMcp*({ fn: api.x.y })`
embeds a reference to `api`, and `api` includes the module that exports
`tools`, so the type chases its own tail. (This is general Convex
behaviour; any `api`-referencing value you export from `convex/` can do
it, tool lists just hit it most often.)

Two ways to break the loop:

**1. Annotate the export.** Keep it exported (e.g. so a registration
mutation can reuse the same list) and give it an explicit type, so
TypeScript uses the annotation instead of inferring from the
`api`-referencing initializer:

```ts
import { defineMcpQuery, type McpToolRegistration } from "convex-mcp-gateway";

export const tools: McpToolRegistration[] = [
  defineMcpQuery({
    /* ... */
  }),
];
```

**2. Don't export it from a Convex module.** A non-exported
`const tools = [...]` declared inline in `http.ts` is never part of
`api`, so it needs no annotation:

```ts
// convex/http.ts
const tools = [
  defineMcpQuery({
    /* ... */
  }),
];
const mcp = httpAction(async (ctx, req) =>
  gateway.handleMcpRequest(ctx, req, { authorize, tools }),
);
```

Either way the per-tool checks are unaffected: `args` and `returns` are
validated against the function's real signature at each `defineMcp*`
call, regardless of how (or whether) you type the surrounding array.

## (Optional) Serve resources

Beyond tools, the gateway serves read-only MCP **resources**. Declare one
with `defineMcpResource` and pass it to the same `handleMcpRequest` call:

```ts
// convex/mcp.ts
import { defineMcpResource } from "convex-mcp-gateway";
import { api } from "./_generated/api.js";

export const resources = [
  defineMcpResource({
    uri: "invoices://summary",
    name: "invoice-summary",
    mimeType: "application/json",
    read: async (ctx, { uri }) => [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(await ctx.runQuery(api.invoices.summary, {})),
      },
    ],
  }),
];

// convex/http.ts
//   gateway.handleMcpRequest(ctx, req, { authorize, tools, resources });
```

Reads run only for authenticated callers. Add `defineMcpResourceTemplate`
for parameterized URIs, `authorizeResource` for per-resource policy, and
`auditResources` to log reads. A complete runnable wiring is in
[`example/convex`](../example/convex/mcp.ts). Full guide:
[resources.md](./resources.md).

## Where to go next

- [architecture.md](./architecture.md): component model, data flow,
  identity propagation
- [authorization.md](./authorization.md): scope/role recipes,
  `mode: "list"` vs `"call"`, audit-redaction
- [resources.md](./resources.md): resources, templates, subscriptions,
  shape validation
- [oauth.md](./oauth.md): full OAuth 2.1 setup with discovery
- [audit-log.md](./audit-log.md): reading and pruning the audit log
- [testing.md](./testing.md): `convex-test` patterns for the gateway
