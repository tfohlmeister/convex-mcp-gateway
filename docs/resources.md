# Resources & resource templates

MCP **resources** are read-only content the gateway exposes alongside
tools: a client lists them (`resources/list`) and reads them
(`resources/read`). The gateway supports two flavours:

- **Concrete resources**: a fixed URI (`docs://handbook`). Declare with
  `defineMcpResource`.
- **Resource templates**: a parameterized URI pattern
  (`weather://{city}/current`), advertised via `resources/templates/list`.
  Declare with `defineMcpResourceTemplate`.

Both run only for authenticated callers by default, flow through the same
optional `authorizeResource` hook, and can be audited via
`auditResources`. A mount that wants to serve public content can opt out
of the identity requirement with `anonymousResources`, see
[Public resources](#public-resources-opt-in-anonymous-access) below. See
[Authorization](./authorization.md) and [Audit log](./audit-log.md).

**Supported MCP methods:** `resources/list`, `resources/read`,
`resources/templates/list`, and, opt-in, `resources/subscribe` /
`resources/unsubscribe`. The `notifications/resources/*` pushes are the
host's responsibility (this gateway's HTTP transport can't push; see
[Subscriptions](#subscriptions--change-notifications)). A complete runnable
wiring lives in
[`example/convex`](../example/convex/mcp.ts) (resource + template +
`authorizeResource` + audit + subscription).

## When to use which

| Use a **concrete resource** when…                                    | Use a **template** when…                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| The URI is fixed and known ahead of time                             | The URI is parameterized (an id, a city, a path)                  |
| You want it persisted in the registry and listed in `resources/list` | You want clients to discover the _shape_ and expand it themselves |
| There's one (or a small fixed set of) document                       | There's an unbounded family of resources behind one pattern       |

A template is not listed in `resources/list`; it appears only in
`resources/templates/list`. The client expands the template to a concrete
URI and reads it through the ordinary `resources/read`.

## Concrete resources

```ts
import { ConvexError } from "convex/values";
import { defineMcpResource } from "convex-mcp-gateway";

const handbook = defineMcpResource({
  uri: "docs://handbook",
  name: "Operator handbook",
  description: "Internal runbook",
  mimeType: "text/markdown",
  read: async (ctx, { uri, identity }) => {
    // Nullable: `null` only on a mount that set `anonymousResources`.
    if (!identity) throw new ConvexError("Unauthorized");
    return [
      { uri, mimeType: "text/markdown", text: await loadHandbook(ctx, identity) },
    ];
  },
});

// gateway.handleMcpRequest(ctx, req, { authorize, resources: [handbook] });
```

Concrete resources declared this way are reconciled into the component
registry on session-based `initialize` and before a stateless 2026-07-28 request
(change-detected), so `resources/list` returns them even from a request that
doesn't pass a provider. See the registry-sync behaviour in
[Architecture](./architecture.md).

### Migrating from a raw provider

Before `defineMcpResource` existed, the escape hatch was to pass a raw
provider object (`{ name, list, read }`) straight to
`handleMcpRequest({ resources })`. That still works (a `defineMcpResource`
registration _is_ such a provider), but prefer the primitive: it declares
the descriptor once (so `list` and the registry stay in sync), validates the
shape at declaration time, and only invokes `read` for its own `uri`.

```ts
// Before: raw provider escape hatch
const handbook = {
  name: "handbook",
  list: async () => [{ uri: "docs://handbook", name: "Operator handbook" }],
  read: async (ctx, { uri }) =>
    uri === "docs://handbook" ? [{ uri, text: await loadHandbook() }] : null,
};

// After: defineMcpResource (uri/name declared once; URI match handled for you)
const handbook = defineMcpResource({
  uri: "docs://handbook",
  name: "Operator handbook",
  read: async (ctx, { uri }) => [{ uri, text: await loadHandbook() }],
});
```

Raw providers remain supported for dynamic catalogs where the URI set isn't
known ahead of time.

## Resource shape & validation

A resource descriptor (a `resources/list` entry, and the object
`defineMcpResource` accepts) supports:

| Field         | Type      | Notes                                                                                                                                                                   |
| ------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uri`         | `string`  | required, non-empty                                                                                                                                                     |
| `name`        | `string`  | required, non-empty                                                                                                                                                     |
| `title`       | `string?` | human-friendly display name; clients fall back to `name`                                                                                                                |
| `description` | `string?` |                                                                                                                                                                         |
| `mimeType`    | `string?` |                                                                                                                                                                         |
| `size`        | `number?` | raw size in bytes, non-negative                                                                                                                                         |
| `annotations` | `object?` | `{ audience?: ("user"\|"assistant")[]; priority?: number /* 0..1 */; lastModified?: string /* conventionally ISO 8601; validated as a string, format not enforced */ }` |
| `icons`       | `array?`  | `{ src: string /* required, non-empty */; mimeType?: string; sizes?: string[] /* "48x48", or "any" for a scalable format */; theme?: "light" \| "dark" }[]` |

A resource template adds `annotations` and `icons` (no `size`). A read
returns an array of contents, each `{ uri, mimeType?, text?, blob? }` with
**at least one of `text`/`blob`**.

`title`, `annotations`, `icons`, and `size` are **runtime-only** for a
concrete resource: they are served from a resource provider's `list`
output, but are not persisted in the registry. So a resource listed purely
from the registry (declared but not passed as a provider on the request)
carries only `uri`/`name`/`description`/`mimeType`. A **template**'s
`title`, `annotations`, and `icons` *are* persisted, so a registry-only
template still lists its full descriptor.

An icon `src` is host-authored content that reaches the client verbatim:
the gateway advertises it and never fetches it. The spec puts the
fetch-side burden on the consumer, which "SHOULD take steps to ensure URLs
serving icons are from the same domain as the client/server or a trusted
domain" and "SHOULD take appropriate precautions when consuming SVGs as
they can contain executable JavaScript". A malformed entry is rejected at
declaration time for a resource or template (inside `defineMcpResource` /
`defineMcpResourceTemplate`) and at catalog sync, with the tool named, for
a tool. Either way it never ships a descriptor a validating client would
drop.

These shapes are validated at two points so structurally malformed
descriptors never reach the client:

- **Declaration time**: `defineMcpResource` / `defineMcpResourceTemplate`
  throw on an invalid descriptor (bad `annotations`, negative `size`, etc.).
- **Request time**: output from a resource _provider_ (`list`/`read`) and a
  template provider is validated before it is returned; an invalid descriptor
  or content array fails the whole operation with a deterministic
  `-32603` JSON-RPC error naming the bad field, rather than shipping
  malformed JSON-RPC. Minimal `{ uri, name }` descriptors remain valid.

## Resource templates

```ts
import { defineMcpResourceTemplate } from "convex-mcp-gateway";

const weather = defineMcpResourceTemplate({
  uriTemplate: "weather://{city}/current",
  name: "Current weather",
  description: "Live weather by city",
  mimeType: "application/json",
  // Optional: resolve matching reads server-side. Omit `read` for a
  // listing-only template (the client reads the expansion elsewhere).
  read: async (ctx, { uri, params, identity }) => [
    {
      uri,
      mimeType: "application/json",
      text: await fetchWeather(params.city),
    },
  ],
});

// gateway.handleMcpRequest(ctx, req, {
//   authorize,
//   resourceTemplates: [weather],
// });
```

### How template reads resolve

When `resources/read` receives a URI:

1. **Concrete providers run first.** A concrete resource always wins over
   a template that would also match the same URI, so dispatch is never
   ambiguous.
2. **Then templates** whose `uriTemplate` matches the URI are tried in
   order; the first template whose `read` returns content serves it. A
   template without a `read` handler is listing-only and is skipped here.
3. If nothing serves the URI, the read returns `Resource not found`
   (`-32602`), with the requested URI repeated in `error.data.uri` as the
   spec's example does, so a client can correlate the miss without parsing
   the message. A provider/template that _throws_ (rather than declining
   with `null`) is isolated and logged; it surfaces as an internal error
   (`-32603`) only if nothing else serves the URI, and carries no `data`:
   that failure is the server's, not the caller's URI.

### Asking the caller a question before serving a read

MCP 2026-07-28 lets `resources/read` answer with an `InputRequiredResult`,
the same multi-round-trip mechanism tool calls use. Configure
`beforeResourceRead` to use it:

```ts
import { completeRead, declineRead, inputRequired } from "convex-mcp-gateway";

gateway.handleMcpRequest(ctx, request, {
  authorizeResource,
  resources,
  mrtr: { secret: process.env.MCP_MRTR_SECRET! },
  beforeResourceRead: async (
    ctx,
    { uri, resourceMetadata, identity, inputResponses },
  ) => {
    if (uri !== "docs://confidential") return null;   // not gated
    if (!inputResponses) {
      return inputRequired(
        {
          confirm: {
            method: "elicitation/create",
            params: { mode: "form", message: "Share the full document?" },
          },
        },
        undefined,
        {
          onUnsupported: completeRead([
            { uri, mimeType: "text/plain", text: "Summary only." },
          ]),
        },
      );
    }
    const confirm = inputResponses.confirm as { action?: string };
    if (confirm?.action !== "accept") {
      return declineRead("Owner declined to share this document");
    }
    return null;                                       // serve it
  },
});
```

Four decisions, mirroring `beforeCall` on the tool side:

| Return | Result |
|---|---|
| `null` | Fall through to the normal read path (providers, then templates) |
| `inputRequired(requests, state?, { onUnsupported })` | `resultType: "input_required"` when supported; otherwise the optional fallback completes the read |
| `completeRead(contents)` | Serve these contents instead, e.g. a redacted summary |
| `declineRead(reason)` | Refuse with `-32003` and that reason; nothing is read |

It is **mount-level**, like `authorizeResource`, rather than per-resource:
a provider serves many URIs and the gateway cannot know which one owns a
URI without calling it, so the gate has to sit where the URI is known and
nothing has run yet. Branch on `uri` inside the hook.

The hook declares the requested interaction; the gateway owns capability
matching. If the client cannot satisfy it, `onUnsupported` is returned before
any provider or template runs. Without a fallback, the existing fail-closed
protocol error remains. The same option works for `completeRead` and
`declineRead` decisions on legacy/session-era requests.

The guarantees are the tool path's, because it is the same machinery: the
continuation is HMAC-sealed and bound to `resources/read:<uri>` plus the
caller's subject, so it cannot be replayed at another URI (a template
expansion is a function of the URI, so expansions are bound too) or
presented as a tool continuation; each round's id is redeemed once, and
re-sending it with different answers is refused; and the chain resolves
exactly once, so a branch forked by an idempotent replay cannot re-open a
read that was already served or refused. Requires `mrtr` and a stateless-era
protocol: a hook that demands input where no continuation can travel fails
the read (`-32603`) rather than serving the resource with the gate skipped.

Auditing follows the tool path: the round that only asks writes no row,
and the round that resolves writes `read`/`allowed` when content is
served or `read`/`denied` for a `declineRead`.

### What the caller is told when a read fails

A thrown exception message never reaches the MCP client. The caller gets
`-32603 Resource read failed`; the full text goes to the audit row and
the Convex deployment log, both server-side. This mirrors what
`dispatch.runTool` does for tools, and for the same reason: an accidental
throw can quote a signed URL, an `Authorization` header, or an upstream
response body, and the caller is an LLM that may relay it onward.

To send a specific message to the caller on purpose, throw `ConvexError`:

```ts
defineMcpResource({
  uri: "invoice://latest",
  name: "Latest invoice",
  read: async (ctx) => {
    const invoice = await ctx.runQuery(api.invoices.latest, {});
    if (!invoice) throw new ConvexError("No invoice for this account yet");
    return [{ uri: "invoice://latest", text: JSON.stringify(invoice) }];
  },
});
```

Two things are deliberately still verbatim on the wire, because both are
written by the gateway and name only a field, never your data:

- descriptor/content contract violations (`resource.uri must be a
  non-empty string`, `content item must include text or blob`), so a
  provider bug stays diagnosable from the client
- `Resource not found: <uri>`, which only echoes the URI the caller sent
  (also in `error.data.uri`)

### `uriTemplate` syntax (level 1)

Only **RFC 6570 level-1** simple placeholders are supported:
`{name}` where `name` is `A–Z a–z 0–9 _`. Each placeholder matches exactly
one URI path segment (it does not span `/`). The following throw at
declaration time so an unusable template fails loudly:

- operators: `{+var}`, `{#var}`, `{/var}`, `{.var}`, `{;var}`, `{?var}`,
  `{&var}`
- comma lists: `{a,b}`
- a template with no placeholder (use `defineMcpResource` instead)
- repeated variable names, unclosed `{`

### Registry persistence

Templates are persisted in the component registry and reconciled on
`initialize`, mirroring concrete resources: the declarative
`resourceTemplates` option is change-detected via a fingerprint and synced,
and `resources/templates/list` merges the registered templates with the
runtime providers (a runtime provider wins on a shared `uriTemplate`). Unlike
concrete resources, templates persist their **full** descriptor (`title`
and `annotations` included) so a registry-only template still lists its
complete shape. You can also manage the catalog imperatively with
`gateway.registerResourceTemplate(s)` / `unregisterResourceTemplate` /
`clearResourceTemplates`. Only catalog metadata is stored; the `read`
handler and matcher are never persisted, so a registry-only template lists
but resolves no reads until a matching runtime provider is supplied.

## Auth & audit

`resources/templates/list` behaves like `resources/list`:

- It requires an authenticated identity, unless the mount set
  `anonymousResources` (below).
- Each template is filtered through `authorizeResource` with
  `mode: "resource_templates_list"` (the template's `uriTemplate` is passed
  as `resourceUri`).
- It is audited when `auditResources` is `true` or
  `{ templatesList: true }`; the audit row's `resourceOperation` is
  `templates_list`. Reads that resolve through a template are audited under
  `resourceOperation: "read"`, exactly like concrete reads.

> **List-deny is not read-deny.** `resources/read` of a template-expanded
> URI is authorized under `mode: "resource_read"` with the _concrete_
> expanded URI (e.g. `weather://london/current`) and `resourceMetadata:
null`, not under `resource_templates_list` with the `uriTemplate`. So
> hiding a template from `resources/templates/list` does **not** by itself
> block reads of its expansions. `resource_templates_list` controls catalog
> _visibility_; `resource_read` is the gate for every read. To deny reads of
> a template's URIs, match the URI shape in your `resource_read` branch
> and/or enforce the check inside the template's own `read` handler.

### Public resources (opt-in anonymous access)

By default `resources/list`, `resources/templates/list` and
`resources/read` refuse an unauthenticated caller with `-32001` before
`authorizeResource` runs, as a JSON-RPC error inside an HTTP `200`, so a
browser client gets no signal it should log in. `requireAuth` is the
existing remedy for an all-private mount; the option below is what lets a
mixed mount challenge on the gated resources while serving the public
ones. Set `anonymousResources: true` to hand that
decision to the host instead:

```ts
gateway.handleMcpRequest(ctx, request, {
  anonymousResources: true,
  authorizeResource: async (_ctx, args) => {
    if (args.mode === "resource_anonymous") {
      const meta = (args.resourceMetadata ?? {}) as { public?: boolean };
      return { allowed: meta.public === true };
    }
    // ...the authenticated policy, unchanged
    return { allowed: true };
  },
  resources: [
    defineMcpResource({
      uri: "docs://changelog",
      name: "changelog",
      metadata: { public: true },
      read: async (_ctx, { uri }) => [{ uri, text: await loadChangelog() }],
    }),
  ],
});
```

This is the resource counterpart of a public tool, with one difference
that matters. A public tool is pure host convention: the gateway always
calls `authorize` and `metadata.public` means whatever the callback says
it means. Resources cannot work that way, because a mount with no
`authorizeResource` allows every resource, so "let the authorizer decide"
would publish the whole catalog. Hence the explicit option, and hence the
gateway throws on the first request through a mount that sets it without
an `authorizeResource`.

The contract:

- **An anonymous caller arrives under `mode: "resource_anonymous"`**, never
  under the three authenticated modes, with `identity: null` and an
  `operation` of `"list"`, `"templates_list"` or `"read"`. That keeps a
  policy written for authenticated callers from being applied to one it
  was not written for, but **it does not decide the outcome for you**.
  What an existing authorizer does with an unrecognised mode is whatever
  its default branch does:

  ```ts
  // Denies: a missing decision is read as a denial.
  if (args.mode === "resource_read") return { allowed: await mayRead(args) };
  // ...no default return

  // ALLOWS, and publishes whatever was asked for.
  if (args.mode !== "resource_read") return { allowed: true };
  ```

  The lock is `anonymousResources` itself, which no existing mount has
  set. Read your default branch before you set it.
- **`resourceMetadata` is `null` for templates and for template-derived
  reads**, exactly as on an authenticated call. A public template is
  recognised by its URI shape, not by metadata.
- **A provider's `identity` is nullable.** `McpResourceReadHandler`, and
  the `list` / `read` of a `McpResourceProvider`, receive
  `McpResourceCaller`, which is `null` only on a mount that opted in.

  This and the authorizer union are **compile-time breaks for existing
  code**, whether or not you use the option:

  ```ts
  // Before: identity was non-null.
  read: async (ctx, { uri, identity }) => [
    { uri, text: await load(ctx, identity.subject) },   // now TS2532
  ],
  // After: narrow once. On a mount without `anonymousResources` the
  // branch is unreachable, so throwing is fine, use ConvexError if you
  // want the message to reach the client.
  read: async (ctx, { uri, identity }) => {
    if (!identity) throw new ConvexError("Unauthorized");
    return [{ uri, text: await load(ctx, identity.subject) }];
  },
  ```

  An `authorizeResource` that switched exhaustively over the old
  three-member `mode` union also stops compiling, since the union gained
  a member. Adding the `"resource_anonymous"` branch is the fix, and it
  is the branch you want to write deliberately anyway.
- **A provider's `list` runs before the authorizer**, for anonymous
  callers as for authenticated ones: the gateway collects candidates and
  then filters them through `authorizeResource`. Nothing leaks, since the
  filter decides what ships, but any work a `list` implementation does
  becomes anonymously triggerable on an opted-in mount. `read` is the
  other way round: the authorizer runs first, and no provider is
  consulted until it allows.
- **The `401` challenge is per method, and the host triggers it.** A
  reason starting `unauth` (case-insensitive) means "logging in would
  help". On `resources/read` that answers HTTP `401` instead of `200`. On
  `resources/list` and `resources/templates/list`, where per-candidate
  reasons are otherwise discarded, it answers `401` only when the caller
  got **nothing**: a mixed mount that served the public subset stays
  quiet, since telling a caller to log in when it already has what is
  public would be a false prompt. Any other reason answers `200` with the
  subset, or with `-32003` on a read. This restores a signal the gate used to
  give, and a stronger one: the gate answered `-32001` inside an HTTP
  `200`, which a browser client cannot act on, where this answers `401`.
  Without it a client whose Bearer merely expired would get an empty `200`
  and no signal at all. Capabilities are fixed at `initialize`, so it
  could stay that way for the life of the connection.
- **A `read` denial reaches an unauthenticated caller verbatim.** On
  `resources/read` the `reason` you return is host-authored and goes on
  the wire, exactly as on the authenticated path, so do not put anything
  in it an anonymous caller may not see. (List denials do not: a rejected
  candidate is simply omitted, and its reason never leaves the server.)
  A read reason that starts with `unauth` (case-insensitive) means
  "logging in would help": the gateway answers an anonymous caller with
  HTTP `401`, carrying the same JSON-RPC `-32001` body, plus a
  `WWW-Authenticate` header when an OAuth config is set. The status is
  the part that matters, because it is the only thing a browser MCP
  client reacts to, and, for a cross-origin browser, the only part it
  can read: `access-control-expose-headers` does not list
  `WWW-Authenticate`, so the RFC 9728 hint reaches non-browser clients
  only. That predates this option and applies to `requireAuth` too. Any
  other reason answers HTTP `200` + `-32003`, which
  is what to use for "this is not public and never will be". A thrown or
  malformed reason never reaches the wire: it goes to the deployment log,
  and to the audit row only for an authenticated caller. Authenticated
  denials keep the HTTP `200` body they have always returned.
- **`resources/subscribe` and `resources/unsubscribe` stay
  authenticated.** A subscription is server-side state an anonymous caller
  would accumulate, and it delivers nothing on a transport that cannot
  push.
- **It cannot be combined with `beforeResourceRead`**, which throws on the
  first request through the mount: that hook's contract passes a non-null
  identity and an MRTR
  continuation must bind to a principal.
- **It does not override `requireAuth`**, which answers anonymous POSTs
  with `401` before the method switch. A mount setting both serves no
  anonymous resource, the same as `requireAuth` with a public tool.

> **A failed anonymous outcome is not audited.** An anonymous `denied` or
> `error` row is never written, which bounds what a *failing* request can
> put in the table. `resources/read` carries a caller-controlled `uri`,
> and every miss lands on the not-found branch, which does write a row; a
> list the authorizer emptied is recorded as `denied` for the same reason.
> An authenticated caller's rows are untouched.
>
> It does **not** bound successful ones. An allowed anonymous read through
> a permissive template writes one row per request carrying the URI the
> caller chose, capped at 1024 UTF-16 code units but still content it picked. So
> wire up `gateway.pruneAuditEntries` on a cron before opening a mount:
> that is the bound, not this rule. Sizes and scope are in
> [Audit log](./audit-log.md#privacy-considerations).

## Subscriptions & change notifications

MCP defines `resources/subscribe` + `resources/unsubscribe` (the server pushes
`notifications/resources/updated` when a watched resource changes) and
`notifications/resources/list_changed` (the catalog changed). All three are
**server→client pushes**.

**This gateway's HTTP transport cannot push.** It runs on Convex HTTP actions:
each request gets exactly one response, `GET /mcp/` is `405` (no standalone
server→client SSE stream), and there is no background process holding streams
open. So subscriptions are **off by default**:

- `initialize` advertises `capabilities.resources` as `{}`, neither
  `subscribe` nor `listChanged`.
- `resources/subscribe` and `resources/unsubscribe` return `-32601` with a
  message explaining the capability isn't advertised.

A spec-compliant client checks the capability before subscribing, so it never
calls these. The `-32601` is for non-compliant clients.

### Opting in (host owns delivery)

If you front the gateway with a transport that **can** push (your own SSE or
WebSocket layer keyed by `Mcp-Session-Id`), opt in:

```ts
gateway.handleMcpRequest(ctx, req, {
  authorize,
  resources: [...],
  resourceSubscriptions: { subscribe: true, listChanged: true },
});
```

This makes `initialize` advertise `resources: { subscribe: true, listChanged:
true }`, except that `subscribe` is withheld from an anonymous session on a
mount that set [`anonymousResources`](#public-resources-opt-in-anonymous-access),
where resource methods do serve that caller but `resources/subscribe` still
refuses it. `listChanged` is advertised to an anonymous session and an
authenticated one alike, whenever you set it: it names no method the
caller invokes. The gateway then **tracks subscription state per session**:
`resources/subscribe` records `(session, uri)` (identity required, idempotent,
capped per session), `resources/unsubscribe` removes it, and an explicit
session `DELETE` cascades its subscriptions.

The gateway does **not** deliver notifications, you do, using the state it
tracks plus the payload builders:

```ts
// When the data behind a resource changes:
const sessionIds = await gateway.listResourceSubscribers(ctx, uri);
const note = gateway.buildResourceUpdatedNotification(uri);
// → { jsonrpc: "2.0", method: "notifications/resources/updated",
//     params: { uri } }
for (const sessionId of sessionIds) yourTransport.send(sessionId, note);

// When the catalog changes:
const listChanged = gateway.buildResourceListChangedNotification();
// → { jsonrpc: "2.0", method: "notifications/resources/list_changed" }
yourTransport.broadcast(listChanged);
```

Notes:

- **Identity-bound, not content-authz.** Subscribing requires an
  authenticated caller, and `subscribe`/`unsubscribe` are bound to the
  session's owner (like `DELETE`), so a leaked `Mcp-Session-Id` can't be used
  to grief another user's subscriptions. But it is _not_ content-authorized:
  the `updated` payload carries just the URI, and the subscriber must still
  `resources/read` (which re-applies `resource_read`) to get content.
  Authorize delivery yourself if a "this URI changed" signal is itself
  sensitive.
- **Cleanup.** Idle sessions dropped by `pruneSessions` don't cascade their
  subscriptions (an explicit `DELETE` does). Run
  `gateway.pruneResourceSubscriptions(ctx)` alongside session pruning; it
  pages through the table in bounded windows and returns the total deleted.
  `listResourceSubscribers` may briefly return session IDs that have ended,
  treat unknown sessions as no-ops.
- **`listChanged` without `subscribe`.** You can set `listChanged: true`
  alone to advertise catalog-change notifications without per-resource
  subscriptions.
