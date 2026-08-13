import { describe, expect, onTestFinished, test, vi } from "vitest";
import { v } from "convex/values";
import type { FunctionReference } from "convex/server";
import {
  defineMcpAction,
  defineMcpMutation,
  defineMcpQuery,
  defineMcpResource,
  defineMcpResourceTemplate,
  mcpCallerValidator,
  McpGateway,
  type McpCaller,
} from "./index.js";
import { describeToolHeaderSchemaProblem } from "./mcp-handler.js";

// defineMcpQuery's TS signature requires a real Convex function
// reference; runtime validation runs first regardless of TS, so we
// cast through unknown to exercise the runtime check on bad input.
function call(name: string) {
  return (defineMcpQuery as unknown as (c: unknown) => unknown)({
    name,
    description: "test",
    fn: {},
    args: {},
  });
}

function callWithReturns(returns: unknown) {
  return (defineMcpQuery as unknown as (c: unknown) => unknown)({
    name: "demo_tool",
    description: "test",
    fn: {},
    args: {},
    returns,
  });
}

describe("defineMcp* name validation", () => {
  test("accepts a compliant name", () => {
    expect(() => call("invoices_list")).not.toThrow();
  });

  test("rejects a dotted name with a helpful message", () => {
    expect(() => call("invoices.list")).toThrow(
      /violates the required pattern.*use "namespace_tool"/s,
    );
  });

  test("rejects names with whitespace, slashes, or other punctuation", () => {
    for (const bad of [
      "with space",
      "with/slash",
      "with:colon",
      "with(paren)",
      "ümlaut",
      "",
    ]) {
      expect(() => call(bad), `name "${bad}" should be rejected`).toThrow(
        /violates the required pattern/,
      );
    }
  });

  test("rejects names longer than 64 chars", () => {
    expect(() => call("a".repeat(65))).toThrow(/violates the required pattern/);
  });

  test("accepts hyphens, digits, underscores up to 64 chars", () => {
    expect(() => call("a-b_c-1234")).not.toThrow();
    expect(() => call("a".repeat(64))).not.toThrow();
  });
});

describe("defineMcp* protocol metadata", () => {
  test("retains protocol metadata for registration", () => {
    const tool = (defineMcpQuery as unknown as (c: unknown) => unknown)({
      name: "get_context",
      description: "Read entity context",
      fn: {},
      args: {},
      title: "Get entity context",
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: "ui://lonir/entity-context.html" } },
      securitySchemes: [{ type: "oauth2", scopes: ["openid"] }],
    });

    expect(tool).toMatchObject({
      title: "Get entity context",
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: "ui://lonir/entity-context.html" } },
      securitySchemes: [{ type: "oauth2", scopes: ["openid"] }],
    });
  });
});

describe("defineMcp* identityArg (inputSchema + compile-time safety)", () => {
  type QueryRef<Args extends Record<string, unknown>> = FunctionReference<
    "query",
    "public",
    Args,
    unknown
  >;

  test("excludes the injected caller arg from inputSchema", () => {
    const okRef = {} as QueryRef<{ caller: McpCaller; status?: string }>;
    const tool = defineMcpQuery({
      name: "ok_tool",
      description: "x",
      fn: okRef,
      args: { caller: mcpCallerValidator, status: v.optional(v.string()) },
      identityArg: "caller",
    });
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties ?? {}).not.toHaveProperty("caller");
    expect(schema.properties ?? {}).toHaveProperty("status");
    expect((tool as { identityArg?: string }).identityArg).toBe("caller");
  });

  test("identityArg must name an arg that accepts a caller (type error otherwise)", () => {
    const badRef = {} as QueryRef<{ status: string }>;
    defineMcpQuery({
      name: "bad_tool",
      description: "x",
      fn: badRef,
      args: { status: v.string() },
      // @ts-expect-error - "status" is a plain string arg, not an McpCaller sink
      identityArg: "status",
    });
    expect(true).toBe(true);
  });

  test("identityArg naming a key absent from args throws at runtime", () => {
    // TS would catch this, but runtime validation must also reject it for
    // JS callers / casts that bypass the compiler.
    expect(() =>
      (defineMcpQuery as unknown as (c: unknown) => unknown)({
        name: "missing_arg_tool",
        description: "x",
        fn: {},
        args: { status: v.optional(v.string()) },
        identityArg: "caller",
      }),
    ).toThrow(/identityArg "caller" is not a key of args/);
  });
});

describe("defineMcp* mrtrArgs", () => {
  type QueryRef<Args extends Record<string, unknown>> = FunctionReference<
    "query",
    "public",
    Args,
    unknown
  >;

  test("excludes the injected idempotency-key arg from inputSchema", () => {
    const ref = {} as QueryRef<{
      id: string;
      continuationKey?: string;
    }>;
    const tool = defineMcpQuery({
      name: "confirm_tool",
      description: "x",
      fn: ref,
      args: {
        id: v.string(),
        continuationKey: v.optional(v.string()),
      },
      mrtrArgs: { idempotencyKey: "continuationKey" },
      beforeCall: async () => null,
    });
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties ?? {}).toEqual({ id: { type: "string" } });
    expect(tool.mrtrArgs).toEqual({ idempotencyKey: "continuationKey" });
  });

  test("a hook without mrtrArgs is valid (confirmation-only tools)", () => {
    const ref = {} as QueryRef<{ id: string }>;
    expect(() =>
      defineMcpQuery({
        name: "confirm_only_tool",
        description: "x",
        fn: ref,
        args: { id: v.string() },
        beforeCall: async () => null,
      }),
    ).not.toThrow();
  });

  test("rejects missing, colliding, or hook-less injected args", () => {
    expect(() =>
      (defineMcpQuery as unknown as (c: unknown) => unknown)({
        name: "bad_mrtr_tool",
        description: "x",
        fn: {},
        args: { id: v.string() },
        mrtrArgs: { idempotencyKey: "missing" },
        beforeCall: async () => null,
      }),
    ).toThrow(/Gateway-injected arg "missing" is not a key/);

    // identityArg and mrtrArgs naming the same key would make the gateway
    // inject two different values into one argument. Must be rejected at
    // definition time, not discovered as a broken continuation at runtime.
    expect(() =>
      (defineMcpQuery as unknown as (c: unknown) => unknown)({
        name: "identity_collision_tool",
        description: "x",
        fn: {},
        args: { caller: v.optional(v.any()) },
        identityArg: "caller",
        mrtrArgs: { idempotencyKey: "caller" },
        beforeCall: async () => null,
      }),
    ).toThrow(/Gateway-injected args must be distinct/);

    // The key is only injected on hook-approved continuations, so it is
    // meaningless without the hook.
    expect(() =>
      (defineMcpQuery as unknown as (c: unknown) => unknown)({
        name: "keyed_without_hook",
        description: "x",
        fn: {},
        args: { continuationKey: v.optional(v.string()) },
        mrtrArgs: { idempotencyKey: "continuationKey" },
      }),
    ).toThrow(/mrtrArgs requires beforeCall/);

    // The key is absent on first-call and legacy dispatches, so its
    // validator must be optional or those calls fail the Convex arg
    // validator at runtime. Caught at define time instead.
    expect(() =>
      (defineMcpQuery as unknown as (c: unknown) => unknown)({
        name: "non_optional_key",
        description: "x",
        fn: {},
        args: { continuationKey: v.string() },
        mrtrArgs: { idempotencyKey: "continuationKey" },
        beforeCall: async () => null,
      }),
    ).toThrow(/must be an optional validator/);

    // A replayed continuation dispatches again, so a mutation or action
    // that gates on a hook must be able to recognize the repeat. The
    // chain's idempotency key is that mechanism, so it is mandatory.
    for (const define of [defineMcpMutation, defineMcpAction]) {
      expect(() =>
        (define as unknown as (c: unknown) => unknown)({
          name: "hooked_without_key",
          description: "x",
          fn: {},
          args: { id: v.string() },
          beforeCall: async () => null,
        }),
      ).toThrow(/beforeCall requires mrtrArgs/);
    }

    // A query has no durable side effect, so replaying it is harmless
    // and the key stays optional.
    expect(() =>
      (defineMcpQuery as unknown as (c: unknown) => unknown)({
        name: "hooked_query_without_key",
        description: "x",
        fn: {},
        args: { id: v.string() },
        beforeCall: async () => null,
      }),
    ).not.toThrow();
  });

  test("requires declarative tools for beforeCall", async () => {
    const tool = defineMcpQuery({
      name: "confirm_tool",
      description: "test",
      fn: {} as QueryRef<{ continuationKey?: string }>,
      args: { continuationKey: v.optional(v.string()) },
      mrtrArgs: { idempotencyKey: "continuationKey" },
      beforeCall: async () => null,
    });
    const gateway = new McpGateway({} as never);

    await expect(gateway.register({} as never, [tool])).rejects.toThrow(
      "imperative registration cannot run host-side hooks",
    );
  });
});

describe("defineMcp* outputSchema (from returns: validator)", () => {
  test("omitted returns → no outputSchema on the result", () => {
    const tool = (defineMcpQuery as unknown as (c: unknown) => any)({
      name: "demo_tool",
      description: "x",
      fn: {},
      args: {},
    });
    expect(tool.outputSchema).toBeUndefined();
  });

  test("v.object({...}) → JSON Schema object with properties", () => {
    const tool = callWithReturns(
      v.object({ total: v.float64(), label: v.string() }),
    ) as any;
    expect(tool.outputSchema).toEqual({
      type: "object",
      properties: {
        total: { type: "number" },
        label: { type: "string" },
      },
      required: ["total", "label"],
      additionalProperties: false,
    });
  });

  test("v.id('notes') → string + format + table annotation", () => {
    const tool = callWithReturns(v.id("notes")) as any;
    expect(tool.outputSchema).toEqual({
      type: "string",
      format: "convex-id",
      "x-convex-table": "notes",
    });
  });

  test("v.null() → { type: 'null' }", () => {
    const tool = callWithReturns(v.null()) as any;
    expect(tool.outputSchema).toEqual({ type: "null" });
  });

  test("v.union(...) → anyOf", () => {
    const tool = callWithReturns(
      v.union(v.literal("ok"), v.literal("err")),
    ) as any;
    expect(tool.outputSchema).toEqual({
      anyOf: [{ const: "ok" }, { const: "err" }],
    });
  });

  test("v.array(v.string()) → array schema with item type", () => {
    const tool = callWithReturns(v.array(v.string())) as any;
    expect(tool.outputSchema).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  test("v.any() → permissive empty schema", () => {
    const tool = callWithReturns(v.any()) as any;
    expect(tool.outputSchema).toEqual({});
  });
});

describe("defineMcpResource", () => {
  test("creates a concrete resource provider", async () => {
    const resource = defineMcpResource({
      uri: "docs://getting-started",
      name: "Getting Started",
      description: "Intro docs",
      mimeType: "text/markdown",
      metadata: { internal: true },
      read: async (_ctx, args) => [
        {
          uri: args.uri,
          mimeType: "text/markdown",
          text: "# Getting Started",
        },
      ],
    });

    const identity = { subject: "user-1" };
    await expect(resource.list({} as any, { identity })).resolves.toEqual([
      {
        uri: "docs://getting-started",
        name: "Getting Started",
        description: "Intro docs",
        mimeType: "text/markdown",
      },
    ]);
    expect(resource.resource.metadata).toEqual({ internal: true });
    await expect(
      resource.read({} as any, {
        uri: "docs://getting-started",
        identity,
      }),
    ).resolves.toEqual([
      {
        uri: "docs://getting-started",
        mimeType: "text/markdown",
        text: "# Getting Started",
      },
    ]);
    await expect(
      resource.read({} as any, {
        uri: "docs://missing",
        identity,
      }),
    ).resolves.toBeNull();
  });

  test("rejects invalid resource declarations", () => {
    expect(() =>
      (defineMcpResource as unknown as (config: unknown) => unknown)({
        uri: "",
        name: "Missing URI",
        read: async () => [],
      }),
    ).toThrow(/uri must be a non-empty string/);

    expect(() =>
      (defineMcpResource as unknown as (config: unknown) => unknown)({
        uri: "docs://missing-name",
        name: "",
        read: async () => [],
      }),
    ).toThrow(/name must be a non-empty string/);

    expect(() =>
      (defineMcpResource as unknown as (config: unknown) => unknown)({
        uri: "docs://missing-read",
        name: "Missing Read",
      }),
    ).toThrow(/read must be a function/);
  });

  test("carries extended metadata (title, annotations, size)", async () => {
    const resource = defineMcpResource({
      uri: "docs://x",
      name: "X",
      title: "Doc X",
      annotations: {
        audience: ["user"],
        priority: 0.5,
        lastModified: "2026-01-01T00:00:00Z",
      },
      size: 1024,
      read: async (_ctx, args) => [{ uri: args.uri, text: "x" }],
    });

    await expect(
      resource.list({} as any, { identity: { subject: "u" } }),
    ).resolves.toEqual([
      {
        uri: "docs://x",
        name: "X",
        title: "Doc X",
        annotations: {
          audience: ["user"],
          priority: 0.5,
          lastModified: "2026-01-01T00:00:00Z",
        },
        size: 1024,
      },
    ]);
  });

  test("rejects invalid extended metadata", () => {
    const call = defineMcpResource as unknown as (config: unknown) => unknown;
    const base = { uri: "docs://x", name: "X", read: async () => [] };
    expect(() => call({ ...base, size: -1 })).toThrow(
      /size must be a non-negative number/,
    );
    expect(() => call({ ...base, title: 5 })).toThrow(/title must be a string/);
    expect(() => call({ ...base, annotations: { priority: 2 } })).toThrow(
      /priority must be a number between 0 and 1/,
    );
    expect(() =>
      call({ ...base, annotations: { audience: ["nope"] } }),
    ).toThrow(/audience/);
  });
});

describe("defineMcpResourceTemplate", () => {
  test("creates a template provider that matches and extracts params", () => {
    const template = defineMcpResourceTemplate({
      uriTemplate: "db://{table}/{id}",
      name: "Row",
      description: "A database row",
      mimeType: "application/json",
      read: async () => null,
    });

    expect(template.template).toEqual({
      uriTemplate: "db://{table}/{id}",
      name: "Row",
      description: "A database row",
      mimeType: "application/json",
    });
    expect(template.match("db://users/42")).toEqual({
      table: "users",
      id: "42",
    });
    // A variable matches a single path segment, so an extra segment fails.
    expect(template.match("db://users/42/extra")).toBeNull();
    expect(template.match("other://users/42")).toBeNull();
  });

  test("matcher handles edge cases: empty segments, regex-special literals, adjacency", () => {
    const multi = defineMcpResourceTemplate({
      uriTemplate: "db://{table}/{id}",
      name: "Row",
    });
    // `[^/]+` requires at least one char per segment, so a trailing empty
    // segment does not match.
    expect(multi.match("db://users/")).toBeNull();
    expect(multi.match("db:///42")).toBeNull();

    // Regex-special characters in the literal portion are escaped, so they
    // match literally rather than as metacharacters.
    const special = defineMcpResourceTemplate({
      uriTemplate: "v1.0+api://{id}",
      name: "Versioned",
    });
    expect(special.match("v1.0+api://42")).toEqual({ id: "42" });
    // The `.` must be literal: `v1X0+api://42` must NOT match.
    expect(special.match("v1X0+api://42")).toBeNull();

    // Adjacent placeholders with no delimiter are greedy/ambiguous; pin the
    // documented-as-undefined-but-deterministic behavior: the first capture
    // takes all but the last char of the segment.
    const adjacent = defineMcpResourceTemplate({
      uriTemplate: "x://{a}{b}",
      name: "Adjacent",
    });
    expect(adjacent.match("x://hello")).toEqual({ a: "hell", b: "o" });
  });

  test("supports listing-only templates (no read handler)", () => {
    const template = defineMcpResourceTemplate({
      uriTemplate: "file://{path}",
      name: "File",
    });
    expect(template.read).toBeUndefined();
    expect(template.match("file://readme")).toEqual({ path: "readme" });
  });

  test("rejects invalid template declarations", () => {
    const call = defineMcpResourceTemplate as unknown as (
      config: unknown,
    ) => unknown;

    expect(() => call({ uriTemplate: "", name: "Empty" })).toThrow(
      /uriTemplate must be a non-empty string/,
    );
    expect(() => call({ uriTemplate: "db://{table}", name: "" })).toThrow(
      /name must be a non-empty string/,
    );
    // No placeholder → should be a concrete resource instead.
    expect(() => call({ uriTemplate: "db://static", name: "Static" })).toThrow(
      /contains no .* placeholder/,
    );
    // Unsupported RFC 6570 operator.
    expect(() => call({ uriTemplate: "file://{+path}", name: "Op" })).toThrow(
      /unsupported/i,
    );
    // A variable name starting with a digit is not a valid regex
    // named-capture identifier; it must fail loud with the friendly
    // "unsupported" error, not an opaque RegExp SyntaxError.
    expect(() => call({ uriTemplate: "x://{2day}", name: "Digit" })).toThrow(
      /unsupported/i,
    );
    // Unclosed expression.
    expect(() =>
      call({ uriTemplate: "db://{table", name: "Unclosed" }),
    ).toThrow(/unclosed/i);
    // Duplicate variable.
    expect(() => call({ uriTemplate: "db://{id}/{id}", name: "Dup" })).toThrow(
      /repeats the variable/,
    );
    // read present but not a function.
    expect(() =>
      call({ uriTemplate: "db://{id}", name: "BadRead", read: "nope" }),
    ).toThrow(/read must be a function/);
  });

  test("carries extended template metadata and rejects invalid annotations", () => {
    const tmpl = defineMcpResourceTemplate({
      uriTemplate: "db://{id}",
      name: "Row",
      title: "Row template",
      annotations: { priority: 1, audience: ["assistant"] },
    });
    expect(tmpl.template).toEqual({
      uriTemplate: "db://{id}",
      name: "Row",
      title: "Row template",
      annotations: { priority: 1, audience: ["assistant"] },
    });

    const call = defineMcpResourceTemplate as unknown as (
      config: unknown,
    ) => unknown;
    expect(() =>
      call({
        uriTemplate: "db://{id}",
        name: "X",
        annotations: { priority: -1 },
      }),
    ).toThrow(/priority must be a number between 0 and 1/);
  });
});

describe("x-mcp-header validation at registration time", () => {
  const header = { type: "string", "x-mcp-header": "Region" };

  test("accepts an annotation reachable through a properties chain", () => {
    expect(
      describeToolHeaderSchemaProblem({
        type: "object",
        properties: { filter: { type: "object", properties: { region: header } } },
      }),
    ).toBeNull();
  });

  test.each([
    ["items", { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { region: header } } } } }],
    ["anyOf", { type: "object", anyOf: [{ type: "object", properties: { region: header } }] }],
    ["allOf", { type: "object", allOf: [{ type: "object", properties: { region: header } }] }],
    ["$defs", { type: "object", $defs: { F: { type: "object", properties: { region: header } } } }],
    ["if/then", { type: "object", then: { type: "object", properties: { region: header } } }],
  ])("rejects an annotation reachable only through %s", (_label, schema) => {
    expect(describeToolHeaderSchemaProblem(schema)).toMatch(
      /must be reachable through schema properties/,
    );
  });

  test("rejects a number-typed and a duplicated annotation", () => {
    expect(
      describeToolHeaderSchemaProblem({
        type: "object",
        properties: { region: { type: "number", "x-mcp-header": "Region" } },
      }),
    ).toMatch(/string, integer, or boolean/);
    expect(
      describeToolHeaderSchemaProblem({
        type: "object",
        properties: {
          a: header,
          b: { type: "string", "x-mcp-header": "region" },
        },
      }),
    ).toMatch(/case-insensitively unique/);
  });

  test("registerTool rejects an invalid schema before touching Convex", async () => {
    const gateway = new McpGateway({} as never);
    await expect(
      gateway.registerTool({} as never, {
        name: "search",
        description: "Search",
        kind: "query",
        fn: {} as never,
        functionReference: {} as never,
        inputSchema: { type: "object", items: { properties: { region: header } } },
      }),
    ).rejects.toThrow(
      /MCP tool "search" has an invalid inputSchema: x-mcp-header must be reachable/,
    );
  });

  test("a hand-built gated mutation without mrtrArgs is refused at the catalog boundary", async () => {
    // defineMcp* enforces this, but a host can hand handleMcpRequest a
    // registration it built itself. Without the chain's idempotency key
    // every replay of an accepted continuation dispatches the mutation
    // again with nothing to deduplicate on, so the gateway has to
    // refuse the catalog rather than trust the constructor. The check
    // runs before any component call, hence the inert ctx.
    const errors: string[] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
    // Restore even when an assertion below throws, or every later test
    // in this file loses its diagnostics.
    onTestFinished(() => errorSpy.mockRestore());
    const gateway = new McpGateway({} as never);
    const request = new Request("https://gateway.example/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const response = await gateway.handleMcpRequest(
      {
        auth: { getUserIdentity: async () => null },
        runQuery: async () => {
          throw new Error("catalog guard must run before any component call");
        },
        runMutation: async () => {
          throw new Error("catalog guard must run before any component call");
        },
      } as never,
      request,
      {
        authorize: async () => ({ allowed: true as const }),
        tools: [
          {
            name: "archive",
            description: "Archives",
            kind: "mutation",
            fn: { __fn: "invoices:archive" },
            inputSchema: { type: "object" },
            beforeCall: async () => null,
          },
        ] as never,
      },
    );
    // The reason stays server-side (it names host internals), so the
    // wire only carries -32603. Assert on what the operator sees, which
    // is what actually distinguishes this from any other sync failure.
    const body = (await response.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32603);
    expect(
      errors.some((line) => /beforeCall but no mrtrArgs/.test(line)),
    ).toBe(true);
  });

  // The catalog-level "no ungated alias" rule keys on resolved function
  // handles, and `createFunctionHandle` only runs inside a Convex
  // backend, so its coverage lives in `src/component/registry.test.ts`
  // (registry enforcement) rather than here.

  test("register rejects an invalid schema before touching Convex", async () => {
    const gateway = new McpGateway({} as never);
    await expect(
      gateway.register({} as never, [
        {
          name: "ok",
          description: "Fine",
          kind: "query",
          fn: {} as never,
          functionReference: {} as never,
          inputSchema: { type: "object", properties: { region: header } },
        },
        {
          name: "broken",
          description: "Broken",
          kind: "query",
          fn: {} as never,
          functionReference: {} as never,
          inputSchema: {
            type: "object",
            anyOf: [{ properties: { region: header } }],
          },
        },
      ]),
    ).rejects.toThrow(/MCP tool "broken" has an invalid inputSchema/);
  });
});

describe("taskSupport and argument redaction are mutually exclusive", () => {
  function taskTool(auditArgs: unknown) {
    return {
      name: "reports_generate",
      description: "Generates a report",
      kind: "action" as const,
      fn: {} as never,
      functionReference: {} as never,
      inputSchema: { type: "object" },
      taskSupport: true,
      metadata: { auditArgs },
    };
  }

  // A task row stores the caller's arguments verbatim for the whole
  // retention window (execution needs them), so a tool that asked for
  // argument redaction cannot also be a task: the audit row would honour
  // the request while the task row beside it did not.
  test.each([
    ["auditArgs: false", false],
    ["auditArgs: { redact }", { redact: ["token"] }],
  ])("registerTool rejects taskSupport with %s", async (_label, auditArgs) => {
    const gateway = new McpGateway({} as never);
    await expect(
      gateway.registerTool({} as never, taskTool(auditArgs) as never),
    ).rejects.toThrow(
      /cannot combine taskSupport with metadata.auditArgs/,
    );
  });

  test("register rejects the combination too", async () => {
    const gateway = new McpGateway({} as never);
    await expect(
      gateway.register({} as never, [taskTool(false) as never]),
    ).rejects.toThrow(/cannot combine taskSupport with metadata.auditArgs/);
  });

  test("taskSupport with default (or explicit true) auditing passes the guard", async () => {
    const gateway = new McpGateway({} as never);
    // Reaches past the guard and fails later, on the mocked Convex call.
    await expect(
      gateway.registerTool({} as never, taskTool(true) as never),
    ).rejects.not.toThrow(/cannot combine taskSupport/);
  });
});
