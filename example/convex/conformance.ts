import { v } from "convex/values";
import {
  defineMcpQuery,
  defineMcpResource,
  defineMcpResourceTemplate,
  type McpResourceRegistration,
  type McpResourceTemplateProvider,
  type McpToolRegistration,
} from "convex-mcp-gateway";
import { api } from "./_generated/api.js";
import { query } from "./_generated/server.js";

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
 *     authenticated caller, and the suite cannot send an Authorization
 *     header.
 *
 * So the suite cannot reach the gateway's non-text content paths at all.
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
  // SEP-1613 keyword preservation. Written out by hand because
  // `defineMcpQuery` derives `inputSchema` from Convex validators, which
  // inline everything and never emit `$defs`. Whether these keywords
  // reach the client unresolved is exactly what the scenario measures,
  // and the registry keeps the authored schema alongside the resolved
  // one so that they do.
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
      },
      additionalProperties: false,
    },
  },
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
