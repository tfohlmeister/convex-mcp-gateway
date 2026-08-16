import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const sessionValidator = v.object({
  _id: v.id("sessions"),
  _creationTime: v.number(),
  sessionId: v.string(),
  protocolVersion: v.string(),
  clientCapabilities: v.optional(v.record(v.string(), v.any())),
  createdAt: v.number(),
  lastSeenAt: v.number(),
  identitySubject: v.optional(v.union(v.string(), v.null())),
});

/**
 * Create a fresh session for the negotiated protocol version. Called
 * from the HTTP handler after a successful `initialize`. The session ID
 * is generated server-side; never trust a client-supplied value.
 *
 * `clientCapabilities` is optional for callers and defaults to `{}` so
 * sessions created before this field existed remain compatible.
 *
 * `identitySubject` is the JWT subject the gateway resolved at
 * `initialize` time (or `null` if the caller was anonymous). It binds
 * the session to a specific user so DELETE can verify the teardown
 * caller matches the creator.
 */
export const createSession = mutation({
  args: {
    sessionId: v.string(),
    protocolVersion: v.string(),
    clientCapabilities: v.optional(v.record(v.string(), v.any())),
    identitySubject: v.union(v.string(), v.null()),
  },
  returns: v.id("sessions"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("sessions", {
      sessionId: args.sessionId,
      protocolVersion: args.protocolVersion,
      clientCapabilities: args.clientCapabilities ?? {},
      identitySubject: args.identitySubject,
      createdAt: now,
      lastSeenAt: now,
    });
  },
});

/**
 * Look up a session by its public id. Returns null if unknown or
 * already terminated; the HTTP handler responds with 404 in that case
 * so the client knows to start a new session per MCP 2025-06-18.
 */
export const getSession = query({
  args: { sessionId: v.string() },
  returns: v.union(sessionValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    return row ?? null;
  },
});

/**
 * Mark the session as recently seen so a future timeout-based pruner
 * can distinguish active from idle sessions. Best-effort: failures are
 * non-fatal and the HTTP handler swallows them.
 */
export const touchSession = mutation({
  args: { sessionId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (!row) return false;
    await ctx.db.patch("sessions", row._id, { lastSeenAt: Date.now() });
    return true;
  },
});

/**
 * Outcome of a session-delete attempt:
 *
 *   - `"deleted"`: row existed and identity check passed
 *   - `"not_found"`: no row with that id (404 to the client)
 *   - `"forbidden"`: row exists but the caller's identitySubject
 *                     doesn't match what was bound at create time
 *                     (403 to the client, defends against
 *                     session-id-leak DoS)
 */
const deleteSessionResultValidator = v.union(
  v.literal("deleted"),
  v.literal("not_found"),
  v.literal("forbidden"),
);

/**
 * Terminate a session if the calling identity matches what was bound
 * at create time. The HTTP DELETE handler calls this; the
 * spec-required follow-up is HTTP 404 (no such session) or 403
 * (mismatch). Pre-binding session rows (no `identitySubject` field)
 * fall back to the legacy "delete anything you know the id of"
 * behaviour for forward-compat; new rows always have the field and
 * always check.
 */
export const deleteSession = mutation({
  args: {
    sessionId: v.string(),
    callerIdentitySubject: v.union(v.string(), v.null()),
  },
  returns: deleteSessionResultValidator,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (!row) return "not_found";
    // Forward-compat: rows from before identity binding shipped have
    // no `identitySubject` field. Treat as "owner unknown, allow
    // delete" so existing in-flight sessions during the deploy
    // window don't get stuck.
    if (row.identitySubject !== undefined) {
      if (row.identitySubject !== args.callerIdentitySubject) {
        return "forbidden";
      }
    }
    // Cascade: drop this session's resource subscriptions so an explicit
    // teardown leaves no orphan rows. Bounded by the per-session
    // subscription cap, so it stays within Convex's per-mutation limits.
    const subs = await ctx.db
      .query("subscriptions")
      .withIndex("by_session_uri", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    for (const sub of subs) {
      await ctx.db.delete("subscriptions", sub._id);
    }
    await ctx.db.delete("sessions", row._id);
    return "deleted";
  },
});

/**
 * Drop sessions whose `lastSeenAt` is older than the given cutoff.
 * Bounded per-call: up to `PRUNE_BATCH` rows are deleted in one
 * mutation, so very busy deployments don't hit Convex's per-mutation
 * read/write limits. Callers loop until the return value is `0` to
 * fully drain. The host invokes this from a cron when it cares about
 * idle cleanup; the component runs no background work itself.
 */
const PRUNE_BATCH = 200;

export const pruneSessions = mutation({
  args: { olderThanMs: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.olderThanMs;
    // The `by_lastSeenAt` index lets us fetch exactly the eligible
    // rows in one indexed read instead of scanning the full table.
    // Subscriptions for pruned sessions are intentionally NOT cascaded here
    // (a batch of sessions could own more rows than one mutation may touch);
    // they become orphans cleaned by `pruneOrphanResourceSubscriptions`.
    // Explicit DELETE cascades inline.
    const rows = await ctx.db
      .query("sessions")
      .withIndex("by_lastSeenAt", (q) => q.lt("lastSeenAt", cutoff))
      .take(PRUNE_BATCH);
    let deleted = 0;
    for (const row of rows) {
      await ctx.db.delete("sessions", row._id);
      deleted++;
    }
    return deleted;
  },
});

/**
 * Per-session cap on resource subscriptions. Subscriptions require an
 * authenticated caller, but a cap still bounds DB growth from a client
 * that subscribes to many distinct URIs.
 */
const SUBSCRIPTION_CAP = 256;

const subscribeResultValidator = v.union(
  v.literal("subscribed"),
  v.literal("exists"),
  v.literal("limit_exceeded"),
);

/**
 * Record a `resources/subscribe` for (session, uri). Idempotent: a repeat
 * subscribe for the same pair returns `"exists"` without inserting a
 * duplicate. Returns `"limit_exceeded"` once the session holds
 * `SUBSCRIPTION_CAP` distinct subscriptions. The caller (HTTP handler) has
 * already validated the session and the caller's identity.
 */
export const subscribeResource = mutation({
  args: { sessionId: v.string(), uri: v.string() },
  returns: subscribeResultValidator,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_session_uri", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    if (existing.some((row) => row.uri === args.uri)) return "exists";
    if (existing.length >= SUBSCRIPTION_CAP) return "limit_exceeded";
    await ctx.db.insert("subscriptions", {
      sessionId: args.sessionId,
      uri: args.uri,
      createdAt: Date.now(),
    });
    return "subscribed";
  },
});

/**
 * Remove a `resources/subscribe` for (session, uri). Returns `true` when a
 * row was deleted, `false` when the pair was not subscribed.
 */
export const unsubscribeResource = mutation({
  args: { sessionId: v.string(), uri: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("subscriptions")
      .withIndex("by_session_uri", (q) =>
        q.eq("sessionId", args.sessionId).eq("uri", args.uri),
      )
      .unique();
    if (!row) return false;
    await ctx.db.delete("subscriptions", row._id);
    return true;
  },
});

/**
 * List the session IDs currently subscribed to `uri`. The host reads this
 * to decide whom to deliver a `notifications/resources/updated` to over its
 * own (push-capable) transport. Rows may reference sessions that have since
 * been idle-pruned; the host treats unknown sessions as no-ops and runs
 * `pruneOrphanResourceSubscriptions` to clean them.
 */
export const listResourceSubscribers = query({
  args: { uri: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("subscriptions")
      .withIndex("by_uri", (q) => q.eq("uri", args.uri))
      .collect();
    return rows.map((row) => row.sessionId);
  },
});

/**
 * Drop subscription rows whose session no longer exists (e.g. sessions
 * dropped by `pruneSessions`, which does not cascade). Orphans are a
 * *sparse* predicate (they can sit anywhere in the table behind live rows)
 * so this scans a fixed window per call ordered by creation time and reports
 * a `cursor` to resume from. Returning "0 deleted" does NOT mean "done"
 * (the window may have held only live rows); drain by following `cursor`
 * until it is `null`. `gateway.pruneResourceSubscriptions` does that loop.
 */
export const pruneOrphanResourceSubscriptions = mutation({
  args: { cursorCreationTime: v.optional(v.number()) },
  returns: v.object({
    deleted: v.number(),
    cursor: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    // Scan a window by the system `by_creation_time` index so the cursor
    // advances regardless of how many rows we actually delete, otherwise
    // a window full of live rows would stall the scan at the front forever.
    const rows = await ctx.db
      .query("subscriptions")
      .withIndex("by_creation_time", (q) =>
        args.cursorCreationTime !== undefined
          ? q.gt("_creationTime", args.cursorCreationTime)
          : q,
      )
      .order("asc")
      .take(PRUNE_BATCH);
    let deleted = 0;
    for (const row of rows) {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", row.sessionId))
        .unique();
      if (!session) {
        await ctx.db.delete("subscriptions", row._id);
        deleted++;
      }
    }
    // A short read means we reached the end of the table → no more pages.
    const last = rows[rows.length - 1];
    const cursor =
      rows.length === PRUNE_BATCH && last ? last._creationTime : null;
    return { deleted, cursor };
  },
});
