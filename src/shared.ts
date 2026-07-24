import { v } from "convex/values";
import type { FunctionReference } from "convex/server";
import type {
  GenericValidator,
  Infer,
  PropertyValidators,
  Validator,
  VAny,
  VArray,
  VBoolean,
  VBytes,
  VFloat64,
  VId,
  VInt64,
  VLiteral,
  VNull,
  VObject,
  VRecord,
  VString,
  VUnion,
} from "convex/values";

export type JsonSchema =
  | {
      type: "string";
      enum?: string[];
      format?: string;
      contentEncoding?: string;
      description?: string;
      [key: string]: unknown;
    }
  | { type: "number"; description?: string; [key: string]: unknown }
  | {
      type: "integer";
      format?: string;
      description?: string;
      [key: string]: unknown;
    }
  | { type: "boolean"; description?: string; [key: string]: unknown }
  | { type: "null"; description?: string; [key: string]: unknown }
  | {
      type: "array";
      items: JsonSchema;
      description?: string;
      [key: string]: unknown;
    }
  | {
      type: "object";
      properties?: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: JsonSchema | boolean;
      description?: string;
      [key: string]: unknown;
    }
  | { const: unknown; description?: string; [key: string]: unknown }
  | { anyOf: JsonSchema[]; description?: string; [key: string]: unknown }
  | { description?: string; [key: string]: unknown };

export type McpToolKind = "query" | "mutation" | "action";

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export type McpToolSecurityScheme =
  | { type: "noauth"; [key: string]: unknown }
  | { type: "oauth2"; scopes: string[]; [key: string]: unknown };

export interface McpToolDefinition {
  name: string;
  description: string;
  kind: McpToolKind;
  functionReference: unknown;
  inputSchema: JsonSchema;
  /**
   * Optional MCP `outputSchema` (JSON Schema). When set, the gateway
   * also includes `structuredContent` in every `tools/call` response
   * for this tool, alongside the existing text-JSON `content` block.
   * Most commonly populated by passing `returns:` to
   * `defineMcp{Query,Mutation,Action}`.
   */
  outputSchema?: JsonSchema;
  title?: string;
  annotations?: McpToolAnnotations;
  _meta?: Record<string, unknown>;
  securitySchemes?: McpToolSecurityScheme[];
  /**
   * Name of the tool function argument the gateway fills server-side
   * with the resolved caller identity (`{ subject, claims }`). When set:
   * the arg is removed from the advertised `inputSchema` (clients never
   * see it), stripped from caller-supplied arguments (no spoofing), and
   * injected from the identity resolved at the gateway boundary right
   * before dispatch. Lets identity-scoped tools read the caller without
   * `ctx.auth` (which Convex strips across the component boundary). Use
   * `mcpCallerValidator` for the arg's validator.
   */
  identityArg?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A Convex function reference usable as an MCP tool: a query, mutation,
 * or action of either visibility. The arg/return generics are `any`
 * here on purpose, the per-tool arg/return type-checking happens in the
 * `defineMcp*` config parameter, not at this widened element type.
 */
export type McpToolFunctionReference = FunctionReference<
  McpToolKind,
  "internal" | "public",
  any,
  any
>;

/**
 * Element type of a declarative tool catalog: the result of
 * `defineMcp{Query,Mutation,Action}`. Use it to annotate an exported
 * `tools` array so it can be passed to `gateway.handleMcpRequest` or
 * `gateway.register`:
 *
 * ```ts
 * export const tools: McpToolRegistration[] = [defineMcpQuery({ ... })];
 * ```
 *
 * The annotation is only needed when the array is **exported from a
 * Convex module** (one under your `convex/` functions dir): without it,
 * the inferred type reads `api.*` from the tool `fn`s while `api` itself
 * includes that module, and Convex's generated `api.d.ts` hits a
 * circular-reference error. A non-exported `const tools = [...]` (e.g.
 * declared inline in `http.ts`) needs no annotation.
 *
 * Annotating does **not** weaken per-tool type safety: `args` / `returns`
 * are validated at the `defineMcp*` call against the function's actual
 * signature, independent of how the resulting array is typed.
 */
export type McpToolRegistration = McpToolDefinition & {
  fn: McpToolFunctionReference;
};

/**
 * Validator for the caller identity the gateway injects into a tool's
 * `identityArg`. Declare the receiving argument with this validator so
 * the tool's compile-time `args` check still matches its function:
 *
 * ```ts
 * export const whoami = query({
 *   args: { caller: mcpCallerValidator },
 *   handler: async (_ctx, { caller }) => ({ subject: caller.subject }),
 * });
 *
 * defineMcpQuery({
 *   name: "whoami",
 *   fn: api.x.whoami,
 *   args: { caller: mcpCallerValidator },
 *   identityArg: "caller",
 * });
 * ```
 *
 * `subject` is the caller's stable id; `claims` is whatever the
 * boundary resolved (the upstream userinfo doc in bridge mode, or the
 * Convex JWT identity otherwise).
 */
export const mcpCallerValidator = v.object({
  subject: v.string(),
  claims: v.optional(v.any()),
});

export type McpCaller = Infer<typeof mcpCallerValidator>;

/**
 * Args that the gateway passes to the host's `authorize` callback for
 * each `tools/call` and each filtered `tools/list` evaluation.
 *
 * The authorizer is a regular JS function the host hands to
 * `gateway.handleMcpRequest({ authorize })`, **not** a registered
 * Convex query: Convex doesn't propagate `ctx.auth` into component
 * code, so the policy decision must run host-side where
 * `ctx.auth.getUserIdentity()` works.
 */
export interface McpAuthorizerArgs {
  toolName: string;
  toolKind: McpToolKind;
  args: Record<string, unknown>;
  /**
   * `"call"` for an actual `tools/call` dispatch, `"list"` when the
   * gateway is filtering `tools/list` per tool. `args` for `"list"`
   * is always an empty object.
   */
  mode: "call" | "list";
  /**
   * Free-form metadata the host attached to the tool via
   * `defineMcp*({ metadata })`. The component never inspects this;
   * the authorizer reads it for scope/role / public-flag checks.
   */
  toolMetadata: unknown;
  /**
   * The caller's identity, resolved once at the gateway boundary
   * before this callback runs. Source depends on configuration:
   * - With `resolveIdentity` set: whatever the validator returned
   *   (typically userinfo-endpoint claims).
   * - Without `resolveIdentity`: the result of
   *   `ctx.auth.getUserIdentity()`, with `iss/aud` mismatches treated
   *   as null instead of throwing.
   *
   * `null` for anonymous calls (no Bearer, invalid token, etc.).
   *
   * Prefer this field over calling `ctx.auth.getUserIdentity()`
   * inside the callback: it works in both pure-JWT and bridge modes,
   * and you save a call.
   */
  identity: { subject: string; claims?: Record<string, unknown> } | null;
}

export interface McpAuthorizerDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Runtime validation of the host's authorize-callback return value.
 * Lenient on extra fields (forward-compat); strict on the required
 * `allowed` boolean. Lives in `shared.ts` so both the host (`mcp-handler`)
 * and the component (`dispatch`, via re-export) can defend against
 * authorize callbacks that return malformed shapes.
 */
export function parseAuthorizerDecision(
  decision: unknown,
): McpAuthorizerDecision {
  if (
    typeof decision !== "object" ||
    decision === null ||
    typeof (decision as { allowed?: unknown }).allowed !== "boolean"
  ) {
    return {
      allowed: false,
      reason:
        "Authorizer returned an invalid shape. Expected `{ allowed: boolean, reason?: string }`.",
    };
  }
  const d = decision as { allowed: boolean; reason?: unknown };
  return {
    allowed: d.allowed,
    reason: typeof d.reason === "string" ? d.reason : undefined,
  };
}

/**
 * Authorizer signature: a regular async (or sync) function. It runs in
 * the host's HTTP-action context, so `ctx.auth.getUserIdentity()`
 * returns the JWT-validated identity here.
 *
 * ```ts
 * import type { McpAuthorizerHandler } from "convex-mcp-gateway";
 *
 * export const authorize: McpAuthorizerHandler = async (ctx, args) => {
 *   const identity = await ctx.auth.getUserIdentity();
 *   if (!identity) return { allowed: false, reason: "Unauthorized" };
 *   // ... your scope / role / metadata check ...
 *   return { allowed: true };
 * };
 * ```
 */
export type McpAuthorizerHandler = (
  ctx: { auth: { getUserIdentity: () => Promise<unknown> } } & Record<
    string,
    unknown
  >,
  args: McpAuthorizerArgs,
) => Promise<McpAuthorizerDecision> | McpAuthorizerDecision;

/**
 * Convert a Convex validator (single value or args-object) into a JSON Schema
 * fragment that satisfies MCP `tools.inputSchema`.
 *
 * MCP tools always present an object-typed input schema. If you pass a
 * `PropertyValidators` record, the result is `{ type: "object", properties, required }`.
 * If you pass a single validator, it returns that fragment unwrapped.
 */
export function convexValidatorToJsonSchema(
  validator: GenericValidator | PropertyValidators,
): JsonSchema {
  if (isValidator(validator)) {
    return validatorToSchema(validator);
  }
  return propertyValidatorsToObjectSchema(validator);
}

function isValidator(value: unknown): value is GenericValidator {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof (value as { kind: unknown }).kind === "string"
  );
}

export function propertyValidatorsToObjectSchema(
  validators: PropertyValidators,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, validator] of Object.entries(validators)) {
    const optional =
      (validator as { isOptional?: string }).isOptional === "optional";
    properties[key] = validatorToSchema(validator);
    if (!optional) {
      required.push(key);
    }
  }
  const out: JsonSchema = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) {
    (out as { required?: string[] }).required = required;
  }
  return out;
}

function validatorToSchema(validator: GenericValidator): JsonSchema {
  const kind = (validator as { kind: string }).kind;
  switch (kind) {
    case "string":
      return { type: "string" };
    case "float64":
      return { type: "number" };
    case "int64":
      return { type: "integer", format: "int64" };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "bytes":
      return { type: "string", contentEncoding: "base64" };
    case "any":
      return {};
    case "id": {
      const v = validator as VId<string, "required" | "optional">;
      const tableName = (v as unknown as { tableName?: string }).tableName;
      return {
        type: "string",
        format: "convex-id",
        ...(tableName !== undefined ? { "x-convex-table": tableName } : {}),
      };
    }
    case "literal": {
      const v = validator as VLiteral<string | number | boolean, "required">;
      return { const: v.value };
    }
    case "array": {
      const v = validator as VArray<unknown, GenericValidator>;
      return { type: "array", items: validatorToSchema(v.element) };
    }
    case "object": {
      const v = validator as VObject<unknown, PropertyValidators>;
      return propertyValidatorsToObjectSchema(v.fields);
    }
    case "record": {
      const v = validator as VRecord<
        unknown,
        Validator<string, "required">,
        GenericValidator
      >;
      return {
        type: "object",
        additionalProperties: validatorToSchema(v.value),
      };
    }
    case "union": {
      const v = validator as VUnion<unknown, GenericValidator[]>;
      return { anyOf: v.members.map(validatorToSchema) };
    }
    default: {
      // exhaustive escape for forward-compat with new validator kinds
      const _exhaustive: never = kind as never;
      void _exhaustive;
      return {};
    }
  }
}

export type {
  GenericValidator,
  PropertyValidators,
  Validator,
  VAny,
  VArray,
  VBoolean,
  VBytes,
  VFloat64,
  VId,
  VInt64,
  VLiteral,
  VNull,
  VObject,
  VRecord,
  VString,
  VUnion,
};

/**
 * Compute the RFC 9728 protected-resource metadata URL for an MCP gateway
 * mounted at `mcpPath` on `origin`. The canonical (path-prefix) form
 * places the well-known segment between host and path:
 *
 *     `<origin>/.well-known/oauth-protected-resource<mcpPath>`
 *
 * For example, an MCP endpoint at `https://app.example.com/mcp/` has
 * metadata at `https://app.example.com/.well-known/oauth-protected-resource/mcp`.
 *
 * Pure function so the gateway can compute the URL from inside an
 * httpAction without re-parsing intermediate URLs, and so it is unit
 * testable independently of any framework.
 *
 * Spec: RFC 9728 §3.1 ("Well-Known URI"). The host is expected to mount
 * the discovery handler at exactly this path; the gateway component
 * does not own any HTTP routes (Convex doesn't propagate `ctx.auth`
 * into component code, so all routes live in the host).
 */
export function buildProtectedResourceMetadataUrl(
  origin: string,
  mcpPath: string,
): string {
  const path = mcpPath.replace(/\/+$/, "");
  return `${origin}/.well-known/oauth-protected-resource${path}`;
}

/**
 * Compute the canonical resource URL for an MCP gateway from a request
 * URL plus an optional override. Used by both the 401 path (where the
 * request hits `<mcpPath>`) and by host-mounted discovery handlers
 * (which call this with the path stripped of the well-known prefix).
 */
export function buildResourceUrl(
  origin: string,
  mcpPath: string,
  override: string | null | undefined,
): string {
  if (override) return override;
  const path = mcpPath.endsWith("/") ? mcpPath : `${mcpPath}/`;
  return `${origin}${path}`;
}

/**
 * Strip the `/.well-known/oauth-protected-resource` prefix from a
 * request path to recover the resource path the metadata document
 * describes. Used by the host's discovery-route handler.
 *
 * Returns `"/"` if nothing follows the well-known segment, matching the
 * RFC 9728 example for resources mounted at the host root.
 */
export function resourcePathFromWellKnownRequest(pathname: string): string {
  const prefix = "/.well-known/oauth-protected-resource";
  if (!pathname.startsWith(prefix)) return pathname;
  const rest = pathname.slice(prefix.length);
  return rest === "" ? "/" : rest;
}
