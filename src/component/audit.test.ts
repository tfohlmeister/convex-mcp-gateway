import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { api } from "./_generated/api.js";

describe("audit", () => {
  test("records and filters resource audit entries", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.runMutation(api.audit.recordResourceEntry, {
        resourceUri: "docs://one",
        resourceOperation: "read",
        args: null,
        outcome: "allowed",
        identitySubject: "user-1",
        durationMs: 12,
      });
      await ctx.runMutation(api.audit.recordResourceEntry, {
        resourceUri: "docs://one",
        resourceOperation: "read",
        args: null,
        outcome: "error",
        identitySubject: "user-1",
        durationMs: 7,
        errorCode: -32603,
        errorMessage: "read failed",
      });
      await ctx.runMutation(api.audit.recordResourceEntry, {
        resourceUri: "docs://two",
        resourceOperation: "list",
        args: { resourceCount: 2 },
        outcome: "allowed",
        identitySubject: "user-1",
        durationMs: 3,
      });

      const docsOne = await ctx.runQuery(api.audit.listEntries, {
        resourceUri: "docs://one",
      });
      expect(docsOne).toHaveLength(2);
      expect(docsOne.map((entry) => entry.resourceUri)).toEqual([
        "docs://one",
        "docs://one",
      ]);

      const resourceErrors = await ctx.runQuery(api.audit.listEntries, {
        entryType: "resource",
        outcome: "error",
      });
      expect(resourceErrors).toMatchObject([
        {
          entryType: "resource",
          resourceUri: "docs://one",
          resourceOperation: "read",
          outcome: "error",
          errorMessage: "read failed",
        },
      ]);
    });
  });

  test("caps the two caller-influenced strings on a resource row", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      // A read URI is chosen by the caller and unbounded, and it reaches a
      // row through both columns: `resourceUri`, and `errorMessage`, which
      // embeds it on the not-found branch. Capping here rather than in the
      // handler is what makes it hold for every writer of this public
      // mutation.
      const huge = `docs://${"A".repeat(200_000)}/raw`;
      const id = await ctx.runMutation(api.audit.recordResourceEntry, {
        resourceUri: huge,
        resourceOperation: "read",
        args: null,
        outcome: "error",
        identitySubject: "user-1",
        durationMs: 1,
        errorCode: -32602,
        errorMessage: `Resource not found: ${huge}`,
      });

      // Deterministic, so pin the exact output: it fixes the cap at 1024
      // rather than at some slack number a reader has to reverse-engineer.
      const row = await ctx.db.get("audit", id);
      expect(row?.resourceUri).toBe(`${huge.slice(0, 1024)}…(truncated)`);
      expect(row?.errorMessage).toBe(
        `${`Resource not found: ${huge}`.slice(0, 1024)}…(truncated)`,
      );
    });
  });

  test("a URI ending mid surrogate pair still stores", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      // `slice` counts UTF-16 units, so cutting between a surrogate pair
      // leaves a lone high surrogate, which is not encodable as UTF-8 and
      // would make the insert throw on exactly the input the cap exists to
      // survive. 1023 filler chars puts the pair astride the boundary.
      const straddling = `${"a".repeat(1023)}${"\u{1F600}".repeat(20)}`;
      const id = await ctx.runMutation(api.audit.recordResourceEntry, {
        resourceUri: straddling,
        resourceOperation: "read",
        args: null,
        outcome: "allowed",
        identitySubject: "user-1",
        durationMs: 1,
      });

      // The only correct output: cut back exactly one unit off 1024, so
      // the pair is left whole. Asserting the string proves both that no
      // lone surrogate survived and that the back-off was minimal, which
      // a "contains no surrogates" loop does not.
      const row = await ctx.db.get("audit", id);
      expect(row?.resourceUri).toBe(`${"a".repeat(1023)}…(truncated)`);
    });
  });
});
