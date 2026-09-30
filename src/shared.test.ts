import { describe, expect, test } from "vitest";
import { ConvexError, v } from "convex/values";
import {
  buildProtectedResourceMetadataUrl,
  buildResourceUrl,
  convexValidatorToJsonSchema,
  deliberateErrorMessage,
  propertyValidatorsToObjectSchema,
  resourcePathFromWellKnownRequest,
} from "./shared.js";

describe("convexValidatorToJsonSchema", () => {
  test("primitive validators map to their JSON schema counterparts", () => {
    expect(convexValidatorToJsonSchema(v.string())).toEqual({ type: "string" });
    expect(convexValidatorToJsonSchema(v.number())).toEqual({ type: "number" });
    expect(convexValidatorToJsonSchema(v.boolean())).toEqual({
      type: "boolean",
    });
    expect(convexValidatorToJsonSchema(v.null())).toEqual({ type: "null" });
    expect(convexValidatorToJsonSchema(v.any())).toEqual({});
  });

  test("int64 surfaces as JSON integer with int64 format", () => {
    expect(convexValidatorToJsonSchema(v.int64())).toEqual({
      type: "integer",
      format: "int64",
    });
  });

  test("bytes maps to base64-encoded string", () => {
    expect(convexValidatorToJsonSchema(v.bytes())).toEqual({
      type: "string",
      contentEncoding: "base64",
    });
  });

  test("literal becomes a const schema", () => {
    expect(convexValidatorToJsonSchema(v.literal("open"))).toEqual({
      const: "open",
    });
  });

  test("union becomes anyOf", () => {
    expect(
      convexValidatorToJsonSchema(v.union(v.literal("open"), v.literal("paid"))),
    ).toEqual({
      anyOf: [{ const: "open" }, { const: "paid" }],
    });
  });

  test("array becomes typed array schema", () => {
    expect(convexValidatorToJsonSchema(v.array(v.string()))).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  test("id carries the table name as a JSON-Schema extension", () => {
    expect(convexValidatorToJsonSchema(v.id("invoices"))).toEqual({
      type: "string",
      format: "convex-id",
      "x-convex-table": "invoices",
    });
  });

  test("PropertyValidators record becomes an object schema with required[]", () => {
    const schema = propertyValidatorsToObjectSchema({
      status: v.optional(v.union(v.literal("open"), v.literal("paid"))),
      limit: v.number(),
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        status: { anyOf: [{ const: "open" }, { const: "paid" }] },
        limit: { type: "number" },
      },
      required: ["limit"],
      additionalProperties: false,
    });
  });

  test("PropertyValidators with only optional fields omits required[]", () => {
    const schema = propertyValidatorsToObjectSchema({
      status: v.optional(v.string()),
    });

    expect(schema).toEqual({
      type: "object",
      properties: { status: { type: "string" } },
      additionalProperties: false,
    });
  });

  test("record becomes an object with additionalProperties schema", () => {
    expect(
      convexValidatorToJsonSchema(v.record(v.string(), v.number())),
    ).toEqual({
      type: "object",
      additionalProperties: { type: "number" },
    });
  });

  test("buildProtectedResourceMetadataUrl emits the RFC 9728 path-prefix variant", () => {
    expect(
      buildProtectedResourceMetadataUrl("https://app.example.com", "/mcp"),
    ).toBe("https://app.example.com/.well-known/oauth-protected-resource/mcp");
    // Trailing slashes on the resource path are stripped per RFC 9728 §3.1.
    expect(
      buildProtectedResourceMetadataUrl("https://app.example.com", "/mcp/"),
    ).toBe("https://app.example.com/.well-known/oauth-protected-resource/mcp");
    expect(
      buildProtectedResourceMetadataUrl("https://app.example.com", "/mcp//"),
    ).toBe("https://app.example.com/.well-known/oauth-protected-resource/mcp");
    // Resource at host root: path is empty, well-known sits directly on origin.
    expect(
      buildProtectedResourceMetadataUrl("https://app.example.com", "/"),
    ).toBe("https://app.example.com/.well-known/oauth-protected-resource");
  });

  test("buildResourceUrl honors override and otherwise auto-derives", () => {
    expect(
      buildResourceUrl("https://app.example.com", "/mcp", undefined),
    ).toBe("https://app.example.com/mcp/");
    expect(
      buildResourceUrl("https://app.example.com", "/mcp/", null),
    ).toBe("https://app.example.com/mcp/");
    expect(
      buildResourceUrl(
        "https://app.example.com",
        "/mcp",
        "https://override.example/custom/",
      ),
    ).toBe("https://override.example/custom/");
  });

  test("resourcePathFromWellKnownRequest strips the well-known prefix", () => {
    expect(
      resourcePathFromWellKnownRequest(
        "/.well-known/oauth-protected-resource/mcp",
      ),
    ).toBe("/mcp");
    expect(
      resourcePathFromWellKnownRequest(
        "/.well-known/oauth-protected-resource",
      ),
    ).toBe("/");
    expect(
      resourcePathFromWellKnownRequest(
        "/.well-known/oauth-protected-resource/tenants/acme/mcp",
      ),
    ).toBe("/tenants/acme/mcp");
    // Non-well-known paths pass through (caller decides how to handle).
    expect(resourcePathFromWellKnownRequest("/random/path")).toBe(
      "/random/path",
    );
  });

  test("nested object validator recurses through fields", () => {
    expect(
      convexValidatorToJsonSchema(
        v.object({
          inner: v.object({
            x: v.number(),
            y: v.optional(v.string()),
          }),
        }),
      ),
    ).toEqual({
      type: "object",
      properties: {
        inner: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "string" },
          },
          required: ["x"],
          additionalProperties: false,
        },
      },
      required: ["inner"],
      additionalProperties: false,
    });
  });
});

describe("deliberateErrorMessage", () => {
  // The shape a real backend gives an error that crossed a function
  // boundary; `convex-test` leaves `message` bare, so the test builds it.
  function crossedBoundary(data: string | Record<string, string>) {
    const err = new ConvexError(data);
    const rendered = typeof data === "string" ? data : JSON.stringify(data);
    err.message =
      `Uncaught ConvexError: ${rendered}\n` +
      "    at handler (../convex/projects.ts:12:11)\n";
    return err;
  }

  test("string data reaches the caller without prefix or stack", () => {
    expect(
      deliberateErrorMessage(crossedBoundary('No project with id "x".')),
    ).toBe('No project with id "x".');
  });

  test("structured data reaches the caller as JSON, code included", () => {
    expect(
      deliberateErrorMessage(
        crossedBoundary({ code: "NOT_FOUND", message: "No project" }),
      ),
    ).toBe('{"code":"NOT_FOUND","message":"No project"}');
  });

  test("data serialized in place by convex is decoded", () => {
    const err = Object.assign(new ConvexError<string>("unused"), {
      data: '{"code":"NOT_FOUND"}',
      ConvexErrorSymbol: Symbol.for("ConvexError"),
    });
    expect(deliberateErrorMessage(err)).toBe('{"code":"NOT_FOUND"}');
    err.data = '"Invoice not found"';
    expect(deliberateErrorMessage(err)).toBe("Invoice not found");
  });

  test("oversized data is truncated to the runtime's error length", () => {
    const text = deliberateErrorMessage(new ConvexError("x".repeat(20000)));
    expect(text).toHaveLength(16384);
    expect(text.endsWith("[...truncated]")).toBe(true);
  });

  test("truncation never splits a surrogate pair", () => {
    const text = deliberateErrorMessage(
      new ConvexError("x".repeat(16384 - 15) + "😀".repeat(10)),
    );
    expect(text).toBe("x".repeat(16384 - 15) + "[...truncated]");
  });

  test("an error named ConvexError without Convex data keeps its message", () => {
    const err = new Error("Invoice not found");
    err.name = "ConvexError";
    expect(deliberateErrorMessage(err)).toBe("Invoice not found");
  });
});
