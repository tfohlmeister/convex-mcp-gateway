import { httpRouter } from "convex/server";
import {
  McpGateway,
  type McpAuthorizerHandler,
  type McpResourceAuthorizerHandler,
} from "convex-mcp-gateway";
import { components, internal } from "./_generated/api.js";
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
    // Multi-round-trip requests (see invoices_archiveAfterConfirmation in
    // mcp.ts). Real deployments must supply ≥32 bytes of private, stable
    // key material from a Convex environment variable
    // (process.env.MCP_MRTR_SECRET); the literal only keeps the example
    // and its test suite self-contained.
    mrtr: { secret: "example-only-mrtr-secret-not-for-production-use" },
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
    // Opt-in MCP Tasks (io.modelcontextprotocol/tasks): tools registered
    // with `taskSupport: true` (invoices_recount) accept task-augmented
    // modern calls. No `execute` is supplied, so the built-in scheduled
    // executor runs the tool once; hosts needing retries, delays, or
    // input_required rounds wire @convex-dev/workflow here instead
    // (see docs/tasks.md).
    tasks: {},
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

// Host-executed MCP tasks demo (the @convex-dev/workflow integration
// shape, without the dependency): `execute` owns durable execution and
// pauses immediately for confirmation; the accepted responses run the
// idempotent internal mutation and complete the task. A real host would
// call `workflowManager.start(...)` in `execute`, resume the run in
// `onInputResponses`, and cancel it in `onCancel` (see docs/tasks.md).
// Both hooks are at-least-once, so everything they do is idempotent:
// the side effect is keyed on the task's idempotency key, and a repeat
// completion lands on a terminal row as a harmless "conflict".
const mcpHandlerHostTasks = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, {
    authorize,
    cors: true,
    resolveIdentity,
    tools,
    tasks: {
      execute: async (ctx, task) => {
        // Only start work the executor actually owns; other task tools
        // in the catalog keep their normal meaning for this host.
        if (task.toolName !== "invoices_bulkMarkPaid") {
          throw new Error(`No host execution wired for ${task.toolName}`);
        }
        // Check the outcome: every non-"updated" answer means the task
        // never entered `input_required`, so nothing would ever ask the
        // owner and nothing would ever run. Throwing here is the contract
        // — the gateway fails the task and returns a clean error — while
        // dropping the value would leave the client polling `working`
        // until the TTL with no trace anywhere.
        const asked = await gateway.requireTaskInput(ctx, task.taskId, {
          confirm: {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: "Mark every open invoice as paid?",
              requestedSchema: {
                type: "object",
                properties: { confirm: { type: "boolean" } },
                required: ["confirm"],
              },
            },
          },
        });
        if (asked !== "updated") {
          throw new Error(
            `requireTaskInput returned "${asked}" for ${task.taskId}`,
          );
        }
      },
      onInputResponses: async (ctx, event) => {
        const task = (await gateway.getTask(ctx, event.taskId)) as {
          idempotencyKey: string;
        } | null;
        if (!task) {
          // The row expired or was pruned between the client's update and
          // this hook. The client already saw its responses accepted, so
          // say plainly that the confirmed work is not going to happen.
          console.error(
            "[example] task row gone before execution; the confirmed bulk " +
              "write was NOT performed",
            event.taskId,
          );
          return;
        }
        const confirm = event.inputResponses.confirm as
          | { action?: string }
          | undefined;
        if (confirm?.action !== "accept") {
          const failed = await gateway.failTask(ctx, event.taskId, {
            code: -32000,
            message: "Confirmation declined",
          });
          if (failed !== "finalized") {
            console.warn(
              "[example] declined confirmation could not be recorded",
              failed,
              event.taskId,
            );
          }
          return;
        }
        const result = await ctx.runMutation(
          internal.invoices.bulkMarkPaidTask,
          { key: task.idempotencyKey },
        );
        // The write has committed by now, so an outcome other than
        // "finalized" means the client will be told something other than
        // what actually happened: "conflict" (the owner cancelled first,
        // or a hook retry already completed it) is benign because the
        // keyed mutation did not double-apply, but "not_found" (row
        // expired in between) and "result_too_large" both mean every
        // invoice is paid while the client sees no result. Log it.
        const completed = await gateway.completeTask(ctx, event.taskId, result);
        if (completed !== "finalized" && completed !== "conflict") {
          console.error(
            "[example] bulk mark-paid committed but the task could not be " +
              "completed; the client will not see this result",
            completed,
            event.taskId,
          );
        }
      },
      onCancel: async () => {
        // Nothing to stop in this example: work only happens inside
        // onInputResponses. A workflow host cancels its run here.
      },
    },
  }),
);
for (const method of ["POST", "GET", "DELETE", "OPTIONS"] as const) {
  http.route({
    path: "/mcp-host-tasks/",
    method,
    handler: mcpHandlerHostTasks,
  });
}

export default http;
