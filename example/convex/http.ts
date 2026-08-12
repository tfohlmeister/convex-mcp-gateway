import { httpRouter } from "convex/server";
import {
  McpGateway,
  type McpAuthorizerHandler,
  type McpResourceAuthorizerHandler,
} from "convex-mcp-gateway";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { resources, resourceTemplates, tools } from "./mcp.js";

const gateway = new McpGateway(components.mcpGateway);

/**
 * Authorize callback used by the example host. Public tools opt in via
 * `metadata.public: true`; everything else needs an identity. The
 * `invoices_markPaid` mutation additionally requires the
 * `finance.admin` role to be present in the JWT claims.
 */
export const authorize: McpAuthorizerHandler = async (ctx, args) => {
  const { toolName, toolMetadata, identity: validatorIdentity } = args;
  const meta = (toolMetadata ?? {}) as { public?: boolean };
  if (meta.public) return { allowed: true };

  // Prefer identity already resolved by the gateway (works for both
  // pure-JWT and resolveIdentity/userinfo-bridge modes). Fall back to
  // ctx.auth.getUserIdentity() for backward compat.
  const identity =
    validatorIdentity ?? (await ctx.auth.getUserIdentity().catch(() => null));
  if (!identity) return { allowed: false, reason: "Unauthorized" };

  if (toolName === "invoices_markPaid") {
    const idObj = identity as { claims?: unknown; roles?: unknown };
    const claims = (idObj.claims ?? idObj) as { roles?: unknown };
    const roles = claims.roles;
    const isAdmin = Array.isArray(roles) && roles.includes("finance.admin");
    if (!isAdmin) {
      return {
        allowed: false,
        reason: "Forbidden: finance.admin role required",
      };
    }
  }
  return { allowed: true };
};

/**
 * Per-resource authorization, the resource counterpart of `authorize`.
 * The gateway has already rejected anonymous callers before this runs, so
 * `args.identity` is non-null. Policy:
 * - `resource_list` / `resource_templates_list`: visible to any
 *   authenticated caller.
 * - `resource_read` of `invoices://summary`: any authenticated caller.
 * - `resource_read` of an individual `invoice://{id}` (the expanded URI is
 *   passed as `resourceUri`): requires the `finance.admin` role.
 *
 * Note: list-visibility and read-access are separate decisions. A template
 * read is authorized here on the concrete expanded URI under
 * `resource_read`, not under `resource_templates_list`.
 */
export const authorizeResource: McpResourceAuthorizerHandler = async (
  _ctx,
  args,
) => {
  if (args.mode !== "resource_read") return { allowed: true };
  if (args.resourceUri === "invoices://summary") return { allowed: true };

  const claims = (args.identity.claims ?? {}) as { roles?: unknown };
  const roles = claims.roles;
  if (Array.isArray(roles) && roles.includes("finance.admin")) {
    return { allowed: true };
  }
  return { allowed: false, reason: "Forbidden: finance.admin role required" };
};

const http = httpRouter();

// Test fixture for the userinfo-style resolveIdentity path. Real hosts
// would call the upstream IdP's /userinfo endpoint here; the example
// uses an in-memory map so tests don't need a network. `boom-token`
// triggers a thrown validator so tests can verify the gateway treats
// validator throws as anonymous (warn + null identity) rather than
// 500ing the request.
const resolveIdentity = async (token: string) => {
  if (token === "valid-userinfo-token") {
    return { subject: "validator-resolved-sub" };
  }
  // Like the above, but carries claims so tests can assert the claims
  // half of the resolved caller survives the full HTTP -> inject path.
  if (token === "valid-userinfo-claims-token") {
    return {
      subject: "claims-resolved-sub",
      claims: { email: "claims@example.com" },
    };
  }
  // Carries the finance.admin role so the resource authorizer permits
  // reading an individual `invoice://{id}` (see authorizeResource).
  if (token === "valid-admin-token") {
    return {
      subject: "admin-resolved-sub",
      claims: { roles: ["finance.admin"] },
    };
  }
  if (token === "boom-token") {
    throw new Error("simulated validator failure");
  }
  return null;
};

const mcpHandler = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, {
    authorize,
    cors: true,
    // `cors` decides what a browser may read; `allowedOrigins` decides
    // which origins the gateway serves at all. Any deployment with browser
    // clients should pin the latter. Left off here because this example is
    // driven from CLIs and tests, which send no Origin header:
    // allowedOrigins: ["https://app.example.com"],
    resolveIdentity,
    // Declarative catalog: the registry is reconciled from this list on
    // each initialize, so no separate registerDefaults mutation is
    // needed for the HTTP path.
    tools,
    // MCP resources: a concrete resource plus an RFC 6570 template. Reads
    // run through `authorizeResource` and are recorded in the audit log.
    resources,
    resourceTemplates,
    authorizeResource,
    auditResources: { read: true },
    // Advertise subscription capability. The gateway tracks per-session
    // subscribe/unsubscribe state; this example's transport doesn't push,
    // so a real deployment would deliver notifications/resources/updated
    // over its own channel (see docs/resources.md).
    resourceSubscriptions: { subscribe: true, listChanged: true },
  }),
);
// Mount BOTH /mcp/ and /mcp (no trailing slash). claude.ai (and
// likely other clients) normalise the configured server URL by
// stripping the trailing slash before they POST, even when the user
// typed the slash explicitly. Convex's exact-path routing matches
// /mcp ≠ /mcp/, so a single-route deployment silently 404s those
// calls and the OAuth flow appears to complete but the connector
// "won't connect", debugged the hard way.
for (const path of ["/mcp/", "/mcp"]) {
  http.route({ path, method: "POST", handler: mcpHandler });
  http.route({ path, method: "GET", handler: mcpHandler });
  http.route({ path, method: "DELETE", handler: mcpHandler });
  // CORS preflight for browser MCP clients.
  http.route({ path, method: "OPTIONS", handler: mcpHandler });
}

const discoveryHandler = httpAction(async (ctx, request) =>
  gateway.serveProtectedResourceMetadata(ctx, request),
);
http.route({
  path: "/.well-known/oauth-protected-resource/mcp",
  method: "GET",
  handler: discoveryHandler,
});
http.route({
  path: "/.well-known/oauth-protected-resource/mcp",
  method: "OPTIONS",
  handler: discoveryHandler,
});

// OPT-IN bridge mode: AS metadata + DCR. Hosts whose upstream IdP
// supports DCR can skip these.
http.route({
  path: "/oauth/register",
  method: "POST",
  handler: httpAction(async (ctx, request) =>
    gateway.handleClientRegistration(ctx, request, {
      upstreamClientId: "upstream-client-id-fixed",
      allowedRedirectPatterns: [
        /^https:\/\/claude\.(ai|com)\//,
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//,
      ],
    }),
  ),
});
http.route({
  path: "/oauth/register",
  method: "OPTIONS",
  handler: httpAction(async (ctx, request) =>
    gateway.handleClientRegistration(ctx, request, {
      upstreamClientId: "upstream-client-id-fixed",
      allowedRedirectPatterns: [/^https:\/\/example\.com\//],
    }),
  ),
});
// Mount GET to exercise the handler's internal 405 branch in tests.
// Production hosts would not include this route.
http.route({
  path: "/oauth/register",
  method: "GET",
  handler: httpAction(async (ctx, request) =>
    gateway.handleClientRegistration(ctx, request, {
      upstreamClientId: "upstream-client-id-fixed",
      allowedRedirectPatterns: [/^https:\/\/example\.com\//],
    }),
  ),
});

// AS metadata bridge (RFC 8414). Hosts in bridge mode wrap an
// upstream IdP's openid-configuration document. The example mounts it
// purely to give the test suite a target for
// `serveAuthorizationServerMetadata`; the upstream issuer is unused
// in tests because `globalThis.fetch` is stubbed.
const asMetadataHandler = httpAction(async (ctx, request) =>
  gateway.serveAuthorizationServerMetadata(ctx, request, {
    upstreamIssuer: "https://upstream.example.com",
    // Advertised only when the upstream discovery document explicitly supports
    // CIMD. DCR remains available for legacy clients.
    clientIdMetadataDocuments: true,
  }),
);
http.route({
  path: "/.well-known/oauth-authorization-server",
  method: "GET",
  handler: asMetadataHandler,
});
http.route({
  path: "/.well-known/oauth-authorization-server",
  method: "OPTIONS",
  handler: asMetadataHandler,
});

// Test-only mount with a CORS array allowlist. Lets the test suite
// exercise the `cors: string[]` branch of `McpCorsOption` without
// adding more permissive defaults to the production /mcp/ mount.
const mcpHandlerCorsArray = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, {
    authorize: async () => ({ allowed: true }),
    cors: ["https://allowed.example.com", "https://also-allowed.example.com"],
  }),
);
for (const method of ["POST", "GET", "DELETE", "OPTIONS"] as const) {
  http.route({
    path: "/mcp-cors-array/",
    method,
    handler: mcpHandlerCorsArray,
  });
}

// Test-only mount exercising the requireAuth gate. An all-private
// server like this is unreachable by browser MCP clients (claude.ai)
// without it: the client only does initialize + tools/list, both of
// which would otherwise 200, so it never sees the 401 that triggers
// OAuth. With requireAuth, anonymous POSTs get 401 + WWW-Authenticate.
// Shares resolveIdentity so a Bearer token still authenticates.
const mcpHandlerRequireAuth = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, {
    authorize,
    cors: true,
    requireAuth: true,
    resolveIdentity,
  }),
);
for (const method of ["POST", "GET", "DELETE", "OPTIONS"] as const) {
  http.route({
    path: "/mcp-require-auth/",
    method,
    handler: mcpHandlerRequireAuth,
  });
}

// Test-only mount with an authorize callback that always throws.
// Verifies the gateway's `safeAuthorize` path maps the throw to
// `-32603 INTERNAL_ERROR` with an audit row outcome of `"error"`.
const mcpHandlerThrowingAuthorize = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, {
    authorize: async () => {
      throw new Error("authorize callback boom");
    },
  }),
);
for (const method of ["POST", "GET", "DELETE", "OPTIONS"] as const) {
  http.route({
    path: "/mcp-throws/",
    method,
    handler: mcpHandlerThrowingAuthorize,
  });
}

export default http;
