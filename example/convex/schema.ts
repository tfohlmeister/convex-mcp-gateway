import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  invoices: defineTable({
    status: v.union(v.literal("open"), v.literal("paid")),
    amount: v.number(),
  }),
  // The example persists the gateway-provided MRTR idempotency key. A real
  // application should retain this record for its own retry window.
  mrtrExecutions: defineTable({
    key: v.string(),
    invoiceId: v.id("invoices"),
    result: v.object({ archived: v.boolean(), invoiceId: v.id("invoices") }),
  }).index("by_key", ["key"]),
  // Durable idempotency records for host-executed MCP tasks: one row per
  // task idempotency key, written by invoices.bulkMarkPaidTask so hook
  // retries and workflow re-runs never double-apply the side effect.
  // A real application should retain these for its own retry window.
  taskExecutions: defineTable({
    key: v.string(),
    result: v.any(),
  }).index("by_key", ["key"]),
});
