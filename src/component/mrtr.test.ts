import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { api } from "./_generated/api.js";

/**
 * Component-level tests of the one-time continuation redemption. The
 * handler tests in `src/client/mrtr.test.ts` run against a mocked
 * component, so the real fresh/replay/conflict semantics are pinned
 * here against the actual schema and mutation.
 */

const EXPIRES_AT = 1_800_000_000_000;

describe("mrtr redemption", () => {
  test("first redemption is fresh, the same digest replays", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      expect(
        await ctx.runMutation(api.mrtr.redeemContinuation, {
          jti: "cont-1",
          responsesDigest: "digest-a",
          expiresAt: EXPIRES_AT,
        }),
      ).toBe("fresh");
      expect(
        await ctx.runMutation(api.mrtr.redeemContinuation, {
          jti: "cont-1",
          responsesDigest: "digest-a",
          expiresAt: EXPIRES_AT,
        }),
      ).toBe("replay");
    });
  });

  test("a different digest for the same continuation is a conflict", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.mrtr.redeemContinuation, {
        jti: "cont-2",
        responsesDigest: "decline",
        expiresAt: EXPIRES_AT,
      });
      expect(
        await ctx.runMutation(api.mrtr.redeemContinuation, {
          jti: "cont-2",
          responsesDigest: "accept",
          expiresAt: EXPIRES_AT,
        }),
      ).toBe("conflict");
    });
  });

});

describe("mrtr chain claim", () => {
  test("the first claim wins and later ones report the winner", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      expect(
        await ctx.runMutation(api.mrtr.claimChain, {
          chainKey: "chain-1",
          jti: "jti-a",
          resolution: "completed",
          expiresAt: EXPIRES_AT,
        }),
      ).toBe("claimed");
      // A different branch of the same chain trying to dispatch loses,
      // and learns both HOW it was resolved and BY WHICH continuation,
      // which is what lets the host allow a lost-response retry of that
      // one continuation while refusing every sibling.
      expect(
        await ctx.runMutation(api.mrtr.claimChain, {
          chainKey: "chain-1",
          jti: "jti-b",
          resolution: "dispatched",
          expiresAt: EXPIRES_AT,
        }),
      ).toEqual({ resolution: "completed", resolvedByJti: "jti-a" });
    });
  });

  test("a dispatch claim blocks a later completion", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.mrtr.claimChain, {
        chainKey: "chain-2",
        jti: "jti-a",
        resolution: "dispatched",
        expiresAt: EXPIRES_AT,
      });
      expect(
        await ctx.runMutation(api.mrtr.claimChain, {
          chainKey: "chain-2",
          jti: "jti-b",
          resolution: "completed",
          expiresAt: EXPIRES_AT,
        }),
      ).toEqual({ resolution: "dispatched", resolvedByJti: "jti-a" });
    });
  });

  test("chains are independent of one another", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.mrtr.claimChain, {
        chainKey: "chain-3",
        jti: "jti-a",
        resolution: "dispatched",
        expiresAt: EXPIRES_AT,
      });
      expect(
        await ctx.runMutation(api.mrtr.claimChain, {
          chainKey: "chain-4",
          jti: "jti-b",
          resolution: "dispatched",
          expiresAt: EXPIRES_AT,
        }),
      ).toBe("claimed");
    });
  });

  test("a later claim may raise the window but never shorten it", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.mrtr.claimChain, {
        chainKey: "chain-5",
        jti: "jti-a",
        resolution: "completed",
        expiresAt: EXPIRES_AT,
      });
      const expiry = async () =>
        (
          await ctx.db
            .query("mrtrChains")
            .withIndex("by_chainKey", (q) => q.eq("chainKey", "chain-5"))
            .unique()
        )?.expiresAt;

      // Shortening would let the prune drop the claim while a
      // longer-lived sibling of the chain is still answerable.
      await ctx.runMutation(api.mrtr.claimChain, {
        chainKey: "chain-5",
        jti: "jti-b",
        resolution: "completed",
        expiresAt: EXPIRES_AT - 60_000,
      });
      expect(await expiry()).toBe(EXPIRES_AT);

      await ctx.runMutation(api.mrtr.claimChain, {
        chainKey: "chain-5",
        jti: "jti-c",
        resolution: "completed",
        expiresAt: EXPIRES_AT + 60_000,
      });
      expect(await expiry()).toBe(EXPIRES_AT + 60_000);
    });
  });

  test("getChainResolution reports null until a chain resolves", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      expect(
        await ctx.runQuery(api.mrtr.getChainResolution, {
          chainKey: "chain-6",
        }),
      ).toBeNull();
      await ctx.runMutation(api.mrtr.claimChain, {
        chainKey: "chain-6",
        jti: "jti-a",
        resolution: "completed",
        expiresAt: EXPIRES_AT,
      });
      expect(
        await ctx.runQuery(api.mrtr.getChainResolution, {
          chainKey: "chain-6",
        }),
      ).toEqual({ resolution: "completed", resolvedByJti: "jti-a" });
    });
  });

  test("the prune drains expired redemptions and chain claims together", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.mrtr.redeemContinuation, {
        jti: "old-jti",
        responsesDigest: "d",
        expiresAt: 1,
      });
      await ctx.runMutation(api.mrtr.claimChain, {
        chainKey: "old-chain",
        jti: "old-jti",
        resolution: "completed",
        expiresAt: 1,
      });
      // Hosts wire one cron, so one call must clear both tables.
      expect(await ctx.runMutation(api.mrtr.pruneMrtrRedemptions, {})).toBe(2);
      expect(
        await ctx.runQuery(api.mrtr.getChainResolution, {
          chainKey: "old-chain",
        }),
      ).toBeNull();
    });
  });
});
