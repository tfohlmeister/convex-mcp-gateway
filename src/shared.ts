import { ConvexError, v } from "convex/values";
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

/**
 * Names of tool arguments reserved for gateway-injected MRTR data. Only
 * the idempotency key is ever injected: continuation state and input
 * responses stay inside the `beforeCall` hook, so the underlying Convex
 * function remains MCP-unaware.
 */
export interface McpMrtrArgs {
  idempotencyKey: string;
}

/**
 * A host-side MRTR decision. The gateway signs `state` but does not encrypt
 * it, so it must not contain credentials.
 */
export type McpInputRequiredResult = {
  __mcpInputRequired: true;
  inputRequests?: Record<string, unknown>;
  state?: unknown;
};

/**
 * A host-side `beforeCall` decision that ends the call without invoking
 * the underlying Convex function. `result` is the literal MCP
 * `tools/call` result the client receives (`content`, optional
 * `structuredContent`, optional `isError`), e.g. "Invoice was not
 * archived." after a declined confirmation.
 */
export type McpCompleteCallResult = {
  __mcpCompleteCall: true;
  result: Record<string, unknown>;
};

export type McpBeforeCallResult =
  | McpInputRequiredResult
  | McpCompleteCallResult
  | null
  | undefined;

/** Create a host-side `beforeCall` result that requests another round trip. */
export function inputRequired(
  inputRequests: Record<string, unknown> = {},
  state?: unknown,
): McpInputRequiredResult {
  return {
    __mcpInputRequired: true,
    inputRequests,
    ...(state !== undefined ? { state } : {}),
  };
}

/**
 * Create a host-side `beforeCall` result that terminates the call with
 * the given MCP tool result, without dispatching the Convex function.
 */
export function completeCall(
  result: Record<string, unknown>,
): McpCompleteCallResult {
  return { __mcpCompleteCall: true, result };
}

/**
 * A single entry of a tool's `securitySchemes`. The field is still a
 * draft addition to the MCP Tool spec and the gateway only passes it
 * through, so the shape stays open: `type` plus whatever the scheme
 * carries (`scopes` for `oauth2`, nothing for `noauth`). Pinning the
 * union here would reject schemes the spec adds later without buying
 * any runtime safety.
 */
export interface McpToolSecurityScheme {
  type: string;
  [key: string]: unknown;
}

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
  /**
   * Name of the tool argument the gateway fills with the continuation's
   * stable idempotency key on a verified MRTR retry that continues to
   * dispatch. Removed from the advertised input schema and stripped from
   * every client request. Optional: a tool without durable side effects
   * (or one only used for gateway-side confirmation) does not need it.
   */
  mrtrArgs?: McpMrtrArgs;
  /**
   * The host-side MRTR state machine, run in the host HTTP action before
   * the underlying Convex tool on the first call AND on every verified
   * continuation (where it additionally receives the decoded state, the
   * client's untrusted `inputResponses`, and the stable idempotency key).
   * Returns `inputRequired()` for another round, `completeCall()` to end
   * the call without dispatching, or `null`/`undefined` to continue to
   * the Convex function. Supported only by the declarative `tools`
   * option of `handleMcpRequest`.
   */
  beforeCall?: McpBeforeCallHandler;
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
 * What a `beforeCall` hook receives. On the first call only `args` and
 * `identity` are present. On a verified continuation the gateway adds
 * the decoded `state` the hook sealed in the previous round, the
 * client's untrusted `inputResponses` (validate every field before
 * acting on it), the chain's stable `idempotencyKey`, and the 1-based
 * `round` number of the continuation being answered.
 */
export type McpBeforeCallArgs = {
  args: Record<string, unknown>;
  identity: McpCaller;
  state?: unknown;
  inputResponses?: Record<string, unknown>;
  idempotencyKey?: string;
  round?: number;
};

export type McpBeforeCallHandler = (
  ctx: { auth: { getUserIdentity: () => Promise<unknown> } } & Record<
    string,
    unknown
  >,
  args: McpBeforeCallArgs,
) => McpBeforeCallResult | Promise<McpBeforeCallResult>;

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
 * Is this a `ConvexError`, i.e. a message the host threw on purpose?
 *
 * The gateway treats `ConvexError` as the deliberate caller-facing
 * channel: its message reaches the MCP client verbatim. Every other
 * throw is an accident (a failed `fetch` quoting a signed URL, a driver
 * error echoing a connection string) and only ever reaches the client
 * as a generic message.
 *
 * The `instanceof` check covers the in-process case; the
 * `name === "ConvexError"` fallback catches errors that crossed a Convex
 * function boundary (`ctx.runQuery` / `runMutation` / `runAction`
 * reconstruct the error with the proper `name`, but the class identity
 * can differ across module resolution boundaries inside `convex-test`).
 *
 * Lives in `shared.ts` because the component (`dispatch.runTool`) and the
 * host (`mcp-handler`'s resource paths) must classify errors identically;
 * two copies of this predicate would be two chances to drift.
 */
export function isDeliberateConvexError(err: unknown): boolean {
  return (
    err instanceof ConvexError ||
    (err instanceof Error && err.name === "ConvexError")
  );
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

// =================================================================
// Bounded JSON Schema 2020-12 reference resolution
// =================================================================

/**
 * Budgets for `resolveJsonSchemaBounded`. Hard limits with named
 * errors: silently truncating a schema would advertise a contract the
 * tool does not have, which is worse than rejecting it at registration.
 */
export const SCHEMA_MAX_STRUCTURAL_DEPTH = 64;
export const SCHEMA_MAX_REF_EXPANSIONS = 64;
export const SCHEMA_MAX_RESOLVED_BYTES = 64 * 1024;

/**
 * Version of the resolution semantics. Folded into the declarative
 * catalog fingerprint so a change here re-syncs every registry that was
 * written under the old rules, instead of leaving deployments
 * advertising stale resolutions until someone edits a tool. Bump on any
 * behavior change (new supported ref position, different budget
 * accounting, changed drop rules).
 */
export const SCHEMA_RESOLVER_VERSION = 2;

const LOCAL_DEFS_REF = /^#\/\$defs\/(.+)$/;

/** JSON Pointer token unescape (RFC 6901): `~1` -> `/`, `~0` -> `~`. */
function unescapeJsonPointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * Keywords whose value is itself a schema. `$ref` handling is
 * position-aware: an object key named `"$ref"` is only a reference when
 * the object sits in a schema position; inside data keywords
 * (`enum` / `const` / `default` / `examples`), inside unknown vendor
 * keywords, or as a PROPERTY NAME under `properties`, it is plain data
 * and must pass through untouched.
 */
const SCHEMA_VALUED_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
/** Keywords whose value is a map of `name -> schema`. */
const SCHEMA_MAP_KEYWORDS = new Set([
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
/** Keywords whose value is an array of schemas. */
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
/**
 * Definition containers. Deliberately NOT walked as output positions:
 * resolution is reachability-driven, so an entry is only resolved (and
 * only charged against the expansion budget) when something actually
 * references it. Walking them eagerly would let an unused authoring
 * artefact in a generated bundle — a self-referential type, a remote
 * `$ref`, or simply many definitions — fail a schema whose resolved
 * form is perfectly fine, and a declarative sync is all-or-nothing.
 */
const DEFINITION_CONTAINER_KEYWORDS = new Set(["$defs", "definitions"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** UTF-8 byte length without `TextEncoder` (unavailable in some Convex runtimes). */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair: 4 bytes total, consume the low surrogate too.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Position-INDEPENDENT scan for a reference-shaped object anywhere in a
 * resolved schema, returning its JSON path or `null`. This is the
 * no-dangling-ref guard, and it deliberately does not share the keyword
 * sets with the walker: a check built from the same sets is unreachable
 * by construction (whatever the walker skips, the check would skip too),
 * which is exactly how a `$ref` under an unhandled keyword could ship
 * with its `$defs` already deleted.
 */
function findRefLikePath(node: unknown, path: string[] = []): string | null {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      const found = findRefLikePath(node[index], [...path, String(index)]);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(node)) return null;
  if (typeof node.$ref === "string") {
    return path.length === 0 ? "(root)" : path.join(".");
  }
  for (const [key, value] of Object.entries(node)) {
    const found = findRefLikePath(value, [...path, key]);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Position-aware detection: true only when a `$ref` keyword occurs at a
 * SCHEMA position. `{ properties: { $ref: { type: "string" } } }`
 * declares a field literally named `$ref` and contains no reference.
 */
function schemaContainsRef(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if ("$ref" in schema) return true;
  for (const [key, value] of Object.entries(schema)) {
    // Definition containers are skipped on purpose: a schema whose only
    // references live in unused definitions needs no resolution at all,
    // and is returned verbatim with its containers (and therefore their
    // references) intact.
    if (DEFINITION_CONTAINER_KEYWORDS.has(key)) continue;
    if (SCHEMA_VALUED_KEYWORDS.has(key)) {
      // Accept the array form too (draft-07 `items`/`additionalItems`):
      // whatever draft the client validates with, the author meant
      // schemas, and detection must mirror expansion exactly.
      if (Array.isArray(value)) {
        if (value.some(schemaContainsRef)) return true;
      } else if (schemaContainsRef(value)) {
        return true;
      }
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
      for (const entry of Object.values(value)) {
        if (schemaContainsRef(entry)) return true;
      }
    }
    if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      if (value.some(schemaContainsRef)) return true;
    }
  }
  return false;
}

/**
 * Own-property assignment that survives keys like `"__proto__"`: a
 * plain `out[key] = value` would hit the inherited accessor, which is a
 * prototype-pollution hazard during the walk. This keeps the walk safe;
 * it is NOT an end-to-end guarantee that such a field is storable,
 * since Convex's own serialization drops a `__proto__` field (and
 * rejects `$`-prefixed field names) at the storage boundary.
 */
function setOwn(
  out: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export type ResolvedJsonSchema =
  | { resolved: unknown; problem?: undefined }
  | { resolved?: undefined; problem: string };

/**
 * Resolve a tool schema's local `$ref`s within hard budgets, producing
 * a self-contained schema suitable for storage and advertisement.
 *
 * The contract, deliberately narrow:
 *
 * - A schema with no `$ref` at any SCHEMA position is returned
 *   **verbatim** (the same reference), so every schema that registers
 *   today keeps advertising byte-identically. Detection and expansion
 *   are position-aware: `$ref` is only a reference where a schema is
 *   expected, never inside data keywords (`enum`, `const`, `default`,
 *   `examples`), unknown vendor keywords, or as a property NAME. Note
 *   this is about how the resolver INTERPRETS such values, not a
 *   promise that they are storable: Convex rejects `$`-prefixed field
 *   names at the storage boundary, so a schema declaring a property
 *   named `$ref` cannot be registered whatever this function returns.
 * - Only root-relative `#/$defs/<name>` references are supported
 *   (single JSON Pointer token, RFC 6901 unescaped). Remote (`https:`)
 *   references, anchors, and pointers into arbitrary schema locations
 *   are rejected by name -- the gateway must never fetch, and a ref
 *   into the middle of another schema has no stable meaning once the
 *   target is rewritten.
 * - `$ref` must be the only key of its schema object. JSON Schema
 *   2020-12 gives adjacent keywords `allOf`-like semantics; merging
 *   them correctly is a composition problem, and composition is
 *   exactly where static reachability (and with it the `x-mcp-header`
 *   binding guarantee) ends.
 * - Resolution is **reachability-driven**: definition containers
 *   (`$defs`, `definitions`) are never walked as output, only pulled
 *   from when something references them. An unused definition — a
 *   self-referential type or a remote `$ref` in a generated bundle —
 *   therefore cannot fail a schema whose resolved form is fine, and the
 *   expansion budget counts only definitions that end up in the output.
 * - Expansion is bounded three ways: traversal depth (each nesting
 *   level of the schema tree charges one), total `$ref` expansions, and
 *   the UTF-8 size of the result. Cycles are detected via the active
 *   reference chain, not left to the depth budget, so the error names
 *   the cycle.
 * - On success the root definition containers are dropped: every
 *   reference into them has been inlined, and advertising dead
 *   definitions would only confuse clients that do not resolve
 *   references (which is why the gateway inlines rather than passes
 *   `$ref` through: the advertised schema works for every client, and
 *   the runtime `Mcp-Param-*` walk sees exactly what was validated at
 *   registration). A reference that survives resolution anywhere in the
 *   output — e.g. under a keyword the walker does not treat as a schema
 *   position, or inside a nested definition container — is rejected by
 *   name rather than shipped dangling.
 */
export function resolveJsonSchemaBounded(schema: unknown): ResolvedJsonSchema {
  if (!schemaContainsRef(schema)) return { resolved: schema };
  const root = schema as Record<string, unknown>;
  const rawDefs = root.$defs;
  const defs = isRecord(rawDefs) ? rawDefs : {};

  let expansions = 0;
  let problem: string | null = null;

  function fail(message: string): undefined {
    problem ??= message;
    return undefined;
  }

  function walkSchema(
    node: unknown,
    depth: number,
    activeRefs: readonly string[],
    isRoot = false,
  ): unknown {
    if (problem !== null) return undefined;
    if (depth > SCHEMA_MAX_STRUCTURAL_DEPTH) {
      return fail(
        `schema exceeds the structural depth budget (${SCHEMA_MAX_STRUCTURAL_DEPTH})`,
      );
    }
    // Booleans are valid 2020-12 schemas; anything non-object passes
    // through (invalid shapes are a validation concern, not ours).
    if (!isRecord(node)) return node;
    if ("$ref" in node) {
      const ref = node.$ref;
      if (Object.keys(node).length !== 1) {
        return fail(
          `adjacent keywords beside $ref are not supported (${JSON.stringify(ref)})`,
        );
      }
      if (typeof ref !== "string") {
        return fail("$ref must be a string");
      }
      const match = LOCAL_DEFS_REF.exec(ref);
      // A single pointer token only: a `/` remaining after the $defs
      // prefix would point into the middle of a definition.
      if (!match || match[1].includes("/")) {
        return fail(
          `only local "#/$defs/<name>" references are supported (${JSON.stringify(ref)})`,
        );
      }
      const key = unescapeJsonPointerToken(match[1]);
      if (!Object.prototype.hasOwnProperty.call(defs, key)) {
        return fail(`unknown $defs entry ${JSON.stringify(key)}`);
      }
      if (activeRefs.includes(key)) {
        return fail(
          `cyclic $ref through "#/$defs/${key}" ` +
            `(chain: ${[...activeRefs, key].join(" -> ")})`,
        );
      }
      expansions += 1;
      if (expansions > SCHEMA_MAX_REF_EXPANSIONS) {
        return fail(
          `schema exceeds the $ref expansion budget (${SCHEMA_MAX_REF_EXPANSIONS})`,
        );
      }
      return walkSchema(defs[key], depth + 1, [...activeRefs, key]);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (isRoot && DEFINITION_CONTAINER_KEYWORDS.has(key)) {
        // Consumed on demand by `$ref`, never emitted: the output is
        // self-contained, so the container is dead weight.
        continue;
      }
      if (SCHEMA_VALUED_KEYWORDS.has(key)) {
        // Array form (draft-07 `items`/`additionalItems`): elements are
        // schemas by author intent, resolve them like `prefixItems`.
        setOwn(
          out,
          key,
          Array.isArray(value)
            ? value.map((entry) => walkSchema(entry, depth + 1, activeRefs))
            : walkSchema(value, depth + 1, activeRefs),
        );
      } else if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
        const map: Record<string, unknown> = {};
        for (const [name, entry] of Object.entries(value)) {
          setOwn(map, name, walkSchema(entry, depth + 1, activeRefs));
          if (problem !== null) return undefined;
        }
        setOwn(out, key, map);
      } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
        setOwn(
          out,
          key,
          value.map((entry) => walkSchema(entry, depth + 1, activeRefs)),
        );
      } else {
        // Data keywords (enum/const/default/examples), annotations, and
        // unknown vendor keys pass through verbatim: nothing inside
        // them is a reference position, whatever it looks like. A
        // ref-SHAPED object here is caught by the no-dangling-ref check
        // after the walk, since it could not be resolved.
        setOwn(out, key, value);
      }
      if (problem !== null) return undefined;
    }
    return out;
  }

  const resolved = walkSchema(root, 0, [], true) as
    | Record<string, unknown>
    | undefined;
  if (problem !== null || resolved === undefined) {
    return { problem: problem ?? "schema resolution failed" };
  }
  // No-dangling-ref guard. Position-INDEPENDENT by design (see
  // `findRefLikePath`): the definition containers are gone from the
  // output, so any surviving reference — under a keyword the walker
  // treats as data, or inside a nested definition container — would
  // otherwise ship unresolvable. Reject it by path instead.
  const danglingPath = findRefLikePath(resolved);
  if (danglingPath !== null) {
    return {
      problem:
        `an unresolved $ref remains at ${danglingPath} after resolution ` +
        `(the reference is in a position this resolver does not treat as ` +
        `a schema, so it cannot be inlined)`,
    };
  }
  const serialized = JSON.stringify(resolved);
  const size = utf8ByteLength(serialized);
  if (size > SCHEMA_MAX_RESOLVED_BYTES) {
    return {
      problem:
        `resolved schema exceeds the size budget ` +
        `(${size} > ${SCHEMA_MAX_RESOLVED_BYTES} UTF-8 bytes)`,
    };
  }
  return { resolved };
}
