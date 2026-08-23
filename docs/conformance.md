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

# The default "active" suite excludes pending scenarios, which is where
# `json-schema-2020-12` lives:
npx @modelcontextprotocol/conformance server --url <site-url>/mcp --suite all
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

`json-schema-2020-12` passes 4/4, including the two SEP-1613 keyword
checks. It lives in the **pending** suite rather than the active one, so
`--suite all` is needed to reach it at all:

```
[json-schema-2020-12-tool-found          ] SUCCESS Server advertises tool 'json_schema_2020_12_tool'
[json-schema-2020-12-$schema             ] SUCCESS inputSchema.$schema field preserved
[json-schema-2020-12-$defs               ] SUCCESS inputSchema.$defs field preserved with expected structure
[json-schema-2020-12-additionalProperties] SUCCESS inputSchema.additionalProperties field preserved
```

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

### Reachable through the anonymous opt-in: `resources/*`

`resources-list`, `resources-read-text`, `resources-read-binary` and
`resources-templates-read` all need an anonymous `resources/*` call,
which is the only kind the suite can make: it cannot send an
`Authorization` header.

The three `sep-2164` not-found checks (`-no-empty-contents`,
`-error-code`, `-data-uri`) need the same thing, but they ship only in
`0.2.0-alpha.11`, not in the `latest` the command above installs, so
reaching them needs an explicit version. They also need the authorizer to
let an unknown `test://` URI through to resolution: SEP-2164 is about the
answer a server gives for a resource it does not have, and an authorizer
that denies unknown URIs replaces that `-32602` with a `-32003`. The
example allows the whole `test://` scheme under the switch for exactly
this reason, which is a fixture decision, not a model policy.

Resource methods require an identity by default, so the example sets
`anonymousResources` under the `MCP_CONFORMANCE` switch and its
`authorizeResource` serves the fixtures marked `metadata: { public: true }`.
Both halves are needed, and not symmetrically: `anonymousResources`
without an `authorizeResource` is refused outright (it would publish the
whole catalog), while an `authorizeResource` without the option is the
ordinary configuration every other mount here uses.

The fixtures are transcribed from what each scenario asks for, and the
gateway side is covered by unit tests, but the suite itself has not been
run against a live deployment for this change, so treat the entries above
as reachable rather than as measured passes.

`resources-subscribe` and `resources-unsubscribe` stay unreachable, and
deliberately so. A subscription is server-side state an anonymous caller
would accumulate, and this transport cannot push the
`notifications/resources/updated` a subscription exists to receive.

### Not implemented

`prompts/*` (no prompts feature), `logging/setLevel` and
`completion/complete` (capabilities the gateway never advertises), and
the sampling, progress and in-call elicitation scenarios, which need
server-initiated messages the HTTP transport does not push.

## Known conformance gaps

- **A property name outside ASCII cannot be registered.** Convex field
  names must be non-control ASCII, and a property name carries meaning,
  so it cannot be dropped the way a `$`-prefixed keyword can. Such a
  schema fails registration with the tool and the field named, rather
  than failing the write from inside Convex.

SEP-1613 keyword preservation used to sit here. The registry now keeps
the authored schema beside the resolved one, so `$schema`, `$defs` and
`$ref` reach the client intact while the gateway keeps walking the
resolved form. See "Two schemas per tool" in
[architecture.md](./architecture.md). Measured: `json-schema-2020-12`
passes 4/4 against a local deployment, see above.

## What the suite does not cover

There are **no server scenarios for `2026-07-28`**. All 32 are tagged
`2025-06-18` / `2025-11-25`, so the stateless era, which is the larger
half of this gateway, is not verified by conformance at all today. Any
claim about stateless conformance still rests on this repo's own tests.
