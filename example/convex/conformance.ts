import { ConvexError, v } from "convex/values";
import {
  defineMcpAction,
  defineMcpMutation,
  defineMcpQuery,
  defineMcpResource,
  defineMcpResourceTemplate,
  type McpResourceRegistration,
  type McpResourceTemplateProvider,
  type McpToolRegistration,
} from "convex-mcp-gateway";
import { api } from "./_generated/api.js";
import { action, mutation, query } from "./_generated/server.js";

/**
 * Fixtures for the official MCP conformance suite
 * (`@modelcontextprotocol/conformance`). Each scenario states the tool it
 * expects and the exact result, so this file is a transcription of those
 * requirements rather than a design of its own. Served by the `/mcp/`
 * mount when `MCP_CONFORMANCE=1`, see the switch in `http.ts`.
 *
 * ```sh
 * npx convex env set MCP_CONFORMANCE 1   # then redeploy
 * npx @modelcontextprotocol/conformance server --url <site-url>/mcp
 * ```
 *
 * Kept out of `mcp.ts` on purpose: `test_*` tools teach a reader nothing
 * about the gateway, and folding them into the example catalog would
 * make the thing people actually read worse.
 *
 * ## What is deliberately missing, and why it cannot be added
 *
 * The suite also defines `test_image_content`, `test_audio_content`,
 * `test_embedded_resource` and `test_multiple_content_types`. They are
 * absent because three constraints rule them out together, not because
 * nobody got to them:
 *
 *  1. A dispatched Convex result is serialized into exactly one
 *     `type: "text"` content block. Image, audio, embedded-resource and
 *     multi-block results have no other route to the wire.
 *  2. The one escape hatch is a `beforeCall` hook returning
 *     `completeCall(...)`, whose result is forwarded verbatim.
 *  3. A tool carrying a `beforeCall` hook structurally requires an
 *     authenticated caller, and the suite sends no Authorization header.
 *
 * Constraint 3 is a property of the SUITE, not of the gateway, and
 * `pnpm conformance:proxy` lifts it (see docs/conformance.md). These
 * fixtures are still absent because constraints 1 and 2 stand: writing
 * them means giving the example a hook whose only job is to hand back a
 * canned image, which teaches a reader nothing. #50 is where the real
 * fix belongs.
 *
 * ## What the resource fixtures below are for
 *
 * The `resources/*` scenarios used to be unreachable for constraint 3
 * above, applied to resource methods: they always required an identity.
 * `anonymousResources` is the opt-out that changes it, and `http.ts` sets
 * it only under this switch. The fixtures are named exactly as the
 * scenarios request them.
 *
 * `resources-subscribe` and `resources-unsubscribe` stay out of reach on
 * purpose (see `anonymousResources`). `test://watched-resource` exists
 * anyway, because the scenario subscribes to a URI the catalog is
 * expected to list.
 */

/** Exactly the string the `tools-call-simple-text` scenario expects. */
export const simpleText = query({
  args: {},
  returns: v.string(),
  handler: async () => "This is a simple text response for testing.",
});

/**
 * Always throws. The gateway maps a dispatch failure to a *successful*
 * JSON-RPC response carrying `isError: true`, which is the distinction
 * the `tools-call-error` scenario is checking.
 */
export const alwaysFails = query({
  args: {},
  returns: v.null(),
  handler: async () => {
    throw new Error("This tool intentionally returns an error for testing");
  },
});

/** Never dispatched: the scenario only inspects the advertised schema. */
export const noop = query({
  args: {},
  returns: v.null(),
  handler: async () => null,
});

/**
 * Echoes the routing parameter back. `region` is optional because the
 * SEP-2243 cases deliberately send a `Mcp-Param-region` header with no
 * matching body argument, and the gateway's header check has to be what
 * refuses that, not an argument validator upstream of it.
 */
export const echoRegion = query({
  args: { region: v.optional(v.string()) },
  returns: v.string(),
  handler: async (_ctx, { region }) => `region=${region ?? "(none)"}`,
});

/**
 * The deferred half of `test_tool_with_task`. A mutation only because a
 * task that writes is the ordinary case worth showing; the executor runs
 * a task-supporting query just as happily.
 */
export const taskEcho = mutation({
  args: {},
  returns: v.string(),
  handler: async () => "Task completed for conformance testing.",
});

/** `greet`: the tasks scenarios' sync-only control, never task-augmented. */
export const greet = query({
  args: { name: v.string() },
  returns: v.string(),
  handler: async (_ctx, { name }) => `Hello, ${name}!`,
});

/**
 * `slow_compute`: an action rather than a mutation, because the scenario
 * asks for a real delay so it can observe a `working` status and cancel a
 * task mid-flight, and a Convex mutation is transactional and cannot
 * sleep. `seconds: 0` is the immediate path the same scenario uses to
 * check that a fast operation may skip task creation.
 */
export const slowCompute = action({
  args: { seconds: v.optional(v.number()), label: v.optional(v.string()) },
  returns: v.string(),
  handler: async (_ctx, { seconds, label }) => {
    const delayMs = Math.min(Math.max(seconds ?? 0, 0), 10) * 1000;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return `Computed ${label ?? "result"} after ${delayMs}ms.`;
  },
});

/**
 * `failing_job`: a TOOL error, which SEP-2663 wants reported as
 * `status: "completed"` with `result.isError`, not as `failed`. That is
 * what the gateway does: `runTool` maps any throw to `-32000` and the
 * task path launders exactly that code into a completed-with-isError
 * result.
 */
export const failingJob = action({
  args: {},
  returns: v.null(),
  handler: async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    throw new ConvexError("This job always fails for conformance testing");
  },
});

/**
 * `protocol_error_job`: the scenario wants the other half of that
 * distinction, a protocol-level failure reported as `status: "failed"`
 * with an inlined error and no result.
 *
 * This fixture cannot produce it, and no fixture can: a tool's throw is
 * `-32000` whatever its class, and only a refusal the tool never saw
 * (unknown tool, missing caller) fails a task. So the check this fixture
 * feeds documents a gateway gap rather than testing a behaviour. It stays
 * because the scenario names the tool and would otherwise report
 * untestable, which reads as "not measured" rather than "measured, and
 * this is missing".
 */
export const protocolErrorJob = action({
  args: {},
  returns: v.null(),
  handler: async () => {
    throw new Error("protocol failure for conformance testing");
  },
});

export const conformanceTools: McpToolRegistration[] = [
  defineMcpQuery({
    name: "test_simple_text",
    description: "Returns simple text content",
    fn: api.conformance.simpleText,
    args: {},
  }),
  defineMcpQuery({
    name: "test_error_handling",
    description: "Always reports a tool error",
    fn: api.conformance.alwaysFails,
    args: {},
  }),
  // SEP-1613 and SEP-2106 keyword preservation. Written out by hand
  // because `defineMcpQuery` derives `inputSchema` from Convex
  // validators, which inline everything and never emit `$defs`. Whether
  // these keywords reach the client unresolved is exactly what the
  // scenario measures, and the registry keeps the authored schema
  // alongside the resolved one so that they do.
  //
  // The shapes are dictated by the checks, not chosen: SEP-2106 wants a
  // non-empty `allOf` with a nested `anyOf` inside one of its members,
  // all three of `if` / `then` / `else` at the root, and an `$anchor` on
  // `$defs.address`.
  {
    name: "json_schema_2020_12_tool",
    description: "Tool with JSON Schema 2020-12 features",
    kind: "query",
    fn: api.conformance.noop,
    functionReference: api.conformance.noop,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: {
        address: {
          $anchor: "address",
          type: "object",
          properties: {
            street: { type: "string" },
            city: { type: "string" },
          },
        },
      },
      properties: {
        name: { type: "string" },
        address: { $ref: "#/$defs/address" },
        contactMethod: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
      },
      allOf: [
        {
          anyOf: [
            { required: ["email"] },
            { required: ["phone"] },
            { properties: { name: { type: "string" } } },
          ],
        },
      ],
      if: { properties: { contactMethod: { const: "email" } } },
      then: { required: ["email"] },
      else: { properties: { phone: { type: "string" } } },
      additionalProperties: false,
    },
  },
  // SEP-2243 custom routing headers. The scenario needs any tool with an
  // `x-mcp-header` annotation on a string property; without one it marks
  // every custom-header requirement untestable rather than failing them.
  {
    name: "test_custom_headers",
    description: "Tool whose region argument is bound to a routing header",
    kind: "query",
    fn: api.conformance.echoRegion,
    functionReference: api.conformance.echoRegion,
    inputSchema: {
      type: "object",
      properties: {
        region: { type: "string", "x-mcp-header": "region" },
      },
    },
  },
  // The tasks extension is advertised only when the catalog contains a
  // task-supporting tool, so without this the whole `tasks-*` group
  // reports the capability as absent and never reaches the gateway's
  // task machinery. `taskSupport: true` is the strongest thing this
  // gateway can register; SEP-2663's `required` has no equivalent, which
  // is why `tasks-required-task-error` still fails.
  defineMcpMutation({
    name: "test_tool_with_task",
    description: "Task-capable tool for the MCP Tasks extension scenarios",
    fn: api.conformance.taskEcho,
    args: {},
    taskSupport: true,
  }),
  // The four fixtures the SEP-2663 tasks scenarios name explicitly. Their
  // shapes are dictated by what those checks assert, including the tool
  // error / protocol error split that this gateway cannot currently
  // produce, see `protocolErrorJob` above.
  defineMcpQuery({
    name: "greet",
    description: "Greets by name. The sync-only control for the tasks scenarios",
    fn: api.conformance.greet,
    args: { name: v.string() },
  }),
  defineMcpAction({
    name: "slow_compute",
    description: "Sleeps for `seconds`, then returns a labelled result",
    fn: api.conformance.slowCompute,
    args: { seconds: v.optional(v.number()), label: v.optional(v.string()) },
    taskSupport: true,
  }),
  defineMcpAction({
    name: "failing_job",
    description: "Always reports a tool execution error, after about a second",
    fn: api.conformance.failingJob,
    args: {},
    taskSupport: true,
  }),
  defineMcpAction({
    name: "protocol_error_job",
    description: "Always fails with a protocol-level error",
    fn: api.conformance.protocolErrorJob,
    args: {},
    taskSupport: true,
  }),
];

/**
 * A 1x1 PNG: RGBA, one 50%-opaque blue pixel. The smallest thing that is
 * genuinely an image. `resources-read-binary` only requires `uri`,
 * `mimeType` and a non-empty `blob`, so the bytes matter less than the
 * shape, but a real PNG keeps the fixture honest for a client that tries
 * to decode it.
 */
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" +
  "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * Concrete resources the suite reads by exact URI. `metadata.public`
 * marks them for `authorizeResource` in `http.ts`, the same convention the
 * example's tools use, so the anonymous decision is the host's rather than
 * the gateway's.
 */
export const conformanceResources: McpResourceRegistration[] = [
  defineMcpResource({
    uri: "test://static-text",
    name: "Static Text Resource",
    description: "A static text resource for conformance testing",
    mimeType: "text/plain",
    metadata: { public: true },
    read: async () => [
      {
        uri: "test://static-text",
        mimeType: "text/plain",
        text: "This is the content of the static text resource.",
      },
    ],
  }),
  defineMcpResource({
    uri: "test://static-binary",
    name: "Static Binary Resource",
    description: "A static binary resource for conformance testing",
    mimeType: "image/png",
    metadata: { public: true },
    read: async () => [
      {
        uri: "test://static-binary",
        mimeType: "image/png",
        blob: ONE_PIXEL_PNG,
      },
    ],
  }),
  defineMcpResource({
    uri: "test://watched-resource",
    name: "Watched Resource",
    description: "A resource the subscribe scenarios watch",
    mimeType: "text/plain",
    metadata: { public: true },
    read: async () => [
      {
        uri: "test://watched-resource",
        mimeType: "text/plain",
        text: "This resource can be watched for changes.",
      },
    ],
  }),
];

/**
 * `resources-templates-read` reads `test://template/123/data` and asserts
 * the returned text contains the substituted parameter, so the handler has
 * to echo `params.id` rather than return a fixed string.
 */
export const conformanceResourceTemplates: McpResourceTemplateProvider[] = [
  defineMcpResourceTemplate({
    uriTemplate: "test://template/{id}/data",
    name: "Template Resource",
    description: "A parameterized resource for conformance testing",
    mimeType: "text/plain",
    read: async (_ctx, { uri, params }) => [
      {
        uri,
        mimeType: "text/plain",
        text: `Data for template parameter ${params.id}.`,
      },
    ],
  }),
];
