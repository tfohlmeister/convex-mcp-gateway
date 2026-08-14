import { ConvexError, v } from "convex/values";
import { mcpCallerValidator } from "convex-mcp-gateway";
import { internalMutation, mutation, query } from "./_generated/server";

export const seed = mutation({
  args: {},
  returns: v.id("invoices"),
  handler: async (ctx) => {
    const existing = await ctx.db.query("invoices").first();
    if (existing) return existing._id;
    return await ctx.db.insert("invoices", { status: "open", amount: 42 });
  },
});

export const list = query({
  args: {
    status: v.optional(v.union(v.literal("open"), v.literal("paid"))),
  },
  handler: async (ctx, args) => {
    // Tools invoked via the MCP gateway run inside the component's dispatch
    // action; `ctx.auth` is NOT propagated across the component boundary.
    // `getUserIdentity()` returns null here even when the gateway's
    // authorize callback saw a valid JWT. If a tool needs the caller's
    // identity, pass relevant claims as explicit args from the authorize
    // callback. This example returns `caller: null` as the documented
    // behaviour.
    const identity = await ctx.auth.getUserIdentity();
    const invoices = await ctx.db.query("invoices").collect();
    const filtered = args.status
      ? invoices.filter((invoice) => invoice.status === args.status)
      : invoices;
    return { caller: identity?.subject ?? null, invoices: filtered };
  },
});

export const markPaid = mutation({
  args: { id: v.id("invoices") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("invoices", args.id, { status: "paid" });
    return null;
  },
});

/**
 * A mutation that runs only after the gateway-side MRTR `beforeCall`
 * hook (see convex/mcp.ts) accepted the confirmation. It is entirely
 * MCP-unaware: the hook owns the elicitation round-trip and the
 * accept/decline decision; this function only receives its business
 * arguments plus the gateway-injected continuation key, which makes the
 * side effect idempotent across client retries of the same continuation.
 */
export const archiveAfterConfirmation = mutation({
  args: {
    id: v.id("invoices"),
    continuationKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // A hook-approved gateway continuation always injects the key. A
    // call without one did not come through the confirmation flow
    // (e.g. direct host code), so refuse the side effect.
    if (!args.continuationKey) return { archived: false, invoiceId: args.id };

    const prior = await ctx.db
      .query("mrtrExecutions")
      .withIndex("by_key", (q) => q.eq("key", args.continuationKey!))
      .unique();
    if (prior) return prior.result;

    const result = { archived: true, invoiceId: args.id };
    await ctx.db.insert("mrtrExecutions", {
      key: args.continuationKey,
      invoiceId: args.id,
      result,
    });
    return result;
  },
});

/**
 * Look up one invoice by id. Used by the `invoice://{id}` resource template
 * in convex/mcp.ts: the template's read handler passes the matched `{id}`
 * here as a plain string, so we `normalizeId` it (returning `null` for a
 * malformed or unknown id) rather than trusting it as a typed `Id`.
 */
export const get = query({
  args: { id: v.string() },
  returns: v.union(
    v.object({
      id: v.id("invoices"),
      status: v.union(v.literal("open"), v.literal("paid")),
      amount: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { id }) => {
    const docId = ctx.db.normalizeId("invoices", id);
    if (!docId) return null;
    const invoice = await ctx.db.get("invoices", docId);
    if (!invoice) return null;
    return { id: invoice._id, status: invoice.status, amount: invoice.amount };
  },
});

/**
 * Identity-injected tool. Unlike `list` (which sees `ctx.auth` as null
 * across the component boundary), this declares a `caller` argument that
 * the gateway fills with the resolved caller identity, wired via
 * `identityArg: "caller"` in convex/mcp.ts. The tool reads the
 * authenticated caller directly and safely; clients can neither see nor
 * spoof the `caller` argument.
 */
export const whoami = query({
  args: { caller: mcpCallerValidator },
  returns: v.object({ subject: v.string(), hasClaims: v.boolean() }),
  handler: async (_ctx, { caller }) => {
    return { subject: caller.subject, hasClaims: caller.claims !== undefined };
  },
});

/**
 * A public read-only summary that does not require authentication. The
 * example's authorize callback opts it out of authentication via
 * `metadata: { public: true }` in convex/mcp.ts.
 */
export const summary = query({
  args: {},
  returns: v.object({ total: v.number() }),
  handler: async (ctx) => {
    const invoices = await ctx.db.query("invoices").collect();
    return { total: invoices.length };
  },
});

/**
 * A deferred "recount" used by the MCP Tasks example: registered with
 * `taskSupport: true` in convex/mcp.ts, so a modern client can invoke it
 * as a task-augmented `tools/call` and poll `tasks/get` for this result.
 * With the built-in executor the mutation runs exactly once after the
 * HTTP request, so it needs no idempotency bookkeeping of its own; a
 * host that switches to a retrying workflow executor should persist the
 * gateway-issued idempotency key around the write (see docs/tasks.md).
 */
export const recount = mutation({
  args: {
    failWith: v.optional(v.string()),
    failPlain: v.optional(v.string()),
    // Test hook: pads the result past the task result cap so the suite can
    // exercise the oversized-result path.
    padResult: v.optional(v.number()),
    // Test hook: returns a v.int64(), which JSON cannot represent, so the
    // suite can exercise the unrepresentable-result path separately from
    // the oversized one. The two must not report as each other.
    bigintResult: v.optional(v.boolean()),
  },
  returns: v.object({
    total: v.number(),
    pad: v.optional(v.string()),
    big: v.optional(v.int64()),
  }),
  handler: async (ctx, args) => {
    // Test hooks: `failWith` exercises the deliberate (ConvexError)
    // channel, `failPlain` the accidental one, whose text must NOT reach
    // the polling client.
    if (args.failPlain) throw new Error(args.failPlain);
    if (args.failWith) throw new ConvexError(args.failWith);
    const invoices = await ctx.db.query("invoices").collect();
    return {
      total: invoices.length,
      ...(args.padResult !== undefined
        ? { pad: "x".repeat(args.padResult) }
        : {}),
      ...(args.bigintResult === true ? { big: BigInt(7) } : {}),
    };
  },
});

/**
 * The registered function of the host-executed MCP task demo
 * (`invoices_bulkMarkPaid` on the /mcp-host-tasks/ mount). It never does
 * the work itself: with a host executor configured, execution flows
 * through the executor and `bulkMarkPaidTask` below, so a synchronous
 * (non-task) call gets a deliberate, user-facing error instead of an
 * unconfirmed bulk write.
 */
export const bulkMarkPaid = mutation({
  args: {},
  returns: v.null(),
  handler: async () => {
    throw new ConvexError(
      "invoices_bulkMarkPaid must be invoked as an MCP task",
    );
  },
});

/**
 * The actual bulk write, run by the host task executor after the owner
 * confirmed. Idempotent under hook retries and workflow re-runs: the
 * side effect is keyed on the gateway-issued task idempotency key, so a
 * repeated call returns the recorded result instead of re-applying.
 */
export const bulkMarkPaidTask = internalMutation({
  args: { key: v.string() },
  returns: v.object({ updated: v.number() }),
  handler: async (ctx, args) => {
    const prior = await ctx.db
      .query("taskExecutions")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (prior) return prior.result as { updated: number };

    const invoices = await ctx.db.query("invoices").collect();
    const open = invoices.filter((invoice) => invoice.status === "open");
    for (const invoice of open) {
      await ctx.db.patch("invoices", invoice._id, { status: "paid" });
    }
    const result = { updated: open.length };
    await ctx.db.insert("taskExecutions", { key: args.key, result });
    return result;
  },
});

/**
 * Test-only fixture: always throws a plain Error. The gateway treats
 * this as an unexpected internal failure, the wire response carries
 * a generic "Tool execution failed" message, while the audit row
 * keeps the verbose "boom" string for operator debugging.
 */
export const throwsAlways = query({
  args: {},
  returns: v.null(),
  handler: async () => {
    throw new Error("boom, should not reach the wire");
  },
});

/**
 * Test-only fixture: throws a `ConvexError`, the deliberate
 * user-facing error channel. The gateway forwards the message
 * verbatim to the wire (so the LLM can reason about the error) AND
 * to the audit row.
 */
export const throwsConvexError = query({
  args: {},
  returns: v.null(),
  handler: async () => {
    throw new ConvexError("Invoice not found");
  },
});

/**
 * Test-only fixture: accepts any payload under `args.payload`, returns
 * null. Lets redaction tests pass arbitrarily-shaped args without
 * tripping Convex's per-function arg validator.
 */
export const noopAny = query({
  args: { payload: v.optional(v.any()) },
  returns: v.null(),
  handler: async () => null,
});
