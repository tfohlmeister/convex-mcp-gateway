import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

/**
 * Server-side one-time redemption for MRTR continuations. The sealed
 * `requestState` is stateless and stays valid until its TTL, so the
 * host handler redeems each continuation id (`jti`) here before acting
 * on it: the first redemption records a digest of the client's
 * `inputResponses`, and any later use of the same continuation must
 * carry byte-identical responses. That turns "replay a captured
 * continuation with a different answer" (decline to accept) into a
 * rejected `"conflict"`, while a client's legitimate network-level
 * retry of the same answer remains an idempotent `"replay"` that is
 * safe to re-process (hooks are deterministic over the same inputs).
 *
 * This covers ONE continuation. It cannot make a decision final,
 * because `jti` is fresh per round: a replay that re-runs the hook
 * mints a new, unredeemed sibling. `claimChain` below is what closes
 * the chain, and the two are meant to be read together.
 *
 * A continuation carrying no `inputResponses` decides nothing, so it is
 * not redeemed at all: pinning an empty answer would reject the real
 * answer that follows on the same state, and state-only retries are a
 * supported client pattern. Nothing is lost by that, because the branch
 * such a retry can fork is closed by the chain claim, not here.
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
    /**
     * Digest of the client's `inputResponses`. Absent when the
     * continuation carried none, which decides nothing and is therefore
     * not pinned.
     */
    responsesDigest: v.optional(v.string()),
    /** The continuation's own expiry; the row never needs to outlive it. */
    expiresAt: v.number(),
  },
  returns: redeemResultValidator,
  handler: async (ctx, args) => {
    if (args.responsesDigest === undefined) return "fresh";
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
    let deleted = 0;
    const redemptions = await ctx.db
      .query("mrtrRedemptions")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(PRUNE_BATCH);
    for (const row of redemptions) {
      await ctx.db.delete("mrtrRedemptions", row._id);
      deleted++;
    }
    // Chain claims drain through the same call so hosts wire one cron.
    // Budgeted separately: a batch of expired redemptions must not
    // starve the claims, and vice versa.
    const chains = await ctx.db
      .query("mrtrChains")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(PRUNE_BATCH);
    for (const row of chains) {
      await ctx.db.delete("mrtrChains", row._id);
      deleted++;
    }
    return deleted;
  },
});

const chainResolutionValidator = v.union(
  v.literal("dispatched"),
  v.literal("completed"),
);

const resolvedChainValidator = v.object({
  resolution: chainResolutionValidator,
  resolvedByJti: v.string(),
  resolvedByDigest: v.optional(v.string()),
});

/**
 * The chain's resolution, or `null` while it is still open. Read-only
 * pre-check: the host uses it to refuse a continuation that could only
 * fork or re-dispatch an already-resolved chain, while still allowing
 * an idempotent re-send of a completed call to reproduce its result.
 * The binding decision is `claimChain` below, not this.
 */
export const getChainResolution = query({
  args: { chainKey: v.string() },
  returns: v.union(v.null(), resolvedChainValidator),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mrtrChains")
      .withIndex("by_chainKey", (q) => q.eq("chainKey", args.chainKey))
      .unique();
    if (!row) return null;
    return {
      resolution: row.resolution,
      resolvedByJti: row.resolvedByJti,
      ...(row.resolvedByDigest !== undefined
        ? { resolvedByDigest: row.resolvedByDigest }
        : {}),
    };
  },
});

/**
 * Claim a chain's single resolution. Called by the host immediately
 * before it dispatches the tool or finishes the call via
 * `completeCall()`, so the insert IS the decision rather than a record
 * of one: a later claim for the same chain, from any continuation of
 * it, loses and reports who won.
 *
 * This is what makes a resolved decision final. Per-continuation
 * redemption cannot, because `jti` is fresh per round and a replay that
 * re-runs the hook mints a new, unpinned sibling. It also makes
 * dispatch at-most-once per chain gateway-side.
 */
export const claimChain = mutation({
  args: {
    chainKey: v.string(),
    resolution: v.union(v.literal("dispatched"), v.literal("completed")),
    /** The continuation making the claim; recorded as the resolver. */
    jti: v.string(),
    /** Digest of its `inputResponses`, absent when it carried none. */
    responsesDigest: v.optional(v.string()),
    /**
     * When this claim may be pruned. It MUST outlive every continuation
     * the chain can still have outstanding, not just the one that
     * resolved it: siblings minted earlier expire later, and a claim
     * pruned while one is still valid lets that sibling resolve the
     * chain a second time. Hosts pass `now + the TTL ceiling`; a
     * shorter value is silently raised rather than trusted.
     */
    expiresAt: v.number(),
  },
  returns: v.union(v.literal("claimed"), resolvedChainValidator),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("mrtrChains")
      .withIndex("by_chainKey", (q) => q.eq("chainKey", args.chainKey))
      .unique();
    // Losing the claim returns the winner's resolution, so the host can
    // tell "already completed" (an idempotent re-send may reproduce the
    // result) from "already dispatched" (nothing may follow).
    if (existing) {
      // Never let a later claim shorten the window: the row has to
      // outlive the longest-lived continuation of this chain.
      if (args.expiresAt > existing.expiresAt) {
        await ctx.db.patch("mrtrChains", existing._id, {
          expiresAt: args.expiresAt,
        });
      }
      return {
        resolution: existing.resolution,
        resolvedByJti: existing.resolvedByJti,
        ...(existing.resolvedByDigest !== undefined
          ? { resolvedByDigest: existing.resolvedByDigest }
          : {}),
      };
    }
    await ctx.db.insert("mrtrChains", {
      chainKey: args.chainKey,
      resolution: args.resolution,
      resolvedByJti: args.jti,
      ...(args.responsesDigest !== undefined
        ? { resolvedByDigest: args.responsesDigest }
        : {}),
      expiresAt: args.expiresAt,
    });
    return "claimed";
  },
});
