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

Run on 2026-08-29 against a local deployment, gateway `1.0.0` plus
everything this measurement produced so far (SEP-2243 base64 decoding,
`initialize` at the modern wire, and the SEP-2663 task wire), suite
`0.2.0-alpha.11`. Counts are checks, not scenarios, and a scenario the
summary marks with a tick may simply have scored nothing, so read the
`-o` output rather than the summary when it matters.

| Requirement set | Anonymous | Through the auth proxy |
| --- | --- | --- |
| `2026-07-28` | **130 passed, 50 failed** | **141 passed, 40 failed** |
| `2025-11-25` | **54 passed, 19 failed** | unchanged |

The ten-check gap between the two columns is the whole tasks group,
which is owner-bound and therefore invisible to a suite that cannot
authenticate. `tasks-lifecycle` is 7/9 through the proxy and 1/9 without
it; `tasks-required-task-error` and `tasks-dispatch-and-envelope` tell
the same story. Run authenticated when working on tasks or MRTR.

Every failure below is accounted for in the next section. Nothing here is
an unexplained red.

### Fully passing, `2026-07-28`

`tools-list`, `tools-call-simple-text`, `tools-call-error`,
`server-sse-multiple-streams`, `resources-list`, `resources-read-text`,
`resources-read-binary`, `resources-templates-read`,
`sep-2164-resource-not-found` (4/4), `dns-rebinding-protection` (2/2),
`http-header-validation` (14/14),
`http-custom-header-server-validation` (10/10),
`json-schema-2020-12` (8/8, including
the SEP-1613 keyword checks and all three SEP-2106 ones), and four of the
MRTR scenarios that assert refusals rather than interactions
(`missing-input-response`, `unsupported-methods`, `ignore-extra-params`,
`validate-input`).

`tasks-capability-negotiation` is 4/5 since the extension moved under
`extensions`, and `tasks-lifecycle` 8/9 through the proxy.
`server-stateless` is 21/25 and `caching` 7/8, with the misses named
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

### 1. Nobody authenticated, which is a setup gap, not a wall

Most of what this gateway does needs an authenticated caller: MCP Tasks
are owner-bound, and a `beforeCall` hook, the only route to an MRTR round
or to a non-text result, structurally requires one. The suite sends no
`Authorization` header and has no flag to add one, so all of it answers
`-32001` and reports as unreachable:

- Ten `input-required-result-*` scenarios.
- The ten `tasks-*` extension scenarios.
- `tools-call-image`, `tools-call-audio`, `tools-call-embedded-resource`,
  `tools-call-mixed-content`. A dispatched Convex result is serialized
  into exactly one `type: "text"` block, and `completeCall` from a hook
  is the only other route, so these need a hook as well. Tracked in
  [#50](https://github.com/tfohlmeister/convex-mcp-gateway/issues/50).

**This is fixable, and it is worth saying plainly because an earlier
version of this document called it structural.** It is not: the suite
cannot authenticate, but nothing stops something in front of it from
doing so. `pnpm conformance:proxy` runs a loopback proxy that puts a
Bearer on every request and forwards to the deployment; point `--url` at
it and the scenarios above run for real.

```sh
pnpm conformance:proxy    # in one shell, defaults to the example's
                          # valid-admin-token fixture

npx @modelcontextprotocol/conformance@alpha server \
  --url http://127.0.0.1:3399/mcp --requirements 2026-07-28
```

The measured numbers above are the ANONYMOUS run, which is the honest
default: it is what the suite does unaided, and it is the configuration
a reader reproduces first. The authenticated run measures more of the
gateway and is the one to use when working on tasks or MRTR.

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

- **Two SSE recommendations are unmet**, both SHOULD rather than MUST: no
  priming event with an id and empty data on the POST stream, and no
  `retry` field. Both matter for resumability, which this transport does
  not offer anyway.
- **A bare string renders differently inline and through a task.** A
  tool returning `"Hello"` inline puts a JSON-quoted `"Hello"` in the
  text block; through a task it puts `Hello`. The task path is the
  deliberate one and the suite agrees with it
  (`tasks-headers-tolerate-mcp-method-on-tools-call` asserts the
  unquoted form), so the inline path is the odd one out. Small, and a
  wire change for anything parsing the quoted form.
- **`wire-schema-valid` fails in every tasks scenario**, reporting that
  a `tools/call` result "must have required property `content`". A
  `CreateTaskResult` has no `content` by construction, and the suite
  appears to validate every `tools/call` response against
  `CallToolResult` rather than against the union SEP-2663 defines.
  Suspected suite limitation rather than a gateway defect, but it is
  unverified and counted in the numbers above either way.

The rest of the SEP-2663 distance is closed: the capability is
advertised under `capabilities.extensions`, a `CreateTaskResult` is flat
and carries `ttlMs` / `createdAt` / `lastUpdatedAt`, an unknown task id
answers `-32602`, a non-declaring caller answers `-32021`,
`taskSupport` has the three levels, and the server decides per call
whether a call becomes a task.

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
