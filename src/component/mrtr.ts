import { v } from "convex/values";
import { mutation } from "./_generated/server.js";

/**
 * Server-side one-time redemption for MRTR continuations. The sealed
 * `requestState` is stateless and stays valid until its TTL, so the
 * host handler redeems each continuation id (`jti`) here before acting
 * on it: the first redemption records a digest of the client's
 * `inputResponses`, and any later use of the same continuation must
 * carry byte-identical responses. That turns "replay a captured
 * continuation with a different answer" (decline → accept) into a
 * rejected `"conflict"`, while a client's legitimate network-level
 * retry of the same answer remains an idempotent `"replay"` that is
 * safe to re-process (hooks are deterministic over the same inputs and
 * dispatched tools dedupe on the chain's idempotency key).
 *
 * Declared as public `mutation` for the same anyApi resolution reason
 * as `registry.*` / `dispatch.*`; only the host can reach component
 * functions.
 */

const redeemResultValidator = v.union(
  v.literal("fresh"),
  v.literal("replay"),
  v.literal("conflict"),
);

export const redeemContinuation = mutation({
  args: {
    jti: v.string(),
    responsesDigest: v.string(),
    /** The continuation's own expiry; the row never needs to outlive it. */
    expiresAt: v.number(),
  },
  returns: redeemResultValidator,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("mrtrRedemptions")
      .withIndex("by_jti", (q) => q.eq("jti", args.jti))
      .unique();
    if (existing) {
      return existing.responsesDigest === args.responsesDigest
        ? "replay"
        : "conflict";
    }
    await ctx.db.insert("mrtrRedemptions", {
      jti: args.jti,
      responsesDigest: args.responsesDigest,
      expiresAt: args.expiresAt,
    });
    return "fresh";
  },
});

/**
 * Drop redemption rows whose continuation has expired (the sealed state
 * they guard can no longer verify anyway). Bounded per call like every
 * other prune in this component; hosts drain from a cron via
 * `gateway.pruneMrtrRedemptions`, looping until the return value is `0`.
 */
const PRUNE_BATCH = 200;

export const pruneMrtrRedemptions = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("mrtrRedemptions")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(PRUNE_BATCH);
    let deleted = 0;
    for (const row of rows) {
      await ctx.db.delete("mrtrRedemptions", row._id);
      deleted++;
    }
    return deleted;
  },
});
