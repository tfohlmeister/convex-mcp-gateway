import { v } from "convex/values";
import {
  McpGateway,
  defineMcpMutation,
  defineMcpQuery,
  defineMcpResource,
  defineMcpResourceTemplate,
  completeCall,
  inputRequired,
  mcpCallerValidator,
  type McpResourceRegistration,
  type McpResourceTemplateProvider,
  type McpToolRegistration,
} from "convex-mcp-gateway";
import { api, components } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);

/**
 * The declarative tool catalog. Declared once here and passed to
 * `gateway.handleMcpRequest({ authorize, tools })` in `http.ts`, the
 * gateway reconciles the registry on each `initialize`, so changing
 * this list takes effect on the next connect with no manual mutation.
 *
 * The same list also backs `registerDefaults` below, which the
 * component-level tests use to populate the registry without going
 * through the HTTP path.
 *
 * The `McpToolRegistration[]` annotation is required because this array
 * is exported from a Convex module: without it, the inferred type reads
 * `api.*` from the tool `fn`s while `api` includes this module, and
 * codegen hits a circular reference. It does not weaken type safety,
 * `args`/`returns` are still checked at each `defineMcp*` call below.
 */
export const tools: McpToolRegistration[] = [
  defineMcpQuery({
    name: "invoices_list",
    description: "List invoices, optionally filtered by status.",
    fn: api.invoices.list,
    args: {
      status: v.optional(v.union(v.literal("open"), v.literal("paid"))),
    },
  }),
  defineMcpMutation({
    name: "invoices_markPaid",
    description: "Mark an invoice as paid.",
    fn: api.invoices.markPaid,
    args: { id: v.id("invoices") },
  }),
  defineMcpMutation({
    name: "invoices_archiveAfterConfirmation",
    description:
      "Ask for confirmation, then archive an invoice with a replay-safe retry.",
    fn: api.invoices.archiveAfterConfirmation,
    args: {
      id: v.id("invoices"),
      // Gateway-only: filled with the continuation's idempotency key on a
      // hook-approved retry. Absent from tools/list, unspoofable.
      continuationKey: v.optional(v.string()),
    },
    mrtrArgs: { idempotencyKey: "continuationKey" },
    // The gateway-side confirmation state machine. The mutation above is
    // MCP-unaware: accept dispatches it, decline finishes the call right
    // here, and a malformed answer simply asks again.
    beforeCall: async (_ctx, { args, inputResponses, round }) => {
      const ask = () =>
        inputRequired(
          {
            confirm: {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: "Archive this invoice?",
                requestedSchema: {
                  type: "object",
                  properties: { confirm: { type: "boolean" } },
                  required: ["confirm"],
                },
              },
            },
          },
          { invoiceId: args.id },
        );
      // First call: no continuation yet, request the confirmation round.
      // Discriminate on `round`, not on `inputResponses`. Both work for
      // this hook, because its "no answer yet" branch below also asks,
      // but `round` says what is actually being tested: a state-only
      // retry is a continuation, not a first call, and a hook that
      // treats the two differently needs to tell them apart.
      if (round === undefined) return ask();
      // Verified continuation: `inputResponses` is client-controlled,
      // so validate every field before acting on it.
      const confirm = inputResponses?.confirm as
        | { action?: string; content?: { confirm?: unknown } }
        | undefined;
      if (confirm === undefined) return ask(); // missing answer: ask again
      if (confirm.action !== "accept" || confirm.content?.confirm !== true) {
        // Declined (or cancelled): finish WITHOUT dispatching. The
        // mutation never runs, gateway-side by construction.
        return completeCall({
          content: [{ type: "text", text: "Invoice was not archived." }],
          isError: false,
        });
      }
      return null; // accepted: dispatch, with continuationKey injected
    },
  }),
  defineMcpQuery({
    name: "invoices_whoami",
    description:
      "Return the authenticated caller. Identity is injected by " +
      "the gateway into the `caller` arg (never sent by the client).",
    fn: api.invoices.whoami,
    args: { caller: mcpCallerValidator },
    returns: v.object({ subject: v.string(), hasClaims: v.boolean() }),
    // The gateway fills `caller` from the resolved identity, strips
    // it from the advertised schema + client args, and rejects calls
    // with no caller as Unauthorized.
    identityArg: "caller",
  }),
  defineMcpQuery({
    name: "invoices_summary",
    description: "Return the total number of invoices. Public.",
    fn: api.invoices.summary,
    args: {},
    // Declaring `returns` makes the gateway advertise an MCP
    // `outputSchema` for this tool and ship a `structuredContent`
    // block in every tools/call response. Type-checked against
    // the Convex function's actual return type at compile time.
    returns: v.object({ total: v.float64() }),
    // Client-facing protocol metadata: advertised verbatim on this
    // tool in `tools/list`. Distinct from `metadata` below, which the
    // client never sees.
    title: "Invoice summary",
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { "example.com/category": "invoices" },
    securitySchemes: [{ type: "noauth" }],
    // The host's authorize callback in http.ts treats `public:
    // true` as the opt-in for unauthenticated calls.
    metadata: { public: true },
  }),
];

/**
 * MCP resources exposed by this gateway, passed to
 * `gateway.handleMcpRequest({ resources })` in `http.ts`.
 *
 * `invoices://summary` is a concrete resource declared with
 * `defineMcpResource`: a fixed URI whose read handler loads content (here
 * the invoice total) and stamps the authenticated caller. Resource reads
 * receive the resolved caller identity; anonymous reads are rejected by the
 * gateway before this handler runs.
 *
 * The `McpResourceRegistration[]` annotation mirrors the `tools` array: it
 * keeps Convex codegen from chasing the `api.*` references in the read
 * handler into a circular type.
 */
export const resources: McpResourceRegistration[] = [
  defineMcpResource({
    uri: "invoices://summary",
    name: "invoice-summary",
    title: "Invoice summary",
    description: "Total invoice count for the authenticated caller.",
    mimeType: "application/json",
    annotations: { audience: ["assistant"], priority: 0.5 },
    read: async (ctx, { uri, identity }) => {
      const summary = await ctx.runQuery(api.invoices.summary, {});
      return [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ ...summary, caller: identity.subject }),
        },
      ];
    },
  }),
];

/**
 * MCP resource templates (RFC 6570), passed to
 * `gateway.handleMcpRequest({ resourceTemplates })`. `invoice://{id}` is a
 * parameterized resource: clients discover the shape via
 * `resources/templates/list`, then read a concrete `invoice://<id>` which
 * the gateway resolves through this handler (concrete resources above take
 * precedence on any URI that matches both).
 */
export const resourceTemplates: McpResourceTemplateProvider[] = [
  defineMcpResourceTemplate({
    uriTemplate: "invoice://{id}",
    name: "invoice",
    title: "Invoice by id",
    description: "Read a single invoice by its id.",
    mimeType: "application/json",
    read: async (ctx, { uri, params }) => {
      const invoice = await ctx.runQuery(api.invoices.get, { id: params.id });
      if (!invoice) return null;
      return [
        { uri, mimeType: "application/json", text: JSON.stringify(invoice) },
      ];
    },
  }),
];

/**
 * Imperative alternative to the declarative `tools` option: populate
 * the component registry from a mutation. Kept for advanced/dynamic
 * cases and used by the component-level tests; hosts that pass `tools`
 * to `handleMcpRequest` do not need to run this.
 *
 * ```sh
 * npx convex run mcp:registerDefaults
 * ```
 */
export const registerDefaults = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // `beforeCall` is executable host code, so only the HTTP route's
    // declarative `tools` path receives it. The registry still needs the
    // serializable descriptors for component-level tests and admin tooling.
    // The stripped row keeps `mrtrArgs`, so it registers as MRTR-gated:
    // a handler serving it WITHOUT the matching hook (e.g. a mount that
    // omits the `tools` option) fails such calls closed instead of
    // dispatching without the confirmation.
    await gateway.register(
      ctx,
      tools.map(({ beforeCall: _beforeCall, ...tool }) => tool),
    );
    return null;
  },
});
