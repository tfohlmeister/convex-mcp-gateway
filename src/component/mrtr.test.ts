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
