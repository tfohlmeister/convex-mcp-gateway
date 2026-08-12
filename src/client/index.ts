import {
  createFunctionHandle,
  getFunctionName,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import type {
  GenericValidator,
  Infer,
  ObjectType,
  PropertyValidators,
} from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  buildResourceUrl,
  convexValidatorToJsonSchema,
  resourcePathFromWellKnownRequest,
  type McpCaller,
  type McpToolAnnotations,
  type McpToolDefinition,
  type McpToolKind,
  type McpToolRegistration,
  type McpToolSecurityScheme,
} from "../shared.js";
import {
  describeResourceProblem,
  describeResourceTemplateProblem,
  describeToolHeaderSchemaProblem,
  pickTemplateFields,
  handleMcpRequest as handleMcpRequestImpl,
  type HandleMcpRequestOptions,
  type McpHandlerCtx,
  type McpResource,
  type McpResourceContent,
  type McpResourceProvider,
  type McpResourceTemplate,
  type McpResourceTemplateProvider,
  type McpResourceTemplateReadHandler,
} from "./mcp-handler.js";

export type {
  JsonSchema,
  McpAuthorizerArgs,
  McpAuthorizerDecision,
  McpAuthorizerHandler,
  McpCaller,
  McpToolAnnotations,
  McpToolDefinition,
  McpToolFunctionReference,
  McpToolKind,
  McpToolRegistration,
  McpToolSecurityScheme,
} from "../shared.js";
export type {
  HandleMcpRequestOptions,
  McpAllowedOriginsOption,
  McpCorsOption,
  McpHandlerCtx,
  McpIdentityResolver,
  McpResourceAuditOption,
  McpResourceAuthorizerArgs,
  McpResourceAuthorizerHandler,
  McpResource,
  McpResourceAnnotations,
  McpResourceContent,
  McpResourceProvider,
  McpResourceTemplate,
  McpResourceTemplateProvider,
  McpResourceTemplateReadHandler,
} from "./mcp-handler.js";
export {
  buildProtectedResourceMetadataUrl,
  buildResourceUrl,
  convexValidatorToJsonSchema,
  mcpCallerValidator,
  resourcePathFromWellKnownRequest,
} from "../shared.js";

export type RunQueryCtx = {
  runQuery: <Query extends FunctionReference<"query", "internal" | "public">>(
    query: Query,
    args: FunctionArgs<Query>,
  ) => Promise<FunctionReturnType<Query>>;
};

export type RunMutationCtx = RunQueryCtx & {
  runMutation: <
    Mutation extends FunctionReference<"mutation", "internal" | "public">,
  >(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
  ) => Promise<FunctionReturnType<Mutation>>;
};

export type McpResourceReadHandler = (
  ctx: McpHandlerCtx,
  args: {
    uri: string;
    identity: { subject: string; claims?: Record<string, unknown> };
  },
) => Promise<McpResourceContent[]>;

/**
 * Catalog metadata persisted in the component registry. Intentionally
 * narrower than {@link McpResource}: the registry stores only stable
 * catalog fields (see the component schema), so the richer list-response
 * fields (`title`, `annotations`, `size`) are **runtime-only** and are not
 * accepted here. They are still served from a resource provider's `list`
 * output; they just aren't persisted.
 */
export type McpResourceDescriptor = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
};

export type McpResourceRegistration = McpResourceProvider & {
  resource: McpResourceDescriptor;
};

export type McpResourceConfig = McpResource & {
  /**
   * Free-form metadata stored alongside the registry descriptor (never sent
   * to clients). The component does not inspect it.
   */
  metadata?: Record<string, unknown>;
  /**
   * Read this concrete resource. The gateway only calls this handler when
   * `resources/read` requests `uri`, so handlers can focus on loading content
   * and applying any resource-specific checks.
   */
  read: McpResourceReadHandler;
};

type ToolFunctionReference<Kind extends McpToolKind> = FunctionReference<
  Kind,
  "internal" | "public",
  any,
  any
>;

type AnyToolFunctionReference = ToolFunctionReference<McpToolKind>;

/**
 * Args validators must produce exactly the function's expected args.
 * If they don't, TypeScript surfaces a `_typeMismatch` error on the config
 * object that makes the failing field obvious.
 */
type ValidateArgs<
  Ref extends AnyToolFunctionReference,
  ArgsV,
> = ArgsV extends PropertyValidators
  ? ObjectType<ArgsV> extends FunctionArgs<Ref>
    ? FunctionArgs<Ref> extends ObjectType<ArgsV>
      ? unknown
      : {
          _typeMismatch: "args validator does not match the function's expected arguments";
          expected: FunctionArgs<Ref>;
          received: ObjectType<ArgsV>;
        }
    : {
        _typeMismatch: "args validator does not match the function's expected arguments";
        expected: FunctionArgs<Ref>;
        received: ObjectType<ArgsV>;
      }
  : { _typeMismatch: "args must be a Convex property validators object" };

/**
 * Mirror of `ValidateArgs` for the optional `returns:` validator.
 * When the host omits `returns`, ReturnsV resolves to `undefined` and
 * validation is bypassed (no constraint). When provided, the validator's
 * inferred type must equal the function's actual return type, drift
 * between them surfaces as a `_typeMismatch` on the config object.
 */
type ValidateReturns<
  Ref extends AnyToolFunctionReference,
  ReturnsV,
> = ReturnsV extends undefined
  ? unknown
  : ReturnsV extends GenericValidator
    ? Infer<ReturnsV> extends FunctionReturnType<Ref>
      ? FunctionReturnType<Ref> extends Infer<ReturnsV>
        ? unknown
        : {
            _typeMismatch: "returns validator does not match the function's return type";
            expected: FunctionReturnType<Ref>;
            received: Infer<ReturnsV>;
          }
      : {
          _typeMismatch: "returns validator does not match the function's return type";
          expected: FunctionReturnType<Ref>;
          received: Infer<ReturnsV>;
        }
    : { _typeMismatch: "returns must be a Convex validator" };

/**
 * Keys of `ArgsV` whose validator accepts the injected caller identity
 * (`McpCaller`). `identityArg` is constrained to these, so it can only
 * point at an argument the underlying Convex function actually accepts:
 * naming an arg of the wrong type (e.g. `v.string()`) or one that does
 * not exist is a compile error, not a runtime surprise. When no arg
 * accepts a caller, this is `never`, so `identityArg` cannot be set
 * until you declare one with `mcpCallerValidator`.
 */
type McpCallerArgKeys<ArgsV extends PropertyValidators> = {
  [K in keyof ArgsV]: McpCaller extends Infer<ArgsV[K]> ? K : never;
}[keyof ArgsV] &
  string;

interface McpToolConfigBase<
  Ref extends AnyToolFunctionReference,
  ArgsV extends PropertyValidators,
  ReturnsV extends GenericValidator | undefined = undefined,
> {
  name: string;
  description: string;
  fn: Ref;
  args: ArgsV;
  /**
   * Optional Convex return-validator. When set, the tool advertises an
   * MCP `outputSchema` and every `tools/call` response includes a
   * `structuredContent` field with the typed value alongside the
   * text-JSON `content` block (per MCP 2025-06-18).
   *
   * Type-checked against `FunctionReturnType<typeof fn>` at compile
   * time, so a drift between the registered Convex function and the
   * MCP-advertised return shape can't ship undetected.
   *
   * Bytes (`v.bytes()`) are intentionally NOT supported in the first
   * cut, the JSON-Schema mapping is fine but base64-encoding the
   * runtime value in `structuredContent` adds enough nuance that we
   * defer it until there's demand.
   */
  returns?: ReturnsV;
  /**
   * Name of an `args` key the gateway fills server-side with the
   * resolved caller identity (`{ subject, claims }`) instead of taking
   * it from the client. Declare that key with `mcpCallerValidator` so
   * the compile-time `args` check still matches the function. The key
   * is excluded from the advertised `inputSchema`, stripped from
   * caller-supplied arguments (no spoofing), and injected from the
   * identity resolved at the gateway boundary right before dispatch.
   *
   * Use this for identity-scoped tools: Convex strips `ctx.auth` across
   * the component boundary, so a dispatched tool function cannot read
   * the caller from the token. `identityArg` is the supported channel.
   * Calls with no resolved identity are rejected as `Unauthorized`
   * before dispatch, so the tool never runs unscoped.
   */
  identityArg?: McpCallerArgKeys<ArgsV>;
  /** Optional display title advertised in `tools/list`. */
  title?: string;
  /** MCP behavior hints advertised in `tools/list`. */
  annotations?: McpToolAnnotations;
  /** Client-specific protocol metadata advertised in `tools/list`. */
  _meta?: Record<string, unknown>;
  /** Authentication schemes advertised in `tools/list`. */
  securitySchemes?: McpToolSecurityScheme[];
  /**
   * Free-form metadata stored alongside the tool registration. The
   * component never inspects this; it is surfaced to the host's
   * authorize callback as `args.toolMetadata` so per-tool scope/role
   * checks stay declarative. Use whatever shape your callback expects,
   * e.g. `{ scopes: ["finance:read"], roles: [...] }`.
   */
  metadata?: Record<string, unknown>;
}

/**
 * MCP tool names must match `^[a-zA-Z0-9_-]{1,64}$` (letters, digits,
 * underscore, hyphen; 1-64 chars). Some clients, notably claude.ai's
 * frontend, reject the entire tool list with a validation error
 * when any single name violates this, even for tools the caller
 * never invokes. The MCP spec itself doesn't pin this regex, but
 * it's the de-facto-enforced pattern across the major clients.
 *
 * Common gotcha: dotted names like `notes.list` or `invoices.create`
 * (mirroring Convex's `api.notes.list` reference style) fail.
 * Use `notes_list` / `invoices_create` instead.
 */
const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function build<
  Kind extends McpToolKind,
  Ref extends ToolFunctionReference<Kind>,
  ArgsV extends PropertyValidators,
  ReturnsV extends GenericValidator | undefined,
>(
  kind: Kind,
  config: McpToolConfigBase<Ref, ArgsV, ReturnsV>,
): McpToolDefinition & { fn: Ref; kind: Kind } {
  if (!MCP_TOOL_NAME_PATTERN.test(config.name)) {
    throw new Error(
      `MCP tool name "${config.name}" violates the required pattern ` +
        `${MCP_TOOL_NAME_PATTERN.source}. Allowed: letters, digits, ` +
        `underscore, hyphen; 1-64 chars. Dotted names like ` +
        `"namespace.tool" are not allowed by most MCP clients, ` +
        `use "namespace_tool" instead.`,
    );
  }
  if (
    config.identityArg !== undefined &&
    !(config.identityArg in config.args)
  ) {
    throw new Error(
      `identityArg "${config.identityArg}" is not a key of args for tool ` +
        `"${config.name}".`,
    );
  }
  // The identity-injected arg is server-filled, so it must NOT appear in
  // the schema advertised to clients (they neither see nor send it).
  let clientArgs: PropertyValidators = config.args;
  if (config.identityArg !== undefined) {
    clientArgs = { ...config.args };
    delete (clientArgs as Record<string, unknown>)[config.identityArg];
  }
  return {
    name: config.name,
    description: config.description,
    kind,
    fn: config.fn,
    functionReference: config.fn,
    inputSchema: convexValidatorToJsonSchema(clientArgs),
    ...(config.returns !== undefined
      ? { outputSchema: convexValidatorToJsonSchema(config.returns) }
      : {}),
    ...(config.identityArg !== undefined
      ? { identityArg: config.identityArg }
      : {}),
    ...(config.title !== undefined ? { title: config.title } : {}),
    ...(config.annotations !== undefined
      ? { annotations: config.annotations }
      : {}),
    ...(config._meta !== undefined ? { _meta: config._meta } : {}),
    ...(config.securitySchemes !== undefined
      ? { securitySchemes: config.securitySchemes }
      : {}),
    ...(config.metadata !== undefined ? { metadata: config.metadata } : {}),
  } as McpToolDefinition & { fn: Ref; kind: Kind };
}

/**
 * Declare a Convex `query` function as an MCP tool. The `fn` reference must
 * point to a `query`; passing a mutation or action is a compile error.
 *
 * `args` is checked against `FunctionArgs<typeof fn>` at compile time, so a
 * drift between the registered Convex function and the tool descriptor
 * cannot ship undetected.
 *
 * Authorization is *not* configured per-tool. The host passes a single
 * `authorize` callback to `gateway.handleMcpRequest({ authorize })`; it
 * sees every `tools/call` (and every `tools/list` filter) and decides
 * whether to allow it.
 */
export function defineMcpQuery<
  Ref extends ToolFunctionReference<"query">,
  ArgsV extends PropertyValidators,
  ReturnsV extends GenericValidator | undefined = undefined,
>(
  config: McpToolConfigBase<Ref, ArgsV, ReturnsV> &
    ValidateArgs<Ref, ArgsV> &
    ValidateReturns<Ref, ReturnsV>,
): McpToolDefinition & { fn: Ref; kind: "query" } {
  return build(
    "query",
    config as unknown as McpToolConfigBase<Ref, ArgsV, ReturnsV>,
  );
}

/**
 * Declare a Convex `mutation` function as an MCP tool. Mirrors
 * `defineMcpQuery`; the `fn` reference must point to a mutation
 * (passing a query or action is a compile error) and `args` is
 * checked against `FunctionArgs<typeof fn>` at compile time.
 */
export function defineMcpMutation<
  Ref extends ToolFunctionReference<"mutation">,
  ArgsV extends PropertyValidators,
  ReturnsV extends GenericValidator | undefined = undefined,
>(
  config: McpToolConfigBase<Ref, ArgsV, ReturnsV> &
    ValidateArgs<Ref, ArgsV> &
    ValidateReturns<Ref, ReturnsV>,
): McpToolDefinition & { fn: Ref; kind: "mutation" } {
  return build(
    "mutation",
    config as unknown as McpToolConfigBase<Ref, ArgsV, ReturnsV>,
  );
}

/**
 * Declare a Convex `action` function as an MCP tool. Mirrors
 * `defineMcpQuery`; the `fn` reference must point to an action
 * (passing a query or mutation is a compile error) and `args` is
 * checked against `FunctionArgs<typeof fn>` at compile time. Use
 * this for tools that perform external IO (fetch, third-party APIs)
 * or non-transactional work.
 */
export function defineMcpAction<
  Ref extends ToolFunctionReference<"action">,
  ArgsV extends PropertyValidators,
  ReturnsV extends GenericValidator | undefined = undefined,
>(
  config: McpToolConfigBase<Ref, ArgsV, ReturnsV> &
    ValidateArgs<Ref, ArgsV> &
    ValidateReturns<Ref, ReturnsV>,
): McpToolDefinition & { fn: Ref; kind: "action" } {
  return build(
    "action",
    config as unknown as McpToolConfigBase<Ref, ArgsV, ReturnsV>,
  );
}

/**
 * Declare a concrete MCP resource. The returned provider can be passed to
 * `gateway.handleMcpRequest({ resources: [...] })`.
 *
 * This is intentionally a lightweight primitive: it gives resources the same
 * first-class declaration style as `defineMcpQuery` / `defineMcpMutation` /
 * `defineMcpAction`, while registry sync, audit, authorization hooks, resource
 * templates, and subscriptions remain separate feature layers.
 */
export function defineMcpResource(
  config: McpResourceConfig,
): McpResourceRegistration {
  // Validate the descriptor shape (uri, name, and any title/description/
  // mimeType/size/annotations) with the same rules the request handler
  // enforces on provider output, so a bad declaration fails loud here.
  const problem = describeResourceProblem(config);
  if (problem) {
    throw new Error(`MCP resource is invalid: ${problem}`);
  }
  if (typeof config.read !== "function") {
    throw new Error("MCP resource read must be a function");
  }

  // Full shape served by the provider's `list` (carries the runtime-only
  // title/annotations/size).
  const publicResource: McpResource = {
    uri: config.uri,
    name: config.name,
    ...(config.title !== undefined ? { title: config.title } : {}),
    ...(config.description !== undefined
      ? { description: config.description }
      : {}),
    ...(config.mimeType !== undefined ? { mimeType: config.mimeType } : {}),
    ...(config.annotations !== undefined
      ? { annotations: config.annotations }
      : {}),
    ...(config.size !== undefined ? { size: config.size } : {}),
  };
  // Narrow descriptor persisted in the registry: only the fields the
  // component schema accepts. title/annotations/size are runtime-only and
  // must NOT leak here, or declarative sync (replaceResources) would reject
  // them as unknown fields.
  const resource: McpResourceDescriptor = {
    uri: config.uri,
    name: config.name,
    ...(config.description !== undefined
      ? { description: config.description }
      : {}),
    ...(config.mimeType !== undefined ? { mimeType: config.mimeType } : {}),
    ...(config.metadata !== undefined ? { metadata: config.metadata } : {}),
  };

  return {
    name: config.name,
    resource,
    list: async () => [publicResource],
    read: async (ctx, args) => {
      if (args.uri !== config.uri) return null;
      return await config.read(ctx, args);
    },
  };
}

export type McpResourceTemplateConfig = McpResourceTemplate & {
  /**
   * Optional server-side read handler for URIs that match `uriTemplate`.
   * When present, the gateway resolves matching `resources/read` requests by
   * calling this with the extracted `params` (concrete resources still take
   * precedence). When omitted, the template is listing-only: clients expand
   * it and read the concrete URI through another provider.
   */
  read?: McpResourceTemplateReadHandler;
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile an RFC 6570 *level-1* URI template (simple `{var}` placeholders)
 * into a matcher. Each `{var}` matches exactly one URI path segment (no
 * `/`) — the correct behavior for simple string expansion, where reserved
 * characters are percent-encoded and so never appear literally. Operators
 * (`{+var}`, `{#var}`, `{/var}`, `{?var}`, `{&var}`, `{;var}`, `{.var}`)
 * and comma-separated variable lists (`{a,b}`) are intentionally
 * unsupported in this phase: they throw at definition time so an
 * unsupported template fails loudly instead of silently never matching.
 */
function compileUriTemplate(
  uriTemplate: string,
): (uri: string) => Record<string, string> | null {
  const varNames: string[] = [];
  let pattern = "";
  let i = 0;
  while (i < uriTemplate.length) {
    const ch = uriTemplate[i];
    if (ch === "{") {
      const end = uriTemplate.indexOf("}", i);
      if (end === -1) {
        throw new Error(
          `MCP resource template "${uriTemplate}" has an unclosed "{" expression.`,
        );
      }
      const expr = uriTemplate.slice(i + 1, end);
      // The variable name becomes a regex named-capture group, which must be
      // a valid identifier (letter/underscore first, then letters/digits/
      // underscore). Allowing a leading digit here would pass this check but
      // make `new RegExp("(?<2x>...)")` throw an opaque SyntaxError below.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) {
        throw new Error(
          `MCP resource template "${uriTemplate}" uses an unsupported ` +
            `expression "{${expr}}". Only simple level-1 placeholders ` +
            `("{name}", where name is a letter/underscore followed by ` +
            `letters, digits, or underscores) are supported; operators ` +
            `(+ # . / ; ? &) and comma lists ("{a,b}") are not.`,
        );
      }
      if (varNames.includes(expr)) {
        throw new Error(
          `MCP resource template "${uriTemplate}" repeats the variable ` +
            `"{${expr}}"; each variable must be unique.`,
        );
      }
      varNames.push(expr);
      pattern += `(?<${expr}>[^/]+)`;
      i = end + 1;
    } else {
      pattern += escapeRegExp(ch);
      i += 1;
    }
  }
  if (varNames.length === 0) {
    throw new Error(
      `MCP resource template "${uriTemplate}" contains no "{var}" ` +
        `placeholder; use defineMcpResource for a concrete resource instead.`,
    );
  }
  const regex = new RegExp(`^${pattern}$`);
  return (uri: string) => {
    const match = regex.exec(uri);
    if (!match || !match.groups) return null;
    return { ...match.groups };
  };
}

/**
 * Declare an MCP resource template (RFC 6570). The returned provider can be
 * passed to `gateway.handleMcpRequest({ resourceTemplates: [...] })`: it is
 * advertised via `resources/templates/list`, and — when a `read` handler is
 * supplied — used to resolve `resources/read` requests whose URI matches
 * `uriTemplate` (concrete resources declared via `defineMcpResource` always
 * take precedence).
 *
 * Use a template when resources are parameterized (e.g.
 * `weather://{city}/current`); use `defineMcpResource` for a fixed, concrete
 * URI. Only simple level-1 `{var}` placeholders are supported; an
 * unsupported template throws here at definition time.
 */
export function defineMcpResourceTemplate(
  config: McpResourceTemplateConfig,
): McpResourceTemplateProvider {
  if (
    typeof config.uriTemplate !== "string" ||
    config.uriTemplate.length === 0
  ) {
    throw new Error(
      "MCP resource template uriTemplate must be a non-empty string",
    );
  }
  if (typeof config.name !== "string" || config.name.length === 0) {
    throw new Error("MCP resource template name must be a non-empty string");
  }
  if (config.read !== undefined && typeof config.read !== "function") {
    throw new Error(
      "MCP resource template read must be a function when provided",
    );
  }
  // Validate any title/description/mimeType/annotations with the same rules
  // the request handler enforces, so a bad declaration fails loud here.
  const problem = describeResourceTemplateProblem(config);
  if (problem) {
    throw new Error(`MCP resource template is invalid: ${problem}`);
  }
  // Compile eagerly so an invalid uriTemplate fails at declaration time.
  const match = compileUriTemplate(config.uriTemplate);
  const template = pickTemplateFields(config);
  return {
    template,
    match,
    ...(config.read !== undefined ? { read: config.read } : {}),
  };
}

function isStaticResourceProvider(
  provider: McpResourceProvider,
): provider is McpResourceRegistration {
  return (
    typeof (provider as { resource?: unknown }).resource === "object" &&
    (provider as { resource?: unknown }).resource !== null
  );
}

function declaredResourcesFromProviders(
  providers: McpResourceProvider[] | undefined,
): McpResourceDescriptor[] {
  return (providers ?? [])
    .filter(isStaticResourceProvider)
    .map((provider) => provider.resource);
}

function resourcesFingerprint(resources: McpResourceDescriptor[]): string {
  const normalized = resources
    .map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description ?? null,
      mimeType: resource.mimeType ?? null,
      metadata: resource.metadata ?? null,
    }))
    .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  return JSON.stringify(normalized);
}

async function syncDeclaredResources(
  ctx: RunMutationCtx,
  component: ComponentApi,
  resources: McpResourceDescriptor[],
): Promise<void> {
  const fingerprint = resourcesFingerprint(resources);
  const current = await ctx.runQuery(
    component.registry.getResourcesFingerprint,
    {},
  );
  if (current === fingerprint) return;
  await ctx.runMutation(component.registry.replaceResources, {
    resources,
    fingerprint,
  });
}

/**
 * Project each template provider's `.template` into the registry descriptor
 * shape (known fields only — defends against a hand-built provider whose
 * `.template` carries extra keys the registry's validator would reject).
 * Every template provider carries `.template`, so unlike resources there is
 * no "static vs runtime-only" split to filter on.
 */
function declaredResourceTemplatesFromProviders(
  providers: McpResourceTemplateProvider[] | undefined,
): McpResourceTemplate[] {
  return (providers ?? []).map((provider) =>
    pickTemplateFields(provider.template),
  );
}

function resourceTemplatesFingerprint(
  templates: McpResourceTemplate[],
): string {
  const normalized = templates
    .map((template) => ({
      uriTemplate: template.uriTemplate,
      name: template.name,
      title: template.title ?? null,
      description: template.description ?? null,
      mimeType: template.mimeType ?? null,
      annotations: template.annotations ?? null,
    }))
    .sort((a, b) =>
      a.uriTemplate < b.uriTemplate
        ? -1
        : a.uriTemplate > b.uriTemplate
          ? 1
          : 0,
    );
  return JSON.stringify(normalized);
}

async function syncDeclaredResourceTemplates(
  ctx: RunMutationCtx,
  component: ComponentApi,
  templates: McpResourceTemplate[],
): Promise<void> {
  const fingerprint = resourceTemplatesFingerprint(templates);
  const current = await ctx.runQuery(
    component.registry.getResourceTemplatesFingerprint,
    {},
  );
  if (current === fingerprint) return;
  await ctx.runMutation(component.registry.replaceResourceTemplates, {
    templates,
    fingerprint,
  });
}

/**
 * Collect the client-facing protocol fields into the single column the
 * registry stores. Returns `undefined` when the tool declares none, so
 * the row stays free of an empty object and matches how every other
 * optional field is written.
 */
function toolProtocolMetadata(
  tool: McpToolRegistration,
): Record<string, unknown> | undefined {
  const protocolMetadata = {
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.annotations !== undefined
      ? { annotations: tool.annotations }
      : {}),
    ...(tool._meta !== undefined ? { _meta: tool._meta } : {}),
    ...(tool.securitySchemes !== undefined
      ? { securitySchemes: tool.securitySchemes }
      : {}),
  };
  return Object.keys(protocolMetadata).length > 0
    ? protocolMetadata
    : undefined;
}

/** `toolProtocolMetadata` as a spreadable registry row fragment. */
function protocolMetadataField(tool: McpToolRegistration) {
  const protocolMetadata = toolProtocolMetadata(tool);
  return protocolMetadata !== undefined ? { protocolMetadata } : {};
}

/**
 * Resolve a declarative tool list into the registry's row shape,
 * creating a `functionHandle` per tool. Shared by `register` and the
 * declarative `tools` sync.
 */
/**
 * Reject a hand-written `inputSchema` whose `x-mcp-header` annotations
 * violate the Streamable HTTP constraints. Catching it here names the
 * offending tool; the alternative is every modern `tools/call` for that
 * tool failing at runtime with nothing pointing at the cause.
 *
 * Only the imperative path can produce this. `defineMcp*` derives the
 * schema from Convex validators, which never emit the annotation.
 *
 * On `registerTool` / `register` this fails the registration mutation. On
 * the declarative `tools` path it fails catalog sync, which runs on every
 * modern request and on legacy `initialize`, so one malformed schema takes
 * the whole endpoint down until the list is fixed. That is deliberate and
 * matches how a duplicate tool name already behaves: a declarative catalog
 * is all-or-nothing, and silently dropping a tool is the drift this API
 * exists to prevent.
 */
function assertToolHeaderSchemas(tools: McpToolRegistration[]): void {
  for (const tool of tools) {
    const problem = describeToolHeaderSchemaProblem(tool.inputSchema);
    if (problem) {
      throw new Error(
        `MCP tool "${tool.name}" has an invalid inputSchema: ${problem}.`,
      );
    }
  }
}

async function resolveToolHandles(tools: McpToolRegistration[]) {
  assertToolHeaderSchemas(tools);
  return await Promise.all(
    tools.map(async (tool) => ({
      name: tool.name,
      description: tool.description,
      kind: tool.kind,
      functionHandle: await createFunctionHandle(tool.fn as any),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema !== undefined
        ? { outputSchema: tool.outputSchema }
        : {}),
      ...(tool.identityArg !== undefined
        ? { identityArg: tool.identityArg }
        : {}),
      ...protocolMetadataField(tool),
      ...(tool.metadata !== undefined ? { metadata: tool.metadata } : {}),
    })),
  );
}

/**
 * Stable fingerprint of a declarative tool catalog, computed WITHOUT
 * creating function handles (which is a runtime syscall). Covers every
 * field the registry stores plus the target function's name, sorted by
 * tool name so reordering the source array doesn't churn it.
 */
function toolsFingerprint(tools: McpToolRegistration[]): string {
  const normalized = tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      kind: tool.kind,
      fn: getFunctionName(tool.fn),
      inputSchema: tool.inputSchema ?? null,
      outputSchema: tool.outputSchema ?? null,
      identityArg: tool.identityArg ?? null,
      protocolMetadata: toolProtocolMetadata(tool) ?? null,
      metadata: tool.metadata ?? null,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify(normalized);
}

/**
 * Reconcile the component registry from a declarative `tools` list, but
 * only when it actually changed. Compares the in-memory fingerprint
 * against the one stored at the last sync; on a match it does nothing
 * (one cheap query, no handle creation, no writes), so calling it on
 * every `initialize` is cheap in the steady state.
 */
async function syncDeclaredTools(
  ctx: RunMutationCtx,
  component: ComponentApi,
  tools: McpToolRegistration[],
): Promise<void> {
  // Ahead of the fingerprint short-circuit: an in-memory schema walk is
  // cheaper than the fingerprint itself, and validating only on change
  // would let a catalog that was synced under an older version keep its
  // matching fingerprint and never get checked at all.
  assertToolHeaderSchemas(tools);
  const fingerprint = toolsFingerprint(tools);
  const current = await ctx.runQuery(
    component.registry.getToolsFingerprint,
    {},
  );
  if (current === fingerprint) return;
  const resolved = await resolveToolHandles(tools);
  await ctx.runMutation(component.registry.replaceTools, {
    tools: resolved,
    fingerprint,
  });
}

/**
 * Host-app handle for the MCP gateway component.
 *
 * Authorization is **not** registered ahead of time as a Convex
 * function reference. Pass an `authorize` callback to
 * `gateway.handleMcpRequest` instead; it runs inside the host's
 * HTTP-action context where `ctx.auth.getUserIdentity()` works.
 *
 * Construct one with the generated `components.mcpGateway` and use it
 * to register typesafe tool descriptors:
 *
 * ```ts
 * import {
 *   McpGateway,
 *   defineMcpQuery,
 *   type McpAuthorizerHandler,
 * } from "convex-mcp-gateway";
 * import { components, api } from "./_generated/api.js";
 * import { internalMutation } from "./_generated/server.js";
 *
 * const gateway = new McpGateway(components.mcpGateway);
 *
 * export const bootstrap = internalMutation({
 *   args: {},
 *   handler: async (ctx) => {
 *     await gateway.register(ctx, [defineMcpQuery({ ... })]);
 *   },
 * });
 *
 * export const authorize: McpAuthorizerHandler = async (ctx, args) => {
 *   const identity = await ctx.auth.getUserIdentity();
 *   if (!identity) return { allowed: false, reason: "Unauthorized" };
 *   return { allowed: true };
 * };
 * ```
 */
/**
 * Run one catalog-sync step, logging an actionable hint before letting
 * the failure propagate. A no-op when the host didn't declare that part
 * of the catalog.
 */
async function runSyncStep(
  step: (() => Promise<void>) | undefined,
  hint: string,
): Promise<void> {
  if (!step) return;
  try {
    await step();
  } catch (err) {
    console.error(`[mcp-gateway] ${hint}`, err);
    throw err;
  }
}

export class McpGateway {
  constructor(public component: ComponentApi) {}

  /**
   * Upsert a single tool by name. Prefer `register(ctx, tools[])` for
   * the declarative "this is the full registry" pattern; reach for
   * `registerTool` only in plugin systems that register tools at
   * runtime from disjoint code paths. Replacing a tool clears its
   * `metadata` so a stale field can't survive a re-registration.
   */
  async registerTool(
    ctx: RunMutationCtx,
    tool: McpToolRegistration,
  ): Promise<void> {
    assertToolHeaderSchemas([tool]);
    const handle = await createFunctionHandle(tool.fn as any);
    await ctx.runMutation(this.component.registry.registerTool, {
      name: tool.name,
      description: tool.description,
      kind: tool.kind,
      functionHandle: handle,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema !== undefined
        ? { outputSchema: tool.outputSchema }
        : {}),
      ...(tool.identityArg !== undefined
        ? { identityArg: tool.identityArg }
        : {}),
      ...protocolMetadataField(tool),
      ...(tool.metadata !== undefined ? { metadata: tool.metadata } : {}),
    });
  }

  /**
   * Atomically replace the entire registry with the given list of
   * tools. Any tool currently in the registry whose name isn't in
   * `tools` is removed; named tools are upserted. Runs in a single
   * Convex mutation, so concurrent `tools/list` / `tools/call`
   * callers never observe a partial swap.
   *
   * Replace-always is the only semantics: an additive `register`
   * leaks stale registrations across deploys (the old tool stays
   * exposed forever unless you remember to call `unregisterTool`),
   * which is exactly the kind of silent drift this API exists to
   * prevent. If you need genuinely incremental upserts (e.g. plugin
   * systems that register tools at runtime from disjoint codepaths),
   * call `registerTool` directly per tool.
   */
  async register(
    ctx: RunMutationCtx,
    tools: McpToolRegistration[],
  ): Promise<void> {
    const resolved = await resolveToolHandles(tools);
    // No fingerprint: the imperative path clears any declarative
    // fingerprint so a later `tools`-option sync re-applies.
    await ctx.runMutation(this.component.registry.replaceTools, {
      tools: resolved,
    });
  }

  /**
   * Remove a single tool by name. Returns `true` if a row was deleted,
   * `false` if no tool with that name was registered. Prefer
   * `register(ctx, tools[])` for declarative cleanup; this method is
   * for runtime/plugin scenarios.
   */
  async unregisterTool(ctx: RunMutationCtx, name: string): Promise<boolean> {
    return await ctx.runMutation(this.component.registry.unregisterTool, {
      name,
    });
  }

  /**
   * Upsert a single resource by URI. This stores catalog metadata only;
   * resource contents are still served by the resource provider passed to
   * `handleMcpRequest({ resources })`.
   */
  async registerResource(
    ctx: RunMutationCtx,
    resource: McpResourceDescriptor,
  ): Promise<void> {
    const problem = describeResourceProblem(resource);
    if (problem) {
      throw new Error(`MCP resource is invalid: ${problem}`);
    }
    await ctx.runMutation(this.component.registry.registerResource, resource);
  }

  /**
   * Atomically replace the entire resource registry with the given catalog.
   * Any resource currently in the registry whose URI is not in `resources`
   * is removed; matching URIs are upserted. This mirrors `register` for
   * tools, but persists metadata only, not read handlers or contents.
   */
  async registerResources(
    ctx: RunMutationCtx,
    resources: McpResourceDescriptor[],
  ): Promise<void> {
    for (const resource of resources) {
      const problem = describeResourceProblem(resource);
      if (problem) {
        throw new Error(`MCP resource is invalid: ${problem}`);
      }
    }
    await ctx.runMutation(this.component.registry.replaceResources, {
      resources,
    });
  }

  /**
   * Remove a single resource by URI. Returns `true` if a row was deleted,
   * `false` if no resource with that URI was registered.
   */
  async unregisterResource(ctx: RunMutationCtx, uri: string): Promise<boolean> {
    return await ctx.runMutation(this.component.registry.unregisterResource, {
      uri,
    });
  }

  /**
   * List every tool currently in the registry, raw rows from the
   * component table. Useful for debugging or building admin UIs.
   * For the spec-compliant, authorize-filtered catalog that MCP
   * clients see, use the gateway's `tools/list` JSON-RPC method via
   * `handleMcpRequest` instead.
   */
  async listTools(ctx: RunQueryCtx) {
    return await ctx.runQuery(this.component.registry.listTools, {});
  }

  /**
   * List every resource currently in the registry, raw rows from the
   * component table. For the spec-compliant catalog that MCP clients see,
   * use `resources/list` via `handleMcpRequest`.
   */
  async listResources(ctx: RunQueryCtx) {
    return await ctx.runQuery(this.component.registry.listResources, {});
  }

  /**
   * Upsert a single resource template by `uriTemplate`. Stores catalog
   * metadata only; matching reads are still served by a template provider
   * passed to `handleMcpRequest({ resourceTemplates })`.
   */
  async registerResourceTemplate(
    ctx: RunMutationCtx,
    template: McpResourceTemplate,
  ): Promise<void> {
    const problem = describeResourceTemplateProblem(template);
    if (problem) {
      throw new Error(`MCP resource template is invalid: ${problem}`);
    }
    await ctx.runMutation(
      this.component.registry.registerResourceTemplate,
      template,
    );
  }

  /**
   * Atomically replace the entire resource-template registry with the given
   * catalog. Templates whose `uriTemplate` is not in `templates` are removed;
   * matching ones are upserted. Mirrors `registerResources`.
   */
  async registerResourceTemplates(
    ctx: RunMutationCtx,
    templates: McpResourceTemplate[],
  ): Promise<void> {
    for (const template of templates) {
      const problem = describeResourceTemplateProblem(template);
      if (problem) {
        throw new Error(`MCP resource template is invalid: ${problem}`);
      }
    }
    await ctx.runMutation(this.component.registry.replaceResourceTemplates, {
      templates,
    });
  }

  /**
   * Remove a single resource template by `uriTemplate`. Returns `true` if a
   * row was deleted, `false` if none was registered.
   */
  async unregisterResourceTemplate(
    ctx: RunMutationCtx,
    uriTemplate: string,
  ): Promise<boolean> {
    return await ctx.runMutation(
      this.component.registry.unregisterResourceTemplate,
      { uriTemplate },
    );
  }

  /**
   * List every resource template currently in the registry, raw rows from
   * the component table. For the spec-compliant catalog that MCP clients
   * see, use `resources/templates/list` via `handleMcpRequest`.
   */
  async listResourceTemplates(ctx: RunQueryCtx) {
    return await ctx.runQuery(
      this.component.registry.listResourceTemplates,
      {},
    );
  }

  /**
   * Inspect the audit log written by the component on every `tools/call`
   * and (when enabled) resource operation. Returns newest entries first.
   * Filter by `entryType` (`"tool"` | `"resource"`), `toolName`,
   * `resourceUri`, and/or `outcome`; `limit` defaults to 100 and is capped
   * server-side at 1000. (The server applies one index per call; combining
   * `resourceUri` and `toolName` is not meaningful since a row has only one.)
   */
  async listAuditEntries(
    ctx: RunQueryCtx,
    args: {
      entryType?: "tool" | "resource";
      toolName?: string;
      resourceUri?: string;
      outcome?: "allowed" | "denied" | "error";
      limit?: number;
    } = {},
  ) {
    return await ctx.runQuery(this.component.audit.listEntries, args);
  }

  /**
   * Drop MCP sessions that have not been touched within `idleMs`.
   * Returns the number of rows deleted in this call (up to a
   * bounded batch size, ~200, to stay inside Convex's per-mutation
   * limits). Hosts on busy deployments loop until the return value
   * is `0`, or schedule a follow-up mutation if a single tick is
   * insufficient. The component does not garbage-collect sessions
   * on its own.
   */
  async pruneSessions(ctx: RunMutationCtx, idleMs: number): Promise<number> {
    return await ctx.runMutation(this.component.sessions.pruneSessions, {
      olderThanMs: idleMs,
    });
  }

  /**
   * Drop audit entries older than `retentionMs`. Returns the number
   * of rows deleted in this call (up to a bounded batch size, ~200,
   * to stay inside Convex's per-mutation limits). Callers loop
   * until the return value is `0` to fully drain. Schedule from
   * `crons.ts` for time-based retention:
   *
   * ```ts
   * crons.daily("audit cleanup", { hourUTC: 3, minuteUTC: 0 },
   *   internal.audit.runPrune, {});
   *
   * export const runPrune = internalMutation({
   *   args: {},
   *   handler: async (ctx) => {
   *     let total = 0;
   *     for (;;) {
   *       const n = await gateway.pruneAuditEntries(ctx, 30 * 24 * 60 * 60 * 1000);
   *       total += n;
   *       if (n === 0) break;
   *     }
   *     return total;
   *   },
   * });
   * ```
   */
  async pruneAuditEntries(
    ctx: RunMutationCtx,
    retentionMs: number,
  ): Promise<number> {
    return await ctx.runMutation(this.component.audit.pruneOlderThan, {
      cutoffMs: Date.now() - retentionMs,
    });
  }

  /**
   * Wipe the entire tool registry. Does **not** touch `config`,
   * `audit`, or `sessions`, only the `tools` table. Intended for
   * tests and one-shot deploy resets where you want the next
   * `register(ctx, [...])` to start from an empty registry.
   */
  async clearTools(ctx: RunMutationCtx): Promise<void> {
    await ctx.runMutation(this.component.registry.clearAllTools, {});
  }

  /**
   * Wipe the entire resource registry. Does not touch tools, config,
   * audit, or sessions.
   */
  async clearResources(ctx: RunMutationCtx): Promise<void> {
    await ctx.runMutation(this.component.registry.clearAllResources, {});
  }

  /**
   * Wipe the entire resource-template registry. Does not touch resources,
   * tools, config, audit, or sessions.
   */
  async clearResourceTemplates(ctx: RunMutationCtx): Promise<void> {
    await ctx.runMutation(
      this.component.registry.clearAllResourceTemplates,
      {},
    );
  }

  /**
   * List the session IDs currently subscribed to `uri` via
   * `resources/subscribe`. A host that fronts the gateway with a
   * push-capable transport reads this to decide whom to deliver a
   * `notifications/resources/updated` to. See the `resourceSubscriptions`
   * option on `handleMcpRequest`. Returned rows may reference sessions that
   * have since been pruned; treat unknown sessions as no-ops and run
   * `pruneResourceSubscriptions` to clean them.
   */
  async listResourceSubscribers(
    ctx: RunQueryCtx,
    uri: string,
  ): Promise<string[]> {
    return await ctx.runQuery(this.component.sessions.listResourceSubscribers, {
      uri,
    });
  }

  /**
   * Delete subscription rows whose session no longer exists (sessions
   * dropped by `pruneSessions` do not cascade their subscriptions). Drains
   * fully by paging through the table in bounded windows (each window is its
   * own component transaction) and returns the total number deleted. Wire it
   * alongside `pruneSessions` in a cron when you use resource subscriptions.
   */
  async pruneResourceSubscriptions(ctx: RunMutationCtx): Promise<number> {
    let total = 0;
    let cursorCreationTime: number | undefined;
    for (;;) {
      const { deleted, cursor } = await ctx.runMutation(
        this.component.sessions.pruneOrphanResourceSubscriptions,
        cursorCreationTime !== undefined ? { cursorCreationTime } : {},
      );
      total += deleted;
      if (cursor === null) break;
      cursorCreationTime = cursor;
    }
    return total;
  }

  /**
   * Build a `notifications/resources/list_changed` JSON-RPC notification for
   * the host to deliver over its own transport when the resource catalog
   * changes. The gateway does not deliver it (its HTTP transport cannot
   * push); see the `resourceSubscriptions` option on `handleMcpRequest`.
   */
  buildResourceListChangedNotification(): {
    jsonrpc: "2.0";
    method: "notifications/resources/list_changed";
  } {
    return { jsonrpc: "2.0", method: "notifications/resources/list_changed" };
  }

  /**
   * Build a `notifications/resources/updated` notification for `uri`, for the
   * host to deliver to that resource's subscribers (see
   * `listResourceSubscribers`). The payload carries only the URI; clients
   * re-read via `resources/read`, which re-applies authorization.
   */
  buildResourceUpdatedNotification(uri: string): {
    jsonrpc: "2.0";
    method: "notifications/resources/updated";
    params: { uri: string };
  } {
    return {
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri },
    };
  }

  /**
   * Configure OAuth 2.1 protected-resource discovery so MCP clients can
   * find the authorization server that issues their Bearer tokens.
   *
   * Once set, `tools/call` responses with `-32001 Unauthorized` switch
   * to HTTP 401 with a `WWW-Authenticate: Bearer resource_metadata=...`
   * header. The host must additionally mount the discovery handler at
   * the canonical RFC 9728 path on its own `httpRouter`; see
   * `serveProtectedResourceMetadata`.
   *
   * `resourceUrl` is optional; when omitted the discovery handler
   * derives the resource from the inbound request URL, which is correct
   * for single-tenant deployments. Pass `authServerUrl: null` to disable
   * discovery again. Both URLs are validated as absolute http/https URLs
   * at write time; an invalid value throws `ConvexError` immediately.
   */
  async setOAuthConfig(
    ctx: RunMutationCtx,
    config: { authServerUrl: string | null; resourceUrl?: string | null },
  ): Promise<void> {
    await ctx.runMutation(this.component.registry.setOAuthConfig, {
      authServerUrl: config.authServerUrl,
      ...(config.resourceUrl !== undefined
        ? { resourceUrl: config.resourceUrl }
        : {}),
    });
  }

  /**
   * Handle an MCP HTTP request (POST/GET/DELETE on `/mcp/`). Hosts mount
   * this on their own `httpRouter`; the component's HTTP routes have no
   * `ctx.auth` per Convex's component-isolation model, so the protocol
   * surface lives here on the client side instead.
   *
   * The host supplies an `authorize` callback that runs in the host's
   * action context (so `ctx.auth.getUserIdentity()` works). The
   * callback decides per `tools/call` and per tool in `tools/list`.
   *
   * Pass `tools` to declare the catalog inline (recommended): the
   * gateway reconciles the registry on `initialize`, so you change the
   * list in code and it just applies on the next connect, no separate
   * registration mutation to run. The reconcile is change-detected: it
   * fingerprints the list and only rewrites the registry when something
   * actually changed, so the steady-state cost per connection is a
   * single cheap lookup. The imperative `gateway.register(...)` mutation
   * stays available for dynamic/plugin catalogs.
   *
   * ```ts
   * import { httpRouter } from "convex/server";
   * import { httpAction } from "./_generated/server.js";
   * import { gateway, tools } from "./mcp.js";
   * import { authorize } from "./authorize.js";
   *
   * const http = httpRouter();
   * const mcp = httpAction(async (ctx, req) =>
   *   gateway.handleMcpRequest(ctx, req, { authorize, tools }),
   * );
   * http.route({ path: "/mcp/", method: "POST",   handler: mcp });
   * http.route({ path: "/mcp/", method: "GET",    handler: mcp });
   * http.route({ path: "/mcp/", method: "DELETE", handler: mcp });
   * export default http;
   * ```
   */
  async handleMcpRequest(
    ctx: RunMutationCtx & {
      runAction: (ref: any, args: any) => Promise<any>;
      auth: { getUserIdentity: () => Promise<any> };
    },
    request: Request,
    options: HandleMcpRequestOptions,
  ): Promise<Response> {
    const { tools, resources, resourceTemplates, ...rest } = options;
    const syncTools = tools
      ? async () => {
          await syncDeclaredTools(ctx, this.component, tools);
        }
      : undefined;
    const declaredResources = declaredResourcesFromProviders(resources);
    const syncResources =
      resources !== undefined
        ? async () => {
            await syncDeclaredResources(ctx, this.component, declaredResources);
          }
        : undefined;
    const declaredTemplates =
      declaredResourceTemplatesFromProviders(resourceTemplates);
    const syncResourceTemplates =
      resourceTemplates !== undefined
        ? async () => {
            await syncDeclaredResourceTemplates(
              ctx,
              this.component,
              declaredTemplates,
            );
          }
        : undefined;
    // Each step logs its own hint before rethrowing. The handler only
    // sees "catalog sync failed", so without this the deployment log
    // says nothing about which list is malformed or why.
    const ensureCatalogSynced = async () => {
      await runSyncStep(
        syncTools,
        "declarative tool sync failed; the request will fail. Check the " +
          "`tools` list passed to handleMcpRequest (e.g. duplicate tool names).",
      );
      await runSyncStep(
        syncResources,
        "declarative resource sync failed; the request will fail. Check the " +
          "static resources passed to handleMcpRequest (e.g. duplicate " +
          "resource URIs).",
      );
      await runSyncStep(
        syncResourceTemplates,
        "declarative resource-template sync failed; the request will fail. " +
          "Check the resourceTemplates passed to handleMcpRequest (e.g. " +
          "duplicate uriTemplates).",
      );
    };
    return await handleMcpRequestImpl(ctx, request, this.component, {
      ...rest,
      resources,
      resourceTemplates,
      ensureCatalogSynced,
    });
  }

  /**
   * Serve the RFC 9728 protected-resource metadata document. Hosts mount
   * this on their own `httpRouter` at the canonical well-known path:
   *
   * ```ts
   * import { httpRouter } from "convex/server";
   * import { httpAction } from "./_generated/server.js";
   * import { gateway } from "./mcp.js";  // or wherever you build it
   *
   * const http = httpRouter();
   * http.route({
   *   pathPrefix: "/.well-known/oauth-protected-resource",
   *   method: "GET",
   *   handler: httpAction(async (ctx, request) =>
   *     gateway.serveProtectedResourceMetadata(ctx, request),
   *   ),
   * });
   * export default http;
   * ```
   *
   * The host mounts this route alongside the `/mcp/` route from
   * `handleMcpRequest`; RFC 9728 §3.1 mandates the metadata at
   * `<origin>/.well-known/oauth-protected-resource<path>`. The
   * component itself does not own any HTTP routes (Convex does not
   * propagate `ctx.auth` into component code, so all routes live in
   * the host).
   *
   * Returns `404` when no OAuth config has been set via `setOAuthConfig`.
   */
  async serveProtectedResourceMetadata(
    ctx: RunQueryCtx,
    request: Request,
  ): Promise<Response> {
    // Discovery is read-only public metadata (RFC 9728 §3) and is
    // fetched cross-origin by every browser MCP client. Always
    // permissive CORS, no secrets here.
    const corsHeaders = {
      "access-control-allow-origin": "*",
      vary: "Origin",
    } as const;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers":
            request.headers.get("access-control-request-headers") ?? "*",
          "access-control-max-age": "86400",
        },
      });
    }
    const oauthConfig = await ctx.runQuery(
      this.component.registry.getOAuthConfig,
      {},
    );
    if (!oauthConfig) {
      return new Response("OAuth discovery not configured", {
        status: 404,
        headers: corsHeaders,
      });
    }
    const url = new URL(request.url);
    const resourcePath = resourcePathFromWellKnownRequest(url.pathname);
    const resource = buildResourceUrl(
      url.origin,
      resourcePath,
      oauthConfig.resourceUrl,
    );
    return new Response(
      JSON.stringify({
        resource,
        authorization_servers: [oauthConfig.authServerUrl],
        bearer_methods_supported: ["header"],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=3600",
          ...corsHeaders,
        },
      },
    );
  }

  // ---------------------------------------------------------------
  // OPTIONAL: OIDC-bridge mode
  //
  // The two methods below are opt-in helpers for hosts whose upstream
  // IdP doesn't support Dynamic Client Registration (RFC 7591), e.g.
  // Pocket-ID 2.x, but who still want browser-based MCP clients
  // (which DO require DCR) to connect.
  //
  // Pattern: the host advertises ITSELF as the authorization server in
  // the protected-resource metadata, mounts these two helpers as
  // `/.well-known/oauth-authorization-server` and `/oauth/register`,
  // pre-registers ONE client with the upstream IdP, and configures
  // these helpers with that client's id. DCR requests from MCP clients
  // are answered with the same fixed client id; everything else (the
  // actual `authorize`, `token`, `userinfo` endpoints) flows directly
  // to the upstream.
  //
  // Hosts that don't need this can ignore both methods. The "dumb"
  // pass-through mode (the host owns auth entirely via its `authorize`
  // callback, with or without `setOAuthConfig` for plain RFC 9728
  // discovery) keeps working unchanged.
  // ---------------------------------------------------------------

  /**
   * Serve RFC 8414 OAuth Authorization Server Metadata, wrapping an
   * upstream IdP. Fetches the upstream's openid-configuration once
   * per process (in-memory cached), copies the relevant fields, and
   * substitutes our own `registration_endpoint` so MCP clients DCR
   * against `handleClientRegistration` instead of the upstream.
   *
   * Mount on the host:
   *
   * ```ts
   * http.route({
   *   path: "/.well-known/oauth-authorization-server",
   *   method: "GET",
   *   handler: httpAction(async (ctx, request) =>
   *     gateway.serveAuthorizationServerMetadata(ctx, request, {
   *       upstreamIssuer: "https://id.example.com",
   *     }),
   *   ),
   * });
   * ```
   */
  async serveAuthorizationServerMetadata(
    _ctx: unknown,
    request: Request,
    options: {
      upstreamIssuer: string;
      /** Path to your `handleClientRegistration` route. Default: `/oauth/register` */
      registrationPath?: string;
      /**
       * Advertise Client ID Metadata Documents (CIMD) when the upstream
       * authorization server declares support. This is intentionally opt-in:
       * the bridge does not fetch or validate a client's metadata document,
       * so it can only expose CIMD when the upstream authorization endpoint
       * performs that validation itself. DCR remains advertised as a
       * backwards-compatible fallback.
       */
      clientIdMetadataDocuments?: boolean;
      /**
       * Fields to override in the bridged metadata. Useful for:
       *
       * - Removing `openid` from `scopes_supported` (when the client
       *   would otherwise request an `id_token` and reject it because
       *   the upstream's `iss` claim won't match the bridge's
       *   advertised `issuer`).
       * - Restricting `response_types_supported` to `["code"]` to
       *   force pure-OAuth code flow (no `id_token` hybrid).
       * - Setting `issuer` to the upstream issuer instead of the
       *   bridge origin, if the client refuses to accept the
       *   mismatch (technically violates RFC 8414 §2 but works with
       *   stricter clients).
       *
       * Any key set here replaces the bridged value verbatim. Keys
       * not set fall through to the upstream's value (or our default).
       */
      overrides?: Record<string, unknown>;
    },
  ): Promise<Response> {
    const corsHeaders = {
      "access-control-allow-origin": "*",
      vary: "Origin",
    } as const;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers":
            request.headers.get("access-control-request-headers") ?? "*",
          "access-control-max-age": "86400",
        },
      });
    }
    const url = new URL(request.url);
    const registrationPath = options.registrationPath ?? "/oauth/register";
    let upstream: Record<string, unknown>;
    try {
      upstream = await fetchOidcConfigCached(options.upstreamIssuer);
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "upstream_metadata_unreachable",
          error_description: err instanceof Error ? err.message : String(err),
        }),
        {
          status: 502,
          headers: { "content-type": "application/json", ...corsHeaders },
        },
      );
    }
    const body: Record<string, unknown> = {
      issuer: url.origin,
      authorization_endpoint: upstream.authorization_endpoint,
      token_endpoint: upstream.token_endpoint,
      userinfo_endpoint: upstream.userinfo_endpoint,
      jwks_uri: upstream.jwks_uri,
      scopes_supported: upstream.scopes_supported,
      response_types_supported: upstream.response_types_supported,
      grant_types_supported: upstream.grant_types_supported,
      code_challenge_methods_supported:
        upstream.code_challenge_methods_supported,
      // Public-client (PKCE) only at the bridge, secrets stay
      // upstream and never round-trip through here.
      token_endpoint_auth_methods_supported: ["none"],
      registration_endpoint: `${url.origin}${registrationPath}`,
      ...(options.clientIdMetadataDocuments &&
      upstream.client_id_metadata_document_supported === true
        ? { client_id_metadata_document_supported: true }
        : {}),
      ...(options.overrides ?? {}),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600",
        ...corsHeaders,
      },
    });
  }

  /**
   * Serve RFC 7591 Dynamic Client Registration, returning a fixed
   * pre-registered upstream client id for every request. This is the
   * "fake DCR" that lets browser MCP clients (which insist on DCR)
   * connect to upstream IdPs that don't support DCR.
   *
   * **`allowedRedirectPatterns` is required** to prevent open-redirect
   * attacks: without it any caller could "register" a client with an
   * attacker-controlled `redirect_uri` and steal auth codes.
   *
   * Mount on the host:
   *
   * ```ts
   * http.route({
   *   path: "/oauth/register",
   *   method: "POST",
   *   handler: httpAction(async (ctx, request) =>
   *     gateway.handleClientRegistration(ctx, request, {
   *       upstreamClientId: "<your pre-registered id>",
   *       allowedRedirectPatterns: [
   *         /^https:\/\/claude\.ai\//,
   *         /^https:\/\/claude\.com\//,
   *         /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//,
   *       ],
   *     }),
   *   ),
   * });
   * ```
   */
  async handleClientRegistration(
    _ctx: unknown,
    request: Request,
    options: {
      upstreamClientId: string;
      allowedRedirectPatterns: RegExp[];
    },
  ): Promise<Response> {
    const corsHeaders = {
      "access-control-allow-origin": "*",
      vary: "Origin",
    } as const;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers":
            request.headers.get("access-control-request-headers") ??
            "content-type",
          "access-control-max-age": "86400",
        },
      });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST, OPTIONS", ...corsHeaders },
      });
    }
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonError(
        400,
        "invalid_client_metadata",
        "Invalid JSON body",
        corsHeaders,
      );
    }
    const redirectUris = Array.isArray(body.redirect_uris)
      ? (body.redirect_uris as unknown[])
      : [];
    if (redirectUris.length === 0) {
      return jsonError(
        400,
        "invalid_redirect_uri",
        "redirect_uris is required and must be a non-empty array",
        corsHeaders,
      );
    }
    const invalid = redirectUris.filter((u) => {
      if (typeof u !== "string") return true;
      return !options.allowedRedirectPatterns.some((p) => p.test(u));
    });
    if (invalid.length > 0) {
      // Truncate each echoed URI to bound response size against an
      // attacker probing the (public, unauthenticated) DCR endpoint
      // with megabyte-scale payloads.
      const sample = invalid.slice(0, 5).map((u) => {
        const s = typeof u === "string" ? u : JSON.stringify(u);
        return s.length > 200 ? `${s.slice(0, 200)}...` : s;
      });
      const description =
        invalid.length === 1
          ? `redirect_uri not allowed: ${sample[0]}`
          : `${invalid.length} redirect_uris not allowed (first ${sample.length}: ${sample.join(", ")})`;
      return jsonError(400, "invalid_redirect_uri", description, corsHeaders);
    }
    return new Response(
      JSON.stringify({
        client_id: options.upstreamClientId,
        client_name: body.client_name ?? "MCP Client",
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      {
        status: 201,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          ...corsHeaders,
        },
      },
    );
  }
}

// In-memory cache for upstream OIDC discovery docs. One Convex
// httpAction process serves many requests; refetching openid-config
// per call would add 100ms+ per AS-metadata request for no benefit
// (the doc is effectively static, TTL is 1 hour to recover from
// upstream config changes without a redeploy).
const oidcCache = new Map<
  string,
  { fetchedAt: number; doc: Record<string, unknown> }
>();
const OIDC_CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchOidcConfigCached(
  issuer: string,
): Promise<Record<string, unknown>> {
  // Defense-in-depth against hosts that wire `upstreamIssuer` from
  // request input: reject anything that isn't an absolute http(s) URL,
  // and reject plain http unless it points at localhost (dev).
  // Without this, an attacker controlling the issuer string can turn
  // the gateway into an SSRF primitive against internal services
  // reachable from Convex's egress (e.g. cloud-metadata endpoints).
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new Error(`upstreamIssuer is not a valid URL: ${issuer}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `upstreamIssuer must use http or https, got: ${parsed.protocol}`,
    );
  }
  if (
    parsed.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)
  ) {
    throw new Error(
      `upstreamIssuer must use https for non-localhost hosts, got: ${issuer}`,
    );
  }

  const normalizedIssuer = normalizeIssuer(parsed);
  const cached = oidcCache.get(normalizedIssuer);
  if (cached && Date.now() - cached.fetchedAt < OIDC_CACHE_TTL_MS) {
    return cached.doc;
  }
  const url = `${normalizedIssuer}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Upstream OIDC discovery returned ${res.status} from ${url}`,
    );
  }
  const doc = (await res.json()) as Record<string, unknown>;
  if (typeof doc.issuer !== "string") {
    throw new Error(`Upstream OIDC discovery is missing issuer at ${url}`);
  }
  let metadataIssuer: string;
  try {
    metadataIssuer = normalizeIssuer(new URL(doc.issuer));
  } catch {
    throw new Error(`Upstream OIDC discovery has an invalid issuer at ${url}`);
  }
  if (metadataIssuer !== normalizedIssuer) {
    throw new Error(
      `Upstream OIDC discovery issuer mismatch: expected ${normalizedIssuer}, got ${metadataIssuer}`,
    );
  }
  // Soft cap on cache size: a host that ever calls this with many
  // distinct issuers (multi-tenant bridge) shouldn't be able to grow
  // the Map unboundedly. 32 entries comfortably covers every
  // realistic deployment.
  if (oidcCache.size >= 32 && !oidcCache.has(normalizedIssuer)) {
    const firstKey = oidcCache.keys().next().value;
    if (firstKey !== undefined) oidcCache.delete(firstKey);
  }
  oidcCache.set(normalizedIssuer, { fetchedAt: Date.now(), doc });
  return doc;
}

function normalizeIssuer(url: URL): string {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`issuer must use http or https, got: ${url.protocol}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("issuer must not contain credentials, query, or fragment");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function jsonError(
  status: number,
  error: string,
  description: string,
  extraHeaders: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status,
      headers: { "content-type": "application/json", ...extraHeaders },
    },
  );
}

export default McpGateway;
