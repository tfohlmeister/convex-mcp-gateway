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
```

The suite scores against one spec revision at a time, and this gateway
serves two eras, so both runs matter:

```sh
# The 2026-07-28 wire: stateless, MRTR, caching, routing headers, tasks.
npx @modelcontextprotocol/conformance@alpha server \
  --url <site-url>/mcp --requirements 2026-07-28

# The session era.
npx @modelcontextprotocol/conformance@alpha server \
  --url <site-url>/mcp --requirements 2025-11-25

# One scenario, with the raw JSON:
npx @modelcontextprotocol/conformance@alpha server \
  --url <site-url>/mcp --scenario tools-call-simple-text --verbose

# Per-check results as files, which is what the tables below were read from:
npx @modelcontextprotocol/conformance@alpha server \
  --url <site-url>/mcp --requirements 2026-07-28 -o ./conformance-out
```

**Use the `alpha` tag, not `latest`.** The `latest` release (`0.1.16` at
the time of writing) defines 32 server scenarios, none of them tagged
`2026-07-28`, so it cannot see the stateless era at all. `0.2.0-alpha.11`
defines 62, and `--requirements 2026-07-28` freezes the 37 that revision
requires. `conformance list --requirements 2026-07-28` prints the set.

Turn it off again with `npx convex env remove MCP_CONFORMANCE` and
redeploy, or the example serves `test_*` tools instead of the invoice
ones.

It is a **catalog switch, not a second mount**, and that is forced. The
component keeps one tool registry and one catalog fingerprint, so two
mounts passing different `tools` arrays delete each other's tools on
every reconciliation. Mounts may differ by `tasks` or `authorize`, never
by their catalog.

## Measured results

Run on 2026-08-29 against a local deployment, gateway `1.0.0`, suite
`0.2.0-alpha.11`. Counts are checks, not scenarios, and a scenario the
summary marks with a tick may simply have scored nothing, so read the
`-o` output rather than the summary when it matters.

| Requirement set | Result |
| --- | --- |
| `2026-07-28` | **120 passed, 59 failed** |
| `2025-11-25` | **54 passed, 19 failed** |

Every failure below is accounted for in the next section. Nothing here is
an unexplained red.

### Fully passing, `2026-07-28`

`tools-list`, `tools-call-simple-text`, `tools-call-error`,
`server-sse-multiple-streams`, `resources-list`, `resources-read-text`,
`resources-read-binary`, `resources-templates-read`,
`sep-2164-resource-not-found` (4/4), `dns-rebinding-protection` (2/2),
`http-header-validation` (14/14), `json-schema-2020-12` (8/8, including
the SEP-1613 keyword checks and all three SEP-2106 ones), and four of the
MRTR scenarios that assert refusals rather than interactions
(`missing-input-response`, `unsupported-methods`, `ignore-extra-params`,
`validate-input`).

`server-stateless` is 18/25 and `caching` 7/8, with the misses named
below.

### Fully passing, `2025-11-25`

`server-initialize`, `server-session-lifecycle`, `ping`, `tools-list`,
`tools-call-simple-text`, `tools-call-error`, the four `resources-*`
read/list scenarios, `dns-rebinding-protection`, `json-schema-2020-12`
and `server-sse-multiple-streams`.

`server-sse-polling` prints as a pass and is not one. It scores 0 of 0:
every check it emitted is informational, and it raised two SHOULD-level
warnings, `server-sse-priming-event` and `server-sse-retry-field`. Read
it as unverified rather than as green.

## Why the rest fails

Three different causes, and the distinction is the useful part.

### 1. The authenticated-hook rule, which blocks the most

A tool carrying a `beforeCall` hook structurally requires an
authenticated caller, and the suite cannot send an `Authorization`
header. Since a hook is also the only route to a non-text result and the
only way to open an MRTR round, one rule makes three groups unreachable:

- `tools-call-image`, `tools-call-audio`, `tools-call-embedded-resource`,
  `tools-call-mixed-content` (a dispatched Convex result is serialized
  into exactly one `type: "text"` block; `completeCall` from a hook is the
  only other route). Tracked in
  [#50](https://github.com/tfohlmeister/convex-mcp-gateway/issues/50).
- Ten `input-required-result-*` scenarios, which need a tool that answers
  round one with `inputRequests`.
- The MRTR half of the tasks group (`tasks-mrtr-input`,
  `tasks-mrtr-composition`), plus `test_input_required_result_*`.

`anonymousResources` solved exactly this shape for resource methods. The
tool-side equivalent does not exist, so these stay unreachable rather than
failing on their merits.

### 2. Features the gateway does not implement

`prompts/*` (five scenarios, plus the `prompts/list` half of `caching` and
of `sep-2549`), `completion/complete`, `logging/setLevel` and
`tools-call-with-logging`, `tools-call-with-progress`, `tools-call-sampling`,
the `elicitation-*` scenarios on the session era, and
`resources-subscribe` / `resources-unsubscribe`, which stay authenticated
by design. `subscriptions/listen` is unimplemented, so the five
subscription checks inside `server-stateless` report as skipped rather
than failed.

`server-stateless` also names three diagnostic fixtures this catalog does
not provide, because each needs a feature above:
`test_missing_capability`, `test_streaming_elicitation`,
`test_logging_tool`. Their checks report untestable.

### 3. Real gaps the run found

These are the ones worth acting on. None of them were visible before the
suite covered the modern era.

- **Missing `_meta` answers `-32020`, not `-32602`.** A stateless request
  with no `_meta`, or with a `_meta` that omits
  `io.modelcontextprotocol/protocolVersion`, is a malformed request.
  SEP-2575 wants `-32602 Invalid params`; the gateway reports the header
  mismatch it noticed first. Two checks in `server-stateless`.
- **`initialize` is answered at the `2026-07-28` wire.** The revision
  removed the method, and a server that does not implement it must answer
  HTTP 404 with `-32601`. This gateway routes `initialize` to the legacy
  era unconditionally, which is deliberate dual-era behaviour and is
  exactly what the check reads as non-compliant. Needs a decision, not
  just a fix: the session era has to keep working.
- **Base64 routing headers accept invalid padding.** `=?base64?SGVsbG8?=`
  decodes leniently and matched the body value, where the SEP-2243 table
  requires HTTP 400 with `-32020`.
- **A malformed base64 wrapper is not treated as a literal.** SEP-2243
  says a value without the closing `?=` is not an encoded value at all, so
  it must be compared literally. The gateway rejects it as a mismatch
  instead, refusing a request it must accept.
- **A task can never report a protocol-level failure.** SEP-2663 splits a
  tool error (`completed` with `result.isError`) from a protocol error
  (`failed` with an inlined error). The gateway maps every throw to
  `-32000` and the task path launders exactly that into the first shape,
  so only a refusal the tool never saw (unknown tool, missing caller)
  can fail a task. `protocol_error_job` exists to make that visible.
- **Two SSE recommendations are unmet**, both SHOULD rather than MUST: no
  priming event with an id and empty data on the POST stream, and no
  `retry` field. Both matter for resumability, which this transport does
  not offer anyway.
- **The tasks extension is implemented against an earlier SEP-2663
  draft.** The suite tests the v2 wire and the gateway answers v1:
  `capabilities.extensions` is not advertised, a `CreateTaskResult` is not
  produced for a client that opts in per request or for server-directed
  creation, `ttlMs` is missing, `tasks/get` on an unknown id answers
  `-32001` rather than `-32602`, the non-declaring case answers `-32001` /
  `-32601` rather than `-32021`, and `taskSupport` has no `required`
  level. Ten scenarios, all in the extension group, which the suite does
  not score for conformance.

## Known gaps that predate the suite

- **A property name outside ASCII cannot be registered.** Convex field
  names must be non-control ASCII, and a property name carries meaning,
  so it cannot be dropped the way a `$`-prefixed keyword can. Such a
  schema fails registration with the tool and the field named, rather
  than failing the write from inside Convex.

## Fixtures

`example/convex/conformance.ts` is a transcription of what the scenarios
ask for, not a design of its own. Two parts are load-bearing and easy to
break:

- **`anonymousResources`.** Resource methods require an identity by
  default, so `http.ts` sets the option under the switch and its
  `authorizeResource` serves the fixtures marked
  `metadata: { public: true }`. Both halves are needed, and not
  symmetrically: `anonymousResources` without an `authorizeResource` is
  refused outright (it would publish the whole catalog), while an
  `authorizeResource` without the option is the ordinary configuration
  every other mount here uses. SEP-2164 additionally needs the authorizer
  to let an unknown `test://` URI reach resolution, or the `-32602` it
  tests for is replaced by a `-32003`.
- **`allowedOrigins`.** Set under the switch, because
  `dns-rebinding-protection` sends `Origin: http://evil.example.com` and
  requires a refusal. A request with no `Origin` at all is served either
  way, so it does not gate the rest of the suite. It is a matcher rather
  than a list on purpose: the suite derives its "valid" origin from the
  `--url` you pass, and the local backend answers to both
  `http://127.0.0.1:<port>` and `http://localhost:<port>`, so an
  exact-string allowlist built from `CONVEX_SITE_URL` alone fails the
  scenario for whichever spelling you did not use.

The tasks fixtures (`greet`, `slow_compute`, `failing_job`,
`protocol_error_job`, `test_tool_with_task`) are named by the SEP-2663
scenarios and exist so that group reaches the gateway's task machinery
rather than reporting the capability as absent. They currently surface
the v1-versus-v2 gap above, which is what they are for.
