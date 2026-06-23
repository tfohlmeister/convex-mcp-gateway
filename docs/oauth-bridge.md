# OAuth bridge mode

Use this mode when you want **browser-based MCP clients** (claude.ai
Custom Connectors, MCP Inspector served from a webapp, IDE plugins
with embedded browsers) to connect to an upstream IdP that **doesn't
support Dynamic Client Registration** (Pocket-ID, some older Authentik
/ Keycloak setups, plain OIDC providers without RFC 7591).

This is **opt-in**. The default ["dumb" pass-through mode](./authorization.md),
where your `authorize` callback is the entire auth story, keeps
working unchanged.

> **See also:** Using [`@convex-dev/better-auth`](https://github.com/get-convex/better-auth)
> directly as the authorization server (opaque tokens, split-domain discovery,
> browser login continuation) is covered in the
> [Better Auth recipe](./recipes/better-auth.md).

## What the bridge does

![OAuth bridge mode end-to-end flow](./diagrams/oauth-bridge.svg)

The host pre-registers **one** client at the upstream IdP. The bridge
hands that same client id to every browser MCP client that DCRs,
without exposing the client secret (everything runs in public-client /
PKCE mode). Token validation happens against the IdP's userinfo
endpoint, so opaque access tokens (Pocket-ID's default) work without
local JWT validation.

## Setup

### 1. Register one client at your IdP

In the IdP's admin UI, create an OIDC client with:

- **Type**: public (no client_secret), **PKCE**: required (S256)
- **Allowed redirect URIs**: the well-known callbacks of the MCP
  clients you want to support. For claude.ai:
  `https://claude.ai/api/mcp/auth_callback`. For local Inspector:
  `http://localhost:6274/oauth/callback/debug`. For IDE plugins:
  whatever they document.

Note the **client id**, the bridge needs it.

### 2. Mount the bridge endpoints

```ts
// convex/http.ts (extending the routing from getting-started.md)
import { httpRouter } from "convex/server";
import {
  McpGateway,
  type McpAuthorizerHandler,
  type McpIdentityResolver,
} from "convex-mcp-gateway";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);

const UPSTREAM_ISSUER = "https://id.example.com";
const UPSTREAM_CLIENT_ID = "00000000-0000-0000-0000-000000000000";

// Validate Bearer tokens via the upstream's userinfo endpoint.
// Works for opaque tokens (no local JWT validation, no key
// distribution headaches). The host's `authorize` callback will see
// `args.identity = { subject, claims }` for valid tokens, `null`
// for anonymous/invalid.
const resolveIdentity: McpIdentityResolver = async (token) => {
  const r = await fetch(`${UPSTREAM_ISSUER}/api/oidc/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = (await r.json()) as { sub: string; [k: string]: unknown };
  return { subject: u.sub, claims: u };
};

const authorize: McpAuthorizerHandler = async (_ctx, args) => {
  // ... your policy, reading args.identity ...
  if (!args.identity) return { allowed: false, reason: "Unauthorized" };
  return { allowed: true };
};

const http = httpRouter();

const mcpHandler = httpAction(async (ctx, req) =>
  gateway.handleMcpRequest(ctx, req, { authorize, cors: true, resolveIdentity }),
);
for (const path of ["/mcp/", "/mcp"]) {
  http.route({ path, method: "POST", handler: mcpHandler });
  http.route({ path, method: "GET", handler: mcpHandler });
  http.route({ path, method: "DELETE", handler: mcpHandler });
  http.route({ path, method: "OPTIONS", handler: mcpHandler });
}

// Resource metadata. Note: in bridge mode the `authorization_servers`
// field points at YOUR deployment, not the upstream IdP.
http.route({
  path: "/.well-known/oauth-protected-resource/mcp",
  method: "GET",
  handler: httpAction(async (ctx, req) =>
    gateway.serveProtectedResourceMetadata(ctx, req),
  ),
});
http.route({
  path: "/.well-known/oauth-protected-resource/mcp",
  method: "OPTIONS",
  handler: httpAction(async (ctx, req) =>
    gateway.serveProtectedResourceMetadata(ctx, req),
  ),
});

// AS metadata: wraps the upstream and substitutes our own
// registration_endpoint so DCR requests land at our /oauth/register.
const asHandler = httpAction(async (ctx, req) =>
  gateway.serveAuthorizationServerMetadata(ctx, req, {
    upstreamIssuer: UPSTREAM_ISSUER,
    // See "Pitfalls" below, issuer override matches tokens, NOT spec.
    overrides: { issuer: UPSTREAM_ISSUER },
  }),
);
http.route({ path: "/.well-known/oauth-authorization-server", method: "GET", handler: asHandler });
http.route({ path: "/.well-known/oauth-authorization-server", method: "OPTIONS", handler: asHandler });

// DCR: returns the pre-registered upstream client id, no matter what
// the requester sends. `allowedRedirectPatterns` MUST be set, otherwise
// an attacker can register a malicious redirect URI and steal codes.
const dcrHandler = httpAction(async (ctx, req) =>
  gateway.handleClientRegistration(ctx, req, {
    upstreamClientId: UPSTREAM_CLIENT_ID,
    allowedRedirectPatterns: [
      /^https:\/\/claude\.(ai|com)\//,
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//,
    ],
  }),
);
http.route({ path: "/oauth/register", method: "POST", handler: dcrHandler });
http.route({ path: "/oauth/register", method: "OPTIONS", handler: dcrHandler });

export default http;
```

### 3. Configure the OAuth config

Point `authServerUrl` and `resourceUrl` at your deployment's origin (NOT
the upstream IdP). This makes the protected-resource metadata steer
MCP clients to the bridge instead of straight to the upstream:

```ts
// convex/mcp.ts (in your bootstrap mutation)
await gateway.setOAuthConfig(ctx, {
  authServerUrl: "https://your-deployment.convex.site",
  resourceUrl:   "https://your-deployment.convex.site",
});
```

### 4. Turn on `requireAuth` (all-private servers)

The bridge above exists to serve **browser MCP clients** (claude.ai),
and the `authorize` callback in this guide rejects every anonymous call
(no `public` tools). That combination has a trap: claude.ai only does
`initialize` + `tools/list` when a connector is added, both return
HTTP 200 (an empty filtered list) by default, so claude.ai concludes
"connected, no tools" and **never starts the OAuth flow**. Its only
trigger is a `401` + `WWW-Authenticate`.

Set `requireAuth: true` so anonymous POSTs are challenged with that 401
at the door instead of being let through:

```ts
const mcpHandler = httpAction(async (ctx, req) =>
  gateway.handleMcpRequest(ctx, req, {
    authorize,
    cors: true,
    resolveIdentity,
    requireAuth: true, // all-private + browser client → 401-challenge anonymous
  }),
);
```

This is the single most common reason a freshly-mounted all-private
gateway "connects" in claude.ai but shows no tools and never prompts a
login. See [oauth.md](./oauth.md#all-private-servers-and-browser-clients-requireauth)
for the full rationale and the before/after diagram.

## Adding the connector in claude.ai

claude.ai connectors are configured in the UI, there is no file to
commit, so the "config" is the server URL plus the matching server-side
setup above. Once your deployment is mounted (bridge endpoints + OAuth
config + `requireAuth`), add it as a **Custom Connector**:

1. **Settings → Connectors → Add custom connector** (Pro/Team/Enterprise;
   "Custom Connectors" must be enabled for the workspace).
2. **Name**: anything, e.g. `My Convex App`.
3. **Remote MCP server URL**: your `/mcp` endpoint, e.g.
   `https://your-deployment.convex.site/mcp`. claude.ai strips a
   trailing slash before POSTing, which is why the host mounts both
   `/mcp` and `/mcp/` (see [Trailing-slash](#trailing-slash-url-normalisation)).
4. Save. claude.ai fetches the MCP endpoint, gets a `401 +
   WWW-Authenticate` (thanks to `requireAuth`), then walks the discovery
   chain:
   `/.well-known/oauth-protected-resource/mcp` →
   `/.well-known/oauth-authorization-server` →
   DCR at `/oauth/register` → upstream login.
5. A browser window opens for the upstream IdP login. After consent,
   claude.ai re-runs `initialize` with the Bearer and `tools/list`
   returns the catalog the user is allowed to call.

Checklist if the connector "won't connect":

| Symptom | Likely cause |
|---|---|
| "Connected", no tools, no login prompt | `requireAuth` not set on an all-private server (this guide) |
| Login prompt, then "couldn't connect" | upstream redirect URI missing `https://claude.ai/api/mcp/auth_callback` |
| 404 on MCP traffic, OAuth looked fine | only `/mcp/` mounted, not `/mcp` (trailing slash) |
| Login loops / id_token rejected | issuer mismatch, see [Pitfalls](#issuer-mismatch-with-upstream-token-claims) |

## Pitfalls (debugged the hard way)

### Trailing-slash URL normalisation

claude.ai (and likely others) **strip the trailing slash** from the
configured server URL before they POST, even when the user typed it
explicitly. If you only mount `/mcp/`, Convex's strict-path routing
404s the actual MCP traffic silently. **Always mount both `/mcp` and
`/mcp/`** (the example above does this in a loop).

### Issuer mismatch with upstream token claims

RFC 8414 §2.1 says the `issuer` field in your AS metadata MUST equal
the URL the metadata document was served from. If you follow that
literally, the bridge advertises `issuer: <your origin>`, but tokens
from the upstream carry `iss: <upstream origin>`. Some clients
validate `id_token.iss === metadata.issuer` and reject the OAuth flow
silently.

Workaround: **override `issuer` to the upstream's value**:

```ts
overrides: { issuer: UPSTREAM_ISSUER }
```

Technically a spec violation but no client we've tested
(claude.ai, MCP Inspector) refuses on that.

### Hardcoded client scopes

claude.ai's DCR request always asks for `scope: "openid profile email
groups"`. Stripping `openid` from your advertised `scopes_supported`
doesn't help, claude.ai asks anyway. Don't bother filtering scopes
to "fix" client behaviour; either the upstream issues an id_token or
it doesn't.

### RFC 8707 audience binding is best-effort

MCP 2025-06-18 §6.4 wants tokens audience-bound to the MCP resource
URL. Many IdPs (Pocket-ID 2.x, others) ignore the `resource`
parameter and just set `aud: [client_id]`. Most clients we've tested
accept that, but a strict client would reject it. Resolving this
requires re-signing tokens at the bridge (with our own keys + JWKS),
out of scope for now.

### Pre-registering claude.ai's redirect URI

Pocket-ID (and similar) won't redirect to a URL that isn't in the
client's allowlist. Make sure
`https://claude.ai/api/mcp/auth_callback` (and any other client
callback you support) is in the upstream client's allowed redirect
URIs.

### Browser CORS on upstream endpoints

If a browser MCP client calls the upstream IdP's `userinfo`,
`token`, or `jwks` endpoints directly (some do, some don't), the
upstream must serve CORS for the client's origin. We saw Pocket-ID
return `Access-Control-Allow-Origin: *` on all OIDC endpoints, if
yours doesn't, you may need a CORS proxy on the bridge as well.

## What the bridge does NOT do

- **It does not issue or re-sign tokens.** The upstream remains the
  signing authority. We just intermediate discovery and DCR.
- **It does not store client credentials.** Public-client / PKCE flow
  only. No secrets ever round-trip through the bridge.
- **It does not enforce scopes.** Whatever the upstream grants is
  what reaches your resolveIdentity. Per-tool scope checks belong in
  the `authorize` callback ([recipes](./authorization.md#recipes)).
- **It does not proxy authentication.** Login happens directly between
  the user's browser and the upstream IdP. We never see credentials.

## Verifying the bridge end-to-end

A trace-table debugging pattern that proved invaluable while
integrating Pocket-ID with claude.ai: instrument every bridge route
to persist (method, path, request body, response status+body, headers)
into a Convex table you can query post-hoc. Convex log streaming has
gaps; an in-DB trace is reliable.

Sketch (host-side):

```ts
// convex/trace.ts
export const record = mutation({ args: { ... }, handler: async (ctx, args) => {
  await ctx.db.insert("requestTrace", args);
}});
export const list = query({ args: {}, handler: async (ctx) =>
  ctx.db.query("requestTrace").order("desc").take(80),
});

// convex/http.ts
const trace = (note, inner) => httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const body = request.method === "POST"
    ? await request.clone().text() : "";
  const response = await inner(ctx, /* fresh request */);
  const respBody = await response.clone().text();
  await ctx.runMutation(api.trace.record, {
    method: request.method, path: url.pathname, ...
  });
  return response;
});
```

Then `npx convex run trace:list` dumps the full flow. Diff this
against MCP 2025-06-18 spec when a client misbehaves.
