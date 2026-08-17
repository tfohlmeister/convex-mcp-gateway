import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { api } from "./_generated/api.js";

describe("sessions", () => {
  test("createSession + getSession round-trip", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const id = await ctx.runMutation(api.sessions.createSession, {
        sessionId: "deadbeef",
        protocolVersion: "2025-06-18",
        identitySubject: null,
      });
      expect(id).toBeTypeOf("string");

      const session = await ctx.runQuery(api.sessions.getSession, {
        sessionId: "deadbeef",
      });
      expect(session?.sessionId).toBe("deadbeef");
      expect(session?.protocolVersion).toBe("2025-06-18");
      expect(session?.identitySubject).toBeNull();
      expect(session?.createdAt).toBe(session?.lastSeenAt);
    });
  });

  test("getSession returns null for unknown ids", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      expect(
        await ctx.runQuery(api.sessions.getSession, {
          sessionId: "nope",
        }),
      ).toBeNull();
    });
  });

  test("touchSession updates lastSeenAt and reports presence", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // Establish a session, then advance the wall clock and touch it.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      await ctx.runMutation(api.sessions.createSession, {
        sessionId: "s1",
        protocolVersion: "2025-06-18",
        identitySubject: null,
      });
      const before = await ctx.runQuery(api.sessions.getSession, {
        sessionId: "s1",
      });

      vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
      const touched = await ctx.runMutation(api.sessions.touchSession, {
        sessionId: "s1",
      });
      expect(touched).toBe(true);

      const after = await ctx.runQuery(api.sessions.getSession, {
        sessionId: "s1",
      });
      expect(after?.lastSeenAt).toBeGreaterThan(before!.lastSeenAt);
      expect(after?.createdAt).toBe(before!.createdAt);
      vi.useRealTimers();

      // Touching an unknown session is a no-op that reports false.
      expect(
        await ctx.runMutation(api.sessions.touchSession, {
          sessionId: "ghost",
        }),
      ).toBe(false);
    });
  });

  test("deleteSession returns 'deleted' for an anonymous match", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.sessions.createSession, {
        sessionId: "tmp",
        protocolVersion: "2025-06-18",
        identitySubject: null,
      });
      expect(
        await ctx.runMutation(api.sessions.deleteSession, {
          sessionId: "tmp",
          callerIdentitySubject: null,
        }),
      ).toBe("deleted");
      expect(
        await ctx.runQuery(api.sessions.getSession, { sessionId: "tmp" }),
      ).toBeNull();
      expect(
        await ctx.runMutation(api.sessions.deleteSession, {
          sessionId: "tmp",
          callerIdentitySubject: null,
        }),
      ).toBe("not_found");
    });
  });

  test("deleteSession returns 'forbidden' when caller subject mismatches", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.sessions.createSession, {
        sessionId: "alice-sess",
        protocolVersion: "2025-06-18",
        identitySubject: "alice",
      });

      // Anonymous caller tries to delete alice's session: refused.
      expect(
        await ctx.runMutation(api.sessions.deleteSession, {
          sessionId: "alice-sess",
          callerIdentitySubject: null,
        }),
      ).toBe("forbidden");

      // Mallory tries to delete alice's session: also refused.
      expect(
        await ctx.runMutation(api.sessions.deleteSession, {
          sessionId: "alice-sess",
          callerIdentitySubject: "mallory",
        }),
      ).toBe("forbidden");

      // Alice herself: deletion goes through.
      expect(
        await ctx.runMutation(api.sessions.deleteSession, {
          sessionId: "alice-sess",
          callerIdentitySubject: "alice",
        }),
      ).toBe("deleted");
    });
  });

  test("pruneSessions deletes rows older than the cutoff and keeps newer ones", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      await ctx.runMutation(api.sessions.createSession, {
        sessionId: "old",
        protocolVersion: "2025-06-18",
        identitySubject: null,
      });

      // Advance 2 hours; 'old' is now stale, create a 'fresh' session.
      vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
      await ctx.runMutation(api.sessions.createSession, {
        sessionId: "fresh",
        protocolVersion: "2025-06-18",
        identitySubject: null,
      });

      // Prune anything older than 1 hour.
      const deleted = await ctx.runMutation(api.sessions.pruneSessions, {
        olderThanMs: 60 * 60 * 1000,
      });
      expect(deleted).toBe(1);
      expect(
        await ctx.runQuery(api.sessions.getSession, { sessionId: "old" }),
      ).toBeNull();
      expect(
        await ctx.runQuery(api.sessions.getSession, { sessionId: "fresh" }),
      ).not.toBeNull();
      vi.useRealTimers();
    });
  });

  test("subscribeResource records, is idempotent, and listResourceSubscribers reports", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      expect(
        await ctx.runMutation(api.sessions.subscribeResource, {
          sessionId: "s1",
          uri: "docs://a",
        }),
      ).toBe("subscribed");
      // Idempotent: same pair again does not insert a duplicate.
      expect(
        await ctx.runMutation(api.sessions.subscribeResource, {
          sessionId: "s1",
          uri: "docs://a",
        }),
      ).toBe("exists");
      await ctx.runMutation(api.sessions.subscribeResource, {
        sessionId: "s2",
        uri: "docs://a",
      });

      const subscribers = await ctx.runQuery(
        api.sessions.listResourceSubscribers,
        { uri: "docs://a" },
      );
      expect([...subscribers].sort()).toEqual(["s1", "s2"]);
      expect(
        await ctx.runQuery(api.sessions.listResourceSubscribers, {
          uri: "docs://other",
        }),
      ).toEqual([]);
    });
  });

  test("unsubscribeResource removes a subscription and reports presence", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.sessions.subscribeResource, {
        sessionId: "s1",
        uri: "docs://a",
      });
      expect(
        await ctx.runMutation(api.sessions.unsubscribeResource, {
          sessionId: "s1",
          uri: "docs://a",
        }),
      ).toBe(true);
      // Already gone → false.
      expect(
        await ctx.runMutation(api.sessions.unsubscribeResource, {
          sessionId: "s1",
          uri: "docs://a",
        }),
      ).toBe(false);
      expect(
        await ctx.runQuery(api.sessions.listResourceSubscribers, {
          uri: "docs://a",
        }),
      ).toEqual([]);
    });
  });

  test("deleteSession cascades its resource subscriptions", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.sessions.createSession, {
        sessionId: "s1",
        protocolVersion: "2025-06-18",
        identitySubject: null,
      });
      await ctx.runMutation(api.sessions.subscribeResource, {
        sessionId: "s1",
        uri: "docs://a",
      });
      await ctx.runMutation(api.sessions.subscribeResource, {
        sessionId: "s1",
        uri: "docs://b",
      });

      expect(
        await ctx.runMutation(api.sessions.deleteSession, {
          sessionId: "s1",
          callerIdentitySubject: null,
        }),
      ).toBe("deleted");

      // Both subscriptions are gone with the session.
      expect(
        await ctx.runQuery(api.sessions.listResourceSubscribers, {
          uri: "docs://a",
        }),
      ).toEqual([]);
      expect(
        await ctx.runQuery(api.sessions.listResourceSubscribers, {
          uri: "docs://b",
        }),
      ).toEqual([]);
    });
  });

  test("pruneOrphanResourceSubscriptions drops rows for nonexistent sessions only", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // 'live' has a real session; 'ghost' does not.
      await ctx.runMutation(api.sessions.createSession, {
        sessionId: "live",
        protocolVersion: "2025-06-18",
        identitySubject: null,
      });
      await ctx.runMutation(api.sessions.subscribeResource, {
        sessionId: "live",
        uri: "docs://a",
      });
      await ctx.runMutation(api.sessions.subscribeResource, {
        sessionId: "ghost",
        uri: "docs://a",
      });

      const { deleted, cursor } = await ctx.runMutation(
        api.sessions.pruneOrphanResourceSubscriptions,
        {},
      );
      expect(deleted).toBe(1);
      // Only two rows total (< PRUNE_BATCH), so a single page drains it.
      expect(cursor).toBeNull();
      // Only the live session's subscription remains.
      expect(
        await ctx.runQuery(api.sessions.listResourceSubscribers, {
          uri: "docs://a",
        }),
      ).toEqual(["live"]);
    });
  });

  test("pruneOrphanResourceSubscriptions advances past live rows at the front", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // A live session subscribed FIRST (so its row sits at the front of the
      // creation-time scan), then an orphan subscription created later. A
      // front-only scan that stalled on live rows would never reach the
      // orphan; the cursor must advance past it.
      await ctx.runMutation(api.sessions.createSession, {
        sessionId: "live",
        protocolVersion: "2025-06-18",
        identitySubject: null,
      });
      await ctx.runMutation(api.sessions.subscribeResource, {
        sessionId: "live",
        uri: "docs://a",
      });
      await ctx.runMutation(api.sessions.subscribeResource, {
        sessionId: "ghost",
        uri: "docs://b",
      });

      const total = await ctx.runMutation(
        api.sessions.pruneOrphanResourceSubscriptions,
        {},
      );
      expect(total.deleted).toBe(1);
      expect(
        await ctx.runQuery(api.sessions.listResourceSubscribers, {
          uri: "docs://b",
        }),
      ).toEqual([]);
      expect(
        await ctx.runQuery(api.sessions.listResourceSubscribers, {
          uri: "docs://a",
        }),
      ).toEqual(["live"]);
    });
  });
});
