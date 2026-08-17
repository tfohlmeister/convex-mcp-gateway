import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import type { FunctionReference } from "convex/server";
import componentSchema from "../component/schema.js";
import { modules as componentModules } from "../component/setup.test.js";
import { api as componentApi } from "../component/_generated/api.js";
import {
  convexValidatorToJsonSchema,
  prepareSchemaForStorage,
  resolveJsonSchemaBounded,
  SCHEMA_MAX_REF_EXPANSIONS,
  SCHEMA_MAX_RESOLVED_BYTES,
} from "../shared.js";
import { describeToolHeaderSchemaProblem } from "./mcp-handler.js";
import { McpGateway, type McpToolRegistration } from "./index.js";

/**
 * Bounded JSON Schema 2020-12 `$ref` resolution: the resolver contract
 * (verbatim short-circuit, strict local refs, budgets, cycles), its
 * interplay with the `x-mcp-header` reachability walk, and the
 * registration wiring that stores/advertises the RESOLVED schema.
 */

describe("resolveJsonSchemaBounded", () => {
  test("returns a schema without $refs verbatim (same reference)", () => {
    const schema = {
      type: "object",
      properties: { region: { type: "string" } },
      // Even an unused $defs passes through untouched: schemas that
      // register today keep advertising byte-identically.
      $defs: { Unused: { type: "number" } },
    };
    const result = resolveJsonSchemaBounded(schema);
    expect(result.problem).toBeUndefined();
    expect(result.resolved).toBe(schema);
  });

  test("inlines local $defs references and drops the dead $defs", () => {
    const result = resolveJsonSchemaBounded({
      type: "object",
      properties: {
        region: { $ref: "#/$defs/Region" },
        backup: { $ref: "#/$defs/Region" },
      },
      $defs: { Region: { type: "string", enum: ["eu", "us"] } },
    });
    expect(result.problem).toBeUndefined();
    expect(result.resolved).toEqual({
      type: "object",
      properties: {
        region: { type: "string", enum: ["eu", "us"] },
        backup: { type: "string", enum: ["eu", "us"] },
      },
    });
  });

  test("resolves reference chains and refs inside $defs entries", () => {
    const result = resolveJsonSchemaBounded({
      type: "object",
      properties: { doc: { $ref: "#/$defs/Doc" } },
      $defs: {
        Doc: {
          type: "object",
          properties: { region: { $ref: "#/$defs/Region" } },
        },
        Region: { type: "string" },
      },
    });
    expect(result.resolved).toEqual({
      type: "object",
      properties: {
        doc: {
          type: "object",
          properties: { region: { type: "string" } },
        },
      },
    });
  });

  test("unescapes JSON Pointer tokens in $defs keys", () => {
    const result = resolveJsonSchemaBounded({
      type: "object",
      properties: { odd: { $ref: "#/$defs/a~1b~0c" } },
      $defs: { "a/b~c": { type: "boolean" } },
    });
    expect(result.resolved).toEqual({
      type: "object",
      properties: { odd: { type: "boolean" } },
    });
  });

  test("names cycles instead of burning the depth budget", () => {
    const result = resolveJsonSchemaBounded({
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" } },
        },
      },
    });
    expect(result.problem).toMatch(/cyclic \$ref through "#\/\$defs\/Node"/);
    expect(result.problem).toMatch(/chain: Node -> Node/);
  });

  test("rejects remote refs, pointer paths, anchors, and $ref siblings by name", () => {
    const cases: Array<[unknown, RegExp]> = [
      [
        { $ref: "https://example.com/schema.json" },
        /only local "#\/\$defs\/<name>" references/,
      ],
      [{ $ref: "#/properties/x" }, /only local "#\/\$defs\/<name>"/],
      [{ $ref: "#/$defs/A/properties/x" }, /only local/],
      [{ $ref: "#Anchor" }, /only local/],
      [
        {
          properties: { x: { $ref: "#/$defs/A", description: "extra" } },
          $defs: { A: { type: "string" } },
        },
        /adjacent keywords beside \$ref/,
      ],
      [{ $ref: "#/$defs/Missing", $defs: {} }, /adjacent keywords/],
    ];
    for (const [schema, pattern] of cases) {
      expect(resolveJsonSchemaBounded(schema).problem).toMatch(pattern);
    }
    expect(
      resolveJsonSchemaBounded({
        properties: { x: { $ref: "#/$defs/Missing" } },
        $defs: {},
      }).problem,
    ).toMatch(/unknown \$defs entry "Missing"/);
  });

  test("enforces the expansion-count budget", () => {
    const properties: Record<string, unknown> = {};
    for (let index = 0; index <= SCHEMA_MAX_REF_EXPANSIONS; index += 1) {
      properties[`p${index}`] = { $ref: "#/$defs/A" };
    }
    const result = resolveJsonSchemaBounded({
      type: "object",
      properties,
      $defs: { A: { type: "string" } },
    });
    expect(result.problem).toMatch(/\$ref expansion budget/);
  });

  test("enforces the resolved-size budget", () => {
    const result = resolveJsonSchemaBounded({
      type: "object",
      properties: {
        a: { $ref: "#/$defs/Big" },
        b: { $ref: "#/$defs/Big" },
      },
      $defs: {
        Big: { type: "string", description: "x".repeat(SCHEMA_MAX_RESOLVED_BYTES / 2) },
      },
    });
    expect(result.problem).toMatch(/size budget/);
  });

  test("no schema-position ref: returned verbatim, containers intact", () => {
    // Nothing to resolve, so the schema (including any definition
    // container and any ref-SHAPED data) passes through untouched. Note
    // Convex itself rejects `$`-prefixed FIELD NAMES, so a schema
    // declaring a property named `$ref` is unstorable upstream of this
    // resolver regardless of what happens here; the resolver simply
    // does not make that worse.
    const fieldNamedRef = {
      type: "object",
      properties: { $ref: { type: "string" } },
    };
    expect(resolveJsonSchemaBounded(fieldNamedRef).resolved).toBe(
      fieldNamedRef,
    );

    // Ref-shaped values inside data keywords, with no schema-position
    // ref anywhere: verbatim, `$defs` kept, so nothing dangles.
    const refShapedData = {
      type: "object",
      properties: {
        pointer: {
          type: "object",
          enum: ["#/$defs/Region"],
          examples: [{ note: "plain data" }],
        },
      },
      $defs: { Region: { type: "string" } },
    };
    expect(resolveJsonSchemaBounded(refShapedData).resolved).toBe(
      refShapedData,
    );
  });

  test("a ref-shaped object in a data position is rejected once resolution runs", () => {
    // With a real reference present, the definition containers are
    // dropped, so a ref-shaped OBJECT parked in a data keyword can no
    // longer be resolved against anything. Rather than ship it dangling,
    // resolution fails by path. (Such a schema is unstorable in Convex
    // anyway: `$ref` as a field name is rejected at the boundary.)
    const mixed = resolveJsonSchemaBounded({
      type: "object",
      properties: {
        region: { $ref: "#/$defs/Region" },
        pointer: { type: "object", const: { $ref: "#/$defs/Region" } },
      },
      $defs: { Region: { type: "string" } },
    });
    expect(mixed.resolved).toBeUndefined();
    expect(mixed.problem).toMatch(/unresolved \$ref remains at/);
    expect(mixed.problem).toMatch(/properties\.pointer\.const/);
  });

  test("a ref under an unhandled keyword is rejected, never left dangling", () => {
    // draft-07 `dependencies` is not a 2020-12 schema position (it was
    // split into dependentSchemas / dependentRequired), so the walker
    // treats it as data. The position-independent guard catches it.
    const result = resolveJsonSchemaBounded({
      type: "object",
      properties: { a: { $ref: "#/$defs/T" } },
      dependencies: { a: { $ref: "#/$defs/T" } },
      $defs: { T: { type: "string" } },
    });
    expect(result.resolved).toBeUndefined();
    expect(result.problem).toMatch(/unresolved \$ref remains at dependencies\.a/);

    // Same for a vendor keyword.
    const vendor = resolveJsonSchemaBounded({
      properties: { a: { $ref: "#/$defs/T" } },
      "x-vendor": { nested: { $ref: "#/$defs/T" } },
      $defs: { T: { type: "string" } },
    });
    expect(vendor.problem).toMatch(/unresolved \$ref remains at x-vendor\.nested/);
  });

  test("resolution is reachability-driven: unused definitions cannot fail a schema", () => {
    // Every case here has a perfectly resolvable output; only the
    // UNUSED definitions are problematic, and generators (zod-to-json-
    // schema, TypeBox, pydantic) emit exactly these bundles.
    const recursiveUnused = resolveJsonSchemaBounded({
      properties: { a: { $ref: "#/$defs/Used" } },
      $defs: {
        Used: { type: "string" },
        Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } },
      },
    });
    expect(recursiveUnused.problem).toBeUndefined();
    expect(recursiveUnused.resolved).toEqual({
      properties: { a: { type: "string" } },
    });

    const remoteUnused = resolveJsonSchemaBounded({
      properties: { a: { $ref: "#/$defs/Used" } },
      $defs: {
        Used: { type: "string" },
        Remote: { $ref: "https://example.com/x.json" },
      },
    });
    expect(remoteUnused.problem).toBeUndefined();

    // Many unused definitions do not consume the expansion budget.
    const manyUnused: Record<string, unknown> = { Used: { type: "string" } };
    for (let i = 0; i < SCHEMA_MAX_REF_EXPANSIONS + 6; i += 1) {
      manyUnused[`Spare${i}`] = { type: "number" };
    }
    const budget = resolveJsonSchemaBounded({
      properties: { a: { $ref: "#/$defs/Used" } },
      $defs: manyUnused,
    });
    expect(budget.problem).toBeUndefined();
    expect(budget.resolved).toEqual({ properties: { a: { type: "string" } } });

    // A cycle in a REFERENCED definition is still rejected.
    const usedCycle = resolveJsonSchemaBounded({
      properties: { a: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } },
      },
    });
    expect(usedCycle.problem).toMatch(/cyclic \$ref/);
  });

  test("the size budget counts UTF-8 bytes, not UTF-16 code units", () => {
    // A CJK description is 3 bytes per character: ~24k characters
    // referenced twice exceeds 64 KiB of UTF-8 while staying well under
    // 64k code units, which the old length-based check would have let
    // through.
    const result = resolveJsonSchemaBounded({
      properties: {
        a: { $ref: "#/$defs/Big" },
        b: { $ref: "#/$defs/Big" },
      },
      $defs: { Big: { type: "string", description: "字".repeat(12_000) } },
    });
    expect(result.problem).toMatch(/UTF-8 bytes/);
  });

  test("the walk does not pollute prototypes on a __proto__ key", () => {
    // `setOwn` keeps a `__proto__` key as an own property instead of
    // hitting the inherited setter, so the walk cannot be steered into
    // prototype pollution. NOTE: this is a property of the walk only:
    // Convex's own serialization drops a `__proto__` field at the
    // storage boundary, so end to end such a field does not survive
    // registration. Do not read this as an end-to-end guarantee.
    const result = resolveJsonSchemaBounded({
      type: "object",
      properties: JSON.parse(
        '{"__proto__": {"$ref": "#/$defs/A"}, "plain": {"type": "number"}}',
      ) as Record<string, unknown>,
      $defs: { A: { type: "string" } },
    });
    expect(result.problem).toBeUndefined();
    const properties = (result.resolved as { properties: object }).properties;
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(
      Object.getOwnPropertyDescriptor(properties, "__proto__")?.value,
    ).toEqual({ type: "string" });
  });

  test("resolves refs under contentSchema and array-form items (no dangling refs)", () => {
    // contentSchema is a 2020-12 schema-valued keyword (Content
    // vocabulary); a ref under it must resolve rather than survive the
    // unconditional $defs drop as a dangling reference.
    const content = resolveJsonSchemaBounded({
      type: "object",
      properties: {
        name: { $ref: "#/$defs/Name" },
        payload: {
          type: "string",
          contentMediaType: "application/json",
          contentSchema: { $ref: "#/$defs/Blob" },
        },
      },
      $defs: {
        Name: { type: "string" },
        Blob: { type: "object" },
      },
    });
    expect(content.problem).toBeUndefined();
    expect(JSON.stringify(content.resolved)).not.toContain("$ref");
    expect(
      (content.resolved as { properties: { payload: { contentSchema: unknown } } })
        .properties.payload.contentSchema,
    ).toEqual({ type: "object" });

    // Draft-07 array-form items: elements are schemas by author intent.
    const arrayItems = resolveJsonSchemaBounded({
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: [{ $ref: "#/$defs/Cell" }, { type: "number" }],
        },
        real: { $ref: "#/$defs/Cell" },
      },
      $defs: { Cell: { type: "string" } },
    });
    expect(arrayItems.problem).toBeUndefined();
    expect(JSON.stringify(arrayItems.resolved)).not.toContain("$ref");
  });

  test("passes composition shapes through untouched when they carry no refs", () => {
    // The gateway's own validatorToSchema emits anyOf for v.union;
    // resolution must be a no-op for it.
    const schema = convexValidatorToJsonSchema({
      status: v.union(v.literal("open"), v.literal("paid")),
    });
    const result = resolveJsonSchemaBounded(schema);
    expect(result.resolved).toBe(schema);
  });
});

describe("x-mcp-header reachability over resolved schemas", () => {
  test("an annotation behind a $ref on a properties chain becomes reachable", () => {
    const authored = {
      type: "object",
      properties: { region: { $ref: "#/$defs/Region" } },
      $defs: {
        Region: { type: "string", "x-mcp-header": "region" },
      },
    };
    // Unresolved, the walk cannot vouch for the annotation...
    const resolved = resolveJsonSchemaBounded(authored);
    expect(resolved.problem).toBeUndefined();
    // ...but on the resolved schema it sits on a plain properties chain.
    expect(describeToolHeaderSchemaProblem(resolved.resolved)).toBeNull();
  });

  test("composition still rejects annotations after resolution", () => {
    const authored = {
      type: "object",
      properties: {
        status: { anyOf: [{ $ref: "#/$defs/Tagged" }, { type: "null" }] },
      },
      $defs: { Tagged: { type: "string", "x-mcp-header": "status" } },
    };
    const resolved = resolveJsonSchemaBounded(authored);
    expect(resolved.problem).toBeUndefined();
    // Branching means the value is not guaranteed present at the path,
    // so the binding guarantee ends exactly where it did before.
    expect(describeToolHeaderSchemaProblem(resolved.resolved)).toMatch(
      /x-mcp-header/,
    );
  });
});

describe("registration stores the resolved schema", () => {
  type QueryRef = FunctionReference<"query", "public", { region?: string }, unknown>;

  function refTool(): McpToolRegistration {
    return {
      name: "regional_lookup",
      description: "x",
      kind: "query",
      fn: {} as QueryRef,
      functionReference: {},
      inputSchema: {
        type: "object",
        properties: { region: { $ref: "#/$defs/Region" } },
        $defs: { Region: { type: "string", "x-mcp-header": "region" } },
      },
      outputSchema: {
        type: "object",
        properties: { result: { $ref: "#/$defs/Result" } },
        $defs: { Result: { type: "number" } },
      },
    } as unknown as McpToolRegistration;
  }

  test("an unresolvable schema fails registration with the tool named", async () => {
    const gateway = new McpGateway({
      registry: { registerTool: Symbol("registerTool") },
    } as never);
    const cyclic = {
      ...refTool(),
      inputSchema: {
        properties: { a: { $ref: "#/$defs/A" } },
        $defs: { A: { $ref: "#/$defs/A" } },
      },
    } as McpToolRegistration;
    await expect(
      gateway.registerTool({ runMutation: async () => null } as never, cyclic),
    ).rejects.toThrow(/"regional_lookup" has an unresolvable inputSchema.*cyclic/);
  });
});

/**
 * Storage preparation. Convex reserves field names beginning with `$`,
 * so a spec-conformant dialect declaration used to take the whole mount
 * down on the write. The resolved copy loses those keywords; the
 * authored copy kept beside it carries them to the client.
 */
describe("prepareSchemaForStorage", () => {
  test("drops $-prefixed keywords at every depth", () => {
    const result = prepareSchemaForStorage({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://example.test/tool",
      type: "object",
      properties: {
        region: { $comment: "internal", type: "string" },
        nested: { type: "object", properties: { a: { $anchor: "x" } } },
      },
    });
    expect(result.problem).toBeUndefined();
    expect(result.storable).toEqual({
      type: "object",
      properties: {
        region: { type: "string" },
        nested: { type: "object", properties: { a: {} } },
      },
    });
  });

  test("keeps every field name Convex actually accepts", () => {
    // Probed against convex-test: leading `_`, spaces, dots, dashes and
    // the empty string all store. Only `$` and non-ASCII do not.
    const schema = {
      type: "object",
      properties: {
        _id: { type: "string" },
        "a b": { type: "string" },
        "a.b": { type: "string" },
        "": { type: "string" },
        "1a": { type: "string", "x-mcp-header": "One" },
      },
    };
    expect(prepareSchemaForStorage(schema).storable).toEqual(schema);
  });

  test("walks arrays without losing entries", () => {
    expect(
      prepareSchemaForStorage({
        type: "object",
        allOf: [{ $comment: "x", type: "object" }, { required: ["a"] }],
      }).storable,
    ).toEqual({ type: "object", allOf: [{ type: "object" }, { required: ["a"] }] });
  });

  test("names an unstorable field name and its path", () => {
    // A property name, not a keyword: dropping it would change what the
    // schema means, so it is a problem rather than a silent strip.
    const result = prepareSchemaForStorage({
      type: "object",
      properties: { "ünï": { type: "string" } },
    });
    expect(result.storable).toBeUndefined();
    expect(result.problem).toMatch(/"ünï" at properties/);
  });

  test("bounds depth instead of overflowing the stack", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 200; i++) {
      const next: Record<string, unknown> = {};
      deep.properties = next;
      deep = next;
    }
    expect(prepareSchemaForStorage(root).problem).toMatch(/depth budget/);
  });
});

describe("registration stores a schema Convex can hold", () => {
  test("a $schema dialect declaration no longer breaks the write", async () => {
    // Issue #48: the authored schema reached `ctx.runMutation` verbatim,
    // and Convex rejected `$schema` as a field name from inside the
    // write, so every request to the mount 500'd, `initialize` included.
    const authored = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { name: { type: "string" } },
    };
    const row = {
      name: "example",
      description: "Example",
      kind: "query" as const,
      functionHandle: "function://example",
      authoredInputSchemaJson: JSON.stringify(authored),
    };
    const t = convexTest(componentSchema, componentModules);

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(componentApi.registry.registerTool, {
          ...row,
          inputSchema: authored,
        }),
      ),
    ).rejects.toThrow(/\$schema starts with a '\$'/);

    // What registration writes today: the prepared copy, plus the
    // authored one as a string, where `$schema` is just characters.
    const prepared = prepareSchemaForStorage(authored);
    await t.run(async (ctx) => {
      await ctx.runMutation(componentApi.registry.registerTool, {
        ...row,
        inputSchema: prepared.storable,
      });
      const stored = await ctx.runQuery(componentApi.registry.getTool, {
        name: "example",
      });
      expect(stored?.inputSchema).toEqual({
        type: "object",
        properties: { name: { type: "string" } },
      });
      expect(JSON.parse(stored!.authoredInputSchemaJson!)).toEqual(authored);
    });
  });

  test("an unstorable field name fails registration with the tool named", async () => {
    const gateway = new McpGateway({
      registry: { registerTool: Symbol("registerTool") },
    } as never);
    await expect(
      gateway.registerTool({ runMutation: async () => null } as never, {
        name: "regional_lookup",
        description: "x",
        kind: "query",
        fn: {},
        functionReference: {},
        inputSchema: { type: "object", properties: { "ünï": { type: "string" } } },
      } as unknown as McpToolRegistration),
    ).rejects.toThrow(/"regional_lookup" has an unstorable inputSchema.*"ünï"/);
  });
});
