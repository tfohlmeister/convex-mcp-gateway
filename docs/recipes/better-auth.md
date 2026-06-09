# Recipe: Better Auth (on Convex) as your IdP

[`@convex-dev/better-auth`](https://github.com/get-convex/better-auth) can act as
the OAuth 2.1 / OIDC authorization server for the gateway via Better Auth's `mcp`
plugin. Three things differ from the "validated JWT" default and need handling.

## 1. Access tokens are opaque → use `resolveIdentity`

Better Auth's `mcp` / `oidcProvider` issues **opaque** access tokens (even with
`oidcConfig.useJWTPlugin: true`, which only signs the `id_token`). Convex's
`ctx.auth.getUserIdentity()` can't validate them, so the gateway's default
identity path resolves to `null`.

Resolve identity yourself with `resolveIdentity`, validating the bearer via Better
Auth's `getMcpSession`:

```ts
gateway.handleMcpRequest(ctx, request, {
  authorize,
  tools,
  resolveIdentity: async (token) => {
    const auth = createAuth(ctx)
    const session = await auth.api.getMcpSession({
      headers: new Headers({ Authorization: `Bearer ${token}` }),
    })
    if (!session?.userId) return null
    return {
      subject: String(session.userId),
      claims: { scopes: session.scopes ?? '' },
    }
  },
})
```

Your `authorize` callback then reads `args.identity.subject` (the Better Auth user
id) and applies your app's RBAC.

## 2. Discovery origin (Convex split-domain)

On `@convex-dev/better-auth`, the auth routes serve on the Convex `*.convex.site`
domain while Better Auth's `baseURL` is the frontend origin. Better Auth's `mcp`
plugin advertises authorization-server discovery from `baseURL`
([better-auth#9961](https://github.com/better-auth/better-auth/issues/9961)), so
it points clients at an origin that doesn't serve `/api/auth`. Serve a corrected
`/.well-known/oauth-authorization-server` from your host (issuer + endpoints at
the `.site` origin) and point the gateway's OAuth config at it:

```ts
await gateway.setOAuthConfig(ctx, { authServerUrl: process.env.CONVEX_SITE_URL })
// + host a corrected AS-metadata doc at
//   `${CONVEX_SITE_URL}/.well-known/oauth-authorization-server`
```

Tip: deploy-time hooks (e.g. `convex deploy --preview-run`) don't have
`CONVEX_SITE_URL`; set the OAuth config lazily on the first request instead — it
*is* available inside `httpAction`s.

## 3. Browser login continuation (cross-domain session)

Better Auth's crossDomain plugin stores the session in the frontend's
localStorage, not a cookie. A browser redirect to `/api/auth/mcp/authorize`
therefore carries no session and loops back to the login page. Bridge it:

- Point `mcp({ loginPage })` at an **absolute** URL on the frontend origin.
- On that login page, once signed in, POST the authorize query plus the session
  (the `Better-Auth-Cookie` header `authClient.getCookie()` returns) to a small
  host endpoint that runs authorize **server-side** (where the 302 `Location` is
  readable) and returns the client redirect URL; then `window.location.assign` it.
- Set `requireAuth: true` so browser clients get the 401 challenge that starts the
  OAuth flow.

With these three in place, spec-compliant browser MCP clients (claude.ai, the MCP
Inspector) complete the full OAuth handshake against a Better-Auth-on-Convex IdP.
