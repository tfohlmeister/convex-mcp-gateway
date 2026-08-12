import { ConvexError, v } from "convex/values";
import { mcpCallerValidator } from "convex-mcp-gateway";
import { mutation, query } from "./_generated/server";

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
