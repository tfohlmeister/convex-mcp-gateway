import type { ComponentApi } from "../component/_generated/component.js";
import {
  buildProtectedResourceMetadataUrl,
  isDeliberateConvexError,
  parseAuthorizerDecision,
  type McpAuthorizerArgs,
  type McpAuthorizerDecision,
  type McpAuthorizerHandler,
  type McpToolRegistration,
} from "../shared.js";

/**
 * Browser-based MCP clients (e.g. anything served from a webapp
 * origin) issue a CORS preflight before each `/mcp/` call. Set this
 * option to enable preflight handling and the matching response
 * headers; non-browser clients (CLIs, server-to-server) work without
 * it.
 *
 * - `true`, permissive: `Access-Control-Allow-Origin: *`,
 *   `Access-Control-Allow-Credentials: false` (the spec forbids
 *   credentials with the wildcard origin). Tokens are passed via
 *   `Authorization: Bearer ...` so this works for OAuth flows.
 * - `string` / `string[]`, exact-match allowlist of origins. The
 *   request's `Origin` header is echoed back if it matches, otherwise
 *   no CORS headers are emitted (the browser then blocks the call).
 * - `(origin: string) => boolean`, custom matcher for things like
 *   subdomain wildcards or per-tenant rules.
 *
 * `Mcp-Session-Id` is automatically exposed via
 * `Access-Control-Expose-Headers` so JS clients can read it after
 * `initialize`.
 *
 * **Production note**: `cors: true` makes response bodies readable
 * from any origin. The gateway carries auth via `Authorization:
 * Bearer ...` (never cookies), so wildcard CORS does not transmit
 * the user's credentials, but a webapp running in the user's
 * browser with the Bearer in its own state can read responses
 * cross-origin. Prefer an explicit allowlist
 * (`cors: ["https://app.example.com"]`) for any deployment with
 * non-trivial auth coupling.
 */
export type McpCorsOption =
  | true
  | string
  | string[]
  | ((origin: string) => boolean);

/**
 * Optional Bearer-token validator for `handleMcpRequest`. When set,
 * the gateway calls this BEFORE `ctx.auth.getUserIdentity()` and uses
 * its return value as the identity for the audit row and as a hint
 * for the authorize callback (via `args.identity`).
 *
 * Useful when the upstream IdP issues opaque access tokens that
 * Convex's local JWT validation can't verify, typical pattern is
 * to call the IdP's userinfo endpoint:
 *
 * ```ts
 * resolveIdentity: async (token) => {
 *   const r = await fetch("https://id.example.com/api/oidc/userinfo", {
 *     headers: { Authorization: `Bearer ${token}` },
 *   });
 *   if (!r.ok) return null;
 *   const u = await r.json();
 *   return { subject: u.sub, claims: u };
 * }
 * ```
 *
 * Returning `null` means "token rejected" (treated identically to
 * "no token at all"). Throwing is treated as null with a warning
 * logged, rejection is not an error condition.
 *
 * When this option is omitted, the gateway falls back to
 * `ctx.auth.getUserIdentity()` (which only handles JWTs validated
 * by your `auth.config.ts`).
 */
export type McpIdentityResolver = (
  token: string,
) => Promise<{ subject: string; claims?: Record<string, unknown> } | null>;

/**
 * MCP resource/content annotations. All fields optional:
 * - `audience`: who the resource is for (`"user"` and/or `"assistant"`).
 * - `priority`: importance from `0` (least) to `1` (most).
 * - `lastModified`: timestamp of the last change, conventionally ISO 8601.
 *   Validated only as a string; the date format is not enforced.
 */
export type McpResourceAnnotations = {
  audience?: ("user" | "assistant")[];
  priority?: number;
  lastModified?: string;
};

export type McpResource = {
  uri: string;
  name: string;
  /** Human-friendly display name; falls back to `name` in clients. */
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: McpResourceAnnotations;
  /** Raw size in bytes, if known. */
  size?: number;
};

export type McpResourceContent = {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
};

export type McpResourceProvider = {
  name: string;
  list: (
    ctx: McpHandlerCtx,
    args: { identity: { subject: string; claims?: Record<string, unknown> } },
  ) => Promise<McpResource[]>;
  read: (
    ctx: McpHandlerCtx,
    args: {
      uri: string;
      identity: { subject: string; claims?: Record<string, unknown> };
    },
  ) => Promise<McpResourceContent[] | null>;
};

/**
 * An RFC 6570 resource template advertised via `resources/templates/list`.
 * `uriTemplate` is a level-1 template (simple `{var}` placeholders, each
 * matching a single URI path segment); clients expand it to a concrete URI
 * and read it through `resources/read`.
 */
export type McpResourceTemplate = {
  uriTemplate: string;
  name: string;
  /** Human-friendly display name; falls back to `name` in clients. */
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: McpResourceAnnotations;
};

/**
 * Server-side read handler for a resource template: invoked when a
 * `resources/read` URI matches the template, with the extracted template
 * variables in `params`. Returns `null` to decline the URI (a later
 * template or a not-found is then used).
 */
export type McpResourceTemplateReadHandler = (
  ctx: McpHandlerCtx,
  args: {
    uri: string;
    params: Record<string, string>;
    identity: { subject: string; claims?: Record<string, unknown> };
  },
) => Promise<McpResourceContent[] | null>;

/**
 * Runtime form of a resource template, as produced by
 * `defineMcpResourceTemplate`. `match` returns the extracted template
 * variables when a concrete URI matches `template.uriTemplate`, or `null`
 * when it doesn't. `read` is optional: present means the gateway resolves
 * expanded-URI reads server-side; absent means the template is
 * listing-only (the client reads the expansion via another provider).
 */
export type McpResourceTemplateProvider = {
  template: McpResourceTemplate;
  match: (uri: string) => Record<string, string> | null;
  read?: McpResourceTemplateReadHandler;
};

export interface McpResourceAuthorizerArgs {
  /**
   * `"resource_list"` when filtering `resources/list`,
   * `"resource_read"` before a `resources/read` handler runs,
   * `"resource_templates_list"` when filtering `resources/templates/list`
   * (here `resourceUri` carries the template's `uriTemplate`).
   *
   * Note on templates: `resources/read` of a template-expanded URI is
   * authorized under `"resource_read"` with the **concrete expanded URI**
   * (e.g. `weather://london/current`), not the `uriTemplate`, and with
   * `resourceMetadata: null`. So a template hidden at list time
   * (`"resource_templates_list"` → denied) is NOT automatically unreadable:
   * `"resource_read"` is the read gate for both concrete and template URIs.
   * Enforce read access in the `resource_read` branch (match the URI shape)
   * and/or inside the template's own `read` handler.
   */
  mode: "resource_list" | "resource_read" | "resource_templates_list";
  resourceUri: string;
  /**
   * Free-form metadata attached to a registered resource. Runtime-only
   * provider resources that are not present in the registry pass `null`.
   */
  resourceMetadata: unknown;
  /**
   * The caller's identity resolved once at the gateway boundary. Resource
   * methods currently require an authenticated caller, so this is non-null
   * when the callback runs.
   */
  identity: { subject: string; claims?: Record<string, unknown> };
}

export type McpResourceAuthorizerHandler = (
  ctx: McpHandlerCtx,
  args: McpResourceAuthorizerArgs,
) => Promise<McpAuthorizerDecision> | McpAuthorizerDecision;

export type McpResourceAuditOption =
  | boolean
  | {
      list?: boolean;
      read?: boolean;
      templatesList?: boolean;
    };

/**
 * Options for `gateway.handleMcpRequest`. The host supplies an
 * `authorize` callback that decides allowed vs denied per
 * `tools/call` and per tool in a filtered `tools/list`. The callback
 * runs in the host's HTTP-action context, so it has the host's
 * `ctx.auth` and can call `ctx.auth.getUserIdentity()` directly.
 */
export interface HandleMcpRequestOptions {
  authorize: McpAuthorizerHandler;
  /** See `McpCorsOption`. Omit for non-browser-only deployments. */
  cors?: McpCorsOption;
  /**
   * See `McpIdentityResolver`. Omit to use Convex's built-in JWT
   * validation via `ctx.auth.getUserIdentity()`.
   */
  resolveIdentity?: McpIdentityResolver;
  /**
   * Override the `serverInfo` returned in the `initialize` response.
   * Defaults to `{ name: "convex-mcp-gateway", version: "0.0.0" }`.
   * Hosts that white-label or want telemetry-grade version reporting
   * can supply their own `{ name, version }` here, the constant
   * baked into this package is intentionally static, because Convex
   * doesn't expose `package.json` to the runtime.
   */
  serverInfo?: { name: string; version: string };
  /**
   * Challenge anonymous requests with `401` instead of letting them
   * through to `initialize` / `tools/list`. Default `false`.
   *
   * Leave this off for **mixed** servers (some tools `public`,
   * some private): anonymous callers should still see the public
   * catalog, so the default 200-with-filtered-list is correct.
   *
   * Turn it on for **all-private** servers that browser MCP clients
   * (claude.ai) connect to. Such a client only does `initialize` +
   * `tools/list` when a connector is added; with the default both
   * return 200 (an empty, authorize-filtered list), so the client
   * concludes "connected, no tools" and never starts the OAuth flow,
   * its only trigger is a `401` + `WWW-Authenticate`. With
   * `requireAuth: true` an anonymous POST gets that 401, so the login
   * is prompted and discovery begins.
   *
   * Needs `setOAuthConfig` to have run so the `WWW-Authenticate`
   * header can carry the protected-resource metadata URL. If
   * `requireAuth` is set but no OAuth config exists, the gate still
   * returns 401, but without the header (and `console.warn`s once);
   * browser clients can't begin discovery until `setOAuthConfig` is
   * called.
   *
   * Applies to `POST` only. `GET` already 405s, `DELETE` is
   * identity-bound, and `OPTIONS` (CORS preflight) is left untouched.
   */
  requireAuth?: boolean;
  /**
   * Declarative tool catalog. When set, the registry is reconciled from
   * this list on `initialize` (change-detected, so an unchanged list is
   * a cheap no-op), and no separate registration mutation is needed.
   * Omit it to manage the registry yourself via `gateway.register(...)`.
   * Annotate an exported list with `McpToolRegistration[]` to avoid a
   * Convex codegen circular-type error (see that type's docs).
   */
  tools?: McpToolRegistration[];
  /**
   * Server-level guidance returned in the MCP `initialize` result's
   * `instructions` field (see the spec's `InitializeResult.instructions`).
   * Clients may hand this to the LLM to explain how to use the server as a
   * whole — e.g. "call `kira_load_skill` before answering" — without bloating
   * individual tool descriptions. Omitted from the response entirely when
   * unset, so the default `initialize` shape is unchanged.
   *
   * Best-effort hint, not a guarantee: the spec says clients MAY add it to
   * the system prompt, and some ignore it entirely. Clients that honor it
   * tend to cap and front-truncate the text, so keep it short and put the
   * critical guidance first. Enforce hard constraints in each tool's
   * `authorize` / handler, never here.
   */
  initializeInstructions?: string;
  /**
   * Optional MCP resources exposed by this gateway. Resources are listed
   * in `initialize.capabilities.resources`, served via `resources/list`,
   * and read via `resources/read`. Resource providers receive the resolved
   * caller identity; anonymous resource requests are rejected.
   */
  resources?: McpResourceProvider[];
  /**
   * Optional MCP resource templates (RFC 6570) exposed by this gateway.
   * Advertised via `resources/templates/list` and, for templates declared
   * with a `read` handler, resolved server-side when `resources/read`
   * requests a URI that matches the template (concrete resources take
   * precedence). Build these with `defineMcpResourceTemplate`.
   */
  resourceTemplates?: McpResourceTemplateProvider[];
  /**
   * Optional central authorization hook for MCP resources. If omitted,
   * authenticated callers can list/read all resources exposed by providers.
   * If set, `resources/list` filters resources through `resource_list`, and
   * `resources/read` checks `resource_read` before invoking the provider.
   */
  authorizeResource?: McpResourceAuthorizerHandler;
  /**
   * Opt-in audit for MCP resource operations. Defaults to `false`.
   * `true` records `resources/list`, `resources/read`, and
   * `resources/templates/list`; the object form (`{ list, read,
   * templatesList }`) enables each operation independently. Resource
   * contents are never stored.
   */
  auditResources?: McpResourceAuditOption;
  /**
   * Opt-in MCP resource subscription support. **Off by default**, because
   * this gateway's HTTP transport is request-scoped and cannot push
   * server-initiated notifications (`notifications/resources/updated` /
   * `notifications/resources/list_changed`). With both flags off,
   * `initialize` advertises neither capability and `resources/subscribe` /
   * `resources/unsubscribe` return a clear `-32601`.
   *
   * Set these flags ONLY when the host fronts the gateway with a transport
   * that CAN deliver notifications (its own SSE/WebSocket layer). The
   * gateway then advertises the capability and tracks subscribe/unsubscribe
   * state per session; the host owns delivery — it reads
   * `gateway.listResourceSubscribers(uri)` and ships payloads built with
   * `gateway.buildResourceUpdatedNotification` /
   * `gateway.buildResourceListChangedNotification`.
   *
   * - `subscribe`: advertise `capabilities.resources.subscribe` and handle
   *   `resources/subscribe` / `resources/unsubscribe`.
   * - `listChanged`: advertise `capabilities.resources.listChanged` (the
   *   host emits `notifications/resources/list_changed` itself when its
   *   catalog changes).
   */
  resourceSubscriptions?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
}

/**
 * Internal handler options: the public `HandleMcpRequestOptions` plus
 * the `syncTools` callback that `McpGateway.handleMcpRequest` derives
 * from the `tools` option and injects. Not exported, hosts never set
 * `syncTools` directly.
 */
type InternalHandleMcpRequestOptions = HandleMcpRequestOptions & {
  syncTools?: () => Promise<void>;
  syncResources?: () => Promise<void>;
  syncResourceTemplates?: () => Promise<void>;
};

export type McpHandlerCtx = {
  runQuery: (ref: any, args: any) => Promise<any>;
  runMutation: (ref: any, args: any) => Promise<any>;
  runAction: (ref: any, args: any) => Promise<any>;
  auth: { getUserIdentity: () => Promise<any> };
};

type HandlerCtx = McpHandlerCtx;

type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
};

type RegisteredTool = {
  name: string;
  description: string;
  kind: "query" | "mutation" | "action";
  functionHandle: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  identityArg?: string;
  protocolMetadata?: {
    title?: string;
    annotations?: unknown;
    _meta?: unknown;
    securitySchemes?: unknown;
  };
  metadata?: unknown;
};

// A row from the resource registry. Narrower than `McpResource`: the
// registry persists only these catalog fields (the richer title/annotations/
// size are runtime-only and never stored), so the row type reflects that.
type RegisteredResource = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  metadata?: unknown;
};

type ResourceCandidate = {
  resource: McpResource;
  metadata: unknown;
};

// A row from the resource-template registry. Unlike concrete resources,
// templates persist their full descriptor (incl. title/annotations).
type RegisteredResourceTemplate = {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: McpResourceAnnotations;
};

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SERVER_NAME = "convex-mcp-gateway";
const SERVER_VERSION = "0.0.0";

const UNAUTHORIZED = -32001;
const FORBIDDEN = -32003;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/**
 * What the MCP client is told when host code threw instead of returning
 * a decision or declining cleanly.
 *
 * The gateway never puts an accidental exception message on the wire:
 * a thrown error can quote a signed URL, an `Authorization` header, a
 * provider response, or a connection string, and the caller is an LLM
 * (often relaying to a third party). `dispatch.runTool` has always done
 * this for tool execution; these constants extend the same rule to the
 * authorize callbacks and the resource paths.
 *
 * The full text is not lost: it goes to the audit row and to the Convex
 * deployment log, both server-side. Hosts that want a specific message
 * to reach the caller throw `ConvexError`, the deliberate channel.
 */
const GENERIC_AUTHORIZER_ERROR = "Authorization check failed";
const GENERIC_RESOURCE_READ_ERROR = "Resource read failed";
const GENERIC_RESOURCE_LIST_ERROR = "Resource listing failed";
const GENERIC_RESOURCE_TEMPLATES_LIST_ERROR =
  "Resource template listing failed";

function resolveCorsOrigin(
  cors: McpCorsOption | undefined,
  requestOrigin: string | null,
): string | null {
  if (cors === undefined) return null;
  if (cors === true) return "*";
  if (!requestOrigin) return null;
  if (typeof cors === "string") {
    return cors === requestOrigin ? requestOrigin : null;
  }
  if (Array.isArray(cors)) {
    return cors.includes(requestOrigin) ? requestOrigin : null;
  }
  return cors(requestOrigin) ? requestOrigin : null;
}

function corsHeaders(
  cors: McpCorsOption | undefined,
  request: Request,
): Record<string, string> {
  const allowOrigin = resolveCorsOrigin(cors, request.headers.get("origin"));
  if (allowOrigin === null) return {};
  const headers: Record<string, string> = {
    "access-control-allow-origin": allowOrigin,
    "access-control-expose-headers": "mcp-session-id",
    vary: "Origin",
  };
  // The wildcard origin forbids credentials per spec; with an exact
  // origin we leave credentials off too because MCP carries auth via
  // Bearer tokens, not cookies.
  return headers;
}

function preflightResponse(
  cors: McpCorsOption | undefined,
  request: Request,
): Response {
  const baseHeaders = corsHeaders(cors, request);
  if (Object.keys(baseHeaders).length === 0) {
    // CORS not configured for this origin, let the browser block it.
    return new Response(null, { status: 204 });
  }
  const requestedHeaders =
    request.headers.get("access-control-request-headers") ??
    "content-type, authorization, mcp-session-id, accept";
  return new Response(null, {
    status: 204,
    headers: {
      ...baseHeaders,
      "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
      "access-control-allow-headers": requestedHeaders,
      "access-control-max-age": "86400",
    },
  });
}

function withCors(
  response: Response,
  cors: McpCorsOption | undefined,
  request: Request,
): Response {
  const extra = corsHeaders(cors, request);
  if (Object.keys(extra).length === 0) return response;
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(extra)) {
    merged.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function clientWantsSse(request: Request): boolean {
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  const sseIdx = accept.indexOf("text/event-stream");
  if (sseIdx === -1) return false;
  const jsonIdx = accept.indexOf("application/json");
  if (jsonIdx === -1) return true;
  // MCP 2025-06-18 requires clients to list BOTH content types. When
  // both are listed, the client signals preference by order: SSE is
  // picked when it appears before application/json. This is a
  // simpler heuristic than full RFC 9110 q-value parsing and lines
  // up with what every real MCP client emits.
  return sseIdx < jsonIdx;
}

function isJsonRpcRequest(message: JsonRpcMessage): boolean {
  return (
    message.method !== undefined &&
    message.id !== undefined &&
    message.id !== null
  );
}

function isJsonRpcNotificationOrResponse(message: JsonRpcMessage): boolean {
  if (
    message.method !== undefined &&
    (message.id === undefined || message.id === null)
  ) {
    return true;
  }
  if (
    message.method === undefined &&
    message.id !== undefined &&
    message.id !== null
  ) {
    return true;
  }
  return false;
}

/**
 * A violation of the gateway's own provider contract: a descriptor or a
 * read result that doesn't match the MCP shape. The message is written
 * here and names only the offending field, never host data, so it is
 * safe to return to the caller (and telling a developer *which* field is
 * wrong is the whole point). It gets its own class so the wire/audit
 * split can tell it apart from an arbitrary host exception.
 */
class ResourceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceContractError";
  }
}

/**
 * Split a thrown error into the text the audit row keeps and the text
 * the MCP client is allowed to see. Mirrors what `dispatch.runTool` does
 * for tool execution: a deliberate `ConvexError` passes through,
 * everything else collapses to `generic`.
 */
function splitErrorText(
  err: unknown,
  generic: string,
): { full: string; wire: string } {
  const full = err instanceof Error ? err.message : String(err);
  const deliberate =
    isDeliberateConvexError(err) || err instanceof ResourceContractError;
  return { full, wire: deliberate ? full : generic };
}

function sseEvent(id: number, payload: string): string {
  return `id: ${id}\nevent: message\ndata: ${payload}\n\n`;
}

function jsonResultEnvelope(id: JsonRpcMessage["id"], value: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result: value });
}

function jsonErrorEnvelope(
  id: JsonRpcMessage["id"],
  code: number,
  message: string,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

let warnedRequireAuthWithoutOAuth = false;

/**
 * Build the `requireAuth` 401 challenge for an anonymous POST. Mirrors
 * the `tools/call` UNAUTHORIZED branch: 401 + `WWW-Authenticate` when
 * an OAuth server is configured (so the client begins RFC 9728
 * discovery), or a bare 401 (plus a one-time warning) when it isn't.
 */
async function requireAuthChallenge(
  ctx: HandlerCtx,
  request: Request,
  component: ComponentApi,
  id: JsonRpcMessage["id"],
): Promise<Response> {
  const reason = "Unauthorized: authentication required";
  const oauthConfig = await ctx.runQuery(component.registry.getOAuthConfig, {});
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (oauthConfig) {
    const requestUrl = new URL(request.url);
    const mcpPath = requestUrl.pathname.replace(/\/+$/, "") || "/";
    const metadataUrl = buildProtectedResourceMetadataUrl(
      requestUrl.origin,
      mcpPath,
    );
    headers["www-authenticate"] = `Bearer resource_metadata="${metadataUrl}"`;
  } else if (!warnedRequireAuthWithoutOAuth) {
    warnedRequireAuthWithoutOAuth = true;
    console.warn(
      "[mcp-gateway] requireAuth is set but no OAuth config exists; " +
        "returning 401 without WWW-Authenticate. Browser clients can't " +
        "begin OAuth discovery until setOAuthConfig is called.",
    );
  }
  return new Response(jsonErrorEnvelope(id, UNAUTHORIZED, reason), {
    status: 401,
    headers,
  });
}

async function safeAuthorize(
  authorize: McpAuthorizerHandler,
  ctx: HandlerCtx,
  args: McpAuthorizerArgs,
): Promise<{ decision: McpAuthorizerDecision; threw: boolean }> {
  try {
    const result = await authorize(ctx, args);
    return { decision: parseAuthorizerDecision(result), threw: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: { allowed: false, reason: `Authorizer threw: ${message}` },
      threw: true,
    };
  }
}

async function safeAuthorizeResource(
  authorizeResource: McpResourceAuthorizerHandler | undefined,
  ctx: HandlerCtx,
  args: McpResourceAuthorizerArgs,
): Promise<{ decision: McpAuthorizerDecision; threw: boolean }> {
  if (!authorizeResource) {
    return { decision: { allowed: true }, threw: false };
  }
  try {
    const result = await authorizeResource(ctx, args);
    return { decision: parseAuthorizerDecision(result), threw: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: {
        allowed: false,
        reason: `Resource authorizer threw: ${message}`,
      },
      threw: true,
    };
  }
}

function dedupeResourceCandidates(
  candidates: ResourceCandidate[],
): ResourceCandidate[] {
  const byUri = new Map<string, ResourceCandidate>();
  for (const candidate of candidates) {
    const existing = byUri.get(candidate.resource.uri);
    byUri.set(candidate.resource.uri, {
      resource: candidate.resource,
      metadata: candidate.metadata ?? existing?.metadata ?? null,
    });
  }
  return Array.from(byUri.values());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate MCP resource/content annotations. Returns a human-readable
 * problem string, or `null` when valid (including when `undefined`).
 * Exported so the `defineMcp*` helpers can fail loud at declaration time
 * with the same rules the request handler enforces on provider output.
 */
export function describeAnnotationsProblem(
  annotations: unknown,
): string | null {
  if (annotations === undefined) return null;
  if (!isPlainObject(annotations)) return "annotations must be an object";
  if (annotations.audience !== undefined) {
    if (
      !Array.isArray(annotations.audience) ||
      !annotations.audience.every((a) => a === "user" || a === "assistant")
    ) {
      return 'annotations.audience must be an array of "user" | "assistant"';
    }
  }
  if (annotations.priority !== undefined) {
    if (
      typeof annotations.priority !== "number" ||
      annotations.priority < 0 ||
      annotations.priority > 1
    ) {
      return "annotations.priority must be a number between 0 and 1";
    }
  }
  if (
    annotations.lastModified !== undefined &&
    typeof annotations.lastModified !== "string"
  ) {
    return "annotations.lastModified must be a string";
  }
  return null;
}

/**
 * Validate an MCP resource descriptor (a `resources/list` entry). Returns a
 * problem string or `null`. `uri` and `name` are required non-empty strings;
 * `title`/`description`/`mimeType` are optional strings; `size` is an
 * optional non-negative number; `annotations` is validated as above.
 */
export function describeResourceProblem(resource: unknown): string | null {
  if (!isPlainObject(resource)) return "resource must be an object";
  if (typeof resource.uri !== "string" || resource.uri.length === 0) {
    return "resource.uri must be a non-empty string";
  }
  if (typeof resource.name !== "string" || resource.name.length === 0) {
    return "resource.name must be a non-empty string";
  }
  for (const field of ["title", "description", "mimeType"] as const) {
    if (resource[field] !== undefined && typeof resource[field] !== "string") {
      return `resource.${field} must be a string`;
    }
  }
  if (
    resource.size !== undefined &&
    (typeof resource.size !== "number" ||
      !Number.isFinite(resource.size) ||
      resource.size < 0)
  ) {
    return "resource.size must be a non-negative number";
  }
  return describeAnnotationsProblem(resource.annotations);
}

/**
 * Validate an MCP resource template descriptor (a `resources/templates/list`
 * entry). Like `describeResourceProblem` but keyed on `uriTemplate` and
 * without `size`.
 */
export function describeResourceTemplateProblem(
  template: unknown,
): string | null {
  if (!isPlainObject(template)) return "resource template must be an object";
  if (
    typeof template.uriTemplate !== "string" ||
    template.uriTemplate.length === 0
  ) {
    return "template.uriTemplate must be a non-empty string";
  }
  if (typeof template.name !== "string" || template.name.length === 0) {
    return "template.name must be a non-empty string";
  }
  for (const field of ["title", "description", "mimeType"] as const) {
    if (template[field] !== undefined && typeof template[field] !== "string") {
      return `template.${field} must be a string`;
    }
  }
  return describeAnnotationsProblem(template.annotations);
}

/**
 * Validate the array a resource read handler returns. Must be an array; each
 * item needs a non-empty string `uri`, optional string `mimeType`, and at
 * least one of `text`/`blob` (each a string when present). Returns a problem
 * string or `null`.
 */
export function describeResourceContentsProblem(
  contents: unknown,
): string | null {
  if (!Array.isArray(contents)) {
    return "resource read result must be an array of content items";
  }
  for (const item of contents) {
    if (!isPlainObject(item)) return "each content item must be an object";
    if (typeof item.uri !== "string" || item.uri.length === 0) {
      return "content.uri must be a non-empty string";
    }
    if (item.mimeType !== undefined && typeof item.mimeType !== "string") {
      return "content.mimeType must be a string";
    }
    if (item.text !== undefined && typeof item.text !== "string") {
      return "content.text must be a string";
    }
    if (item.blob !== undefined && typeof item.blob !== "string") {
      return "content.blob must be a string";
    }
    if (item.text === undefined && item.blob === undefined) {
      return "content item must include text or blob";
    }
  }
  return null;
}

function publicResource(resource: RegisteredResource): McpResource {
  return {
    uri: resource.uri,
    name: resource.name,
    ...(resource.description !== undefined
      ? { description: resource.description }
      : {}),
    ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
  };
}

/**
 * Project an arbitrary resource-shaped object down to exactly the known
 * `McpResource` fields. Applied to every `resources/list` entry before it
 * ships, so a provider's stray/internal keys never leak to the client (the
 * template path does the same via `pickTemplateFields`).
 */
function pickResourceFields(resource: McpResource): McpResource {
  return {
    uri: resource.uri,
    name: resource.name,
    ...(resource.title !== undefined ? { title: resource.title } : {}),
    ...(resource.description !== undefined
      ? { description: resource.description }
      : {}),
    ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
    ...(resource.annotations !== undefined
      ? { annotations: resource.annotations }
      : {}),
    ...(resource.size !== undefined ? { size: resource.size } : {}),
  };
}

/**
 * Project an arbitrary template-shaped object down to exactly the known
 * `McpResourceTemplate` fields. Shared by the request handler (response
 * shaping), `defineMcpResourceTemplate`, and the registry-sync projection so
 * the three never drift, and so a hand-built provider's extra keys never
 * reach the response or the registry's strict validator.
 */
export function pickTemplateFields(
  template: McpResourceTemplate,
): McpResourceTemplate {
  return {
    uriTemplate: template.uriTemplate,
    name: template.name,
    ...(template.title !== undefined ? { title: template.title } : {}),
    ...(template.description !== undefined
      ? { description: template.description }
      : {}),
    ...(template.mimeType !== undefined ? { mimeType: template.mimeType } : {}),
    ...(template.annotations !== undefined
      ? { annotations: template.annotations }
      : {}),
  };
}

function registeredResourceCandidate(
  resource: RegisteredResource,
): ResourceCandidate {
  return {
    resource: publicResource(resource),
    metadata: resource.metadata ?? null,
  };
}

function shouldAuditResource(
  auditResources: McpResourceAuditOption | undefined,
  operation: "list" | "read" | "templatesList",
): boolean {
  if (auditResources === true) return true;
  if (!auditResources) return false;
  return auditResources[operation] === true;
}

async function safeRecordResourceAudit(
  ctx: HandlerCtx,
  component: ComponentApi,
  entry: {
    resourceUri?: string;
    resourceOperation: "list" | "read" | "templates_list";
    args: unknown;
    outcome: "allowed" | "denied" | "error";
    identitySubject: string | null;
    durationMs: number;
    errorCode?: number;
    errorMessage?: string;
  },
): Promise<void> {
  try {
    await ctx.runMutation(component.audit.recordResourceEntry, entry);
  } catch (err) {
    console.error(
      "[mcp-gateway] failed to record resource audit entry",
      entry.resourceOperation,
      entry.resourceUri ?? "(none)",
      entry.outcome,
      err,
    );
  }
}

export async function handleMcpRequest(
  ctx: HandlerCtx,
  request: Request,
  component: ComponentApi,
  options: InternalHandleMcpRequestOptions,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return preflightResponse(options.cors, request);
  }
  let response: Response;
  switch (request.method) {
    case "POST":
      response = await handlePost(ctx, request, component, options);
      break;
    case "GET":
      response = new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST, DELETE, OPTIONS" },
      });
      break;
    case "DELETE":
      response = await handleDelete(ctx, request, component, options);
      break;
    default:
      response = new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST, DELETE, OPTIONS" },
      });
  }
  return withCors(response, options.cors, request);
}

/**
 * Resolve the caller's identity for a request. Used at three points:
 *   - `tools/list` and `tools/call`: identity drives audit + authorize
 *   - `initialize`: identity binds to the session row so DELETE later
 *     verifies teardown is authorised
 *   - `DELETE`: identity matches what was bound at create time
 *
 * Resolution order:
 *   1. `options.resolveIdentity` if configured AND a Bearer is present
 *   2. Convex's `ctx.auth.getUserIdentity()` (validates against
 *      `auth.config.ts`); `iss/aud` mismatches downgrade to null
 *      rather than 500 the request.
 */
async function resolveCallerIdentity(
  ctx: HandlerCtx,
  request: Request,
  options: HandleMcpRequestOptions,
): Promise<{ subject: string; claims?: Record<string, unknown> } | null> {
  if (options.resolveIdentity) {
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7)
      : null;
    if (token) {
      try {
        return await options.resolveIdentity(token);
      } catch (err) {
        console.warn(
          `[mcp-gateway] resolveIdentity threw; treating as anonymous. ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
        return null;
      }
    }
    return null;
  }
  try {
    const raw = (await ctx.auth.getUserIdentity()) as
      | { subject?: string; [k: string]: unknown }
      | null
      | undefined;
    if (raw && typeof raw.subject === "string") {
      return { subject: raw.subject, claims: raw };
    }
  } catch (err) {
    console.warn(
      `[mcp-gateway] ctx.auth.getUserIdentity() threw; treating as anonymous. ` +
        `Likely a Bearer token whose iss/aud doesn't match auth.config.ts. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return null;
}

async function handleDelete(
  ctx: HandlerCtx,
  request: Request,
  component: ComponentApi,
  options: HandleMcpRequestOptions,
): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) {
    return new Response("Missing Mcp-Session-Id header", { status: 400 });
  }
  // Identity-bound DELETE: the session row remembers the subject that
  // initialised it. Teardown must come from the same subject (or both
  // sides anonymous), otherwise a leaked session-id alone is enough
  // to DoS an authenticated user's session.
  const identity = await resolveCallerIdentity(ctx, request, options);
  const result = await ctx.runMutation(component.sessions.deleteSession, {
    sessionId,
    callerIdentitySubject: identity?.subject ?? null,
  });
  if (result === "deleted") return new Response(null, { status: 200 });
  if (result === "not_found") return new Response(null, { status: 404 });
  return new Response(
    "Forbidden: caller identity does not match session owner",
    { status: 403 },
  );
}

async function handlePost(
  ctx: HandlerCtx,
  request: Request,
  component: ComponentApi,
  options: InternalHandleMcpRequestOptions,
): Promise<Response> {
  // MCP 2025-06-18 §"Sending Messages to the Server": clients MUST set
  // Accept to list both application/json and text/event-stream. Enforcing
  // this surfaces interop bugs early instead of silently degrading to
  // JSON-only.
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  if (
    !accept.includes("application/json") ||
    !accept.includes("text/event-stream")
  ) {
    return new Response(
      "Not Acceptable: Accept header must list both application/json and text/event-stream",
      { status: 406 },
    );
  }

  let message: JsonRpcMessage | JsonRpcMessage[];
  try {
    message = (await request.json()) as JsonRpcMessage | JsonRpcMessage[];
  } catch {
    // Per MCP §"Sending Messages": server SHOULD return an HTTP error
    // status when it cannot accept the input. JSON-RPC body retained
    // for clients that read it.
    return new Response(jsonErrorEnvelope(null, -32700, "Parse error"), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // MCP forbids batched requests over Streamable HTTP. Clearer error
  // than the previous "missing method or id" fall-through.
  if (Array.isArray(message)) {
    return new Response(
      jsonErrorEnvelope(
        null,
        -32600,
        "Batched JSON-RPC requests are not supported in MCP Streamable HTTP",
      ),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // Resolve identity once at the boundary and reuse it everywhere below
  // (the requireAuth gate, stale-session cleanup, audit subject, the
  // authorize callback input, and the session-binding subject). One
  // resolution avoids a duplicate resolveIdentity/userinfo round-trip.
  const identity = await resolveCallerIdentity(ctx, request, options);
  const auditIdentitySubject = identity?.subject ?? null;

  // requireAuth gate: challenge anonymous POSTs with 401 before session
  // handling / the method switch, so browser MCP clients (claude.ai)
  // get the 401 + WWW-Authenticate they need to begin OAuth discovery
  // instead of a 200 empty tools/list. Opt-in; default behaviour
  // (200 with the filtered catalog) is unchanged. See
  // HandleMcpRequestOptions.requireAuth.
  if (options.requireAuth && identity === null) {
    return await requireAuthChallenge(ctx, request, component, message.id);
  }

  const isInitialize = message.method === "initialize";

  // MCP-Protocol-Version header: required on post-initialize requests
  // by spec. Missing → silently default to 2025-03-26 (legacy clients).
  // Unsupported value → MUST 400 per spec.
  if (!isInitialize) {
    const protoHeader = request.headers.get("mcp-protocol-version");
    if (
      protoHeader !== null &&
      !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protoHeader)
    ) {
      return new Response(
        `Unsupported MCP-Protocol-Version: ${protoHeader}. ` +
          `Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
        { status: 400 },
      );
    }
  }

  // Session validation. Initialize creates a fresh session. All other
  // requests must carry a valid Mcp-Session-Id; missing is 400, unknown
  // is 404 (per MCP 2025-06-18 §Session Management).
  let sessionId: string;
  let issueSessionHeader = false;
  // The identity bound to the session at create time (undefined for the
  // initialize path and for legacy pre-binding rows). Used to identity-bind
  // session-scoped mutations like resources/subscribe.
  let sessionOwnerSubject: string | null | undefined;

  if (isInitialize) {
    sessionId = generateSessionId();
    issueSessionHeader = true;
    // Best-effort: if the caller `initialize`s while carrying an old
    // session id (buggy client reconnecting without DELETE first),
    // drop the old row so the sessions table doesn't grow unbounded.
    // The deleteSession mutation enforces the identity check, so a
    // mismatched subject (e.g. an attacker who learned someone
    // else's id and tries to re-initialize) cannot evict the
    // original session, only the legitimate owner can.
    const staleSessionId = request.headers.get("mcp-session-id");
    if (staleSessionId) {
      try {
        await ctx.runMutation(component.sessions.deleteSession, {
          sessionId: staleSessionId,
          callerIdentitySubject: identity?.subject ?? null,
        });
      } catch (err) {
        console.warn(
          "[mcp-gateway] failed to clean up stale session on re-initialize",
          err,
        );
      }
    }
  } else {
    const headerSessionId = request.headers.get("mcp-session-id");
    if (!headerSessionId) {
      return new Response("Missing Mcp-Session-Id header", { status: 400 });
    }
    const session = await ctx.runQuery(component.sessions.getSession, {
      sessionId: headerSessionId,
    });
    if (!session) {
      return new Response("Unknown or terminated session", { status: 404 });
    }
    sessionId = headerSessionId;
    sessionOwnerSubject = session.identitySubject;
    try {
      await ctx.runMutation(component.sessions.touchSession, {
        sessionId: headerSessionId,
      });
    } catch (err) {
      // Touch is best-effort; a stuck lastSeenAt only matters for the
      // session pruner, not for the current request. Log so a
      // systematic failure (schema drift, recurring conflict) is
      // discoverable in the deployment log.
      console.warn(
        "[mcp-gateway] touchSession failed (best-effort)",
        headerSessionId,
        err,
      );
    }
  }

  // Notifications / responses: 202 Accepted, no body.
  if (isJsonRpcNotificationOrResponse(message)) {
    const headers: Record<string, string> = {};
    if (issueSessionHeader) headers["mcp-session-id"] = sessionId;
    return new Response(null, { status: 202, headers });
  }

  if (!isJsonRpcRequest(message)) {
    return new Response(
      jsonErrorEnvelope(null, -32600, "Invalid Request: missing method or id"),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  let body: string = jsonErrorEnvelope(
    message.id,
    INTERNAL_ERROR,
    "Handler did not produce a response",
  );
  let raw: Response | null = null;

  switch (message.method) {
    case "initialize": {
      // Lazily reconcile the registry from the host's declarative `tools`
      // option (if provided). Runs on initialize, which is when a client
      // connects, so a tool-list change in the host's code takes effect
      // on the next connect without a manual registration mutation. The
      // sync is change-detected, so an unchanged list is a cheap no-op.
      // A failure here (e.g. a duplicate tool name) should fail the
      // connection loudly, but log first: it's the only fallible step in
      // this handler whose cause would otherwise be invisible.
      if (options.syncTools) {
        try {
          await options.syncTools();
        } catch (err) {
          console.error(
            "[mcp-gateway] declarative tool sync failed during initialize; " +
              "the connection will fail. Check the `tools` list passed to " +
              "handleMcpRequest (e.g. duplicate tool names).",
            err,
          );
          throw err;
        }
      }
      if (options.syncResources) {
        try {
          await options.syncResources();
        } catch (err) {
          console.error(
            "[mcp-gateway] declarative resource sync failed during initialize; " +
              "the connection will fail. Check the static resources passed to " +
              "handleMcpRequest (e.g. duplicate resource URIs).",
            err,
          );
          throw err;
        }
      }
      if (options.syncResourceTemplates) {
        try {
          await options.syncResourceTemplates();
        } catch (err) {
          console.error(
            "[mcp-gateway] declarative resource-template sync failed during " +
              "initialize; the connection will fail. Check the resourceTemplates " +
              "passed to handleMcpRequest (e.g. duplicate uriTemplates).",
            err,
          );
          throw err;
        }
      }
      const registeredResources = (await ctx.runQuery(
        component.registry.listResources,
        {},
      )) as RegisteredResource[];
      const registeredTemplates = (await ctx.runQuery(
        component.registry.listResourceTemplates,
        {},
      )) as RegisteredResourceTemplate[];
      const requested = message.params?.protocolVersion;
      const negotiated =
        typeof requested === "string" &&
        (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION;
      await ctx.runMutation(component.sessions.createSession, {
        sessionId,
        protocolVersion: negotiated,
        identitySubject: auditIdentitySubject,
      });
      // Advertise the resources capability when any resource feature is
      // configured. The subscribe/listChanged flags are added only when the
      // host opts in (and thus has a transport that can deliver); otherwise
      // the capability stays `{}` — the historical, accurate default.
      const advertiseResources =
        registeredResources.length > 0 ||
        registeredTemplates.length > 0 ||
        (options.resources ?? []).length > 0 ||
        (options.resourceTemplates ?? []).length > 0 ||
        Boolean(options.resourceSubscriptions?.subscribe) ||
        Boolean(options.resourceSubscriptions?.listChanged);
      body = jsonResultEnvelope(message.id, {
        protocolVersion: negotiated,
        serverInfo: options.serverInfo ?? {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
        ...(options.initializeInstructions
          ? { instructions: options.initializeInstructions }
          : {}),
        capabilities: {
          tools: {},
          ...(advertiseResources
            ? {
                resources: {
                  ...(options.resourceSubscriptions?.subscribe
                    ? { subscribe: true }
                    : {}),
                  ...(options.resourceSubscriptions?.listChanged
                    ? { listChanged: true }
                    : {}),
                },
              }
            : {}),
        },
      });
      break;
    }

    case "resources/list": {
      const start = Date.now();
      const providers = options.resources ?? [];
      const templates = options.resourceTemplates ?? [];
      const registeredResources = (await ctx.runQuery(
        component.registry.listResources,
        {},
      )) as RegisteredResource[];
      if (
        providers.length === 0 &&
        registeredResources.length === 0 &&
        templates.length === 0
      ) {
        body = jsonErrorEnvelope(
          message.id,
          -32601,
          `Unsupported method: ${message.method}`,
        );
        break;
      }
      if (!identity) {
        // Intentionally NOT audited on the anonymous deny path. An
        // unauthenticated caller can `initialize` once then spam resource
        // requests with no Bearer; auditing the denials would let them grow
        // the audit table without bound (and `resources/read` carries a
        // caller-controlled `uri`). Mirrors the unknown-tool path in
        // dispatch.ts — only authenticated outcomes are audited.
        body = jsonErrorEnvelope(
          message.id,
          UNAUTHORIZED,
          "Unauthorized: authentication required",
        );
        break;
      }
      try {
        // Isolate each provider: a single provider that throws must not
        // collapse the whole catalog. Mirrors the per-item isolation
        // tools/list uses for authorizer throws — a buggy provider hides
        // only its own resources, the healthy providers still list.
        const providerResources = (
          await Promise.all(
            providers.map(async (provider) => {
              try {
                return await provider.list(ctx, { identity });
              } catch (err) {
                console.error(
                  "[mcp-gateway] resource provider threw during resources/list",
                  provider.name,
                  err,
                );
                return [];
              }
            }),
          )
        ).flat();
        // Validate provider output before it reaches the client. A
        // structurally invalid descriptor is a provider bug, so fail the
        // whole list loudly with a deterministic -32603 (caught below)
        // rather than ship malformed JSON-RPC.
        for (const resource of providerResources) {
          const problem = describeResourceProblem(resource);
          if (problem) {
            throw new ResourceContractError(
              `resources/list provider returned an invalid resource: ${problem}`,
            );
          }
        }
        const metadataByUri = new Map(
          registeredResources.map((resource) => [
            resource.uri,
            resource.metadata ?? null,
          ]),
        );
        const candidates = dedupeResourceCandidates([
          ...registeredResources.map(registeredResourceCandidate),
          ...providerResources.map((resource) => ({
            resource,
            metadata: metadataByUri.get(resource.uri) ?? null,
          })),
        ]);
        const resources = [];
        for (const candidate of candidates) {
          const { decision, threw } = await safeAuthorizeResource(
            options.authorizeResource,
            ctx,
            {
              mode: "resource_list",
              resourceUri: candidate.resource.uri,
              resourceMetadata: candidate.metadata,
              identity,
            },
          );
          if (threw) {
            console.error(
              "[mcp-gateway] resource authorizer threw during resources/list for resource",
              candidate.resource.uri,
              decision.reason,
            );
          }
          if (decision.allowed) {
            resources.push(pickResourceFields(candidate.resource));
          }
        }
        if (shouldAuditResource(options.auditResources, "list")) {
          await safeRecordResourceAudit(ctx, component, {
            resourceOperation: "list",
            args: { resourceCount: resources.length },
            outcome: "allowed",
            identitySubject: auditIdentitySubject,
            durationMs: Date.now() - start,
          });
        }
        body = jsonResultEnvelope(message.id, { resources });
      } catch (err) {
        const { full, wire } = splitErrorText(err, GENERIC_RESOURCE_LIST_ERROR);
        console.error("[mcp-gateway] resources/list failed", err);
        if (shouldAuditResource(options.auditResources, "list")) {
          await safeRecordResourceAudit(ctx, component, {
            resourceOperation: "list",
            args: null,
            outcome: "error",
            identitySubject: auditIdentitySubject,
            durationMs: Date.now() - start,
            errorCode: INTERNAL_ERROR,
            errorMessage: full,
          });
        }
        body = jsonErrorEnvelope(message.id, INTERNAL_ERROR, wire);
      }
      break;
    }

    case "resources/templates/list": {
      const start = Date.now();
      const providers = options.resourceTemplates ?? [];
      const registeredTemplates = (await ctx.runQuery(
        component.registry.listResourceTemplates,
        {},
      )) as RegisteredResourceTemplate[];
      // Distinct capability surface: unsupported only when NO templates are
      // configured at all (no runtime providers and none registered). A
      // registry-only template catalog is fully supported.
      if (providers.length === 0 && registeredTemplates.length === 0) {
        body = jsonErrorEnvelope(
          message.id,
          -32601,
          `Unsupported method: ${message.method}`,
        );
        break;
      }
      if (!identity) {
        // Not audited on the anonymous deny path — see the resources/list
        // rationale: anonymous spam must never grow the audit table.
        body = jsonErrorEnvelope(
          message.id,
          UNAUTHORIZED,
          "Unauthorized: authentication required",
        );
        break;
      }
      try {
        // Merge registered templates with runtime providers, deduped by
        // uriTemplate; a runtime provider wins (it's live and carries the
        // read handler), mirroring how resources/list prefers providers.
        const byUriTemplate = new Map<string, McpResourceTemplate>();
        for (const row of registeredTemplates) {
          byUriTemplate.set(row.uriTemplate, row);
        }
        for (const provider of providers) {
          byUriTemplate.set(provider.template.uriTemplate, provider.template);
        }
        const resourceTemplates = [];
        for (const template of byUriTemplate.values()) {
          const problem = describeResourceTemplateProblem(template);
          if (problem) {
            throw new ResourceContractError(
              `resources/templates/list provider returned an invalid template: ${problem}`,
            );
          }
          const { decision, threw } = await safeAuthorizeResource(
            options.authorizeResource,
            ctx,
            {
              mode: "resource_templates_list",
              resourceUri: template.uriTemplate,
              resourceMetadata: null,
              identity,
            },
          );
          if (threw) {
            console.error(
              "[mcp-gateway] resource authorizer threw during resources/templates/list for template",
              template.uriTemplate,
              decision.reason,
            );
          }
          if (decision.allowed) {
            resourceTemplates.push(pickTemplateFields(template));
          }
        }
        if (shouldAuditResource(options.auditResources, "templatesList")) {
          await safeRecordResourceAudit(ctx, component, {
            resourceOperation: "templates_list",
            args: { resourceTemplateCount: resourceTemplates.length },
            outcome: "allowed",
            identitySubject: auditIdentitySubject,
            durationMs: Date.now() - start,
          });
        }
        body = jsonResultEnvelope(message.id, { resourceTemplates });
      } catch (err) {
        const { full, wire } = splitErrorText(
          err,
          GENERIC_RESOURCE_TEMPLATES_LIST_ERROR,
        );
        console.error("[mcp-gateway] resources/templates/list failed", err);
        if (shouldAuditResource(options.auditResources, "templatesList")) {
          await safeRecordResourceAudit(ctx, component, {
            resourceOperation: "templates_list",
            args: null,
            outcome: "error",
            identitySubject: auditIdentitySubject,
            durationMs: Date.now() - start,
            errorCode: INTERNAL_ERROR,
            errorMessage: full,
          });
        }
        body = jsonErrorEnvelope(message.id, INTERNAL_ERROR, wire);
      }
      break;
    }

    case "resources/read": {
      const start = Date.now();
      const providers = options.resources ?? [];
      const templates = options.resourceTemplates ?? [];
      const registeredResources = (await ctx.runQuery(
        component.registry.listResources,
        {},
      )) as RegisteredResource[];
      if (
        providers.length === 0 &&
        registeredResources.length === 0 &&
        templates.length === 0
      ) {
        body = jsonErrorEnvelope(
          message.id,
          -32601,
          `Unsupported method: ${message.method}`,
        );
        break;
      }
      if (!identity) {
        // Not audited on the anonymous deny path — see the resources/list
        // rationale. This matters most here: the denied `read` carries a
        // caller-controlled `uri`, so auditing would let an unauthenticated
        // client grow the table with arbitrary large URIs after one
        // `initialize`.
        body = jsonErrorEnvelope(
          message.id,
          UNAUTHORIZED,
          "Unauthorized: authentication required",
        );
        break;
      }
      const uri = message.params?.uri;
      if (typeof uri !== "string" || uri.length === 0) {
        if (shouldAuditResource(options.auditResources, "read")) {
          await safeRecordResourceAudit(ctx, component, {
            resourceOperation: "read",
            args: null,
            outcome: "error",
            identitySubject: auditIdentitySubject,
            durationMs: Date.now() - start,
            errorCode: INVALID_PARAMS,
            errorMessage: "Missing resource uri",
          });
        }
        body = jsonErrorEnvelope(
          message.id,
          INVALID_PARAMS,
          "Missing resource uri",
        );
        break;
      }
      const metadata =
        registeredResources.find((resource) => resource.uri === uri)
          ?.metadata ?? null;
      const resourceAuthz = await safeAuthorizeResource(
        options.authorizeResource,
        ctx,
        {
          mode: "resource_read",
          resourceUri: uri,
          resourceMetadata: metadata,
          identity,
        },
      );
      if (!resourceAuthz.decision.allowed) {
        const reason = resourceAuthz.decision.reason ?? "Forbidden";
        const code = resourceAuthz.threw
          ? INTERNAL_ERROR
          : /^unauth/i.test(reason)
            ? UNAUTHORIZED
            : FORBIDDEN;
        if (shouldAuditResource(options.auditResources, "read")) {
          await safeRecordResourceAudit(ctx, component, {
            resourceUri: uri,
            resourceOperation: "read",
            args: null,
            outcome: resourceAuthz.threw ? "error" : "denied",
            identitySubject: auditIdentitySubject,
            durationMs: Date.now() - start,
            errorCode: code,
            errorMessage: reason,
          });
        }
        // Same split as the `tools/call` denial: a returned reason is
        // host-authored and goes to the caller, a thrown one carries
        // exception text and stays in the audit row above.
        body = jsonErrorEnvelope(
          message.id,
          code,
          resourceAuthz.threw ? GENERIC_AUTHORIZER_ERROR : reason,
        );
        break;
      }
      try {
        let found = false;
        // Track a provider throw so a buggy provider can't mask a resource
        // a later provider could serve. Providers decline a URI by returning
        // null; a throw must not be *more* powerful than declining, so we
        // isolate it, log it, and keep trying the remaining providers (then
        // the templates).
        //
        // Two texts per throw: `full` for the audit row, `wire` for the
        // caller. They differ unless the provider threw ConvexError on
        // purpose, so an accidental exception can't ship a signed URL or
        // an upstream response body to the LLM.
        let providerError: { full: string; wire: string } | null = null;
        const serveContents = async (contents: McpResourceContent[]) => {
          // Validate handler output before returning it. Invalid contents
          // are a provider bug; throw so the outer catch turns it into a
          // deterministic -32603 instead of shipping malformed JSON-RPC.
          // (Runs outside the per-provider try, so it is a hard error, not a
          // provider-decline that falls through to the next provider.)
          const problem = describeResourceContentsProblem(contents);
          if (problem) {
            throw new ResourceContractError(
              `resources/read provider returned invalid contents: ${problem}`,
            );
          }
          if (shouldAuditResource(options.auditResources, "read")) {
            await safeRecordResourceAudit(ctx, component, {
              resourceUri: uri,
              resourceOperation: "read",
              args: null,
              outcome: "allowed",
              identitySubject: auditIdentitySubject,
              durationMs: Date.now() - start,
            });
          }
          body = jsonResultEnvelope(message.id, { contents });
          found = true;
        };

        // Concrete providers first: a concrete resource always wins over a
        // template that might also match the same URI, so dispatch stays
        // unambiguous.
        for (const provider of providers) {
          let contents: McpResourceContent[] | null;
          try {
            contents = await provider.read(ctx, { uri, identity });
          } catch (err) {
            providerError = splitErrorText(err, GENERIC_RESOURCE_READ_ERROR);
            console.error(
              "[mcp-gateway] resource provider threw during resources/read",
              provider.name,
              uri,
              err,
            );
            continue;
          }
          // A provider declines a URI by returning null OR an empty array;
          // declining via `[]` keeps it from shipping empty contents and
          // shadowing a later provider/template. Anything else (including a
          // malformed non-array) still goes to serveContents, which validates
          // it and surfaces -32603 on a bad shape.
          if (contents && !(Array.isArray(contents) && contents.length === 0)) {
            await serveContents(contents);
            break;
          }
        }

        // Template-backed resolution, only when no concrete provider served.
        // A template with no `read` handler is listing-only and skipped here.
        if (!found) {
          for (const provider of templates) {
            if (!provider.read) continue;
            const params = provider.match(uri);
            if (!params) continue;
            let contents: McpResourceContent[] | null;
            try {
              contents = await provider.read(ctx, { uri, params, identity });
            } catch (err) {
              providerError = splitErrorText(err, GENERIC_RESOURCE_READ_ERROR);
              console.error(
                "[mcp-gateway] resource template threw during resources/read",
                provider.template.uriTemplate,
                uri,
                err,
              );
              continue;
            }
            if (
              contents &&
              !(Array.isArray(contents) && contents.length === 0)
            ) {
              await serveContents(contents);
              break;
            }
          }
        }

        if (!found) {
          // Distinguish "everything cleanly declined" (a genuine not-found →
          // INVALID_PARAMS) from "a provider/template threw and nothing
          // served" (a real fault → INTERNAL_ERROR), so a bug isn't reported
          // to the client as a benign miss.
          const code = providerError ? INTERNAL_ERROR : INVALID_PARAMS;
          // "Resource not found" is gateway-authored and safe either way;
          // a provider throw splits into audit text and caller text.
          const notFound = `Resource not found: ${uri}`;
          if (shouldAuditResource(options.auditResources, "read")) {
            await safeRecordResourceAudit(ctx, component, {
              resourceUri: uri,
              resourceOperation: "read",
              args: null,
              outcome: "error",
              identitySubject: auditIdentitySubject,
              durationMs: Date.now() - start,
              errorCode: code,
              errorMessage: providerError?.full ?? notFound,
            });
          }
          body = jsonErrorEnvelope(
            message.id,
            code,
            providerError?.wire ?? notFound,
          );
        }
      } catch (err) {
        // Hard faults: invalid provider contents, a throwing audit path,
        // anything the per-provider isolation above didn't catch. The
        // caller gets a generic message, so log the cause here too, the
        // audit row alone would make this hard to trace.
        const { full, wire } = splitErrorText(err, GENERIC_RESOURCE_READ_ERROR);
        console.error("[mcp-gateway] resources/read failed", uri, err);
        if (shouldAuditResource(options.auditResources, "read")) {
          await safeRecordResourceAudit(ctx, component, {
            resourceUri: uri,
            resourceOperation: "read",
            args: null,
            outcome: "error",
            identitySubject: auditIdentitySubject,
            durationMs: Date.now() - start,
            errorCode: INTERNAL_ERROR,
            errorMessage: full,
          });
        }
        body = jsonErrorEnvelope(message.id, INTERNAL_ERROR, wire);
      }
      break;
    }

    case "resources/subscribe":
    case "resources/unsubscribe": {
      // Off by default: the gateway's HTTP transport can't push, so the
      // capability is unadvertised and these methods report a clear,
      // descriptive -32601 rather than silently accepting a subscription
      // that could never be delivered.
      if (!options.resourceSubscriptions?.subscribe) {
        body = jsonErrorEnvelope(
          message.id,
          -32601,
          `${message.method} is not supported: this gateway does not ` +
            `advertise the resources.subscribe capability (its HTTP ` +
            `transport cannot deliver server-initiated notifications). ` +
            `Enable resourceSubscriptions.subscribe only behind a ` +
            `push-capable transport.`,
        );
        break;
      }
      // Subscriptions are identity-scoped, like list/read. (Read-time
      // authorization still governs content: the `updated` notification
      // carries only a URI, and `resources/read` re-checks `resource_read`.)
      if (!identity) {
        body = jsonErrorEnvelope(
          message.id,
          UNAUTHORIZED,
          "Unauthorized: authentication required",
        );
        break;
      }
      // Identity-bound, like DELETE: only the session's owner may mutate its
      // subscription state. Without this, a leaked Mcp-Session-Id plus any
      // valid token would let one user grief another's subscriptions (cap
      // exhaustion, spurious update pushes). Legacy rows with no bound owner
      // (`undefined`) skip the check, matching `deleteSession`.
      if (
        sessionOwnerSubject !== undefined &&
        sessionOwnerSubject !== identity.subject
      ) {
        body = jsonErrorEnvelope(
          message.id,
          FORBIDDEN,
          "Forbidden: caller identity does not match session owner",
        );
        break;
      }
      const uri = message.params?.uri;
      if (typeof uri !== "string" || uri.length === 0) {
        body = jsonErrorEnvelope(
          message.id,
          INVALID_PARAMS,
          "Missing resource uri",
        );
        break;
      }
      if (message.method === "resources/subscribe") {
        const result = (await ctx.runMutation(
          component.sessions.subscribeResource,
          { sessionId, uri },
        )) as "subscribed" | "exists" | "limit_exceeded";
        if (result === "limit_exceeded") {
          // A client-induced limit, not a server fault: use FORBIDDEN so it
          // doesn't pollute internal-error signals.
          body = jsonErrorEnvelope(
            message.id,
            FORBIDDEN,
            "Subscription limit reached for this session",
          );
          break;
        }
      } else {
        await ctx.runMutation(component.sessions.unsubscribeResource, {
          sessionId,
          uri,
        });
      }
      // MCP `resources/subscribe` and `resources/unsubscribe` return an
      // empty result object on success.
      body = jsonResultEnvelope(message.id, {});
      break;
    }

    case "tools/list": {
      // Filter the catalog through the authorize callback in mode "list".
      // Throwing authorizers are isolated per tool: a single buggy
      // decision hides only that tool, not the whole list.
      const allTools = (await ctx.runQuery(
        component.registry.listTools,
        {},
      )) as RegisteredTool[];
      const visible = [];
      for (const tool of allTools) {
        const { decision, threw } = await safeAuthorize(
          options.authorize,
          ctx,
          {
            toolName: tool.name,
            toolKind: tool.kind,
            args: {},
            mode: "list",
            toolMetadata: tool.metadata ?? null,
            identity,
          },
        );
        if (threw) {
          // A buggy authorize callback drops only the offending tool,
          // not the whole list. Surface to the deployment log so the
          // shrinking tools/list response is discoverable; the tool
          // stays hidden either way.
          console.error(
            "[mcp-gateway] authorize callback threw during tools/list for tool",
            tool.name,
            decision.reason,
          );
        }
        if (decision.allowed) {
          visible.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            // Only emit `outputSchema` when the tool actually declared
            // one, some MCP clients (Inspector older versions) are
            // strict about the field being absent vs null vs {}.
            ...(tool.outputSchema !== undefined
              ? { outputSchema: tool.outputSchema }
              : {}),
            ...(tool.protocolMetadata ?? {}),
          });
        }
      }
      body = jsonResultEnvelope(message.id, { tools: visible });
      break;
    }

    case "tools/call": {
      const name = message.params?.name;
      if (typeof name !== "string") {
        body = jsonErrorEnvelope(message.id, -32602, "Missing tool name");
        break;
      }
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;

      const tool = (await ctx.runQuery(component.registry.getTool, {
        name,
      })) as RegisteredTool | null;
      if (!tool) {
        // Anti-DoS: unknown-tool calls are not audited because anonymous
        // callers can spam arbitrary names with arbitrary args.
        body = jsonErrorEnvelope(message.id, -32602, `Unknown tool: ${name}`);
        break;
      }

      // Identity-injected arg: the gateway fills this server-side from the
      // resolved caller, so a client-supplied value is meaningless and a
      // spoofing vector. Strip it before authorize / audit / dispatch.
      if (tool.identityArg !== undefined) {
        delete args[tool.identityArg];
      }

      const start = Date.now();
      const authz = await safeAuthorize(options.authorize, ctx, {
        toolName: tool.name,
        toolKind: tool.kind,
        args,
        mode: "call",
        toolMetadata: tool.metadata ?? null,
        identity,
      });
      const threw = authz.threw;
      let decision = authz.decision;
      // A tool that declares identityArg structurally needs a caller. If
      // none was resolved, deny as Unauthorized (so the client starts the
      // OAuth flow) regardless of what the host's authorize returned.
      // The tool must never run unscoped.
      if (decision.allowed && tool.identityArg !== undefined && !identity) {
        decision = {
          allowed: false,
          reason: "Unauthorized: tool requires an authenticated caller",
        };
      }

      if (!decision.allowed) {
        const reason = decision.reason ?? "Forbidden";
        const code = threw
          ? INTERNAL_ERROR
          : /^unauth/i.test(reason)
            ? UNAUTHORIZED
            : FORBIDDEN;
        // A returned `reason` is host-authored and meant for the caller;
        // a thrown one is `Authorizer threw: <exception text>` and must
        // not reach the wire. The audit row below keeps the full text.
        const wireReason = threw ? GENERIC_AUTHORIZER_ERROR : reason;
        // Record the rejection in the audit log so operators see who
        // tried what and was denied (or what made the authorizer throw).
        try {
          await ctx.runMutation(component.dispatch.recordAuthDenial, {
            name: tool.name,
            args,
            auditIdentitySubject,
            outcome: threw ? "error" : "denied",
            errorCode: code,
            errorMessage: reason,
            durationMs: Date.now() - start,
          });
        } catch (err) {
          // Match safeRecordAudit's pattern in dispatch.ts: audit must
          // never alter the dispatch outcome, so swallow, but log so
          // a recurring write failure (schema drift, validator
          // mismatch) is visible to operators.
          console.error(
            "[mcp-gateway] failed to record auth denial",
            tool.name,
            err,
          );
        }
        // 401 + WWW-Authenticate per RFC 6750 + RFC 9728 when an OAuth
        // server is configured. Bypasses the JSON-RPC envelope and uses
        // HTTP status semantics so the MCP client begins discovery.
        if (code === UNAUTHORIZED) {
          const oauthConfig = await ctx.runQuery(
            component.registry.getOAuthConfig,
            {},
          );
          if (oauthConfig) {
            const requestUrl = new URL(request.url);
            const mcpPath = requestUrl.pathname.replace(/\/+$/, "") || "/";
            const metadataUrl = buildProtectedResourceMetadataUrl(
              requestUrl.origin,
              mcpPath,
            );
            raw = new Response(
              jsonErrorEnvelope(message.id, code, wireReason),
              {
                status: 401,
                headers: {
                  "content-type": "application/json",
                  "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
                  ...(issueSessionHeader
                    ? { "mcp-session-id": sessionId }
                    : {}),
                },
              },
            );
            body = "";
            break;
          }
        }
        body = jsonErrorEnvelope(message.id, code, wireReason);
        break;
      }

      // Allowed: dispatch via the component, which runs the registered
      // handle and writes the audit entry.
      const dispatched = await ctx.runAction(component.dispatch.runTool, {
        name,
        args,
        auditIdentitySubject,
        identity,
      });
      if (!dispatched.ok) {
        // MCP 2025-06-18 §tools/call distinguishes:
        //   - Protocol errors (unknown tool, invalid args) → JSON-RPC error
        //   - Tool execution errors                        → result with isError:true
        // The model uses the latter to reason about retries; protocol
        // errors abort the call. Keep -32602 (unknown tool) as a
        // JSON-RPC error; everything else is an execution error and
        // surfaces as a tool result so the LLM can react.
        if (dispatched.error.code === -32602) {
          body = jsonErrorEnvelope(
            message.id,
            dispatched.error.code,
            dispatched.error.message,
          );
        } else {
          body = jsonResultEnvelope(message.id, {
            content: [{ type: "text", text: dispatched.error.message }],
            isError: true,
          });
        }
        break;
      }
      // Always ship the text-JSON `content` block for backwards-compat
      // with clients that don't know `structuredContent`. When the tool
      // declared an `outputSchema` (via `defineMcp*({ returns })`), MCP
      // 2025-06-18 §tools/call mandates ALSO sending the typed value
      // as `structuredContent`. Spec-compliant clients (claude.ai,
      // recent Inspector) prefer the structured form when present.
      body = jsonResultEnvelope(message.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(dispatched.data, null, 2),
          },
        ],
        ...(tool.outputSchema !== undefined
          ? { structuredContent: dispatched.data }
          : {}),
        isError: false,
      });
      break;
    }

    default:
      body = jsonErrorEnvelope(
        message.id,
        -32601,
        `Unsupported method: ${message.method}`,
      );
  }

  if (raw) return raw;

  const headers: Record<string, string> = {};
  if (issueSessionHeader) headers["mcp-session-id"] = sessionId;

  if (clientWantsSse(request)) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(sseEvent(1, body)));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        ...headers,
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
      },
    });
  }

  return new Response(body, {
    status: 200,
    headers: {
      ...headers,
      "content-type": "application/json",
    },
  });
}
