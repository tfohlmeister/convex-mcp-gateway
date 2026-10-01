# Prompts

MCP **prompts** are templates a client offers its user as ready-made
commands (Claude Code shows them as `/mcp__<server>__<prompt>`): the
client lists them (`prompts/list`), the user picks one and fills in its
arguments, and the client fetches the messages to start the conversation
with (`prompts/get`).

**Supported MCP methods:** `prompts/list` and `prompts/get`, advertised as
`capabilities.prompts` in `initialize` and in `server/discover` whenever
the mount has at least one prompt. A complete runnable wiring lives in
[`example/convex`](../example/convex/mcp.ts) (`invoices_review`).

## Declaring a prompt

```ts
import { ConvexError } from "convex/values";
import { defineMcpPrompt } from "convex-mcp-gateway";

const reviewInvoice = defineMcpPrompt({
  name: "invoices_review",
  title: "Review an invoice",
  description: "Check one invoice for problems before it is sent.",
  arguments: [
    { name: "invoiceId", description: "The invoice to review", required: true },
  ],
  get: async (ctx, { arguments: { invoiceId }, identity }) => {
    // Nullable: `null` only on a mount that set `anonymousPrompts`.
    if (!identity) throw new ConvexError("Unauthorized");
    const invoice = await ctx.runQuery(api.invoices.get, { id: invoiceId! });
    if (!invoice) throw new ConvexError(`No invoice ${invoiceId}`);
    return {
      description: `Review of invoice ${invoice.id}`,
      messages: [
        {
          role: "user",
          content: {
            type: "resource",
            resource: {
              uri: `invoice://${invoice.id}`,
              mimeType: "application/json",
              text: JSON.stringify(invoice),
            },
          },
        },
        {
          role: "user",
          content: { type: "text", text: "Review the invoice above." },
        },
      ],
    };
  },
});

// gateway.handleMcpRequest(ctx, req, { authorize, prompts: [reviewInvoice] });
```

`get` runs in the HTTP action with the same `ctx` a resource's `read` gets,
so a prompt can load whatever it needs through `ctx.runQuery`. It is
called only for `prompts/get` of its own name, after authorization, with
`arguments` already checked against the declaration (see
[Arguments](#arguments)).

That `ctx` is the HTTP action's, not the MCP caller's: `ctx.runQuery` is
not scoped to whoever is asking. So whatever `get` loads must be gated by
`authorizePrompt` (or by `get` itself, on `identity`) as strictly as the
matching resource. The example's `invoices_review` embeds the JSON
`invoice://{id}` serves, so its `authorizePrompt` requires the same
`finance.admin` role `authorizeResource` requires for that resource.

Prompts are **runtime-only**. Unlike resources and tools, nothing is
persisted in the component registry: a mount serves exactly the prompts
passed to it, so there is no sync step and no fingerprint. Names must be
unique within a mount; a duplicate throws on the first request through
it.

## Prompt shape & validation

A prompt descriptor (a `prompts/list` entry, and what `defineMcpPrompt`
accepts) supports:

| Field         | Type       | Notes                                                            |
| ------------- | ---------- | ---------------------------------------------------------------- |
| `name`        | `string`   | required, non-empty, unique within the mount                     |
| `title`       | `string?`  | human-friendly display name; clients fall back to `name`         |
| `description` | `string?`  | optional in the spec, but some clients and the conformance suite expect one |
| `arguments`   | `array?`   | `{ name: string; title?: string; description?: string; required?: boolean }[]`, names unique |
| `icons`       | `array?`   | same shape as on tools and resources, see [Resources](./resources.md#resource-shape--validation) |

`get` returns `{ description?: string; messages }`, each message
`{ role: "user" | "assistant"; content }` with one content block:

| `content.type`  | Fields                                                              |
| --------------- | ------------------------------------------------------------------- |
| `text`          | `text`                                                              |
| `image`/`audio` | `data` (base64, non-empty), `mimeType`                              |
| `resource`      | `resource`: the shape a `resources/read` content item has (`uri`, `mimeType?`, `text` or `blob`) |
| `resource_link` | the fields of a `resources/list` entry (`uri`, `name`, …)          |

Every block may carry `annotations`, validated as on resources.

These shapes are checked at three points, so a malformed prompt never
reaches a client:

- **Declaration time**: `defineMcpPrompt` throws on an invalid descriptor.
- **First request through the mount**: the `prompts` option as a whole
  (descriptors, `get` functions, unique names), for entries built by hand.
- **Request time**: what `get` returns. An invalid result fails the
  request with a deterministic `-32603` naming the bad field, rather than
  shipping a result a validating client would reject. Another content
  `type` is refused for the same reason.

## Arguments

The spec types every argument value as a string, so there is no schema:
`required` is the only constraint a declaration states. Before `get` runs,
`prompts/get` refuses with `-32602`:

- `arguments` that is not an object of strings,
- an argument the prompt does not declare,
- a missing required argument.

An undeclared argument is refused rather than dropped, the way a tool's
input schema refuses one, so a misspelt name fails loudly instead of
reaching `get` as a missing value. `get` receives a null-prototype copy
of what the client sent, so an optional argument the client left out
reads as `undefined` whatever its name (`toString` included).

## Authorization

Prompts run for authenticated callers only, by default: without
`anonymousPrompts` an anonymous `prompts/list` or `prompts/get` gets
`-32001` before any host code runs.

The optional `authorizePrompt` hook is the prompt counterpart of
`authorizeResource`. Omit it and every authenticated caller can list and
get every prompt. Set it and:

| Mode                 | When                                    | `identity`  |
| -------------------- | --------------------------------------- | ----------- |
| `"prompt_list"`      | once per prompt, filtering `prompts/list` | non-null  |
| `"prompt_get"`       | before a prompt's `get` runs            | non-null    |
| `"prompt_anonymous"` | either method, `operation: "list" \| "get"`, only on a mount with `anonymousPrompts` | `null` |

Each call carries `promptName` and, for a get, the request's `arguments`
(strings, but not yet checked against the declaration). Like the one
`get` receives, that object is a null-prototype copy: read it with
`args.arguments.name` or `Object.hasOwn(args.arguments, "name")`, since
`Object.prototype` methods such as `hasOwnProperty` are not on it and
calling one throws, which answers the request as an authorizer fault.

`prompts/get` is authorized **before** the name is resolved, so a caller
who may not get a prompt cannot tell a hidden prompt from a missing one.
A denial answers `-32001` when its reason starts with "unauth" and
`-32003` otherwise, with the reason as the message. An authorizer that
throws or returns a malformed decision is a host fault: `-32603` with a
generic message, the detail in the deployment log. On `prompts/list` such
a fault hides only that prompt.

```ts
import { type McpPromptAuthorizerHandler } from "convex-mcp-gateway";

const authorizePrompt: McpPromptAuthorizerHandler = async (_ctx, args) => {
  if (args.mode === "prompt_anonymous") {
    return args.promptName === "welcome"
      ? { allowed: true }
      : { allowed: false, reason: "Unauthorized: sign in to use prompts" };
  }
  if (args.promptName === "invoices_review") {
    const roles = (args.identity.claims ?? {}).roles;
    if (!Array.isArray(roles) || !roles.includes("finance.admin")) {
      return { allowed: false, reason: "Forbidden: finance.admin role required" };
    }
  }
  return { allowed: true };
};
```

### Public prompts

`anonymousPrompts: true` serves both methods to unauthenticated callers,
who reach `authorizePrompt` under `"prompt_anonymous"`. It works the way
[`anonymousResources`](./resources.md#public-resources-opt-in-anonymous-access)
does, for the same reasons:

- It requires `authorizePrompt`, and setting it without one throws on the
  first request: with no authorizer every prompt is allowed, so opting in
  would publish the whole catalog rather than delegate the decision.
- A non-boolean value throws too, so `anonymousPrompts: process.env.X`
  cannot turn "off" into on.
- It does not override `requireAuth`, which answers anonymous POSTs with
  `401` before any method runs.
- An anonymous caller denied with an "unauth" reason gets `401` +
  `WWW-Authenticate` (when OAuth is configured) instead of a JSON-RPC
  error, on `prompts/get` and on a `prompts/list` that granted nothing,
  because that status is the only signal a browser client acts on.

## Errors

| Situation                                              | Answer                         |
| ------------------------------------------------------ | ------------------------------ |
| Mount has no prompts                                   | `-32601` (HTTP 404 on 2026-07-28) |
| Anonymous caller, no `anonymousPrompts`                | `-32001`                       |
| Missing `name`, bad `arguments`, unknown prompt, undeclared or missing argument | `-32602` |
| `authorizePrompt` denies                               | `-32001` / `-32003` with the reason |
| `authorizePrompt` throws or returns a malformed decision | `-32603` "Authorization check failed" |
| `get` throws a `ConvexError`                           | `-32603` with its message      |
| `get` throws anything else                             | `-32603` "Prompt retrieval failed" |
| `get` returns an invalid result                        | `-32603` naming the field      |

As everywhere in the gateway, only a `ConvexError` puts host text on the
wire; anything else is logged in full and answered generically.

## The 2026-07-28 revision

- `prompts/get` needs an `Mcp-Name` header matching `params.name`, like
  `tools/call` (a mismatch is refused before anything runs).
- `prompts/list` is sorted by name and carries the `ttlMs` / `cacheScope`
  caching hints the other list methods carry. `prompts/get` does not: its
  result depends on the arguments.
- A `prompts/get` carrying `requestState` or `inputResponses` is refused
  with `-32602`. The revision lets a prompt ask for input first
  (`InputRequiredResult`), and the gateway offers no hook for that yet,
  so it fails closed rather than answering while ignoring the
  continuation.

## Not supported

- `listChanged`. The capability never advertises it: this transport
  cannot push `notifications/prompts/list_changed`.
- Audit rows for prompt operations.
- Multi-round-trip `prompts/get` (see above), the counterpart of
  `beforeResourceRead`.
- `completion/complete` for argument values.
- Dynamic catalogs: prompts are declared, not listed by a provider at
  request time.
