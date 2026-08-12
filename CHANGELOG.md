# Changelog

## [0.7.0](https://github.com/tfohlmeister/convex-mcp-gateway/compare/v0.6.1...v0.7.0) (2026-08-12)

Adds the stateless MCP `2026-07-28` server path alongside the existing
2025-03-26 and 2025-06-18 session transport. Both eras are served from the
same `/mcp/` endpoint and legacy behaviour is unchanged, so upgrading does
not require touching an existing mount. Modern requests get `server/discover`,
per-request protocol metadata, routing-header validation, and private cache
hints, with no session created, read, or returned.

**What this release is not.** It does not make the gateway fully
`2026-07-28` compliant and does not close
[#18](https://github.com/tfohlmeister/convex-mcp-gateway/issues/18):

- **MRTR** (`resultType: "input_required"`) is not implemented. It needs a
  host-side `beforeCall` hook so an underlying Convex function cannot run
  before its required input is accepted; designed in
  [#17](https://github.com/tfohlmeister/convex-mcp-gateway/issues/17).
- **`subscriptions/listen`** and modern push notifications are not
  implemented. The gateway takes the other option the spec allows and does
  not advertise notification capabilities it cannot deliver.
- **Request-scoped progress and log delivery**, and bounded `$ref` and
  composition handling for general input and output schemas, are not
  implemented.
- **Conformance is unverified.** The protocol contract has focused
  handler-level tests, but the official MCP conformance suite has not been
  run and there are no contract tests against a real modern client.

**New option.** `allowedOrigins` enables `Origin` validation for both eras
and is off by default. It is deliberately separate from `cors`: CORS decides
what a browser may read, `allowedOrigins` decides what the gateway serves.
See SECURITY.md for the reasoning behind the default.

### Features

* add allowedOrigins and fix 2026-07-28 header handling ([#21](https://github.com/tfohlmeister/convex-mcp-gateway/issues/21)) ([363b555](https://github.com/tfohlmeister/convex-mcp-gateway/commit/363b555e7758f4e011bc9fe09a7092e976a1620e))
* add stateless MCP 2026-07-28 server support ([d1969ad](https://github.com/tfohlmeister/convex-mcp-gateway/commit/d1969ad988ac8f01f1eb447c6bbbd3582270f834))

## [0.6.1](https://github.com/tfohlmeister/convex-mcp-gateway/compare/v0.6.0...v0.6.1) (2026-08-03)


### Bug Fixes

* harden tool protocol metadata passthrough ([#16](https://github.com/tfohlmeister/convex-mcp-gateway/issues/16)) ([c5c6bbf](https://github.com/tfohlmeister/convex-mcp-gateway/commit/c5c6bbf4d282a8bcf991556dd1833caa18d31e98))
* preserve tool protocol metadata ([#10](https://github.com/tfohlmeister/convex-mcp-gateway/issues/10)) ([6b1bde8](https://github.com/tfohlmeister/convex-mcp-gateway/commit/6b1bde812c041253109d87157a574792e939a21c))

## [0.6.0](https://github.com/tfohlmeister/convex-mcp-gateway/compare/v0.5.0...v0.6.0) (2026-07-28)


### Features

* redact sensitive tool error messages from audit logs ([10d4061](https://github.com/tfohlmeister/convex-mcp-gateway/commit/10d4061fd7692d1cff95b2ec5dcdbcced50a8556))


### Bug Fixes

* keep accidental exception text off the MCP wire ([407fad2](https://github.com/tfohlmeister/convex-mcp-gateway/commit/407fad22c261fb65a91a3ed3fbaaaf3377a22942))

## 0.5.0 (2026-06-24)

### Added

- **MCP resources.** First-class resource support alongside tools, with the
  same deny-by-default, host-owns-authorization model.
  - `defineMcpResource` (concrete `uri`) and `defineMcpResourceTemplate`
    (RFC 6570 `uriTemplate`) serve `resources/list`, `resources/read`, and
    `resources/templates/list`; raw `McpResourceProvider` objects stay
    supported as an escape hatch.
  - Resources and templates are persisted in the component registry and
    reconciled on `initialize` via change-detected fingerprints (mirroring
    the `tools` catalog), with imperative `registerResource(s)` /
    `registerResourceTemplate(s)` / `unregister*` / `clear*` APIs.
  - One central `authorizeResource` hook gates list / read / templates-list;
    resource reads require an authenticated caller.
  - Opt-in `auditResources` records `list` / `read` / `templates_list`
    operations (URI, operation, identity, outcome, duration), never the
    resource contents.
  - Templates resolve `resources/read` server-side (concrete resources take
    precedence), with level-1 `{var}` matching validated at declaration time.
  - Opt-in resource-subscription capability: per-session, owner-bound
    `resources/subscribe` / `resources/unsubscribe` state plus notification
    builders, for hosts that front the gateway with a push-capable transport.
  - Resource/template types gain `title`, `annotations`, and `size`; provider
    output is runtime-validated and projected so malformed or stray data
    never reaches the client.
  - New `docs/resources.md` and a runnable, tested example under
    `example`.
- **`initializeInstructions` option.** Pass `initializeInstructions` to
  `handleMcpRequest` to populate the MCP `initialize` result's `instructions`
  field: server-level guidance the client can hand the LLM without touching
  individual tool descriptions. Omitted from the response when unset, so the
  default `initialize` shape is unchanged.

## 0.4.0 (2026-05-21)

### Added

- **Declarative `tools` option on `handleMcpRequest`.** Pass the tool
  catalog (the same `defineMcp*` array `register` takes) directly to
  `gateway.handleMcpRequest({ authorize, tools })` and the gateway
  reconciles the component registry on `initialize`, so editing the list
  in code takes effect on the next client connect with no separate
  registration mutation to run by hand. The reconcile is
  **change-detected**: the list is fingerprinted and the registry is only
  rewritten when something actually changed, so the steady-state cost per
  connection is a single cheap lookup, not a rewrite. The imperative
  `gateway.register(...)` / `registerTool(...)` path stays for
  dynamic/plugin catalogs. New exported type `McpToolRegistration` (and
  `McpToolFunctionReference`) to annotate an exported `tools` array
  against a Convex codegen circular-type error.

## 0.3.0 (2026-05-21)

### Added

- **`requireAuth` option for all-private servers.** New opt-in boolean
  on `HandleMcpRequestOptions`. When set, any anonymous POST (including
  `initialize` / `tools/list`) is answered with `401` +
  `WWW-Authenticate` instead of being let through. This is the trigger
  browser MCP clients (claude.ai) need to begin the OAuth flow: with no
  `public` tools, the default 200-empty `tools/list` makes such clients
  conclude "connected, no tools" and they never prompt a login. The
  header reuses the same RFC 6750 / RFC 9728 construction as the
  `tools/call` denial path and needs `setOAuthConfig`; without OAuth
  config the gate still returns 401 but omits the header and warns once.
  Default is `false`, mixed public/private servers keep the 200 +
  filtered-catalog behaviour unchanged. Applies to POST only (`GET`
  still 405s, `DELETE` stays identity-bound, `OPTIONS` preflight is
  untouched). Caller identity is now resolved once per request and
  threaded through the gate, audit, authorize input, and session
  binding, removing a duplicate userinfo round-trip on re-initialize.

## 0.2.0 (2026-05-20)

### Added

- **Caller-identity injection (`identityArg`).** A dispatched tool runs
  inside the component, where `ctx.auth` is unavailable. Tools can now
  opt in to receiving the authenticated caller: declare an argument with
  the new `mcpCallerValidator` (shape `{ subject, claims? }`) and name it
  in `identityArg`. The gateway fills that argument server-side with the
  identity resolved at the request boundary, removes it from the
  advertised `inputSchema` (clients never see it), strips any
  client-supplied value (no spoofing), and rejects calls with no resolved
  caller as `-32001 Unauthorized` (enforced both host-side and inside the
  component's `runTool`). The injected argument is stripped before the
  audit write, so the caller and its claims never reach the audit log;
  the subject is still recorded in the audit row's `identitySubject`
  column. New exports: `mcpCallerValidator`, `McpCaller`.

## 0.1.0 (2026-05-19) - initial version

First public version of `convex-mcp-gateway`. Implements
the MCP server side of the Convex+MCP integration: register Convex
functions as MCP tools, mount one `/mcp/` route in your host, plug
your existing OAuth / JWT issuer in via a callback. No prior release
to break, so the entries below describe the full surface area.

### What's in the package

- **Tool registration.** `defineMcpQuery` / `defineMcpMutation` /
  `defineMcpAction` declare a Convex function as an MCP tool with
  end-to-end-typed `args` and (optional) `returns` validators,
  drift between the registered Convex function and the tool
  descriptor surfaces as a `_typeMismatch` at compile time, never at
  runtime.
- **`McpGateway` client.** Host-side handle exposing `register`,
  `registerTool`, `unregisterTool`, `listTools`, `clearTools`,
  `setOAuthConfig`, `handleMcpRequest`, `serveProtectedResourceMetadata`,
  `serveAuthorizationServerMetadata`, `handleClientRegistration`,
  `pruneSessions`, `pruneAuditEntries`, `listAuditEntries`.
- **MCP 2025-06-18 Streamable HTTP transport.** Sessions (server-
  issued 128-bit hex `Mcp-Session-Id`), `Accept` header negotiation
  with both `application/json` and `text/event-stream`,
  `MCP-Protocol-Version` validation, single-frame SSE responses
  ready for future progress notifications, identity-bound `DELETE`,
  spec-compliant rejection of batched requests and missing-method
  envelopes (HTTP 400). Tool execution failures surface as
  `result.isError: true` (with `content`) so the model can react;
  `-32602 Unknown tool` stays a JSON-RPC error per spec.
- **Authorization is a JS callback** the host passes to
  `gateway.handleMcpRequest({ authorize })`, not a registered Convex
  query. Reason: Convex doesn't propagate `ctx.auth` into component
  code, so the policy decision must run host-side where
  `ctx.auth.getUserIdentity()` works. The same callback gates
  `tools/call` (`mode: "call"`) and filters `tools/list`
  (`mode: "list"`). Identity is resolved once at the request
  boundary and passed in as `args.identity`.
- **OAuth 2.1 protected-resource discovery (RFC 9728).** Configure
  with `gateway.setOAuthConfig({ authServerUrl, resourceUrl? })`;
  mount `serveProtectedResourceMetadata` at the well-known path.
  401 responses on `tools/call` carry
  `WWW-Authenticate: Bearer resource_metadata="..."` per RFC 6750.
- **OAuth bridge mode (opt-in).** For hosts whose upstream IdP
  doesn't support Dynamic Client Registration (Pocket-ID, plain
  OIDC providers, some Authentik/Keycloak setups):
  - `serveAuthorizationServerMetadata` wraps the upstream's
    openid-configuration with the host's own `registration_endpoint`
    (in-process 1-hour cache, SSRF-guarded, capped LRU).
  - `handleClientRegistration` returns a fixed pre-registered
    upstream `client_id` for every RFC 7591 request; required
    `allowedRedirectPatterns` prevents open-redirect abuse, and
    error responses truncate echoed payloads to bound size.
  - `resolveIdentity` callback replaces Convex's JWT validation for
    opaque tokens, typically a userinfo-endpoint fetch.
- **Audit log.** One row per `tools/call` capturing tool, kind,
  outcome (`allowed` / `denied` / `error`), identity subject,
  duration, args, and error detail. Filtered reads via
  `gateway.listAuditEntries({ toolName?, outcome?, limit? })`.
  Argument storage is controlled per-tool by `metadata.auditArgs`:
  - `true` (default): store verbatim
  - `false`: drop entirely
  - `{ redact: ["password", "credentials.token"] }`: dotted paths
    walk nested objects and replace the leaf with `"[redacted]"`.
- **Wire error sanitization.** A plain `throw new Error(...)` from
  a tool handler results in a generic `"Tool execution failed"` on
  the wire; the verbose message lands in the audit row only. Tools
  that want the LLM to see a specific message throw
  `ConvexError(...)`, the deliberate user-facing channel.
- **Sessions bound to creator's identity.** `sessions` rows record
  the `identitySubject` resolved at `initialize` time; `DELETE /mcp/`
  requires a matching subject and returns 403 otherwise, so a
  leaked session id alone cannot DoS an authenticated user's
  session. Pre-binding rows skip the check for forward-compat.
- **Bounded pruning.** `pruneAuditEntries` and `pruneSessions`
  delete at most 200 rows per call (ascending creation-time and
  `by_lastSeenAt` index respectively); callers loop until the
  return value is 0. Designed for `crons.daily(...)` from the host.
- **CORS.** `McpCorsOption` accepts `true`, an exact-match string,
  a `string[]` allowlist, or a function. JSDoc calls out the
  production risk of `cors: true` on auth-bearing endpoints.
- **Tool name validation.** `defineMcp{Query,Mutation,Action}` reject
  names that violate `^[a-zA-Z0-9_-]{1,64}$` at registration time
  rather than letting claude.ai's frontend reject the whole catalog
  later. Dotted names (`invoices.list`) are the common gotcha
  (mirroring `api.invoices.list` reference style); use
  `invoices_list` instead.
- **Component boundary.** The user-facing API is the host's
  `gateway.*` wrapper, never the raw `components.mcpGateway.*`
  functions. Inside the component, `audit.recordEntry` is the only
  `internalMutation` because only in-component `dispatch.runTool`
  writes audit rows; host-called functions (registry, sessions,
  `dispatch.runTool`, `dispatch.recordAuthDenial`) are public
  because Convex enforces the internal/public marker at the
  component boundary at runtime.

### Docs

`docs/getting-started.md`, `docs/architecture.md`,
`docs/authorization.md`, `docs/oauth.md`, `docs/oauth-bridge.md`,
`docs/audit-log.md`, `docs/testing.md`, plus editorial-styled SVG
sequence and data-flow diagrams under `docs/diagrams/`.

### CI / release

GitHub Actions workflows: build + typecheck + test + lint on every
PR, publish to npm on `v*` tag push. Local development against a
pinned `convex-local-backend` binary via `pnpm local:start`
(no Docker).
