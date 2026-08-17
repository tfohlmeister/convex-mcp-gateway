import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const toolKindValidator = v.union(
  v.literal("query"),
  v.literal("mutation"),
  v.literal("action"),
);

export const auditOutcomeValidator = v.union(
  v.literal("allowed"),
  v.literal("denied"),
  v.literal("error"),
);

export const auditEntryTypeValidator = v.union(
  v.literal("tool"),
  v.literal("resource"),
  v.literal("task"),
);

export const resourceAuditOperationValidator = v.union(
  v.literal("list"),
  v.literal("read"),
  v.literal("templates_list"),
);

export const taskAuditOperationValidator = v.union(
  v.literal("create"),
  v.literal("input"),
  v.literal("cancel"),
  v.literal("complete"),
  v.literal("fail"),
);

export const taskStatusValidator = v.union(
  v.literal("working"),
  v.literal("input_required"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export default defineSchema({
  tools: defineTable({
    name: v.string(),
    description: v.string(),
    kind: toolKindValidator,
    functionHandle: v.string(),
    inputSchema: v.any(),
    /**
     * Optional MCP `outputSchema` (JSON Schema). When set, tools/list
     * advertises it and tools/call wraps results in `structuredContent`
     * alongside the text-JSON `content`. Pre-existing rows without the
     * column stay valid courtesy of `v.optional`.
     */
    outputSchema: v.optional(v.any()),
    /**
     * Name of the tool-function argument the gateway fills with the
     * resolved caller identity before dispatch. Excluded from the
     * advertised inputSchema and stripped from caller args. Optional;
     * unset means the tool takes no injected identity. Pre-existing rows
     * without the column stay valid courtesy of `v.optional`.
     */
    identityArg: v.optional(v.string()),
    /**
     * Name of the tool argument the gateway fills with the MRTR
     * continuation's stable idempotency key when a verified retry
     * continues to dispatch (and with the task's own idempotency key
     * when the tool runs as an MCP task). Excluded from the advertised
     * inputSchema and stripped from caller args. Continuation state and
     * input responses are never injected; they stay in the host-side hook.
     */
    mrtrArgs: v.optional(
      v.object({
        idempotencyKey: v.string(),
      }),
    ),
    /**
     * True when the tool was registered with a host-side `beforeCall`
     * hook (or reserves `mrtrArgs`). A gated row must never dispatch
     * without its hook: a handler serving this registry without a
     * matching `beforeCall` fails the call closed instead of silently
     * skipping the confirmation the row promises.
     */
    mrtrGated: v.optional(v.boolean()),
    /**
     * Opt-in MCP Tasks support (`io.modelcontextprotocol/tasks`). Only a
     * tool that sets this may be invoked as a task-augmented modern
     * `tools/call`; the catalog advertises it as
     * `execution: { taskSupport: "optional" }` when the host has
     * configured task execution. Pre-existing rows without the column
     * stay valid courtesy of `v.optional`.
     */
    taskSupport: v.optional(v.boolean()),
    /** MCP-facing title, annotations, `_meta`, and security schemes. */
    protocolMetadata: v.optional(v.any()),
    metadata: v.optional(v.any()),
  })
    .index("by_name", ["name"])
    // Gate consistency is checked per function, not per name: one Convex
    // function reached through both a gated and an ungated tool would
    // let a caller skip the confirmation.
    .index("by_functionHandle", ["functionHandle"]),

  resources: defineTable({
    uri: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    metadata: v.optional(v.any()),
  }).index("by_uri", ["uri"]),

  /**
   * Persisted MCP resource templates (RFC 6570), the template counterpart
   * of `resources`. Stores catalog metadata only, never the `read`
   * handler or matcher. `annotations` is stored as `v.any()` (its shape is
   * validated host-side before write); `title`/`annotations` are persisted
   * here (unlike concrete resources, where they are runtime-only) so a
   * registry-only template still lists its full descriptor.
   */
  resourceTemplates: defineTable({
    uriTemplate: v.string(),
    name: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    annotations: v.optional(v.any()),
    /**
     * Icons a client may display next to the template. Stored as `v.any()`
     * like `annotations` (the shape is validated host-side before the
     * write), and persisted for the same reason `title` is: a registry-only
     * template must still list its full descriptor.
     */
    icons: v.optional(v.any()),
  }).index("by_uriTemplate", ["uriTemplate"]),

  /**
   * Singleton row holding the OAuth 2.1 protected-resource metadata.
   * Empty until the host calls `gateway.setOAuthConfig`.
   *
   * Authorization itself is **not** stored here: it lives in the host
   * as a regular JS callback passed to `gateway.handleMcpRequest`,
   * because Convex doesn't propagate `ctx.auth` into component code.
   *
   * A row exists at most once. We don't use an index because lookups
   * always fetch the single row.
   */
  config: defineTable({
    /**
     * Issuer URL of the OAuth 2.1 authorization server that hands out
     * Bearer tokens for this MCP gateway. Surfaced via
     * `/.well-known/oauth-protected-resource` so MCP clients can discover
     * the AS automatically.
     */
    authServerUrl: v.optional(v.string()),
    /**
     * Canonical resource URL for this MCP server, returned in the
     * protected-resource metadata. Optional: when unset, the discovery
     * endpoint derives it from the inbound request URL (without the
     * `/.well-known/...` suffix), which is correct for single-tenant
     * deployments.
     */
    resourceUrl: v.optional(v.string()),
    /**
     * Legacy field from the pre-callback authorizer model. Tolerated
     * here so old deployments deploy cleanly; the new `setOAuthConfig`
     * uses `db.replace` and silently drops it. Will be removed in a
     * future release.
     */
    authorizerHandle: v.optional(v.string()),
    /**
     * Fingerprint of the declarative tool catalog last synced via the
     * `tools` option of `handleMcpRequest`. Lets the host skip rewriting
     * the registry when the list is unchanged (the common case on every
     * `initialize`). Set by the declarative sync, cleared by the
     * imperative `register` path. Optional: absent means "never synced
     * declaratively".
     */
    toolsFingerprint: v.optional(v.string()),
    /**
     * Fingerprint of the declarative resource catalog last synced via
     * `handleMcpRequest`. Resource contents/read handlers are not stored
     * here; the registry stores stable catalog metadata only.
     */
    resourcesFingerprint: v.optional(v.string()),
    /**
     * Fingerprint of the declarative resource-template catalog last synced
     * via the `resourceTemplates` option of `handleMcpRequest`. Mirrors
     * `resourcesFingerprint`; absent means "never synced declaratively".
     */
    templatesFingerprint: v.optional(v.string()),
  }),

  /**
   * MCP Streamable HTTP sessions. Created on `initialize` if the client
   * negotiated session-aware transport, looked up on every subsequent
   * request, and deleted on explicit `DELETE` or after a server-side
   * timeout (managed by the host via a cron, not the component).
   *
   * `sessionId` is a 128-bit cryptographically random hex string,
   * matching the MCP 2025-06-18 requirement that it be globally unique
   * and consist of visible ASCII characters only.
   *
   * `identitySubject` records the JWT `sub` claim that initialised the
   * session (or `null` for anonymous initialisation). It is set at
   * create time and never changes; `DELETE /mcp/` requires the same
   * subject to authorise teardown, so a leaked session id alone
   * cannot DoS an authenticated user's session. Optional for
   * forward-compat with pre-binding session rows: such rows skip the
   * identity check on DELETE.
   */
  sessions: defineTable({
    sessionId: v.string(),
    protocolVersion: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    identitySubject: v.optional(v.union(v.string(), v.null())),
  })
    .index("by_sessionId", ["sessionId"])
    .index("by_lastSeenAt", ["lastSeenAt"]),

  /**
   * Opt-in MCP resource subscriptions, one row per (session, resource URI).
   * Populated by `resources/subscribe` and cleared by `resources/unsubscribe`
   * (and cascaded on session teardown). The gateway's own HTTP transport
   * cannot push `notifications/resources/updated`, so this table only
   * *records intent*: a host that fronts the gateway with a push-capable
   * transport reads it via `listResourceSubscribers` to decide whom to
   * notify. Rows orphaned by idle-pruned sessions are cleaned by
   * `pruneOrphanResourceSubscriptions`.
   */
  subscriptions: defineTable({
    sessionId: v.string(),
    uri: v.string(),
    createdAt: v.number(),
  })
    .index("by_session_uri", ["sessionId", "uri"])
    .index("by_uri", ["uri"]),

  /**
   * One-time redemption of MRTR continuations, one row per redeemed
   * continuation id (`jti`, minted into the sealed `requestState`).
   * A continuation stays cryptographically valid until its TTL, so
   * without this table a captured `requestState` could be replayed
   * with different `inputResponses` and flip an already-resolved
   * decision (decline to accept) on that same continuation. First
   * redemption wins: a retry with byte-identical responses is an
   * idempotent replay and re-processes; different responses for the
   * same `jti` are rejected. Expired rows are dropped by
   * `pruneMrtrRedemptions` from a host cron.
   *
   * This is per continuation. Chain-level resolution lives in
   * `mrtrChains` below, because `jti` is fresh per round and cannot
   * express "this conversation is over".
   */
  mrtrRedemptions: defineTable({
    jti: v.string(),
    responsesDigest: v.string(),
    expiresAt: v.number(),
  })
    .index("by_jti", ["jti"])
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * One row per resolved MRTR chain, keyed by the chain's stable
   * idempotency key (constant across every round, unlike `jti`).
   *
   * A chain resolves exactly once, when the gateway either dispatches
   * the tool or finishes the call itself via `completeCall()`. The row
   * is inserted BEFORE either happens, so the insert is the decision:
   * whoever claims first wins, and every other continuation of that
   * chain is refused afterwards.
   *
   * Without it, redemption only protects a single continuation. Each
   * `inputRequired()` seals a new `jti` with no row of its own, so any
   * path that makes the hook ask again (an idempotent replay, or a
   * state-only retry) forks an independent branch that stays answerable
   * after a sibling already resolved the decision. Claiming the chain
   * closes every branch at once: only the continuation that resolved
   * the chain, re-sent with the same answer, may dispatch again. That
   * repeat is deliberate (a client whose response was lost), so the
   * gateway does NOT make dispatch strictly at-most-once; the tool's
   * injected idempotency key is what keeps the side effect single.
   *
   * Expired rows are dropped by `pruneMrtrRedemptions` alongside the
   * redemption rows, so hosts wire one cron, not two.
   */
  mrtrChains: defineTable({
    chainKey: v.string(),
    /** What resolved it, for operator forensics. Never sent on the wire. */
    resolution: v.union(v.literal("dispatched"), v.literal("completed")),
    /**
     * WHICH continuation resolved it. A lost response may be retried,
     * so the resolving continuation is allowed to reproduce its own
     * outcome; every other continuation of the chain is not, even one
     * re-sent byte-identically. Without this the gateway could only ask
     * "was this continuation re-sent?", which a sibling also answers
     * yes to, letting it pass its own hook output off as the
     * chain's settled result.
     */
    resolvedByJti: v.string(),
    /**
     * Digest of the `inputResponses` that continuation carried, absent
     * when it carried none. A repeat has to present the same answer,
     * not just the same continuation: otherwise the holder of a
     * state-only continuation that already resolved the chain could
     * re-send it with arbitrary responses and run the host's hook on a
     * settled decision.
     */
    resolvedByDigest: v.optional(v.string()),
    expiresAt: v.number(),
  })
    .index("by_chainKey", ["chainKey"])
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * MCP Tasks (`io.modelcontextprotocol/tasks`): one row per task-augmented
   * modern `tools/call`. The row is the durable source of truth for the
   * task lifecycle (`working` → `input_required` ⇄ `working` →
   * `completed` | `failed` | `cancelled`); the client polls it via
   * `tasks/get` and updates it via `tasks/update`, and the host finalizes
   * it through the trusted `completeTask` / `failTask` /
   * `requireTaskInput` client APIs.
   *
   * `taskId` is a 128-bit cryptographically random hex string generated
   * host-side (never client-supplied). `ownerSubject` binds the task to
   * the authenticated caller that created it; every owner-facing read or
   * update must match it, and a mismatch is answered exactly like an
   * unknown id so foreign tasks are unobservable.
   *
   * `args` snapshots the public tool arguments for deferred execution by
   * the built-in scheduled executor; `caller` snapshots the resolved
   * identity for `identityArg` injection at execution time. Neither is
   * ever returned on the wire, and neither appears in an
   * `entryType: "task"` audit row. The `entryType: "tool"` row that
   * `dispatch.runTool` writes for the run itself DOES carry the
   * arguments, verbatim: a `taskSupport` tool may not set
   * `metadata.auditArgs`, precisely so that this is unambiguous.
   *
   * `idempotencyKey` is issued once per task; the executing tool persists
   * it around its side effect so workflow retries and duplicate client
   * updates cannot double-apply. Repeated `tasks/update` submissions of
   * byte-identical responses are answered idempotently while the same
   * round is still pending; a re-send against a superseded round is
   * `stale_round`, and against a completed or failed row `conflict`.
   */
  tasks: defineTable({
    taskId: v.string(),
    ownerSubject: v.string(),
    toolName: v.string(),
    toolKind: toolKindValidator,
    args: v.any(),
    caller: v.optional(
      v.object({ subject: v.string(), claims: v.optional(v.any()) }),
    ),
    status: taskStatusValidator,
    /**
     * The tool's own return value. The MCP `CallToolResult` a client polls
     * is derived from this and the two flags below when the task is read,
     * never stored: an envelope would keep the value twice over (escaped
     * inside `content[0].text` and again as `structuredContent`), so a
     * legal 256 KiB result could serialize past Convex's document limit
     * after the tool had already committed its writes.
     */
    result: v.optional(v.any()),
    /** The call ran and reported a failure: becomes `isError` on the wire. */
    resultIsError: v.optional(v.boolean()),
    /** The tool declares an `outputSchema`, so derive `structuredContent`. */
    resultStructured: v.optional(v.boolean()),
    error: v.optional(v.object({ code: v.number(), message: v.string() })),
    inputRequests: v.optional(v.any()),
    inputResponses: v.optional(v.any()),
    /**
     * Monotonic count of `input_required` rounds requested on this task
     * (0 before the first). A `tasks/update` submitting responses must
     * echo the round it is answering, so a stale retry of an earlier
     * round cannot be mistaken for the answer to a later, re-asked one.
     * Optional for forward-compat with rows written before this field.
     */
    inputRound: v.optional(v.number()),
    idempotencyKey: v.string(),
    /**
     * `"component"`: the built-in scheduler-based executor runs the
     * registered tool function once and completes/fails the task.
     * `"host"`: the host started durable execution itself (typically a
     * `@convex-dev/workflow` run) and finalizes via the trusted APIs.
     */
    executor: v.union(v.literal("component"), v.literal("host")),
    /**
     * Set once the host's `tasks.execute` returned for this row. Only
     * meaningful for `executor: "host"`: the component executor is
     * scheduled inside the creating mutation, so it is started by
     * construction. Without this marker a replayed request could not tell
     * "the row exists, so execution started" from "the row exists because
     * a start that then failed to be compensated left it behind", and the
     * retry whose job was to start the work would skip it.
     */
    startedAt: v.optional(v.number()),
    /**
     * Mount scope, from the host's `tasks.scope` option. The task table is
     * component-wide and `authorize` runs only at creation, so without
     * this any mount resolving the same subject could poll, cancel, or
     * answer input rounds for a task created through a mount with a
     * different policy. Every owner-facing function requires an exact
     * match (in both directions: a scoped row is invisible to an unscoped
     * mount and vice versa), and a mismatch is answered exactly like an
     * unknown id. Unset preserves the pre-scope behaviour, so
     * single-mount hosts need no migration.
     */
    scope: v.optional(v.string()),
    /**
     * Set when the host's MRTR `beforeCall` hook approved this call before
     * the row was created. The built-in executor requires it for any tool
     * the registry currently marks `mrtrGated`: a task created while the
     * tool had no hook must not still execute after one was added (that
     * confirmation is what the row now promises), while a task the hook
     * already approved must not be blocked by the same rule.
     */
    mrtrApproved: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_taskId", ["taskId"])
    // Lets a task-augmented MRTR continuation that is replayed find the
    // task it already created instead of minting a sibling. Lives here
    // rather than as a task id on the `mrtrChains` row on purpose: MRTR
    // must not know that Tasks exists.
    .index("by_idempotencyKey", ["idempotencyKey"])
    // Bulk owner operations (e.g. cancelling a revoked subject's pending
    // tasks).
    .index("by_ownerSubject", ["ownerSubject"])
    // Per-owner live-task cap. Counting through `by_ownerSubject` would
    // read every task the owner ever created (and take a read dependency
    // on all of them, so any sibling status change could OCC-conflict the
    // next creation); this index reads only the two non-terminal statuses.
    .index("by_owner_status", ["ownerSubject", "status"])
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * Shared audit log for tool calls, task lifecycle transitions, and
   * opt-in resource operations. Tool rows capture the tool name/kind,
   * outcome, duration, and optionally redacted args. Resource rows
   * capture operation metadata (resource URI, list/read, outcome,
   * duration) but never resource contents. Task rows capture the task
   * id, operation, tool name, and owner subject but never task payloads;
   * a task run by the built-in executor also writes the ordinary tool row
   * for the call itself. `identitySubject` is supplied by the host after
   * resolving auth at the HTTP boundary; component code never reads
   * identity directly.
   */
  audit: defineTable({
    /**
     * Optional for forward compatibility with existing tool audit rows.
     * New writes set this to "tool", "resource", or "task".
     */
    entryType: v.optional(auditEntryTypeValidator),
    toolName: v.optional(v.string()),
    toolKind: v.optional(toolKindValidator),
    resourceUri: v.optional(v.string()),
    resourceOperation: v.optional(resourceAuditOperationValidator),
    taskId: v.optional(v.string()),
    taskOperation: v.optional(taskAuditOperationValidator),
    args: v.any(),
    outcome: auditOutcomeValidator,
    identitySubject: v.union(v.string(), v.null()),
    durationMs: v.number(),
    errorCode: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  })
    .index("by_toolName", ["toolName"])
    .index("by_resourceUri", ["resourceUri"])
    .index("by_taskId", ["taskId"])
    .index("by_entryType", ["entryType"])
    .index("by_outcome", ["outcome"]),
});
