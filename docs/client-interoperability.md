# Client interoperability: Claude, Codex, and transports

## Transport

Use **Streamable HTTP** for this gateway's remote MCP endpoint. It is a standard
MCP transport, not a fallback for a broken login. The other standard binding,
stdio, connects to a local subprocess. WebSocket would be a custom transport
requiring an implementation and client support at both ends.

The gateway implements HTTP POST with JSON or request-scoped SSE responses.
Its SSE response contains one message; GET returns 405, so there is no persistent
server-to-client notification stream. Resource subscription options do not
install a WebSocket server: the host must provide notification delivery itself.
Convex's reactive SDK uses a separate WebSocket protocol for query updates; that
is not the protocol spoken by the MCP HTTP action.

References: [MCP transports](https://modelcontextprotocol.io/specification/latest/basic/transports),
[Convex React client internals](https://docs.convex.dev/client/react#under-the-hood),
and [gateway transport behavior](./architecture.md#mcp-streamable-http-transport).

## Three URLs with different jobs

| URL                         | Job                                             | Example                             |
| --------------------------- | ----------------------------------------------- | ----------------------------------- |
| MCP endpoint                | Receives tool requests                          | `https://api.example.com/mcp/codex` |
| Resource identifier         | Identifies the protected API and token audience | `https://api.example.com/mcp`       |
| Authorization-server issuer | Identifies the login/token provider             | `https://id.example.com`            |

An alias may expose the same protected resource at another endpoint. Keep its
discovery metadata, authorization request, and audience validation consistent.
Do not change the audience to the alias URL unless the IdP and resource server
are also configured for that different resource.

## Prefer direct upstream discovery

When a client supports a pre-registered public PKCE client, advertise the actual
IdP in `authorization_servers` and configure that client's ID in the MCP client.
Use [OAuth setup](./oauth.md) with `authServerUrl` pointing at the IdP. Configure
`resourceUrl` explicitly when a canonical resource must be preserved.

The gateway's bridge defaults to its own origin as metadata `issuer`. Overriding
that to an upstream origin is a legacy OIDC-client workaround, not a generally
compatible setup. Codex 0.153.4 rejects the resulting metadata-origin mismatch
before login. See [bridge issuer pitfalls](./oauth-bridge.md#issuer-mismatch-with-upstream-token-claims).

Neither direct discovery nor the bridge replaces token validation. In
particular, an IdP userinfo response alone does not bind a token to this MCP
resource: enforce the resource audience as well as token validity.

## Keep a working legacy Claude connector while adding Codex

If an existing claude.ai deployment depends on the issuer override, a host can
add a direct-discovery alias without replacing its existing bridge:

1. Keep `/mcp`, its discovery document, and the Claude DCR bridge unchanged.
2. Mount `/mcp/codex` (and its trailing-slash form) using the same gateway handler,
   tool catalog, identity resolver, and authorizer. This alias is host-defined;
   the gateway does not install it automatically.
3. Mount `/.well-known/oauth-protected-resource/mcp/codex` with metadata like:

   ```json
   {
     "resource": "https://api.example.com/mcp",
     "authorization_servers": ["https://id.example.com"],
     "bearer_methods_supported": ["header"],
     "scopes_supported": ["openid", "profile", "email", "offline_access"]
   }
   ```

4. For 401 responses on that alias, set `WWW-Authenticate` to
   `Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp/codex"`.
   Serve discovery without authentication, including any required CORS handling.
5. Register the client's callback at the IdP and configure Codex as below.

This is a compatibility recipe, not a requirement to use separate endpoints for
all clients. A deployment with consistent direct IdP discovery can use one MCP
URL for every client that supports its registration method.

## Codex configuration

For an IdP advertising `authorization_response_iss_parameter_supported: true`,
such as the Pocket-ID installation used in the verified setup:

```toml
[mcp_servers.example]
url = "https://api.example.com/mcp/codex"
scopes = ["openid", "profile", "email", "offline_access"]

[mcp_servers.example.oauth]
client_id = "YOUR_PUBLIC_PKCE_CLIENT_ID"
callback_url = "http://127.0.0.1/callback"
```

Then run `codex mcp login example`. The client ID is public; a client secret is
not needed. The IdP must accept the loopback callback's variable port. Providers
without issuer-identification support may need Codex's server-specific callback
path; register the exact callback Codex displays. See
[official Codex MCP configuration](https://developers.openai.com/codex/mcp/).

Do not add a redundant `oauth_resource` when discovery already supplies the
correct resource. Codex 0.153.4 was observed to send two `resource` parameters
in this configuration, causing Pocket-ID to reject the request with
`invalid_target: Only a single 'resource' parameter is supported`.

## Claude Code and claude.ai

For an existing bridge-backed deployment:

```sh
claude mcp add --scope user --transport http example https://api.example.com/mcp
claude mcp login example
claude mcp get example
```

Complete login in an interactive terminal/browser. In claude.ai, keep the
existing connector URL `https://api.example.com/mcp`. Its remote connector is
not automatically a local Claude Code configuration entry.

## Verification and troubleshooting

The host recipe above was verified on 2026-09-07 with Codex 0.153.4 and Pocket-ID:
Codex completed OAuth and loaded 15 tools, and Claude Code completed a fresh
bridge-backed login and reported Connected. The existing claude.ai bridge was
preserved; that browser client's session was not separately retested.

| Symptom                               | Check                                                          |
| ------------------------------------- | -------------------------------------------------------------- |
| 404 before login                      | Stale deployment URL or missing metadata route                 |
| Issuer does not match metadata origin | Upstream issuer override on a bridge-hosted document           |
| `invalid_target`, duplicate resource  | Redundant Codex `oauth_resource` override                      |
| Invalid callback                      | Exact callback host/path and variable loopback port acceptance |
| Login succeeds, MCP returns 401       | Token validity and canonical resource audience                 |
| GET returns 405                       | Expected: this gateway has no persistent GET SSE channel       |

Verify discovery, anonymous 401 challenges, authentication, and tool loading
separately. Start a fresh client session after changing configuration if its
existing tool catalog still refers to the previous connection.
