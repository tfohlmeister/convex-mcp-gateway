# convex-mcp-gateway

Auth-aware MCP server for [Convex](https://convex.dev). Expose selected
Convex functions as MCP tools, bring your own JWT issuer, declare
scopes/roles per tool, get an audit log and OAuth 2.1 protected-resource
discovery for free.

Built as a [Convex Component](https://www.convex.dev/components).

[![Convex Component](https://www.convex.dev/components/badge/convex-mcp-gateway)](https://www.convex.dev/components/convex-mcp-gateway)
[![tests](https://img.shields.io/github/actions/workflow/status/tfohlmeister/convex-mcp-gateway/test.yml?branch=main&label=tests)](https://github.com/tfohlmeister/convex-mcp-gateway/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/convex-mcp-gateway.svg)](https://www.npmjs.com/package/convex-mcp-gateway)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

<!-- START: Include on https://convex.dev/components -->

## Features

- **Type-safe tool registration**: `defineMcpQuery` / `defineMcpMutation` /
  `defineMcpAction` declare a Convex function as an MCP tool with end-to-
  end-typed `args` and (optional) `returns` validators. Declare the list
  once and pass it as `tools` to `handleMcpRequest`, the registry
  auto-syncs on connect (no separate registration mutation), or call
  `gateway.register(...)` for imperative/dynamic catalogs
- **MCP dual-era Streamable HTTP**: legacy 2025-03-26/2025-06-18/2025-11-25
  sessions remain supported alongside stateless 2026-07-28 requests,
  discovery, routing-header validation, and private cache hints. A client
  requesting an unknown revision negotiates down to 2025-11-25 (what the
  current official TypeScript SDK pins as latest); all three legacy
  revisions share one transport wire contract (2025-11-25's SSE
  resumability framing needs an event store the gateway doesn't have, so
  it isn't emitted, a deliberate SHOULD deviation)
- **Stateless multi-round trips**: declarative modern tools use a host-side
  `beforeCall` hook to request input before any Convex function runs, then
  receive HMAC-verified continuation state plus an idempotency key on retry;
  see [Multi-round-trip requests](#multi-round-trip-requests)
- **MCP Tasks (poll-first)**: opt-in `io.modelcontextprotocol/tasks`
  support; task-augmented `tools/call` returns a handle, clients poll
  `tasks/get`, owner-bound with TTL retention and lifecycle audit.
  Built-in durable executor via the Convex scheduler, or bring
  `@convex-dev/workflow` for retries and `input_required` rounds.
  See [Tasks](./docs/tasks.md)
- **MCP resources**: `defineMcpResource` / `defineMcpResourceTemplate`
  serve `resources/list`, `resources/read`, and `resources/templates/list`
  (RFC 6570). Central `authorizeResource` hook, opt-in resource audit,
  runtime shape validation, and opt-in `resources/subscribe` capability.
  See [Resources & templates](./docs/resources.md)
- **One authorize callback**: gates `tools/call` and filters `tools/list`
  with `mode: "list" | "call"`; uses your existing `ctx.auth.getUserIdentity()`
- **OAuth 2.1 protected-resource discovery**: RFC 9728 metadata,
  RFC 6750 `WWW-Authenticate` headers, multi-tenant ready
- **Optional OAuth bridge**: RFC 8414 AS metadata wrap + RFC 7591 DCR
  for browser MCP clients (claude.ai) against IdPs without DCR support, with
  opt-in CIMD advertisement when the upstream authorization server supports it
- **`requireAuth` for all-private servers**: opt-in 401-challenge on
  anonymous requests so browser clients (claude.ai) begin the OAuth flow
  instead of seeing an empty `tools/list` and never prompting a login
- **`initializeInstructions`**: optional server-level guidance returned in
  the MCP `initialize` result's `instructions` field, surfaced to the LLM
  without bloating individual tool descriptions
- **Audit log**: one row per call with per-tool argument redaction
  (verbatim / dropped / dotted-path redacted)
- **Wire-error sanitization**: generic message on the wire, full detail
  in audit; `ConvexError` passes through for deliberate user-facing
  messages
- **`convex-test` helper**: `convex-mcp-gateway/test` exports a one-line
  `register(t)` that hooks the component into a `convexTest` instance so
  your host tests can exercise the full `/mcp/` round-trip in-process.
  See [Testing](./docs/testing.md)

## What it does

![Architecture overview](./docs/diagrams/architecture.svg)

You mount the gateway in a single `httpAction` and pass an `authorize`
JS callback that decides per call whether the request goes through.
The gateway handles the JSON-RPC envelope, legacy Streamable-HTTP session
lifecycle, stateless 2026-07-28 requests, the OAuth discovery doc, the
`WWW-Authenticate` headers, and the audit log. Your existing Convex auth
(Clerk, Auth0, Pocket-ID, custom JWT issuer) just works.

A standalone editorial-styled version of the diagram is at
[`docs/diagrams/architecture.html`](./docs/diagrams/architecture.html);
in-depth sequence and data-flow diagrams live in
[`docs/architecture.md`](./docs/architecture.md).

## Try it

The companion repo
[**convex-mcp-gateway-demo**](https://github.com/tfohlmeister/convex-mcp-gateway-demo)
is a notes app that registers five tools (public, identity-gated,
role-gated) and shows the audit log live. Three run modes including
a local-backend setup that needs no Convex account:

```sh
git clone https://github.com/tfohlmeister/convex-mcp-gateway-demo
cd convex-mcp-gateway-demo
pnpm install && pnpm local:start    # in one terminal
pnpm convex:dev && pnpm convex:run mcp:registerDefaults && pnpm dev
```

## Quickstart

```sh
pnpm add convex-mcp-gateway
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import mcpGateway from "convex-mcp-gateway/convex.config";

const app = defineApp();
app.use(mcpGateway);
export default app;
```

```ts
// convex/mcp.ts, declare your tools once
import { v } from "convex/values";
import { defineMcpQuery } from "convex-mcp-gateway";
import { api } from "./_generated/api.js";

export const tools = [
  defineMcpQuery({
    name: "invoices_summary",
    description: "Public invoice counter.",
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
];
```

```ts
// convex/http.ts, mount the gateway with your authorize callback
import { httpRouter } from "convex/server";
import { McpGateway, type McpAuthorizerHandler } from "convex-mcp-gateway";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { tools } from "./mcp.js";

const gateway = new McpGateway(components.mcpGateway);

const authorize: McpAuthorizerHandler = async (ctx, { toolMetadata }) => {
  const meta = (toolMetadata ?? {}) as { public?: boolean };
  if (meta.public) return { allowed: true };
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return { allowed: false, reason: "Unauthorized" };
  return { allowed: true };
};

const http = httpRouter();
// Pass `tools` and the registry syncs on each connect, no separate
// registration mutation to run.
const mcp = httpAction(async (ctx, req) =>
  gateway.handleMcpRequest(ctx, req, { authorize, tools }),
);
// Mount both /mcp/ and /mcp, some clients (claude.ai) strip the
// trailing slash from the configured URL before POSTing.
for (const path of ["/mcp/", "/mcp"]) {
  http.route({ path, method: "POST", handler: mcp });
  http.route({ path, method: "GET", handler: mcp });
  http.route({ path, method: "DELETE", handler: mcp });
}
export default http;
```

```sh
npx convex dev --once
# No registration step: passing `tools` to handleMcpRequest syncs the
# registry on the initialize below.

# Talk to it (Streamable HTTP, initialize first, then send commands).
SESSION=$(curl -sSD - -X POST "$CONVEX_SITE_URL/mcp/" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  | awk '/^[Mm]cp-[Ss]ession-[Ii]d:/ {print $2}' | tr -d '\r')

curl -X POST "$CONVEX_SITE_URL/mcp/" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

The anonymous client sees only `invoices_summary` (the `public: true`
tool); calling `invoices_list` without a Bearer returns HTTP 401 with a
`WWW-Authenticate` header pointing at your discovery endpoint. Any
spec-compliant MCP client (the official MCP Inspector, IDE plugins,
agent runtimes) handles the session and OAuth handshakes
automatically. See [Getting Started](./docs/getting-started.md) for
the full walkthrough.

If your server has **no public tools** and you connect it to a browser
client like **claude.ai**, add `requireAuth: true` to the
`handleMcpRequest` options. Without it, anonymous `initialize` /
`tools/list` return 200 (empty) and the client never starts OAuth, it
only reacts to a 401. See
[OAuth: all-private servers](./docs/oauth.md#all-private-servers-and-browser-clients-requireauth).

To give the model server-level guidance (how to use the server as a whole,
not any single tool), pass `initializeInstructions` to `handleMcpRequest`. It
populates the `initialize` result's `instructions` field and is omitted when
unset, so the default response shape is unchanged. It's a best-effort hint
(per the spec clients MAY use it; some ignore it), so keep it short and don't
rely on it for hard constraints.

### MCP 2026-07-28 clients

The same endpoint also accepts stateless 2026-07-28 requests. Send
`MCP-Protocol-Version: 2026-07-28`, an exactly matching
`params._meta["io.modelcontextprotocol/protocolVersion"]`, and an
`Mcp-Method` header matching the JSON-RPC method. The `_meta` object must carry
`clientCapabilities`; when supplied, `clientInfo` must include a name and
version. `tools/call`, `resources/read`,
and `prompts/get` require `Mcp-Name` to match the requested name or URI. Start
with `server/discover`; modern requests never create or return
`Mcp-Session-Id`. Discovery, list, and read results are explicitly
non-shareable with `ttlMs: 0` and `cacheScope: "private"`.

When a tool input schema marks a string, safe integer, or boolean property
with `x-mcp-header`, the matching `Mcp-Param-<name>` header must carry the
same value; integers are compared numerically, so `42.0` matches `42`.
Schemas that place this extension anywhere but a plain chain of `properties`
keys are rejected at registration time, with the tool name in the error.
Base64-encoded routing headers must decode to at most 8 KiB of valid UTF-8
without control characters.

Tool schemas may use local `#/$defs/<name>` references: registration
resolves them within hard budgets (traversal depth 64, one unit per
nesting level of the schema tree; 64 `$ref` expansions; and 64 KiB of
UTF-8 in the resolved result; cycles rejected by name) and
stores/advertises the **inlined**, self-contained schema, so clients
never need `$ref` support and the runtime `Mcp-Param-*` walk sees exactly
what registration validated. An `x-mcp-header` annotation authored behind
such a reference therefore works, as long as it lands on a plain
`properties` chain after inlining.

Resolution is **reachability-driven**: definition containers (`$defs`,
`definitions`) are pulled from only when referenced and dropped from the
output, so an unused authoring artefact in a generated bundle (a
self-referential type, a remote `$ref`, or simply many definitions)
cannot fail a schema whose resolved form is fine, and the expansion
budget counts only what ends up advertised. Everything else stays
deliberately out: remote (`https:`) references are never fetched, `$ref`
with adjacent keywords is rejected (2020-12 gives it `allOf` semantics,
and composition is where static reachability ends), and annotations under
`anyOf`/`oneOf`/`allOf` remain rejected because a branched value is not
guaranteed present at its path.

`$ref` counts as a reference only where a schema is expected, so
reference-shaped values in data positions are not silently rewritten;
once resolution runs, though, any reference that survives anywhere in the
output is rejected by path rather than shipped dangling (its definitions
are gone). Schemas with no schema-position reference are returned
verbatim. Note that Convex rejects `$`-prefixed field names at the
storage boundary, so a schema declaring a property literally named
`$ref` is unstorable regardless of how this resolver treats it. Budget or
resolution failures fail the registration/sync loudly with the tool
named, never as a per-request error.

### Origin validation

MCP requires servers to validate the `Origin` header to prevent DNS-rebinding
attacks. Pass `allowedOrigins` to turn that gate on:

```ts
gateway.handleMcpRequest(ctx, req, {
  authorize,
  cors: ["https://app.example.com"],           // what a browser may read
  allowedOrigins: ["https://app.example.com"], // what the gateway will serve
});
```

A request whose `Origin` is present but not allowed gets HTTP 403 before
identity resolution, authorization, auditing, or dispatch. This applies to
both protocol eras. Requests without an `Origin` header (every CLI and
server-to-server client) are unaffected.

`allowedOrigins` accepts a string, a string array, or an
`(origin: string) => boolean` matcher. It is deliberately separate from
`cors`: CORS decides what a browser may *read*, `allowedOrigins` decides what
the gateway is willing to *serve*. Deriving one from the other means the
permissive `cors: true` silently disables the gate.

**Omitting `allowedOrigins` disables origin validation.** That is the default
because a Convex deployment lives at a fixed public URL rather than on
localhost, which is the scenario DNS rebinding targets. Set it for any
deployment that serves browser clients.

### Multi-round-trip requests

Modern declarative tools can request elicitation, sampling, or roots input
without a protocol session. Enable `mrtr` with stable private key material and
give the tool a `beforeCall` hook: it is the gateway-side state machine, run
before the underlying Convex function on the first call AND on every verified
continuation, so accept/decline/ask-again decisions never leak into your
business logic:

```ts
import { completeCall, inputRequired } from "convex-mcp-gateway";

defineMcpMutation({
  name: "invoices_archiveAfterConfirmation",
  fn: api.invoices.archiveAfterConfirmation, // MCP-unaware mutation
  args: {
    id: v.id("invoices"),
    // Gateway-only: filled with the continuation's idempotency key on a
    // hook-approved retry. Hidden from tools/list, unspoofable.
    continuationKey: v.optional(v.string()),
  },
  mrtrArgs: { idempotencyKey: "continuationKey" },
  beforeCall: async (_ctx, { args, inputResponses, round }) => {
    const ask = () =>
      inputRequired(
        {
          confirm: {
            method: "elicitation/create",
            params: { mode: "form", message: "Archive this invoice?" },
          },
        },
        { invoiceId: args.id },
      );
    // Round one: ask before anything can run. Discriminate on `round`:
    // a state-only retry is a continuation, not a first call.
    if (round === undefined) return ask();
    const confirm = inputResponses?.confirm as { action?: string } | undefined;
    if (confirm === undefined) return ask(); // missing answer: ask again
    if (confirm.action !== "accept") {
      // Declined: finish WITHOUT running the mutation.
      return completeCall({
        content: [{ type: "text", text: "Invoice was not archived." }],
        isError: false,
      });
    }
    return null; // accepted: dispatch, with continuationKey injected
  },
});

gateway.handleMcpRequest(ctx, request, {
  authorize,
  mrtr: { secret: process.env.MCP_MRTR_SECRET! },
});
```

The gateway HMAC-signs the opaque `requestState` with a five-minute default
TTL, binding it to the tool name, original public arguments, authenticated
caller subject, and a per-round continuation id. Each continuation is
additionally **redeemed once server-side**: re-sending the same responses is an
idempotent replay, but that same continuation replayed with a different answer
(decline to accept) is rejected. On top of that a **chain resolves exactly
once**: the gateway claims the chain before it dispatches or finishes the call,
recording which continuation resolved it and with which answer. Re-sending that
same continuation and answer repeats the outcome, so a lost response still
retries cleanly: an accepted call dispatches again under the same idempotency
key, and a completed one re-runs the hook rather than erroring. Every other continuation of the chain is refused, including one
re-sent byte-identically, and asking again is refused outright, so a branch
forked by replaying an earlier round is never handed out and a settled decline
cannot be turned into a dispatch. Chains may run multiple rounds (asking again for missing input, per
the spec's error-handling guidance) up to a hard ceiling.

The hook receives the client's untrusted `inputResponses` and decoded `state`;
neither is ever injected into the Convex function. Only the chain's stable
idempotency key is, via `mrtrArgs`, and it is audited like any other argument.
Persist it around the tool's side effect for durable replay protection. The
state is signed, not encrypted, so never put credentials or other secrets in
it. Wire `gateway.pruneMrtrRedemptions` into a cron to drop expired
redemption rows and resolved-chain claims.

Safety properties: the hook runs only for `tools` passed to
`handleMcpRequest`, and a registry row registered as MRTR-gated (a hook, or
`mrtrArgs`) **fails closed** when served by a handler without the matching
hook, so imperative registrations and stale catalogs can never dispatch
unconfirmed. MRTR tools require an authenticated caller on every transport
(anonymous calls get the real 401 + `WWW-Authenticate` challenge and an audit
row). The gateway returns `-32021` (listing only the missing entries, per
mode for elicitation) rather than sending input requests for a capability
absent from that request's `clientCapabilities`, and supports state-only
retries without `inputResponses`: such a retry decides nothing, so it is not
redeemed and never burns the continuation for the answer that follows.
Required input is never silently bypassed:
the hook also runs for legacy 2025-era requests, and when it demands input
there (or when `mrtr` is not configured), the call fails closed instead of
dispatching. Note that rounds that end gateway-side (an `input_required`
response, a declined confirmation, a `-32021` rejection) write no audit rows;
the audit log records authorization denials and dispatches. See the runnable
[example](./example/convex/mcp.ts) and its durable idempotency record in
[invoices.ts](./example/convex/invoices.ts). `subscriptions/listen`, Tasks,
MCP Apps, and Enterprise Managed Authorization are not advertised until a
host provides their required durable state or long-lived delivery
infrastructure.

### Tasks (deferred tool calls)

Modern clients can run a tool as an MCP task
(`io.modelcontextprotocol/tasks`): `tools/call` with a `task` request
returns a handle immediately, and the client polls `tasks/get` for the
outcome; `tasks/update` cancels or answers `input_required` rounds.
Doubly opt-in: register the tool with `taskSupport: true` AND configure
the `tasks` option; the capability is not advertised otherwise.

```ts
defineMcpMutation({
  name: "invoices_recount",
  fn: api.invoices.recount,
  args: {},
  taskSupport: true, // advertised as execution: { taskSupport: "optional" }
});

gateway.handleMcpRequest(ctx, req, {
  authorize,
  tools,
  tasks: {}, // built-in durable executor (Convex scheduler, runs once)
});
```

Tasks are owner-bound to the authenticated caller (foreign, unknown, and
expired ids answer identically), retained 24 hours by default (clamped to
[1 minute, 7 days], prunable via `gateway.pruneTasks`), audited per
lifecycle transition, and rejected loudly on the legacy protocol instead
of silently running inline. Mount the gateway more than once with
different `authorize` policies and you also want `tasks.scope`, so a task
started on one mount cannot be polled through another. Hosts that need retries, delays, or
`input_required` rounds plug in `@convex-dev/workflow` through
`tasks.execute` and finalize with `gateway.completeTask` / `failTask` /
`requireTaskInput`. See [Tasks](./docs/tasks.md) for the full contract,
execution models, idempotency rules, and size limits.


## Resources

Alongside tools, the gateway serves MCP **resources** (read-only content).
Declare a concrete resource with `defineMcpResource` and pass it to the
same `handleMcpRequest` call as your tools:

```ts
// convex/mcp.ts
import { defineMcpResource } from "convex-mcp-gateway";
import { api } from "./_generated/api.js";

export const resources = [
  defineMcpResource({
    uri: "invoices://summary",
    name: "invoice-summary",
    title: "Invoice summary",
    mimeType: "application/json",
    // Read handlers receive the resolved caller identity; anonymous
    // resource requests are rejected before this runs.
    read: async (ctx, { uri, identity }) => {
      const summary = await ctx.runQuery(api.invoices.summary, {});
      return [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ ...summary, caller: identity.subject }),
        },
      ];
    },
  }),
];
```

```ts
// convex/http.ts: add `resources` to the same mount as `tools`
const mcp = httpAction(async (ctx, req) =>
  gateway.handleMcpRequest(ctx, req, { authorize, tools, resources }),
);
```

Supported methods: `resources/list`, `resources/read`,
`resources/templates/list` (RFC 6570 templates via
`defineMcpResourceTemplate`), and opt-in `resources/subscribe` /
`resources/unsubscribe`. A central `authorizeResource` hook gates
list/read, resource operations are auditable, and reads run only for
authenticated callers. A complete, runnable example (concrete resource +
template + per-resource auth + audit + subscription) is wired into
[`example/convex`](./example/convex/mcp.ts); see
[Resources & templates](./docs/resources.md) for the full guide.

## Documentation

- **[Getting Started](./docs/getting-started.md)**: install, register,
  call, in five minutes
- **[Architecture](./docs/architecture.md)**: component model, data
  flow, sequence diagrams
- **[Authorization](./docs/authorization.md)**: authorizer contract,
  `mode: "list"` vs `"call"`, scope/role recipes
- **[Resources & templates](./docs/resources.md)**: concrete resources
  vs RFC 6570 templates, `resources/templates/list`, read resolution
- **[OAuth 2.1 setup](./docs/oauth.md)**: RFC 9728 discovery, host-side
  mount, multi-tenant, `requireAuth` for all-private servers
- **[OAuth bridge mode](./docs/oauth-bridge.md)**: opt-in DCR + AS
  metadata wrap + userinfo token validation, for browser MCP clients
  (claude.ai) against IdPs that don't support Dynamic Client
  Registration (Pocket-ID, etc.)
- **[Audit log](./docs/audit-log.md)**: tool / resource / task row
  shapes, reading, filtering, redacting, pruning
- **[Recipe: Better Auth on Convex](./docs/recipes/better-auth.md)**:
  opaque-token `resolveIdentity`, split-domain discovery, and browser
  login continuation for `@convex-dev/better-auth` as the IdP
- **[Testing](./docs/testing.md)**: convex-test patterns, identity
  injection, swappable authorizers

## Design choices, briefly

- **One authorize callback, deny-by-default.** The component has no
  notion of scopes, roles, JWT claims, or tenants. You pass a single JS
  callback to `handleMcpRequest` that decides per call (it runs host-side
  where `ctx.auth` works). Until you pass it, nothing reaches your tools.
- **Scope-aware `tools/list`.** The catalog visible to a caller equals
  the set of tools they could actually invoke; the same authorizer
  filters both with a `mode: "list"` discriminator.
- **Audit never alters dispatch.** Every audit write is best-effort;
  failures log and swallow. A successful tool mutation always returns
  `ok: true`.
- **Identity propagation is free.** Convex validates inbound Bearer
  tokens against your `auth.config.ts` before any function runs; the
  same identity flows into the authorizer and the tool handler.
- **OAuth discovery is opt-in.** Configure an authorization server, and
  401s carry `WWW-Authenticate` headers per RFC 6750 and the
  RFC 9728 path-prefix metadata URL.

<!-- END: Include on https://convex.dev/components -->

## Local development

```sh
pnpm install
pnpm check                              # codegen + typecheck + tests + lint

# Iterate against a local Convex backend:
pnpm local:start                        # downloads the pinned binary, writes .env.local
                                        # runs on :3310 / :3311 (no Docker)
```

The local backend uses upstream test fixture credentials checked into
`get-convex/convex-backend`, public, deterministic, safe to commit.
See [docs/testing.md](./docs/testing.md) for `convex-test` patterns and
[CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow.

## Roadmap

By design the gateway is the **resource-server** half of MCP's OAuth
profile only; it will not ship a bundled authorization server (that
duplicates what every IdP already does and would put two
security-critical surfaces in one component). Bring your own OAuth 2.1
/ OIDC issuer. On the radar beyond that:

- Capability tokens for agent-spawning workflows (small JWT helper,
  not a full AS: `gateway.signCapabilityToken({ tools, runId, ttl })`
  plus authorizer-side validation)
- `mcpPrompt` MCP primitive (the `mcpResource` primitive has shipped, see
  [Resources & templates](./docs/resources.md))
- Pre-baked multi-tenant patterns (per-tenant URL, RFC 8707 audience
  binding)
- RFC 8693 token exchange for cross-domain identity

See the repo's GitHub issues for finer-grained tracking.

## Security

If you discover a vulnerability, please follow [SECURITY.md](./SECURITY.md)
(do not file a public issue).

## License

[Apache-2.0](./LICENSE)
