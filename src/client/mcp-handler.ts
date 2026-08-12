import type { ComponentApi } from "../component/_generated/component.js";
import {
  buildProtectedResourceMetadataUrl,
  isDeliberateConvexError,
  parseAuthorizerDecision,
  type McpAuthorizerArgs,
  type McpAuthorizerDecision,
  type McpAuthorizerHandler,
  type McpInputRequiredResult,
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

export type McpMrtrOptions = {
  /** At least 32 bytes of private, stable key material for HMAC-SHA-256. */
  secret: string;
  /** Maximum continuation lifetime. Defaults to five minutes. */
  ttlMs?: number;
};

/**
 * The snapshot handed to a host task executor and to the update hooks.
 * `identity` is the caller resolved when the task was created; `args`
 * are the public tool arguments (identity/reserved keys already
 * stripped); `idempotencyKey` is issued once per task and must be
 * persisted by the tool around its side effect.
 */
export type McpTaskContext = {
  taskId: string;
  toolName: string;
  toolKind: "query" | "mutation" | "action";
  args: Record<string, unknown>;
  identity: { subject: string; claims?: Record<string, unknown> };
  idempotencyKey: string;
  expiresAt: number;
};

/**
 * Starts durable execution for a freshly created task, e.g.
 * `workflow.start(ctx, internal.tasks.runArchive, {...})` with
 * `@convex-dev/workflow`. It must only *start* the work and return;
 * the execution itself finalizes the task later via
 * `gateway.completeTask` / `gateway.failTask` (or pauses it via
 * `gateway.requireTaskInput`). A throw here fails the task immediately.
 */
export type McpTaskExecutor = (
  ctx: McpHandlerCtx,
  task: McpTaskContext,
) => Promise<void> | void;

export type McpTasksOptions = {
  /**
   * Host-owned durable execution. Omit it to use the built-in
   * scheduled executor, which runs the registered tool function once
   * and completes/fails the task (no retries, no input rounds).
   */
  execute?: McpTaskExecutor;
  /**
   * Called after a `tasks/update` accepted MRTR-shaped `inputResponses`
   * for an `input_required` task (now back in `working`). Hosts with a
   * custom `execute` resume their workflow here. Best-effort AND
   * at-least-once: a throw is logged and the update still succeeds (the
   * responses are already durably stored on the task row), and an
   * idempotent duplicate update re-fires the hook so a client that
   * re-sends the same responses retries a notification that previously
   * failed. The hook MUST therefore tolerate repeats.
   */
  onInputResponses?: (
    ctx: McpHandlerCtx,
    event: {
      taskId: string;
      toolName: string;
      inputResponses: Record<string, unknown>;
    },
  ) => Promise<void> | void;
  /**
   * Called after an owner cancellation, including idempotent repeats:
   * re-sending the cancel is the retry path for a notification that
   * previously threw, so the hook MUST tolerate being called for an
   * already-cancelled task. Hosts cancel their workflow run here.
   */
  onCancel?: (
    ctx: McpHandlerCtx,
    event: { taskId: string; toolName: string },
  ) => Promise<void> | void;
  /**
   * Default task retention. A task row (and with it the result) expires
   * `retentionMs` after creation; expired tasks answer like unknown ids
   * and are dropped by `gateway.pruneTasks`. Clamped to
   * [1 minute, 7 days]; defaults to 24 hours. A client may request a
   * shorter `ttlMs` per call, clamped the same way.
   */
  retentionMs?: number;
  /**
   * Identifies THIS mount for task ownership. Stored on every task the
   * mount creates, and required to match on every `tasks/get` /
   * `tasks/update`; a mismatch answers exactly like an unknown task id.
   *
   * Set it whenever the gateway is mounted more than once with different
   * `authorize` policies over the same identity namespace. The task table
   * is component-wide and `authorize` runs only at creation, so without a
   * scope a caller permitted on a broad mount can start a privileged task
   * there and collect its result through a narrower one — bypassing the
   * narrower mount's policy without any bug in it.
   *
   * A sealed MRTR `requestState` is not bound to the mount, so two mounts
   * sharing `mrtr.secret` both accept the same continuation and each ends
   * up owning its own task row for that chain (their rows are
   * scope-isolated). The tool still dedupes, because both runs receive the
   * same chain key in `mrtrArgs`. Give differently-scoped mounts different
   * secrets if you want continuations to be non-transferable.
   *
   * Unset (the default) keeps the pre-scope behaviour, so a single-mount
   * host needs no migration. Adopting it later only affects tasks created
   * from then on: rows already in flight have no scope and stay visible
   * only to unscoped mounts until they expire.
   */
  scope?: string;
  /** Advertised polling interval hint, defaults to 2000 ms. */
  pollIntervalMs?: number;
};

/**
 * Origin allowlist for `handleMcpRequest`. MCP Streamable HTTP requires
 * servers to validate the `Origin` header to prevent DNS-rebinding
 * attacks: a request whose `Origin` is present but not allowed is
 * rejected with HTTP 403 before identity resolution, authorization,
 * auditing, or dispatch. Requests without an `Origin` header (every
 * CLI and server-to-server client) are unaffected.
 *
 * - `string` / `string[]`, exact-match allowlist of origins.
 * - `(origin: string) => boolean`, custom matcher for subdomain
 *   wildcards or per-tenant rules.
 *
 * This is deliberately independent of `cors`. CORS is a browser
 * mechanism that decides what a browser is allowed to *read*;
 * `allowedOrigins` is an authorization gate that decides what the
 * gateway is willing to *serve*. Coupling the two makes the permissive
 * `cors: true` silently disable the origin gate, so they are separate
 * options.
 *
 * **Omitting this option disables origin validation entirely.** That is
 * the default because a Convex deployment is reachable at a fixed
 * public URL rather than on localhost, which is the DNS-rebinding
 * scenario the requirement targets. Set it for any deployment that
 * serves browser clients.
 */
export type McpAllowedOriginsOption =
  | string
  | string[]
  | ((origin: string) => boolean);

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
   * See `McpAllowedOriginsOption`. Omit to disable origin validation.
   */
  allowedOrigins?: McpAllowedOriginsOption;
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
   * whole, e.g. "call `kira_load_skill` before answering", without bloating
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
   * state per session; the host owns delivery, it reads
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
  /**
   * Opt-in support for modern multi-round-trip requests (MRTR). A
   * declarative tool's host-side `beforeCall` hook is the state machine:
   * on the first call it can return `inputRequired(inputRequests, state)`
   * before the underlying Convex function can run; on every verified
   * continuation it runs again with the decoded state, the client's
   * untrusted `inputResponses`, and the chain's stable idempotency key,
   * and decides whether to ask for another round, finish without
   * dispatching (`completeCall()`), or continue to the Convex function
   * (which stays MCP-unaware; only the idempotency key is injectable via
   * `mrtrArgs`). Continuations are HMAC-sealed, TTL-bound, bound to the
   * caller/tool/arguments, and redeemed once server-side so a captured
   * state cannot be replayed with different responses.
   */
  mrtr?: McpMrtrOptions;
  /**
   * Opt-in MCP Tasks (`io.modelcontextprotocol/tasks`). **Off by
   * default**; the capability is advertised in `server/discover` only
   * when this option is set, and only tools registered with
   * `taskSupport: true` accept a task-augmented modern `tools/call`.
   *
   * Without `execute`, the gateway runs the tool once via the component's
   * built-in scheduled executor (durable across restarts, no retries) and
   * completes or fails the task. Hosts that need retry policy, delays,
   * or `input_required` rounds supply `execute` to start their own
   * durable execution — typically a `@convex-dev/workflow` run — and
   * finalize via `gateway.completeTask` / `failTask` /
   * `requireTaskInput`. See docs/tasks.md.
   */
  tasks?: McpTasksOptions;
}

/**
 * Internal handler options: the public `HandleMcpRequestOptions` plus the
 * catalog synchronizer that `McpGateway.handleMcpRequest` derives from the
 * declarative catalog options. Not exported, hosts never set it directly.
 */
type InternalHandleMcpRequestOptions = HandleMcpRequestOptions & {
  ensureCatalogSynced?: () => Promise<void>;
  declarativeTools?: McpToolRegistration[];
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
  mrtrArgs?: {
    idempotencyKey: string;
  };
  mrtrGated?: boolean;
  taskSupport?: boolean;
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

/**
 * Session-based protocol revisions this gateway speaks, newest first.
 * The first entry is what `initialize` negotiates when a client requests
 * a version the gateway does not support (per spec, the server answers
 * with its latest supported version). The gateway serves all three with
 * an identical wire contract: `2025-11-25`'s additions over `2025-06-18`
 * are its optional SSE resumability framing (which requires an event
 * store + GET replay this gateway does not have, so it is not emitted,
 * see `sseResponseFrame`) and additive capabilities (tasks, url-mode
 * elicitation, which are not advertised). Not emitting optional features
 * is conforming.
 */
const LEGACY_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;
const MAX_MCP_HEADER_VALUE_LENGTH = 8 * 1024;

function hasMcpHeaderControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const SUPPORTED_PROTOCOL_VERSIONS = LEGACY_PROTOCOL_VERSIONS;
const DEFAULT_PROTOCOL_VERSION = LEGACY_PROTOCOL_VERSIONS[0];
const SERVER_NAME = "convex-mcp-gateway";
const SERVER_VERSION = "0.0.0";

const UNAUTHORIZED = -32001;
const FORBIDDEN = -32003;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const HEADER_MISMATCH = -32020;

/** Advertised default `tasks/get` polling hint (milliseconds). */
const TASK_POLL_INTERVAL_MS = 2000;

/**
 * Default task retention ceiling applied when the host did not set
 * `tasks.retentionMs`. Mirrors the component's `TASK_DEFAULT_TTL_MS`
 * (not imported to keep component server code out of the host bundle).
 */
const TASK_DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Capability / extension key for MCP Tasks. */
const TASKS_CAPABILITY_KEY = "io.modelcontextprotocol/tasks";

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

/**
 * MCP Streamable HTTP: "Servers MUST validate the `Origin` header on all
 * incoming connections to prevent DNS rebinding attacks. If the `Origin`
 * header is present and invalid, servers MUST respond with HTTP 403."
 *
 * Applies to both protocol eras and runs before identity resolution,
 * authorization, auditing, and dispatch. Returns `null` when the request
 * may proceed.
 */
function originRejection(
  request: Request,
  options: HandleMcpRequestOptions,
): Response | null {
  const allowed = options.allowedOrigins;
  if (allowed === undefined) return null;
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  let ok: boolean;
  if (typeof allowed === "string") {
    ok = allowed === origin;
  } else if (Array.isArray(allowed)) {
    ok = allowed.includes(origin);
  } else {
    try {
      ok = allowed(origin);
    } catch (err) {
      // A host matcher written as `new URL(origin).hostname.endsWith(...)`
      // throws on the literal `Origin: null` that sandboxed iframes and
      // some redirects send. Fail closed rather than letting the throw
      // escape as an opaque 500 with no gateway-prefixed log line.
      console.error(
        `[mcp-gateway] allowedOrigins matcher threw for origin ${origin}; ` +
          `treating it as not allowed.`,
        err,
      );
      ok = false;
    }
  }
  if (ok) return null;
  // The spec allows a JSON-RPC error body with no id here. POST callers
  // speak JSON-RPC, so give them one; DELETE has no JSON-RPC envelope.
  const body =
    request.method === "POST"
      ? jsonErrorEnvelope(null, FORBIDDEN, "Forbidden: origin is not allowed")
      : "Forbidden: origin is not allowed";
  return new Response(body, {
    status: 403,
    headers:
      request.method === "POST" ? { "content-type": "application/json" } : {},
  });
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

/**
 * Build the single-frame SSE body of a POST response.
 *
 * - `2026-07-28` (`isModern`): a bare message event. The modern revision
 *   removed `Last-Event-ID` resumability, so no event id at all.
 * - Every session-based revision, INCLUDING `2025-11-25`: one message
 *   event with id 1, byte-identical to what legacy sessions always
 *   received.
 *
 * `2025-11-25` adds an optional priming event + `retry` hint to SSE
 * framing, but the reference server emits those ONLY when it has an
 * event store backing GET + `Last-Event-ID` replay (its
 * `writePrimingEvent` returns early when `!this._eventStore`). This
 * gateway has neither an event store nor a GET channel (GET is a hard
 * 405), so priming here would advertise resumability it cannot honor:
 * a client whose connection dies mid-frame would schedule a GET
 * reconnect with `Last-Event-ID: 0`, get 405, and silently abandon the
 * request instead of failing cleanly. Not emitting the optional
 * additions is the conforming behavior for a server without replay,
 * and it keeps every legacy revision's frame identical.
 */
function sseResponseFrame(body: string, isModern: boolean): string {
  const idLine = isModern ? "" : "id: 1\n";
  return `${idLine}event: message\ndata: ${body}\n\n`;
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

function jsonErrorEnvelopeWithData(
  id: JsonRpcMessage["id"],
  code: number,
  message: string,
  data: Record<string, unknown>,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, data },
  });
}

function modernErrorResponse(
  id: JsonRpcMessage["id"],
  code: number,
  message: string,
  data: Record<string, unknown> = {},
  status = 400,
): Response {
  return new Response(jsonErrorEnvelopeWithData(id, code, message, data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function modernProtocolVersion(message: JsonRpcMessage): string | null {
  const meta = message.params?._meta;
  if (!isPlainObject(meta)) return null;
  const version = meta["io.modelcontextprotocol/protocolVersion"];
  return typeof version === "string" ? version : null;
}

function decodeMcpHeaderValue(value: string | null): string | null {
  if (value === null) return null;
  if (
    value.length > MAX_MCP_HEADER_VALUE_LENGTH ||
    hasMcpHeaderControlCharacter(value)
  ) {
    return null;
  }
  const prefix = "=?base64?";
  const suffix = "?=";
  if (!value.startsWith(prefix)) return value;
  if (!value.endsWith(suffix)) return null;
  const encoded = value.slice(prefix.length, -suffix.length);
  if (encoded.length === 0) return null;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded.length <= MAX_MCP_HEADER_VALUE_LENGTH &&
      !hasMcpHeaderControlCharacter(decoded)
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function modernNameMatches(message: JsonRpcMessage, request: Request): boolean {
  const headerName = decodeMcpHeaderValue(request.headers.get("mcp-name"));
  switch (message.method) {
    case "tools/call":
      return headerName === message.params?.name;
    case "resources/read":
      return headerName === message.params?.uri;
    case "prompts/get":
      return headerName === message.params?.name;
    case "tasks/get":
    case "tasks/update":
      return headerName === message.params?.taskId;
    default:
      return true;
  }
}

type McpHeaderParameter = {
  headerName: string;
  path: string[];
  type: "string" | "integer" | "boolean";
};

type McpHeaderParameterResult =
  | { parameters: McpHeaderParameter[]; problem?: never }
  | { parameters?: never; problem: string };

const HTTP_FIELD_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function collectMcpHeaderParameters(schema: unknown): McpHeaderParameterResult {
  const parameters: McpHeaderParameter[] = [];
  const names = new Set<string>();

  function visit(
    node: unknown,
    path: string[],
    reachable: boolean,
  ): string | null {
    if (Array.isArray(node)) {
      for (const item of node) {
        const problem = visit(item, path, false);
        if (problem) return problem;
      }
      return null;
    }
    if (!isPlainObject(node)) return null;

    if ("x-mcp-header" in node) {
      const headerName = node["x-mcp-header"];
      const type = node.type;
      if (!reachable || path.length === 0) {
        return "x-mcp-header must be reachable through schema properties";
      }
      if (
        typeof headerName !== "string" ||
        !HTTP_FIELD_NAME.test(headerName) ||
        (type !== "string" && type !== "integer" && type !== "boolean")
      ) {
        return "x-mcp-header must name a string, integer, or boolean property";
      }
      const normalizedName = headerName.toLowerCase();
      if (names.has(normalizedName)) {
        return "x-mcp-header names must be case-insensitively unique";
      }
      names.add(normalizedName);
      parameters.push({ headerName, path, type });
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "x-mcp-header") continue;
      if (key === "properties" && isPlainObject(value)) {
        for (const [propertyName, propertySchema] of Object.entries(value)) {
          const problem = visit(
            propertySchema,
            [...path, propertyName],
            reachable,
          );
          if (problem) return problem;
        }
        continue;
      }
      if (typeof value === "object" && value !== null) {
        const problem = visit(value, path, false);
        if (problem) return problem;
      }
    }
    return null;
  }

  const problem = visit(schema, [], true);
  return problem ? { problem } : { parameters };
}

/**
 * Validate the `x-mcp-header` annotations in a tool's `inputSchema`.
 * Returns a human-readable problem string, or `null` when the schema is
 * valid. Called when a catalog is registered or synced, so a
 * schema-authoring mistake surfaces with the tool name attached instead
 * of failing every modern `tools/call` for that tool at runtime.
 */
export function describeToolHeaderSchemaProblem(
  inputSchema: unknown,
): string | null {
  return collectMcpHeaderParameters(inputSchema).problem ?? null;
}

function headerValueForArgument(
  argumentsValue: unknown,
  parameter: McpHeaderParameter,
): string | null {
  let value = argumentsValue;
  for (const segment of parameter.path) {
    if (!isPlainObject(value) || !(segment in value)) return null;
    value = value[segment];
  }
  if (value === null || value === undefined) return null;
  if (parameter.type === "string" && typeof value === "string") return value;
  if (parameter.type === "boolean" && typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (parameter.type === "integer" && typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : null;
  }
  return null;
}

/** Strict decimal literal, so `Number(" 42 ")` and `Number("")` don't slip through. */
const NUMERIC_HEADER_VALUE = /^[+-]?\d+(\.\d+)?$/;

type ModernHeaderProblem =
  /** The tool's own schema is invalid. A server-side configuration error. */
  | { kind: "schema"; problem: string }
  /** The client's headers disagree with the body. `-32020` territory. */
  | { kind: "mismatch"; problem: string };

function validateModernToolParameterHeaders(
  request: Request,
  inputSchema: unknown,
  argumentsValue: unknown,
): ModernHeaderProblem | null {
  const result = collectMcpHeaderParameters(inputSchema);
  if (result.parameters === undefined) {
    return { kind: "schema", problem: result.problem };
  }

  for (const parameter of result.parameters) {
    const header = request.headers.get(`mcp-param-${parameter.headerName}`);
    const expected = headerValueForArgument(argumentsValue, parameter);
    if (expected === null) {
      if (header !== null) {
        return {
          kind: "mismatch",
          problem: `Mcp-Param-${parameter.headerName} must be omitted`,
        };
      }
      continue;
    }
    const mismatch: ModernHeaderProblem = {
      kind: "mismatch",
      problem: `Mcp-Param-${parameter.headerName} must match the request arguments`,
    };
    if (header === null) return mismatch;
    const decoded = decodeMcpHeaderValue(header);
    if (decoded === null) return mismatch;
    // Streamable HTTP: integer parameters SHOULD be compared numerically
    // rather than as strings, so `42.0` and `42` are considered equal.
    if (parameter.type === "integer") {
      if (
        !NUMERIC_HEADER_VALUE.test(decoded) ||
        Number(decoded) !== Number(expected)
      ) {
        return mismatch;
      }
      continue;
    }
    if (decoded !== expected) return mismatch;
  }
  return null;
}

function finalizeModernResult(
  body: string,
  method: string,
  options: HandleMcpRequestOptions,
): string {
  const envelope = JSON.parse(body) as { result?: Record<string, unknown> };
  if (!envelope.result) return body;
  envelope.result.resultType ??= "complete";
  const meta = isPlainObject(envelope.result._meta)
    ? envelope.result._meta
    : {};
  meta["io.modelcontextprotocol/serverInfo"] = options.serverInfo ?? {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  };
  envelope.result._meta = meta;
  if (
    method === "server/discover" ||
    method === "tools/list" ||
    method === "resources/list" ||
    method === "resources/templates/list" ||
    method === "resources/read" ||
    method === "tasks/get"
  ) {
    envelope.result.ttlMs ??= 0;
    envelope.result.cacheScope ??= "private";
  }
  return JSON.stringify(envelope);
}

type VerifiedMrtrState = {
  state: unknown;
  idempotencyKey: string;
  jti: string;
  round: number;
  exp: number;
};

const MRTR_DEFAULT_TTL_MS = 5 * 60 * 1000;
const MRTR_MAX_TTL_MS = 60 * 60 * 1000;
/**
 * Slack added to a chain claim's lifetime on top of the TTL ceiling.
 * The claim must outlive every continuation of its chain, and a branch
 * that read the chain as open can still be sealing one while the
 * winner's claim is being written. With a host `ttlMs` at the ceiling
 * that sibling's expiry exceeds the claim's by exactly that scheduling
 * delta, so cover it rather than reason about how small it is.
 */
const MRTR_CLAIM_SLACK_MS = 60 * 1000;
const MRTR_MAX_STATE_BYTES = 8 * 1024;
const MRTR_MIN_SECRET_BYTES = 32;
/**
 * Hard ceiling on continuation rounds per chain. MRTR server
 * requirement 8 permits repeated `InputRequiredResult`s, but an
 * unbounded chain lets a buggy hook ping-pong with a client forever.
 */
const MRTR_MAX_ROUNDS = 16;

function isMcpInputRequiredResult(
  value: unknown,
): value is McpInputRequiredResult {
  return (
    isPlainObject(value) &&
    value.__mcpInputRequired === true &&
    (value.inputRequests === undefined || isPlainObject(value.inputRequests))
  );
}

function isMcpCompleteCallResult(
  value: unknown,
): value is { __mcpCompleteCall: true; result: Record<string, unknown> } {
  return (
    isPlainObject(value) &&
    value.__mcpCompleteCall === true &&
    isPlainObject(value.result)
  );
}

/**
 * A well-formed MCP `tools/call` result carries a `content` array (the
 * spec-required field); `structuredContent` and `isError` are optional.
 * A `completeCall()` result is forwarded verbatim to the client, so the
 * gateway validates it here rather than shipping a shape a spec-
 * compliant client would reject. Returns a problem string, or `null`
 * when valid.
 */
function describeCompleteCallResultProblem(
  result: Record<string, unknown>,
): string | null {
  if (!Array.isArray(result.content)) {
    return "result.content must be an array";
  }
  if (
    result.structuredContent !== undefined &&
    !isPlainObject(result.structuredContent) &&
    !Array.isArray(result.structuredContent)
  ) {
    return "result.structuredContent must be an object or array";
  }
  if (result.isError !== undefined && typeof result.isError !== "boolean") {
    return "result.isError must be a boolean";
  }
  return null;
}

/**
 * Accumulate the client capabilities a set of `inputRequests` demands.
 * Elicitation is tracked per mode (`form` / `url`); a request without a
 * `mode` is a form request per the spec default. Returns `null` for a
 * request shape or method the gateway cannot vouch for.
 */
function mrtrRequiredCapabilities(
  inputRequests: Record<string, unknown>,
): Record<string, unknown> | null {
  const elicitationModes: { form?: object; url?: object } = {};
  const required: Record<string, unknown> = {};
  for (const request of Object.values(inputRequests)) {
    if (!isPlainObject(request) || typeof request.method !== "string") {
      return null;
    }
    switch (request.method) {
      case "elicitation/create": {
        const mode = isPlainObject(request.params)
          ? request.params.mode
          : undefined;
        if (mode !== undefined && mode !== "form" && mode !== "url")
          return null;
        // Merge instead of overwrite: two requests with different modes
        // require BOTH modes, and a later form request must not erase an
        // earlier url requirement.
        elicitationModes[(mode ?? "form") as "form" | "url"] = {};
        required.elicitation = elicitationModes;
        break;
      }
      case "sampling/createMessage":
        required.sampling = {};
        break;
      case "roots/list":
        required.roots = {};
        break;
      default:
        return null;
    }
  }
  return required;
}

/**
 * The subset of `required` the client did NOT declare, in the exact
 * shape `-32021`'s `data.requiredCapabilities` must carry (only the
 * missing entries, per `basic/index`). Empty object means fully
 * supported. Mode-aware in both directions: `elicitation: {}` is
 * equivalent to declaring form-only (spec backwards-compat rule), and a
 * url-only client does not support form requests.
 */
function missingMrtrCapabilities(
  clientCapabilities: Record<string, unknown>,
  required: Record<string, unknown>,
): Record<string, unknown> {
  const missing: Record<string, unknown> = {};
  for (const [name, requirement] of Object.entries(required)) {
    const declared = clientCapabilities[name];
    if (!isPlainObject(declared)) {
      missing[name] = requirement;
      continue;
    }
    if (name === "elicitation" && isPlainObject(requirement)) {
      const declaresNoModes =
        !isPlainObject(declared.form) && !isPlainObject(declared.url);
      const supportsForm = isPlainObject(declared.form) || declaresNoModes;
      const supportsUrl = isPlainObject(declared.url);
      const missingModes: Record<string, unknown> = {};
      if ("form" in requirement && !supportsForm) missingModes.form = {};
      if ("url" in requirement && !supportsUrl) missingModes.url = {};
      if (Object.keys(missingModes).length > 0) {
        missing.elicitation = missingModes;
      }
    }
  }
  return missing;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function cryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function stableJson(value: unknown): string {
  // Mirror JSON.stringify's undefined semantics so every output is
  // valid JSON: top-level and array-item undefined become null, and
  // undefined-valued properties are omitted. Without this, a call site
  // that forgot a `?? null` guard would embed a literal `undefined`
  // token (or return the value undefined) into digest input.
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * True when `mrtr.secret` cannot key HMAC-SHA-256 safely. Checked up
 * front by the handler so a short secret surfaces as a `-32603` server
 * misconfiguration on BOTH the seal and verify paths, never as a
 * `-32602` that blames the client for a state that may be perfectly
 * valid.
 */
function mrtrSecretTooShort(options: McpMrtrOptions): boolean {
  return (
    new TextEncoder().encode(options.secret).byteLength <
    MRTR_MIN_SECRET_BYTES
  );
}

async function mrtrKey(secret: string): Promise<CryptoKey> {
  if (new TextEncoder().encode(secret).byteLength < MRTR_MIN_SECRET_BYTES) {
    throw new Error("MRTR secret must contain at least 32 bytes");
  }
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Seal one continuation round. `argsDigest` is computed by the caller
 * BEFORE the hook runs, so a hook that mutates its (copied) argument
 * object can never poison the digest the retry is checked against.
 * `idempotencyKey` is minted once on round 1 and carried verbatim
 * through every later round of the chain; `jti` is fresh per round and
 * anchors the one-time redemption record.
 */
async function sealMrtrState(
  options: McpMrtrOptions,
  payloadFields: {
    toolName: string;
    identitySubject: string | null;
    argsDigest: string;
    state: unknown;
    idempotencyKey: string;
    round: number;
  },
): Promise<string> {
  const encodedState = stableJson(payloadFields.state);
  if (
    new TextEncoder().encode(encodedState).byteLength > MRTR_MAX_STATE_BYTES
  ) {
    throw new Error("MRTR state exceeds 8 KiB");
  }
  // `ttlMs` is a host option, not client input, so a nonsensical value
  // (0, negative, NaN, Infinity) is a server misconfiguration. Throw so
  // the seal path reports it as -32603, never as a -32602 that would
  // mint a dead-on-arrival continuation and then blame the client's
  // retry for the "expired" state it was handed.
  if (
    options.ttlMs !== undefined &&
    (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)
  ) {
    throw new Error("MRTR ttlMs must be a positive finite number");
  }
  const ttlMs = Math.min(
    options.ttlMs ?? MRTR_DEFAULT_TTL_MS,
    MRTR_MAX_TTL_MS,
  );
  const now = Date.now();
  const payload = {
    v: 2,
    toolName: payloadFields.toolName,
    identitySubject: payloadFields.identitySubject,
    argsDigest: payloadFields.argsDigest,
    exp: now + ttlMs,
    jti: crypto.randomUUID(),
    round: payloadFields.round,
    idempotencyKey: payloadFields.idempotencyKey,
    state: payloadFields.state,
  };
  const encoded = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await mrtrKey(options.secret),
    new TextEncoder().encode(encoded),
  );
  return `${encoded}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify one continuation. Returns `null` when verification RAN and
 * said no (tampered, expired, wrong principal/tool/arguments): `-32602`
 * territory. Throws when verification could not run at all (e.g. a
 * misconfigured secret): the caller maps that to `-32603` instead of
 * blaming the client.
 */
async function verifyMrtrState(
  options: McpMrtrOptions,
  requestState: unknown,
  expected: {
    toolName: string;
    identitySubject: string | null;
    argsDigest: string;
  },
): Promise<VerifiedMrtrState | null> {
  if (typeof requestState !== "string") return null;
  const [encoded, signature, extra] = requestState.split(".");
  if (!encoded || !signature || extra !== undefined) return null;
  const signatureBytes = base64UrlDecode(signature);
  if (
    !signatureBytes ||
    !(await crypto.subtle.verify(
      "HMAC",
      await mrtrKey(options.secret),
      cryptoBuffer(signatureBytes),
      new TextEncoder().encode(encoded),
    ))
  ) {
    return null;
  }
  const payloadBytes = base64UrlDecode(encoded);
  if (!payloadBytes) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  if (
    payload.v !== 2 ||
    payload.toolName !== expected.toolName ||
    payload.identitySubject !== expected.identitySubject ||
    typeof payload.exp !== "number" ||
    payload.exp < Date.now() ||
    typeof payload.jti !== "string" ||
    typeof payload.round !== "number" ||
    !Number.isSafeInteger(payload.round) ||
    payload.round < 1 ||
    typeof payload.idempotencyKey !== "string" ||
    payload.argsDigest !== expected.argsDigest
  ) {
    return null;
  }
  return {
    state: payload.state,
    idempotencyKey: payload.idempotencyKey,
    jti: payload.jti,
    round: payload.round,
    exp: payload.exp,
  };
}

async function ensureCatalogSynced(
  options: InternalHandleMcpRequestOptions,
): Promise<void> {
  await options.ensureCatalogSynced?.();
}


/**
 * True when this request is the resolving continuation of an
 * already-resolved chain, re-sent with the same answer: the lost
 * response retry. Same continuation with a DIFFERENT answer is not a
 * repeat, which matters for a chain resolved on state alone, whose
 * continuation the redemption table never pinned.
 */
function isChainRepeat(
  chain: ResolvedChain,
  jti: string,
  responsesDigest: string | undefined,
  resolution: "dispatched" | "completed",
): boolean {
  return (
    chain.resolution === resolution &&
    chain.resolvedByJti === jti &&
    chain.resolvedByDigest === responsesDigest
  );
}

/**
 * Response for a continuation whose chain another branch already
 * resolved. Deliberately says nothing about how it resolved: whether
 * the call was accepted or declined is not the caller's business when
 * the caller is presenting a superseded continuation.
 */
function alreadyResolvedEnvelope(
  id: JsonRpcMessage["id"],
  toolName: string,
): string {
  console.warn(
    "[mcp-gateway] MRTR continuation presented for an already-resolved " +
      "chain; rejecting",
    toolName,
  );
  return jsonErrorEnvelope(
    id,
    INVALID_PARAMS,
    "This MRTR request has already been resolved. Start a new call " +
      "without requestState",
  );
}

/**
 * Claim an MRTR chain's single resolution, immediately before the
 * gateway dispatches or finishes the call itself. The claim IS the
 * decision: a continuation forked by an idempotent replay finds the
 * chain already resolved and is refused, which is what per-continuation
 * redemption cannot do (`jti` is fresh per round, so every
 * `inputRequired()` mints an unpinned sibling).
 *
 * Guarded like every other component call on this path: a claim that
 * cannot RUN is a logged `"error"` the caller turns into `-32603`,
 * never a raw 500 that skips the CORS wrapper.
 */
async function claimMrtrChain(
  ctx: HandlerCtx,
  component: ComponentApi,
  toolName: string,
  chainKey: string,
  jti: string,
  responsesDigest: string | undefined,
  resolution: "dispatched" | "completed",
  expiresAt: number,
): Promise<{ status: "claimed" } | ({ status: "lost" } & ResolvedChain) | { status: "error" }> {
  try {
    const result = await ctx.runMutation(component.mrtr.claimChain, {
      chainKey,
      jti,
      ...(responsesDigest !== undefined ? { responsesDigest } : {}),
      resolution,
      expiresAt,
    });
    return result === "claimed"
      ? { status: "claimed" }
      : { status: "lost", ...result };
  } catch (err) {
    console.error(
      "[mcp-gateway] MRTR chain claim failed to run (is the component " +
        "deployment up to date?)",
      toolName,
      err,
    );
    return { status: "error" };
  }
}

/**
 * Read-only pre-check of a chain's resolution, run once per verified
 * continuation before the hook's decision is acted on. It exists so an
 * already-resolved chain refuses a continuation up front instead of
 * handing back one that could never resolve anything, and so an
 * idempotent re-send of a completed call can still reproduce its
 * result. The binding decision remains `claimMrtrChain`.
 */
type ResolvedChain = {
  resolution: "dispatched" | "completed";
  resolvedByJti: string;
  resolvedByDigest?: string;
};

type MrtrChainState =
  | { status: "open" }
  | ({ status: "resolved" } & ResolvedChain)
  | { status: "error" };

async function readMrtrChain(
  ctx: HandlerCtx,
  component: ComponentApi,
  toolName: string,
  chainKey: string,
): Promise<MrtrChainState> {
  try {
    const row = await ctx.runQuery(component.mrtr.getChainResolution, {
      chainKey,
    });
    return row === null ? { status: "open" } : { status: "resolved", ...row };
  } catch (err) {
    console.error(
      "[mcp-gateway] MRTR chain lookup failed to run (is the component " +
        "deployment up to date?)",
      toolName,
      err,
    );
    return { status: "error" };
  }
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

/** Max nesting the task path accepts in client-controlled JSON values. */
const MAX_TASK_VALUE_DEPTH = 64;

/**
 * True when `value` nests deeper than `MAX_TASK_VALUE_DEPTH`. Walked
 * with an EXPLICIT stack, never recursion, so checking a hostile value
 * cannot itself overflow. Task args and input responses are checked at
 * the HTTP boundary before they reach `ctx.runMutation`, whose own arg
 * serialization would otherwise overflow on a deeply nested body and
 * escape as a raw 500 instead of a clean JSON-RPC error.
 */
function nestsTooDeep(value: unknown): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [
    { node: value, depth: 0 },
  ];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (depth > MAX_TASK_VALUE_DEPTH) return true;
    for (const child of Array.isArray(node)
      ? node
      : Object.values(node as Record<string, unknown>)) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
  return false;
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
  // An empty task scope is a configuration error, not "unscoped": it
  // would be stored as its own third namespace, so a host writing
  // `scope: process.env.MOUNT_ID ?? ""` would silently get a namespace
  // nobody intended, unreachable from both scoped and unscoped mounts.
  // Fail at the mount rather than at the first poll.
  if (options.tasks?.scope === "") {
    throw new Error(
      "tasks.scope must be a non-empty string; omit it for an unscoped mount.",
    );
  }
  // Before the preflight branch: telling a browser via CORS that a
  // cross-origin POST is permitted, only to 403 the POST itself, defeats
  // the point of preflight. A disallowed origin gets a bare 403 with no
  // CORS headers at all.
  const rejected = originRejection(request, options);
  if (rejected) return rejected;
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

  const isInitialize = message.method === "initialize";
  const headerProtocolVersion = request.headers.get("mcp-protocol-version");
  const metadataProtocolVersion = modernProtocolVersion(message);
  // `initialize` is always legacy, even when a broken client attaches modern
  // metadata. This keeps its version negotiation and session contract intact.
  const isModern =
    !isInitialize &&
    (headerProtocolVersion === MODERN_PROTOCOL_VERSION ||
      metadataProtocolVersion !== null);
  // The validated `clientCapabilities` object of a modern request,
  // hoisted so MRTR and task-augmented `tools/call` can both negotiate
  // against it below.
  let modernClientCapabilities: Record<string, unknown> | null = null;

  // The 2026 protocol moves protocol negotiation to each request. Check the
  // mirrored routing metadata before identity resolution, catalog writes,
  // authorization, auditing, or tool dispatch.
  if (isModern) {
    if (headerProtocolVersion !== metadataProtocolVersion) {
      return modernErrorResponse(
        message.id,
        HEADER_MISMATCH,
        "MCP-Protocol-Version must exactly match request metadata",
      );
    }
    if (metadataProtocolVersion !== MODERN_PROTOCOL_VERSION) {
      return modernErrorResponse(
        message.id,
        UNSUPPORTED_PROTOCOL_VERSION,
        `Unsupported MCP protocol version: ${metadataProtocolVersion}`,
        {
          supported: [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS],
          requested: metadataProtocolVersion,
        },
      );
    }
    const metadata = message.params?._meta;
    const clientInfo = metadata?.["io.modelcontextprotocol/clientInfo"];
    const clientCapabilities =
      metadata?.["io.modelcontextprotocol/clientCapabilities"];
    if (
      !isPlainObject(clientCapabilities) ||
      (clientInfo !== undefined &&
        (!isPlainObject(clientInfo) ||
          typeof clientInfo.name !== "string" ||
          typeof clientInfo.version !== "string"))
    ) {
      return modernErrorResponse(
        message.id,
        INVALID_PARAMS,
        "Invalid required modern request metadata",
      );
    }
    modernClientCapabilities = clientCapabilities;
    if (request.headers.get("mcp-method") !== message.method) {
      return modernErrorResponse(
        message.id,
        HEADER_MISMATCH,
        "Mcp-Method must exactly match the JSON-RPC method",
      );
    }
    if (!modernNameMatches(message, request)) {
      return modernErrorResponse(
        message.id,
        HEADER_MISMATCH,
        "Mcp-Name must exactly match the JSON-RPC request name",
      );
    }
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

  // Declarative catalog synchronization can write component state. Modern
  // traffic must remain stateless at the protocol level, but anonymous
  // requests must not be able to trigger those writes before requireAuth.
  if (isModern) {
    try {
      await ensureCatalogSynced(options);
    } catch (err) {
      console.error("[mcp-gateway] declarative catalog sync failed", err);
      return modernErrorResponse(
        message.id,
        INTERNAL_ERROR,
        "Failed to synchronize the declarative catalog",
        {},
        500,
      );
    }
  }

  // MCP-Protocol-Version header: required on post-initialize requests
  // by spec. Missing → silently default to 2025-03-26 (legacy clients).
  // Unsupported value → MUST 400 per spec.
  if (!isInitialize && !isModern) {
    const protoHeader = headerProtocolVersion;
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
  let sessionId = "";
  let issueSessionHeader = false;
  // The identity bound to the session at create time (undefined for the
  // initialize path and for legacy pre-binding rows). Used to identity-bind
  // session-scoped mutations like resources/subscribe.
  let sessionOwnerSubject: string | null | undefined;

  if (isModern) {
    // Modern MCP is deliberately stateless. Ignore a legacy session id rather
    // than looking it up, touching it, or echoing it back to the client.
  } else if (isInitialize) {
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

  if (isModern && isJsonRpcNotificationOrResponse(message)) {
    return modernErrorResponse(
      message.id,
      -32600,
      "Client notifications are not supported by this server",
    );
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
  let responseStatus = 200;

  switch (message.method) {
    case "initialize": {
      // Legacy clients reconcile their declarative catalog when they
      // initialize. Modern requests do the same work before dispatch above.
      try {
        await ensureCatalogSynced(options);
      } catch (err) {
        console.error(
          "[mcp-gateway] declarative catalog sync failed during initialize",
          err,
        );
        throw err;
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
      // the capability stays `{}`, the historical, accurate default.
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

    case "server/discover": {
      if (!isModern) {
        body = jsonErrorEnvelope(
          message.id,
          -32601,
          `Unsupported method: ${message.method}`,
        );
        break;
      }
      const registeredResources = (await ctx.runQuery(
        component.registry.listResources,
        {},
      )) as RegisteredResource[];
      const registeredTemplates = (await ctx.runQuery(
        component.registry.listResourceTemplates,
        {},
      )) as RegisteredResourceTemplate[];
      const advertiseResources =
        registeredResources.length > 0 ||
        registeredTemplates.length > 0 ||
        (options.resources ?? []).length > 0 ||
        (options.resourceTemplates ?? []).length > 0;
      body = jsonResultEnvelope(message.id, {
        resultType: "complete",
        supportedVersions: [
          MODERN_PROTOCOL_VERSION,
          ...LEGACY_PROTOCOL_VERSIONS,
        ],
        ...(options.initializeInstructions
          ? { instructions: options.initializeInstructions }
          : {}),
        capabilities: {
          tools: {},
          ...(advertiseResources ? { resources: {} } : {}),
          // Opt-in negotiation: tasks are advertised only when the host
          // configured task execution, per the extension contract.
          ...(options.tasks
            ? {
                "io.modelcontextprotocol/tasks": {
                  pollIntervalMs:
                    options.tasks.pollIntervalMs ?? TASK_POLL_INTERVAL_MS,
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
        if (isModern) responseStatus = 404;
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
        // dispatch.ts: only authenticated outcomes are audited.
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
        // tools/list uses for authorizer throws: a buggy provider hides
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
        if (isModern) {
          resources.sort((a, b) => a.uri.localeCompare(b.uri));
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
        if (isModern) responseStatus = 404;
        body = jsonErrorEnvelope(
          message.id,
          -32601,
          `Unsupported method: ${message.method}`,
        );
        break;
      }
      if (!identity) {
        // Not audited on the anonymous deny path, see the resources/list
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
        if (isModern) {
          resourceTemplates.sort((a, b) =>
            a.uriTemplate.localeCompare(b.uriTemplate),
          );
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
        if (isModern) responseStatus = 404;
        body = jsonErrorEnvelope(
          message.id,
          -32601,
          `Unsupported method: ${message.method}`,
        );
        break;
      }
      if (!identity) {
        // Not audited on the anonymous deny path, see the resources/list
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
      if (isModern) {
        responseStatus = 404;
        body = jsonErrorEnvelope(
          message.id,
          -32601,
          `${message.method} is legacy-only; use subscriptions/listen when it is supported`,
        );
        break;
      }
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
            // Spread first so the registry's own columns always win.
            // `protocolMetadata` is stored as `v.any()`, so a caller
            // reaching the component mutation directly could otherwise
            // shadow `name` or `inputSchema` on the wire.
            ...(tool.protocolMetadata ?? {}),
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            // Only emit `outputSchema` when the tool actually declared
            // one, some MCP clients (Inspector older versions) are
            // strict about the field being absent vs null vs {}.
            ...(tool.outputSchema !== undefined
              ? { outputSchema: tool.outputSchema }
              : {}),
            // Advertise task support only when the host actually
            // configured task execution AND the caller speaks the
            // modern protocol; legacy clients cannot poll tasks.
            ...(tool.taskSupport === true && isModern && options.tasks
              ? { execution: { taskSupport: "optional" } }
              : {}),
          });
        }
      }
      if (isModern) {
        visible.sort((a, b) => a.name.localeCompare(b.name));
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
      const args = isPlainObject(message.params?.arguments)
        ? { ...message.params?.arguments }
        : ((message.params?.arguments ?? {}) as Record<string, unknown>);

      const tool = (await ctx.runQuery(component.registry.getTool, {
        name,
      })) as RegisteredTool | null;
      if (!tool) {
        // Anti-DoS: unknown-tool calls are not audited because anonymous
        // callers can spam arbitrary names with arbitrary args.
        body = jsonErrorEnvelope(message.id, -32602, `Unknown tool: ${name}`);
        break;
      }

      // Reserved fields are never client-controlled. Strip them on both
      // first calls and retries before any digest, authorization, or audit.
      if (tool.mrtrArgs) {
        delete args[tool.mrtrArgs.idempotencyKey];
      }

      // Identity is also gateway-owned. Strip it before calculating an MRTR
      // argument digest so a spoofed value cannot invalidate a continuation.
      if (tool.identityArg !== undefined) {
        delete args[tool.identityArg];
      }

      if (isModern) {
        const headerProblem = validateModernToolParameterHeaders(
          request,
          tool.inputSchema,
          message.params?.arguments,
        );
        if (headerProblem) {
          if (headerProblem.kind === "schema") {
            // The tool's own inputSchema is malformed. That is a server
            // configuration error, not a client header mismatch, so it
            // must not be reported as -32020. Registration validates
            // this, so reaching here means a row predates that check or
            // was written past the client API.
            console.error(
              "[mcp-gateway] tool inputSchema has an invalid x-mcp-header annotation",
              tool.name,
              headerProblem.problem,
            );
            return modernErrorResponse(
              message.id,
              INTERNAL_ERROR,
              "Tool input schema is invalid",
              {},
              500,
            );
          }
          return modernErrorResponse(
            message.id,
            HEADER_MISMATCH,
            headerProblem.problem,
          );
        }
      }

      const requestState = message.params?.requestState;
      const inputResponses = message.params?.inputResponses;
      const declarativeTool = options.declarativeTools?.find(
        (candidate) => candidate.name === tool.name,
      );
      const beforeCall = declarativeTool?.beforeCall;
      // A registered row is "gated" when it promises a confirmation
      // hook: registered from a declarative catalog with `beforeCall`,
      // or reserving `mrtrArgs` (which is meaningless without one).
      const mrtrGated =
        tool.mrtrGated === true ||
        tool.mrtrArgs !== undefined ||
        beforeCall !== undefined;

      // Fail closed: a gated registry row served by a handler with no
      // matching hook (imperative registration, stale declarative
      // catalog, or a mount without the `tools` option) must never
      // dispatch ungated: that would silently skip the confirmation
      // the row promises, on any transport.
      if (mrtrGated && !beforeCall) {
        console.error(
          "[mcp-gateway] tool is registered as MRTR-gated but this " +
            "handler has no beforeCall for it; failing closed",
          tool.name,
        );
        body = jsonErrorEnvelope(
          message.id,
          INTERNAL_ERROR,
          `Tool "${tool.name}" requires a confirmation hook this ` +
            "deployment did not configure",
        );
        break;
      }

      // Task augmentation (`io.modelcontextprotocol/tasks`): validate the
      // whole negotiation before authorize so an unusable task request
      // never runs the tool synchronously as a silent fallback.
      const taskRequest = message.params?.task;
      if (taskRequest !== undefined) {
        if (!isModern) {
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            "Task-augmented calls require MCP protocol " +
              `${MODERN_PROTOCOL_VERSION} or later`,
          );
          break;
        }
        if (!options.tasks) {
          // Same "unsupported because unconfigured" shape as the
          // resource catalogs: the capability was never advertised.
          responseStatus = 404;
          body = jsonErrorEnvelope(
            message.id,
            -32601,
            "Tasks are not supported: the host did not configure task " +
              "execution",
          );
          break;
        }
        if (
          !isPlainObject(modernClientCapabilities?.[TASKS_CAPABILITY_KEY])
        ) {
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            `Task-augmented calls require the ${TASKS_CAPABILITY_KEY} ` +
              "client capability",
          );
          break;
        }
        if (
          !isPlainObject(taskRequest) ||
          (taskRequest.ttlMs !== undefined &&
            typeof taskRequest.ttlMs !== "number")
        ) {
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            "Invalid task request: expected an object with optional " +
              "numeric ttlMs",
          );
          break;
        }
        if (tool.taskSupport !== true) {
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            `Tool "${tool.name}" does not support task execution`,
          );
          break;
        }
        // Reject a deeply nested args value here, before it reaches the
        // createTask mutation whose arg serialization would overflow the
        // stack and escape as a raw 500.
        if (nestsTooDeep(args)) {
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            "Task arguments nest too deeply",
          );
          break;
        }
        // A non-object `arguments` (string, array, number) reaches a
        // synchronous dispatch as-is and the tool's own validator rejects
        // it. On the task path it would instead be PERSISTED first, and
        // the executor's `{...task.args}` spread would turn a string into
        // a character-indexed object before the tool ever saw it. Reject
        // it while the caller is still here to be told.
        if (!isPlainObject(args)) {
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            "Task arguments must be an object",
          );
          break;
        }
        if (!identity) {
          // Tasks are owner-bound rows; an anonymous caller could never
          // poll the result, so reject before creating unpollable state.
          // Use the real 401 + WWW-Authenticate challenge (same as the
          // authorize denial path) so browser clients begin OAuth
          // discovery instead of seeing an unactionable 200.
          raw = await requireAuthChallenge(ctx, request, component, message.id);
          body = "";
          break;
        }
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
      // A tool that declares identityArg structurally needs a caller,
      // and so does an MRTR hook (its contract passes a non-null
      // identity, and a continuation must bind to a principal). Deny as
      // Unauthorized regardless of what the host's authorize returned,
      // through this shared path so the client gets the real 401 +
      // WWW-Authenticate challenge and the denial lands in the audit
      // log like every other one.
      if (
        decision.allowed &&
        (tool.identityArg !== undefined || beforeCall !== undefined) &&
        !identity
      ) {
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

      // MRTR continuation verification, after authorization so denials
      // and anonymous callers went through the audited 401 path above.
      let continuation: VerifiedMrtrState | null = null;
      let mrtrArgsDigest: string | null = null;
      // A chain resolves exactly once, and remembers WHICH continuation
      // resolved it. Only that continuation may reproduce the outcome
      // (a client whose response was lost); every sibling is refused,
      // including one re-sent byte-identically, because its hook output
      // is not the settled result. Re-read after `beforeCall`, which is
      // an await point another branch can resolve the chain across.
      let chain: MrtrChainState = { status: "open" };
      // Digest of THIS request's `inputResponses` (absent when it
      // carries none). Compared against the digest the chain recorded
      // when it resolved, so a repeat has to present the same answer.
      let requestDigest: string | undefined;
      if (
        isModern &&
        (requestState !== undefined || inputResponses !== undefined)
      ) {
        if (!options.mrtr || requestState === undefined) {
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            "MRTR retries require configured state verification and requestState",
          );
          break;
        }
        if (!beforeCall) {
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            "Tool does not support declarative MRTR continuations",
          );
          break;
        }
        if (mrtrSecretTooShort(options.mrtr)) {
          // Server misconfiguration, never the client's fault: the
          // state being verified may be perfectly valid.
          console.error(
            "[mcp-gateway] mrtr.secret is shorter than 32 bytes; " +
              "refusing to verify continuations",
          );
          body = jsonErrorEnvelope(
            message.id,
            INTERNAL_ERROR,
            "MRTR is misconfigured on this gateway",
          );
          break;
        }
        if (inputResponses !== undefined && !isPlainObject(inputResponses)) {
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            "MRTR inputResponses must be an object",
          );
          break;
        }
        mrtrArgsDigest = await sha256Base64Url(stableJson(args));
        try {
          continuation = await verifyMrtrState(options.mrtr, requestState, {
            toolName: tool.name,
            identitySubject: auditIdentitySubject,
            argsDigest: mrtrArgsDigest,
          });
        } catch (err) {
          // Verification could not run (as opposed to running and
          // saying no): -32603, mirroring the sealing path.
          console.error(
            "[mcp-gateway] MRTR state verification failed to run",
            err,
          );
          body = jsonErrorEnvelope(
            message.id,
            INTERNAL_ERROR,
            "MRTR verification failed",
          );
          break;
        }
        if (!continuation) {
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            "Invalid, expired, or mismatched MRTR requestState",
          );
          break;
        }
        // One-time redemption: a continuation stays cryptographically
        // valid until its TTL, so first use pins the responses it was
        // answered with. A byte-identical re-send is an idempotent
        // replay (safe to re-process); different responses for the same
        // continuation would let a captured state flip an
        // already-resolved decision (decline -> accept) and are
        // rejected. Guarded like every sibling step: a redemption that
        // cannot RUN (e.g. the component deployment predates the
        // mrtrRedemptions table) is a logged -32603, not a raw 500 that
        // skips the CORS wrapper.
        if (inputResponses !== undefined) {
          requestDigest = await sha256Base64Url(stableJson(inputResponses));
        }
        let redemption: "fresh" | "replay" | "conflict";
        try {
          redemption = await ctx.runMutation(
            component.mrtr.redeemContinuation,
            {
              jti: continuation.jti,
              ...(requestDigest !== undefined
                ? { responsesDigest: requestDigest }
                : {}),
              expiresAt: continuation.exp,
            },
          );
        } catch (err) {
          console.error(
            "[mcp-gateway] MRTR continuation redemption failed to run " +
              "(is the component deployment up to date?)",
            tool.name,
            err,
          );
          body = jsonErrorEnvelope(
            message.id,
            INTERNAL_ERROR,
            "MRTR verification failed",
          );
          break;
        }
        if (redemption === "conflict") {
          // Either the replay-flip attack this mechanism exists for, or
          // a client re-collecting semantically identical answers into
          // byte-different responses. Make the event observable so an
          // operator can tell the two apart.
          console.warn(
            "[mcp-gateway] MRTR continuation redeemed with different " +
              "responses; rejecting",
            tool.name,
            continuation.jti,
          );
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            "This MRTR continuation was already used with different input " +
              "responses. Re-send the exact previous responses, or restart " +
              "the call without requestState",
          );
          break;
        }
      }

      // The host-side MRTR state machine. It runs before `runTool` on
      // the first call AND on every verified continuation, so the
      // decision to dispatch (accept), ask again (missing input), or
      // finish without dispatching (decline/cancel) lives in the
      // gateway hook; the underlying Convex function never parses MCP
      // envelopes. It runs on EVERY transport so required input is
      // never silently bypassed: when it demands input and the request
      // cannot carry a continuation (legacy protocol, or `mrtr` not
      // configured), the call fails closed instead of dispatching.
      //
      // A chain resolves exactly once. Read that state up front for a
      // verified continuation, so an already-resolved chain refuses the
      // outcomes that would re-open it (another input round, or a
      // dispatch) while still letting an idempotent re-send of a
      // completed call reproduce its result.
      if (beforeCall && continuation) {
        const read = await readMrtrChain(
          ctx,
          component,
          tool.name,
          continuation.idempotencyKey,
        );
        if (read.status === "error") {
          body = jsonErrorEnvelope(
            message.id,
            INTERNAL_ERROR,
            "MRTR verification failed",
          );
          break;
        }
        chain = read;
      }
      // Refuse a superseded continuation BEFORE running the host hook.
      // Only the continuation that actually resolved the chain has
      // anything to reproduce; every other branch is answering a
      // decision that is over, and running arbitrary client-chosen
      // `inputResponses` through host code just to discard the result
      // is work nobody asked for. `beforeCall` is not documented as
      // side-effect-free, so do not call it.
      if (
        continuation &&
        chain.status === "resolved" &&
        !(
          chain.resolvedByJti === continuation.jti &&
          chain.resolvedByDigest === requestDigest
        )
      ) {
        body = alreadyResolvedEnvelope(message.id, tool.name);
        break;
      }
      if (beforeCall) {
        // Digest BEFORE the hook, over the client-sent (stripped)
        // arguments: a hook that mutates even a nested value of its
        // (shallow-copied) argument object must not poison the digest
        // the next retry is checked against.
        const argsDigest =
          mrtrArgsDigest ?? (await sha256Base64Url(stableJson(args)));
        let requested: unknown;
        try {
          requested = await beforeCall(ctx, {
            // JSON round-trip: args are JSON by construction, and a
            // deep copy keeps hook-side normalization away from both
            // the digest above and the dispatch below.
            args: JSON.parse(JSON.stringify(args)) as Record<string, unknown>,
            identity: identity!,
            ...(continuation
              ? {
                  state: continuation.state,
                  ...(isPlainObject(inputResponses)
                    ? { inputResponses }
                    : {}),
                  idempotencyKey: continuation.idempotencyKey,
                  round: continuation.round,
                }
              : {}),
          });
        } catch (err) {
          console.error("[mcp-gateway] MRTR beforeCall failed", tool.name, err);
          body = jsonErrorEnvelope(
            message.id,
            INTERNAL_ERROR,
            "MRTR beforeCall failed",
          );
          break;
        }
        if (isMcpCompleteCallResult(requested)) {
          // Terminal without dispatch, e.g. a declined confirmation.
          // Valid on both eras: it is an ordinary tools/call result.
          // Validate the shape rather than forward a malformed result a
          // spec-compliant client would reject, matching how every other
          // hook output is checked.
          const problem = describeCompleteCallResultProblem(requested.result);
          if (problem) {
            console.error(
              "[mcp-gateway] MRTR beforeCall completeCall() returned a " +
                "malformed tools/call result",
              tool.name,
              problem,
            );
            body = jsonErrorEnvelope(
              message.id,
              INTERNAL_ERROR,
              "MRTR beforeCall returned an invalid result",
            );
            break;
          }
          // Terminal for the whole chain, so claim it before answering.
          // Only a continuation can be forked; a first call has no
          // earlier round to replay.
          //
          // A chain already resolved by a *completion* may reproduce
          // that result: the hook is deterministic over the same
          // inputs, so an idempotent re-send (a client whose response
          // was lost) legitimately gets its answer again. One resolved
          // by a dispatch may not: the tool has run, and telling the
          // caller "declined" afterwards would be a lie.
          if (continuation) {
            const fresh = await readMrtrChain(
              ctx,
              component,
              tool.name,
              continuation.idempotencyKey,
            );
            if (fresh.status === "error") {
              body = jsonErrorEnvelope(
                message.id,
                INTERNAL_ERROR,
                "MRTR verification failed",
              );
              break;
            }
            chain = fresh;
          }
          if (continuation) {
            // Reproducing a completion is legitimate for exactly one
            // continuation: the one that resolved the chain, re-sent
            // after its response was lost. Any sibling would be handing
            // the caller its own hook output as the settled result.
            const mayRepeat =
              chain.status === "resolved" &&
              isChainRepeat(
                chain,
                continuation.jti,
                requestDigest,
                "completed",
              );
            if (!mayRepeat) {
              const claim =
                chain.status === "resolved"
                  ? { ...chain, status: "lost" as const }
                  : await claimMrtrChain(
                      ctx,
                      component,
                      tool.name,
                      continuation.idempotencyKey,
                      continuation.jti,
                      requestDigest,
                      "completed",
                      Date.now() + MRTR_MAX_TTL_MS + MRTR_CLAIM_SLACK_MS,
                    );
              if (claim.status === "error") {
                body = jsonErrorEnvelope(
                  message.id,
                  INTERNAL_ERROR,
                  "MRTR verification failed",
                );
                break;
              }
              // Losing to a concurrent send of this very continuation
              // with this very answer is the same lost-response retry,
              // just interleaved. Refusing it would push the client to
              // start a new chain, i.e. a new idempotency key, i.e. the
              // duplicate the key exists to prevent.
              if (
                claim.status === "lost" &&
                !isChainRepeat(
                  claim,
                  continuation.jti,
                  requestDigest,
                  "completed",
                )
              ) {
                body = alreadyResolvedEnvelope(message.id, tool.name);
                break;
              }
            }
          }
          body = jsonResultEnvelope(message.id, requested.result);
          break;
        }
        if (requested !== null && requested !== undefined) {
          if (!isMcpInputRequiredResult(requested)) {
            // A host-side hook bug (e.g. completeCall with a non-object
            // result). Leave the operator a breadcrumb: tool name plus
            // the returned shape, never the value itself (it may carry
            // host-private state).
            console.error(
              "[mcp-gateway] MRTR beforeCall returned an invalid result",
              tool.name,
              isPlainObject(requested)
                ? `object keys: ${Object.keys(requested).join(", ")}`
                : typeof requested,
            );
            body = jsonErrorEnvelope(
              message.id,
              INTERNAL_ERROR,
              "MRTR beforeCall returned an invalid result",
            );
            break;
          }
          // Asking again on a chain that already resolved would mint a
          // fresh continuation for a decision that is over: exactly the
          // sibling an attacker needs. Re-read rather than trusting the
          // pre-hook snapshot, because `beforeCall` is an await point
          // another branch can resolve the chain across, and the
          // continuation minted here would outlive that branch's claim.
          // No repeat case applies: asking again is never a
          // reproduction of a terminal outcome.
          if (continuation) {
            const fresh = await readMrtrChain(
              ctx,
              component,
              tool.name,
              continuation.idempotencyKey,
            );
            if (fresh.status === "error") {
              body = jsonErrorEnvelope(
                message.id,
                INTERNAL_ERROR,
                "MRTR verification failed",
              );
              break;
            }
            chain = fresh;
          }
          if (chain.status === "resolved") {
            body = alreadyResolvedEnvelope(message.id, tool.name);
            break;
          }
          if (!isModern) {
            body = jsonErrorEnvelope(
              message.id,
              -32601,
              `Tool "${tool.name}" requires multi-round-trip input; ` +
                `connect with MCP protocol ${MODERN_PROTOCOL_VERSION} or later`,
            );
            break;
          }
          if (!options.mrtr) {
            console.error(
              "[mcp-gateway] beforeCall requested input but the `mrtr` " +
                "option is not configured; failing closed for tool",
              tool.name,
            );
            body = jsonErrorEnvelope(
              message.id,
              INTERNAL_ERROR,
              "MRTR is not configured on this gateway",
            );
            break;
          }
          if (mrtrSecretTooShort(options.mrtr)) {
            console.error(
              "[mcp-gateway] mrtr.secret is shorter than 32 bytes; " +
                "refusing to seal a continuation",
            );
            body = jsonErrorEnvelope(
              message.id,
              INTERNAL_ERROR,
              "MRTR is misconfigured on this gateway",
            );
            break;
          }
          const round = (continuation?.round ?? 0) + 1;
          if (round > MRTR_MAX_ROUNDS) {
            console.error(
              "[mcp-gateway] MRTR chain exceeded the round ceiling",
              tool.name,
            );
            body = jsonErrorEnvelope(
              message.id,
              INTERNAL_ERROR,
              "MRTR continuation exceeded the round limit",
            );
            break;
          }
          const inputRequests = requested.inputRequests ?? {};
          const requiredCapabilities = mrtrRequiredCapabilities(inputRequests);
          if (!requiredCapabilities) {
            // Another host-side hook bug: a request method or shape the
            // gateway cannot vouch for (typo'd method, unknown
            // elicitation mode). Name the offending methods so the hook
            // author can find it.
            console.error(
              "[mcp-gateway] MRTR beforeCall returned unsupported input " +
                "requests",
              tool.name,
              Object.values(inputRequests)
                .map((request) =>
                  isPlainObject(request)
                    ? String(request.method)
                    : typeof request,
                )
                .join(", "),
            );
            body = jsonErrorEnvelope(
              message.id,
              INTERNAL_ERROR,
              "MRTR beforeCall returned unsupported input requests",
            );
            break;
          }
          const missingCapabilities = missingMrtrCapabilities(
            // Guaranteed non-null here (validated for every modern
            // request, and legacy requests broke at the -32601 above);
            // the fallback only satisfies the type system.
            modernClientCapabilities ?? {},
            requiredCapabilities,
          );
          if (Object.keys(missingCapabilities).length > 0) {
            return modernErrorResponse(
              message.id,
              -32021,
              "Client lacks a capability required for MRTR input requests",
              // Per spec, data.requiredCapabilities lists only what is
              // MISSING, not the full required set.
              { requiredCapabilities: missingCapabilities },
            );
          }
          try {
            body = jsonResultEnvelope(message.id, {
              resultType: "input_required",
              ...(Object.keys(inputRequests).length > 0
                ? { inputRequests }
                : {}),
              requestState: await sealMrtrState(options.mrtr, {
                toolName: tool.name,
                identitySubject: auditIdentitySubject,
                argsDigest,
                state: requested.state ?? null,
                // Round 1 mints the chain's key; later rounds carry it.
                idempotencyKey:
                  continuation?.idempotencyKey ?? crypto.randomUUID(),
                round,
              }),
            });
          } catch (err) {
            console.error(
              "[mcp-gateway] failed to seal MRTR requestState",
              tool.name,
              err,
            );
            body = jsonErrorEnvelope(
              message.id,
              INTERNAL_ERROR,
              "Failed to create MRTR request state",
            );
          }
          break;
        }
      }

      // Dispatch resolves the chain, so claim it first: the claim is
      // the decision, not a record of one. Without this, a replay that
      // re-runs the hook mints an unpinned sibling continuation that
      // stays answerable after another branch already resolved, and a
      // captured `requestState` could still turn a decline into a
      // dispatch. Claiming also makes dispatch at-most-once per chain
      // gateway-side, ahead of the tool's own idempotency key.
      // A chain resolved by a dispatch may dispatch again: that is the
      // idempotent replay of an accept whose response was lost, and the
      // mandatory `mrtrArgs` key is what stops the tool double-applying
      // it. A chain resolved by a *completion* may not: turning a
      // settled decline into a run is precisely the flip being
      // prevented.
      if (beforeCall && continuation) {
        const fresh = await readMrtrChain(
          ctx,
          component,
          tool.name,
          continuation.idempotencyKey,
        );
        if (fresh.status === "error") {
          body = jsonErrorEnvelope(
            message.id,
            INTERNAL_ERROR,
            "MRTR verification failed",
          );
          break;
        }
        chain = fresh;
        // Only the continuation that dispatched may dispatch again,
        // which is the lost-response retry the tool deduplicates via
        // its injected idempotency key. Everything else claims, and
        // losing the claim means another branch settled this chain
        // first: there is no idempotent case for a second dispatch.
        const mayRepeat =
          chain.status === "resolved" &&
          isChainRepeat(chain, continuation.jti, requestDigest, "dispatched");
        if (!mayRepeat) {
          const claim =
            chain.status === "resolved"
              ? { ...chain, status: "lost" as const }
              : await claimMrtrChain(
                  ctx,
                  component,
                  tool.name,
                  continuation.idempotencyKey,
                  continuation.jti,
                  requestDigest,
                  "dispatched",
                  Date.now() + MRTR_MAX_TTL_MS + MRTR_CLAIM_SLACK_MS,
                );
          if (claim.status === "error") {
            body = jsonErrorEnvelope(
              message.id,
              INTERNAL_ERROR,
              "MRTR verification failed",
            );
            break;
          }
          // As on the completion path: losing to a concurrent send of
          // the same continuation with the same answer is that same
          // retry, and dispatching it again under the unchanged chain
          // key is what the tool deduplicates on.
          if (
            claim.status === "lost" &&
            !isChainRepeat(
              claim,
              continuation.jti,
              requestDigest,
              "dispatched",
            )
          ) {
            body = alreadyResolvedEnvelope(message.id, tool.name);
            break;
          }
        }
      }

      // Task-augmented call: create the durable task row and return the
      // handle immediately; the tool runs after this request completes
      // (built-in scheduled executor) or inside the host's own durable
      // execution.
      //
      // Ordering matters, and this is deliberately the LAST gate before
      // dispatch would have happened:
      //   - after authorize, so a denied caller cannot create tasks;
      //   - after the identityArg strip, so the stored args snapshot is
      //     the public argument set;
      //   - after the MRTR `beforeCall` hook, so no durable row exists
      //     until the hook approved the call. A hook that demands input
      //     answered with the `input_required` envelope above and created
      //     nothing, which keeps MRTR's one negotiation channel intact:
      //     a task-augmented MRTR tool negotiates over `requestState`
      //     first and only then becomes a task.
      //   - after the chain claim above, which is the load-bearing one.
      //     Creating a task is a TERMINAL resolution of the chain, not a
      //     deferral of one: it returns a handle INSTEAD of dispatching,
      //     and once the row exists the executor runs the tool with no
      //     further gate. So it must be covered by the same
      //     `resolution: "dispatched"` claim as a synchronous dispatch —
      //     otherwise a task-augmented continuation of a chain another
      //     branch already settled (a decline, say) would create a row
      //     that quietly runs the tool. A lost claim broke above with
      //     `alreadyResolvedEnvelope` and created nothing.
      if (taskRequest !== undefined && options.tasks && identity) {
        const taskId = generateSessionId();
        // A verified continuation carries the chain's idempotency key, and
        // the executor injects the task row's key into `mrtrArgs`. Reusing
        // it means a replayed continuation (`redemption === "replay"`)
        // that lands as a second task still dedupes inside the tool,
        // exactly as a replayed synchronous continuation does.
        const idempotencyKey =
          continuation?.idempotencyKey ?? crypto.randomUUID();
        const executor = options.tasks.execute ? "host" : "component";
        // A client may only shorten retention, never extend it past the
        // host's configured ceiling (or the 24h default, mirroring the
        // component's TASK_DEFAULT_TTL_MS). The component additionally
        // clamps to the global [1 minute, 7 days] bounds.
        const hostRetentionMs =
          options.tasks.retentionMs ?? TASK_DEFAULT_RETENTION_MS;
        const requestedTtlMs =
          isPlainObject(taskRequest) && typeof taskRequest.ttlMs === "number"
            ? Math.min(taskRequest.ttlMs, hostRetentionMs)
            : hostRetentionMs;
        // A task created from a continuation must outlive every
        // continuation that could ask for it again. Otherwise a client
        // that shortens `ttlMs` below the continuation's own lifetime gets
        // the reuse lookup to miss (the row is expired, so it is not
        // reusable) and every replay mints another task and another tool
        // run from one chain — the exact duplication the shared chain key
        // exists to prevent.
        const ttlMs =
          continuation !== null
            ? Math.max(requestedTtlMs, continuation.exp - Date.now())
            : requestedTtlMs;
        const created = await ctx.runMutation(component.tasks.createTask, {
          taskId,
          ownerSubject: identity.subject,
          ...(options.tasks.scope !== undefined
            ? { scope: options.tasks.scope }
            : {}),
          toolName: tool.name,
          toolKind: tool.kind,
          args,
          caller: identity,
          idempotencyKey,
          executor,
          // The hook ran above and returned null (approve); record it so
          // the executor can tell "this call was confirmed" from "this
          // task predates the tool becoming gated".
          ...(beforeCall !== undefined ? { mrtrApproved: true } : {}),
          ...(ttlMs !== undefined ? { ttlMs } : {}),
        });
        if (!created.created) {
          // Client-caused rejections map to INVALID_PARAMS with a clear
          // message; a duplicate 128-bit id is genuinely-broken and logs.
          const clientReason: Record<string, string | undefined> = {
            args_too_large:
              "Task arguments exceed the permitted serialized size",
            caller_too_large:
              "The caller identity is too large to snapshot for a task",
            limit_exceeded:
              "Too many active tasks for this caller; poll or cancel " +
              "existing tasks before creating more",
          };
          const message_ = clientReason[created.reason];
          if (message_ === undefined) {
            console.error(
              "[mcp-gateway] task creation failed",
              created.reason,
              tool.name,
            );
          }
          body = jsonErrorEnvelope(
            message.id,
            message_ !== undefined ? INVALID_PARAMS : INTERNAL_ERROR,
            message_ ?? "Failed to create task",
          );
          break;
        }
        // The id the CLIENT gets. Normally the one just generated, but a
        // replayed continuation is answered with the task its chain key
        // already owns, so every step below must speak about that row, not
        // the id this request happened to mint and never used.
        const effectiveTaskId = created.task.taskId;
        // A reused row is normally the task the original request already
        // started, and starting again would run the host's workflow twice
        // for one task. `startPending` is the exception the component
        // reports: the row is host-executed, non-terminal, and was never
        // marked started, so its original request died between creating it
        // and getting execution going. This retry is that row's only
        // chance — skipping it would hand back a handle nothing advances.
        const mustStart =
          created.reused !== true || created.startPending === true;
        if (created.startPending === true) {
          console.warn(
            "[mcp-gateway] starting a reused task whose original request " +
              "never recorded a start",
            effectiveTaskId,
            tool.name,
          );
        }
        if (options.tasks.execute && mustStart) {
          try {
            await options.tasks.execute(ctx, {
              taskId: effectiveTaskId,
              toolName: tool.name,
              toolKind: tool.kind,
              args,
              identity,
              idempotencyKey,
              expiresAt: created.task.expiresAt,
            });
            // Durable execution is going; record it so a replay of this
            // request reuses the row without starting a second run, and so
            // a replay after a FAILED start still starts one.
            try {
              await ctx.runMutation(component.tasks.markTaskStarted, {
                taskId: effectiveTaskId,
              });
            } catch (markErr) {
              // Losing the marker only costs an extra start on a replay,
              // which the host's idempotency key already absorbs. Do not
              // fail a task whose execution is running.
              console.warn(
                "[mcp-gateway] could not record that task execution started",
                effectiveTaskId,
                markErr,
              );
            }
          } catch (err) {
            // The executor could not start durable execution; fail the
            // task so the client is not left polling a dead handle.
            console.error(
              "[mcp-gateway] task executor threw during start",
              tool.name,
              err,
            );
            let failed: string | null = null;
            try {
              failed = await ctx.runMutation(component.tasks.failTask, {
                taskId: effectiveTaskId,
                error: {
                  code: INTERNAL_ERROR,
                  message: "Task failed to start",
                },
                auditErrorMessage:
                  err instanceof Error ? err.message : String(err),
              });
            } catch (failErr) {
              // Double fault: the row could not be failed either. The
              // client still gets a clean error (not a raw 500); the
              // orphaned working row is bounded by its TTL.
              console.error(
                "[mcp-gateway] failed to mark task as failed after " +
                  "executor start error",
                effectiveTaskId,
                failErr,
              );
            }
            if (failed !== null && failed !== "finalized") {
              // The throw came AFTER the executor advanced the task: it
              // already completed, was cancelled, or is awaiting input
              // (a `requireTaskInput` that succeeded before the hook
              // threw). Reporting "failed to start" would strand a live
              // task behind an error envelope with no handle, so hand
              // back the handle and let the recorded state speak.
              console.error(
                "[mcp-gateway] task executor threw after the task had " +
                  "already advanced (" +
                  failed +
                  "); durable execution may still be running, so the " +
                  "recorded task state is authoritative, not this error",
                effectiveTaskId,
              );
            } else {
              body = jsonErrorEnvelope(
                message.id,
                INTERNAL_ERROR,
                "Task failed to start",
              );
              break;
            }
          }
        }
        // `created.task` is a snapshot from before `execute` ran, and a
        // host executor may legitimately advance the row inside this same
        // request (a `requireTaskInput` that puts it straight into
        // `input_required`). Re-read so the handle we return does not
        // advertise a status the database no longer holds; fall back to
        // the snapshot if the read fails, since the row demonstrably
        // exists and the client can just poll.
        let descriptor_ = created.task;
        if (options.tasks.execute && mustStart) {
          try {
            const fresh = await ctx.runQuery(component.tasks.getTaskForOwner, {
              taskId: effectiveTaskId,
              ownerSubject: identity.subject,
              ...(options.tasks.scope !== undefined
                ? { scope: options.tasks.scope }
                : {}),
            });
            if (fresh) descriptor_ = fresh;
          } catch (err) {
            console.warn(
              "[mcp-gateway] could not re-read the created task; returning " +
                "the pre-execution snapshot",
              effectiveTaskId,
              err,
            );
          }
        }
        body = jsonResultEnvelope(message.id, {
          resultType: "task",
          task: {
            ...descriptor_,
            pollIntervalMs:
              options.tasks.pollIntervalMs ?? TASK_POLL_INTERVAL_MS,
          },
        });
        break;
      }

      // Allowed (and hook-approved, when one exists): dispatch via the
      // component. Only the chain's idempotency key is ever injected;
      // continuation state and input responses stayed in the hook, so
      // the Convex function remains MCP-unaware.
      const dispatchArgs =
        continuation && tool.mrtrArgs
          ? {
              ...args,
              [tool.mrtrArgs.idempotencyKey]: continuation.idempotencyKey,
            }
          : args;
      const dispatched = await ctx.runAction(component.dispatch.runTool, {
        name,
        args: dispatchArgs,
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

    case "tasks/get":
    case "tasks/update": {
      // Task methods exist only on the modern protocol: a legacy client
      // could never have created a task in the first place.
      if (!isModern) {
        body = jsonErrorEnvelope(
          message.id,
          -32601,
          `Unsupported method: ${message.method}`,
        );
        break;
      }
      if (!options.tasks) {
        // Never advertised (see server/discover): unknown method.
        responseStatus = 404;
        body = jsonErrorEnvelope(
          message.id,
          -32601,
          `Unsupported method: ${message.method}`,
        );
        break;
      }
      if (!identity) {
        // Tasks are owner-bound; without an identity there is nothing a
        // task lookup could legally return. 401 + WWW-Authenticate so
        // browser clients begin OAuth discovery.
        raw = await requireAuthChallenge(ctx, request, component, message.id);
        body = "";
        break;
      }
      const taskId = message.params?.taskId;
      if (typeof taskId !== "string" || taskId.length === 0) {
        body = jsonErrorEnvelope(
          message.id,
          INVALID_PARAMS,
          "Missing task id",
        );
        break;
      }
      const pollIntervalMs =
        options.tasks.pollIntervalMs ?? TASK_POLL_INTERVAL_MS;

      if (message.method === "tasks/get") {
        const task = await ctx.runQuery(component.tasks.getTaskForOwner, {
          taskId,
          ownerSubject: identity.subject,
          // Scope binds the task to the mount that created it: without
          // it, a mount with a narrower policy can serve a task the
          // caller started on a broader one.
          ...(options.tasks.scope !== undefined
            ? { scope: options.tasks.scope }
            : {}),
        });
        if (!task) {
          // Unknown, foreign, and expired ids answer identically so a
          // task's existence never leaks across callers.
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            `Unknown task: ${taskId}`,
          );
          break;
        }
        body = jsonResultEnvelope(message.id, {
          resultType: "task",
          task: { ...task, pollIntervalMs },
        });
        break;
      }

      // tasks/update: exactly one of `action: "cancel"` or MRTR-shaped
      // `inputResponses`.
      const updateAction = message.params?.action;
      const inputResponses = message.params?.inputResponses;
      // The round the client is answering, echoed from the descriptor it
      // polled. Optional, but a malformed value is rejected rather than
      // coerced to "absent": absence is itself meaningful (it means
      // "answering a task that never asked a round"), so coercing `"1"`
      // or `1.5` would answer a client's type bug with the factually
      // wrong "these responses answer a superseded input round".
      const inputRoundRaw = message.params?.inputRound;
      const inputRound =
        inputRoundRaw === undefined ? undefined : Number(inputRoundRaw);
      if (
        inputRoundRaw !== undefined &&
        !(
          typeof inputRoundRaw === "number" &&
          Number.isSafeInteger(inputRoundRaw) &&
          inputRoundRaw >= 0
        )
      ) {
        body = jsonErrorEnvelope(
          message.id,
          INVALID_PARAMS,
          "inputRound must be a non-negative integer",
        );
        break;
      }
      if (
        (updateAction === undefined) === (inputResponses === undefined) ||
        (updateAction !== undefined && updateAction !== "cancel")
      ) {
        body = jsonErrorEnvelope(
          message.id,
          INVALID_PARAMS,
          'tasks/update requires exactly one of action: "cancel" or ' +
            "inputResponses",
        );
        break;
      }
      // Reject a deeply nested inputResponses before it reaches the
      // submit mutation's serialization (would overflow into a raw 500).
      if (inputResponses !== undefined && nestsTooDeep(inputResponses)) {
        body = jsonErrorEnvelope(
          message.id,
          INVALID_PARAMS,
          "inputResponses nest too deeply",
        );
        break;
      }

      if (updateAction === "cancel") {
        const cancelled = await ctx.runMutation(
          component.tasks.cancelTaskForOwner,
          {
            taskId,
            ownerSubject: identity.subject,
            ...(options.tasks.scope !== undefined
              ? { scope: options.tasks.scope }
              : {}),
          },
        );
        if (cancelled.outcome === "not_found") {
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            `Unknown task: ${taskId}`,
          );
          break;
        }
        if (cancelled.outcome === "conflict") {
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            `Task is already ${cancelled.status} and cannot be cancelled`,
          );
          break;
        }
        // Notify the host so it can stop its workflow run. Idempotent
        // repeats re-fire the hook on purpose: the hook is best-effort,
        // so re-sending the cancel is the client's (and operator's) way
        // to retry a notification that previously threw. Hooks must
        // therefore be idempotent (see docs/tasks.md).
        if (options.tasks.onCancel) {
          try {
            await options.tasks.onCancel(ctx, {
              taskId,
              toolName: cancelled.task.toolName,
            });
          } catch (err) {
            console.error(
              "[mcp-gateway] tasks onCancel hook threw; the task is " +
                "cancelled but the host workflow may still be running. " +
                "Re-sending the cancel retries the notification.",
              taskId,
              err,
            );
          }
        } else {
          // The row is cancelled either way, so the wire answer is
          // correct — but if this task is host-executed, nothing here can
          // stop the run. Silence would make a misconfigured mount (or a
          // task created on a different mount, since the task table is
          // component-wide) indistinguishable from a working one.
          console.warn(
            "[mcp-gateway] task cancelled on a mount with no onCancel hook; " +
              "a host-executed run will not be stopped",
            taskId,
            cancelled.task.toolName,
          );
        }
        body = jsonResultEnvelope(message.id, {
          resultType: "task",
          task: { ...cancelled.task, pollIntervalMs },
        });
        break;
      }

      const submitted = await ctx.runMutation(
        component.tasks.submitInputResponsesForOwner,
        {
          taskId,
          ownerSubject: identity.subject,
          ...(options.tasks.scope !== undefined
            ? { scope: options.tasks.scope }
            : {}),
          inputResponses,
          ...(inputRound !== undefined ? { inputRound } : {}),
        },
      );
      switch (submitted.outcome) {
        case "not_found":
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            `Unknown task: ${taskId}`,
          );
          break;
        case "stale_round":
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            `These responses answer a superseded input round; the task is ` +
              `now awaiting round ${submitted.expectedRound}`,
          );
          break;
        case "conflict":
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            `Task is ${submitted.status} and does not accept input responses`,
          );
          break;
        case "mismatch":
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            "inputResponses must answer exactly the requested input keys " +
              'with an action of "accept", "decline", or "cancel"',
          );
          break;
        case "too_large":
          body = jsonErrorEnvelope(
            message.id,
            INVALID_PARAMS,
            "inputResponses exceed the permitted serialized size",
          );
          break;
        case "cancelled":
          // Every response carried action "cancel": treated as an owner
          // cancellation, including the host notification.
          if (options.tasks.onCancel) {
            try {
              await options.tasks.onCancel(ctx, {
                taskId,
                toolName: submitted.task.toolName,
              });
            } catch (err) {
              console.error(
                "[mcp-gateway] tasks onCancel hook threw; the task is " +
                  "cancelled but the host workflow may still be running. " +
                  "Re-sending the same responses retries the notification.",
                taskId,
                err,
              );
            }
          } else {
            console.warn(
              "[mcp-gateway] input responses cancelled the task on a mount " +
                "with no onCancel hook; a host-executed run will not be " +
                "stopped",
              taskId,
              submitted.task.toolName,
            );
          }
          body = jsonResultEnvelope(message.id, {
            resultType: "task",
            task: { ...submitted.task, pollIntervalMs },
          });
          break;
        case "duplicate":
        case "accepted": {
          // Duplicates re-fire the hook on purpose: the hook is the only
          // signal that resumes a paused host workflow, and it is
          // best-effort. If it threw on the fresh acceptance, re-sending
          // the same responses is the client's recovery path, so it must
          // reach the host again. Hooks are required to be idempotent
          // (see docs/tasks.md). Re-sent all-cancel responses do NOT
          // arrive here: the component reports them as `cancelled` above,
          // which is what re-fires `onCancel`.
          if (options.tasks.onInputResponses) {
            try {
              await options.tasks.onInputResponses(ctx, {
                taskId,
                toolName: submitted.task.toolName,
                inputResponses: inputResponses as Record<string, unknown>,
              });
            } catch (err) {
              // The responses are durably stored on the row and the
              // client can retry the notification by re-sending them.
              console.error(
                "[mcp-gateway] tasks update hook threw; the responses are " +
                  "stored but the host workflow was not notified. " +
                  "Re-sending the same tasks/update retries the hook.",
                taskId,
                err,
              );
            }
          } else {
            // Storing the responses is not the point: resuming the paused
            // execution is, and only the hook can do that. The client sees
            // success either way, so this is the operator's only signal.
            console.warn(
              "[mcp-gateway] tasks/update accepted input responses on a " +
                "mount with no onInputResponses hook; a host-executed task " +
                "will not resume",
              taskId,
              submitted.task.toolName,
            );
          }
          body = jsonResultEnvelope(message.id, {
            resultType: "task",
            task: { ...submitted.task, pollIntervalMs },
          });
          break;
        }
      }
      break;
    }

    default:
      if (isModern) responseStatus = 404;
      body = jsonErrorEnvelope(
        message.id,
        -32601,
        `Unsupported method: ${message.method}`,
      );
  }

  if (raw) return raw;

  if (isModern) {
    body = finalizeModernResult(body, message.method!, options);
  }

  if (responseStatus !== 200) {
    return new Response(body, {
      status: responseStatus,
      headers: { "content-type": "application/json" },
    });
  }

  const headers: Record<string, string> = {};
  if (issueSessionHeader) headers["mcp-session-id"] = sessionId;

  if (clientWantsSse(request)) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        // 2026-07-28 dropped `Last-Event-ID` resumability, so an event id
        // carries no meaning there. Legacy frames keep id 1, identical
        // across every session-based revision (see sseResponseFrame).
        controller.enqueue(encoder.encode(sseResponseFrame(body, isModern)));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        ...headers,
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        // Spec SHOULD: tell reverse proxies (nginx) not to buffer the
        // stream, otherwise events are held back until the response ends.
        "x-accel-buffering": "no",
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
