# Running the official MCP conformance suite

[`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance)
connects to a running server as a real MCP client and checks its wire
behaviour against the specification. It is the only thing in this repo
that exercises the gateway through a genuine client rather than through
handler-level tests.

## Running it

The example app serves a fixture catalog when `MCP_CONFORMANCE=1`:

```sh
npx convex env set MCP_CONFORMANCE 1
npx convex dev --once                    # redeploy with the switch on

npx @modelcontextprotocol/conformance server --url <site-url>/mcp
npx @modelcontextprotocol/conformance server --url <site-url>/mcp \
  --scenario tools-call-simple-text --verbose
```

Turn it off again with `npx convex env remove MCP_CONFORMANCE` and
redeploy, or the example serves `test_*` tools instead of the invoice
ones.

It is a **catalog switch, not a second mount**, and that is forced. The
component keeps one tool registry and one catalog fingerprint, so two
mounts passing different `tools` arrays delete each other's tools on
every reconciliation. Mounts may differ by `tasks` or `authorize`, never
by their catalog.

## What it can and cannot reach

The suite defines 32 server scenarios. Only some are reachable, and the
reasons are structural rather than a matter of unfinished fixtures.

### Reachable and passing

`server-initialize`, `tools-list`, `tools-call-simple-text`,
`tools-call-error`, `ping`, `server-sse-polling`,
`server-sse-multiple-streams`, and `dns-rebinding-protection` once the
host sets `allowedOrigins` (the example leaves it off, so that scenario
fails by default, and passes 2/2 with it configured).

### Unreachable: non-text tool content

`tools-call-image`, `tools-call-audio`, `tools-call-embedded-resource`
and `tools-call-mixed-content` cannot be satisfied. Three constraints
combine:

1. A dispatched Convex result is serialized into exactly one
   `type: "text"` content block.
2. The only escape hatch is a `beforeCall` hook returning
   `completeCall(...)`, whose result is forwarded verbatim.
3. A tool carrying a `beforeCall` hook structurally requires an
   authenticated caller, and the suite cannot send an `Authorization`
   header.

### Unreachable: every `resources/*` scenario

Resource reads always require an identity. Tools have a public opt-out
through `metadata.public` plus a permissive `authorize`; resources have
no equivalent, so an anonymous client cannot read one.

### Not implemented

`prompts/*` (no prompts feature), `logging/setLevel` and
`completion/complete` (capabilities the gateway never advertises), and
the sampling, progress and in-call elicitation scenarios, which need
server-initiated messages the HTTP transport does not push.

## Known conformance gaps

- **`$schema` cannot be advertised.** SEP-1613 asks a tool to declare
  its JSON Schema dialect. A hand-written `inputSchema` carrying
  `$schema` crashes `initialize` with an uncaught server error, because
  the schema is persisted as a Convex value and Convex reserves field
  names beginning with `$`. The failure takes down the whole mount, not
  just that tool.
- **`$defs` and `$ref` do not survive.** The gateway resolves them
  before advertising, so a client never sees them. `additionalProperties`
  and the rest of the schema pass through intact.

## What the suite does not cover

There are **no server scenarios for `2026-07-28`**. All 32 are tagged
`2025-06-18` / `2025-11-25`, so the stateless era, which is the larger
half of this gateway, is not verified by conformance at all today. Any
claim about stateless conformance still rests on this repo's own tests.
