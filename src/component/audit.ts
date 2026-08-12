import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server.js";
import {
  auditEntryTypeValidator,
  auditOutcomeValidator,
  resourceAuditOperationValidator,
  taskAuditOperationValidator,
  toolKindValidator,
} from "./schema.js";

const auditEntryValidator = v.object({
  _id: v.id("audit"),
  _creationTime: v.number(),
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
});

/**
 * Component-internal mutation that appends one row to the audit log.
 * Declared as `internalMutation` because only `dispatch.runTool`
 * (inside this component) ever writes audit entries, hosts that
 * want to log custom audit events should wrap the public
 * `gateway.listAuditEntries` reader instead.
 */
export const recordEntry = internalMutation({
  args: {
    toolName: v.string(),
    toolKind: toolKindValidator,
    args: v.any(),
    outcome: auditOutcomeValidator,
    identitySubject: v.union(v.string(), v.null()),
    durationMs: v.number(),
    errorCode: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  },
  returns: v.id("audit"),
  handler: async (ctx, entry) => {
    return await ctx.db.insert("audit", {
      entryType: "tool",
      ...entry,
    });
  },
});

/**
 * Append one resource-operation audit row. Unlike `recordEntry` (written by
 * the in-component `dispatch.runTool`), resource audit is recorded by the
 * host's HTTP handler, so this must be a public `mutation` exposed on the
 * component API, exactly like `dispatch.recordAuthDenial`. Resource contents
 * are intentionally never accepted here; callers store only operation
 * metadata such as URI, duration, outcome, and error summary.
 */
export const recordResourceEntry = mutation({
  args: {
    resourceUri: v.optional(v.string()),
    resourceOperation: resourceAuditOperationValidator,
    args: v.any(),
    outcome: auditOutcomeValidator,
    identitySubject: v.union(v.string(), v.null()),
    durationMs: v.number(),
    errorCode: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  },
  returns: v.id("audit"),
  handler: async (ctx, entry) => {
    return await ctx.db.insert("audit", {
      entryType: "resource",
      ...entry,
    });
  },
});

/**
 * List audit entries newest first, optionally filtered by tool name or
 * outcome. `limit` defaults to 100, capped at 1000 to keep the host from
 * pulling unbounded history through `runQuery`.
 *
 * When both `toolName` and `outcome` are supplied, the iteration walks
 * the `by_toolName` index ordered desc and stops once `limit` matching
 * entries are collected. A naive `take(limit*N)` + JS post-filter would
 * silently miss matches when most of the recent prefix doesn't match the
 * outcome (e.g. lots of recent `allowed` entries hiding older `error`s).
 */
export const listEntries = query({
  args: {
    entryType: v.optional(auditEntryTypeValidator),
    toolName: v.optional(v.string()),
    resourceUri: v.optional(v.string()),
    taskId: v.optional(v.string()),
    outcome: v.optional(auditOutcomeValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(auditEntryValidator),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 1000);

    async function filterByOutcome<T extends { outcome: string }>(
      rows: AsyncIterable<T>,
    ): Promise<T[]> {
      const out: T[] = [];
      for await (const entry of rows) {
        if (entry.outcome === args.outcome) {
          out.push(entry);
          if (out.length >= limit) break;
        }
      }
      return out;
    }

    if (args.resourceUri !== undefined && args.outcome !== undefined) {
      return (await filterByOutcome(
        ctx.db
          .query("audit")
          .withIndex("by_resourceUri", (q) =>
            q.eq("resourceUri", args.resourceUri!),
          )
          .order("desc"),
      )) as never;
    }

    if (args.resourceUri !== undefined) {
      return await ctx.db
        .query("audit")
        .withIndex("by_resourceUri", (q) =>
          q.eq("resourceUri", args.resourceUri!),
        )
        .order("desc")
        .take(limit);
    }

    if (args.taskId !== undefined && args.outcome !== undefined) {
      return (await filterByOutcome(
        ctx.db
          .query("audit")
          .withIndex("by_taskId", (q) => q.eq("taskId", args.taskId!))
          .order("desc"),
      )) as never;
    }

    if (args.taskId !== undefined) {
      return await ctx.db
        .query("audit")
        .withIndex("by_taskId", (q) => q.eq("taskId", args.taskId!))
        .order("desc")
        .take(limit);
    }

    if (args.toolName !== undefined && args.outcome !== undefined) {
      return (await filterByOutcome(
        ctx.db
          .query("audit")
          .withIndex("by_toolName", (q) => q.eq("toolName", args.toolName!))
          .order("desc"),
      )) as never;
    }

    if (args.toolName !== undefined) {
      return await ctx.db
        .query("audit")
        .withIndex("by_toolName", (q) => q.eq("toolName", args.toolName!))
        .order("desc")
        .take(limit);
    }
    if (args.entryType !== undefined && args.outcome !== undefined) {
      return (await filterByOutcome(
        ctx.db
          .query("audit")
          .withIndex("by_entryType", (q) => q.eq("entryType", args.entryType!))
          .order("desc"),
      )) as never;
    }

    if (args.entryType !== undefined) {
      return await ctx.db
        .query("audit")
        .withIndex("by_entryType", (q) => q.eq("entryType", args.entryType!))
        .order("desc")
        .take(limit);
    }
    if (args.outcome !== undefined) {
      return await ctx.db
        .query("audit")
        .withIndex("by_outcome", (q) => q.eq("outcome", args.outcome!))
        .order("desc")
        .take(limit);
    }
    return await ctx.db.query("audit").order("desc").take(limit);
  },
});

/**
 * Drop audit rows older than `cutoffMs` (Date.now() - retentionMs in
 * the typical caller). Bounded per-call: up to `PRUNE_BATCH` rows
 * are scanned and deleted in one mutation, so very large audit
 * tables don't hit Convex's per-mutation read/write limits.
 *
 * Callers loop until the return value is `0` to drain. Hosts wire
 * `gateway.pruneAuditEntries` from a `crons.daily(...)` job; the
 * component runs no background work itself.
 *
 * Returns the number of rows actually deleted, useful for
 * observability dashboards or cron-job logs.
 */
const PRUNE_BATCH = 200;

export const pruneOlderThan = mutation({
  args: { cutoffMs: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    // Iterate oldest-first by `_creationTime` (Convex's default
    // ascending order). The first row whose creationTime >= cutoff
    // means everything after is also too new, break early.
    const candidates = await ctx.db
      .query("audit")
      .order("asc")
      .take(PRUNE_BATCH);
    let deleted = 0;
    for (const row of candidates) {
      if (row._creationTime >= args.cutoffMs) break;
      await ctx.db.delete("audit", row._id);
      deleted++;
    }
    return deleted;
  },
});
