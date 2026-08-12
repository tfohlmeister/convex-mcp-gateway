# Resources & resource templates

MCP **resources** are read-only content the gateway exposes alongside
tools: a client lists them (`resources/list`) and reads them
(`resources/read`). The gateway supports two flavours:

- **Concrete resources**: a fixed URI (`docs://handbook`). Declare with
  `defineMcpResource`.
- **Resource templates**: a parameterized URI pattern
  (`weather://{city}/current`), advertised via `resources/templates/list`.
  Declare with `defineMcpResourceTemplate`.

Both run only for authenticated callers, flow through the same optional
`authorizeResource` hook, and can be audited via `auditResources`. See
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
import { defineMcpResource } from "convex-mcp-gateway";

const handbook = defineMcpResource({
  uri: "docs://handbook",
  name: "Operator handbook",
  description: "Internal runbook",
  mimeType: "text/markdown",
  read: async (ctx, { uri, identity }) => [
    { uri, mimeType: "text/markdown", text: await loadHandbook(ctx, identity) },
  ],
});

// gateway.handleMcpRequest(ctx, req, { authorize, resources: [handbook] });
```

Concrete resources declared this way are reconciled into the component
registry on legacy `initialize` and before a modern 2026-07-28 request
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

A resource template adds `annotations` (no `size`). A read returns an array
of contents, each `{ uri, mimeType?, text?, blob? }` with **at least one of
`text`/`blob`**.

`title`, `annotations`, and `size` are **runtime-only**: they are served
from a resource provider's `list` output, but are not persisted in the
registry. So a resource listed purely from the registry (declared but not
passed as a provider on the request) carries only `uri`/`name`/
`description`/`mimeType`.

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
   (`-32602`). A provider/template that _throws_ (rather than declining
   with `null`) is isolated and logged; it surfaces as an internal error
   (`-32603`) only if nothing else serves the URI.

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

- It requires an authenticated identity.
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
true }` and the gateway then **tracks subscription state per session**:
`resources/subscribe` records `(session, uri)` (identity required, idempotent,
capped per session), `resources/unsubscribe` removes it, and an explicit
session `DELETE` cascades its subscriptions.

The gateway does **not** deliver notifications, you do, using the state it
tracks plus the payload builders:

```ts
// When the data behind a resource changes:
const sessionIds = await gateway.listResourceSubscribers(ctx, uri);
const note = gateway.buildResourceUpdatedNotification(uri);
// → { jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } }
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
