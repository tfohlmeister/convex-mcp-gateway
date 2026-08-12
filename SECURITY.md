# Security policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in
`convex-mcp-gateway`, **please do not open a public GitHub issue**.

Instead, email the maintainers at <thorben@fohlmeister.com> with:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- The version (commit SHA or npm version) you observed it on
- Any deployment context that matters (Convex version, host JWT issuer,
  whether OAuth discovery is configured, etc.)

You will receive an acknowledgement within 72 hours. We aim to publish
a fix or mitigation within 30 days for high-severity issues; lower-
severity issues may take longer.

## Supported versions

This project is pre-1.0. Only the latest published version receives
security fixes. Once a 1.x release ships, we will support the current
major plus one prior major for security fixes.

## Threat model and known limits

The gateway is designed under the following assumptions, which are
worth understanding when evaluating its security posture:

- **The host application is trusted.** The component runs inside the
  same Convex deployment as the host, and the host can call any of the
  component's public mutations (e.g. `audit.recordEntry`,
  `registry.replaceTools`). The component does not defend against a
  malicious or buggy host.
- **The authorize callback is the access boundary.** Mounting the
  gateway requires passing an `authorize` JS callback to
  `gateway.handleMcpRequest({ authorize })`. Without it the handler
  cannot be constructed (TypeScript-enforced). The component performs
  no other policy check; a permissive callback is a wide-open gateway.
- **JWT validation is Convex's job.** The gateway reads
  `ctx.auth.getUserIdentity()` and trusts whatever Convex resolved from
  your `auth.config.ts`. Misconfigured `auth.config.ts` (e.g. wrong
  issuer, no JWKS) makes every caller anonymous.
- **The audit log can carry secrets.** By default, `args` are stored
  verbatim. Use `metadata: { auditArgs: false }` on tools whose
  argument schema accepts credentials, tokens, or PII; the
  `{ redact: [...] }` form supports nested dotted paths
  (`"credentials.token"`).
- **Thrown tool errors are split between wire and audit.** A plain
  `throw new Error("...")` from a tool handler is replaced with a
  generic `"Tool execution failed"` on the wire, while the audit
  row keeps the verbose message. Use `throw new ConvexError("...")`
  when you want a specific message to reach the MCP caller, that
  is the deliberate user-facing channel.
- **The audit log is unbounded.** No automatic retention. Add a cron
  job that prunes rows older than your retention window. See
  [docs/audit-log.md](./docs/audit-log.md).
- **Read access to the audit log is not enforced.**
  `gateway.listAuditEntries` is exposed only through whatever query you
  wrap it in; gate that wrapper with your own authorization checks.
- **Origin validation is opt-in.** MCP requires servers to validate the
  `Origin` header against DNS rebinding. The gateway does this only when
  you pass `allowedOrigins` to `handleMcpRequest`; omitting it accepts
  any origin. The default is off because a Convex deployment lives at a
  fixed public URL rather than on localhost, which is the scenario the
  requirement targets. Set it for any deployment serving browser
  clients. `cors` does not gate this: it decides what a browser may read,
  not what the gateway will serve.

## Known limitations vs. the MCP and OAuth specs

- **No authorization server is built in (yet).** Hosts BYO their AS for
  Bearer-token issuance. See [docs/oauth.md](./docs/oauth.md). An
  optional OAuth-bridge mode wraps an upstream IdP's metadata and
  proxies Dynamic Client Registration; see
  [docs/oauth-bridge.md](./docs/oauth-bridge.md).
- **Sessions table is unbounded by default.** Streamable-HTTP creates a
  row per `initialize`. Clients that disconnect without DELETE leave
  rows behind; schedule `gateway.pruneSessions(ctx, idleMs)` from a
  cron to bound growth.
- **Session DELETE is identity-bound.** The session row records the
  caller's JWT subject at `initialize` time. `DELETE /mcp/` requires
  the same subject (or both ends anonymous) and otherwise returns
  HTTP 403, so a leaked session id alone cannot DoS an authenticated
  user's session.
- **No rate limiting in the component.** Combine with
  [`@convex-dev/rate-limiter`](https://www.npmjs.com/package/@convex-dev/rate-limiter)
  in your authorizer for public tools.
