/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { createFunctionHandle, type FunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema.js";
import { api, components, internal } from "./_generated/api.js";
import { McpGateway } from "convex-mcp-gateway";
import {
  conformanceResourceTemplates,
  conformanceResources,
} from "./conformance.js";
import { authorizeResource } from "./http.js";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!**/*.test.ts"]);
const componentModules = import.meta.glob([
  "../../src/component/**/*.ts",
  "!../../src/component/**/*.test.ts",
]);

import componentSchema from "../../src/component/schema.js";

function newTest() {
  const t = convexTest(schema, modules);
  t.registerComponent("mcpGateway", componentSchema, componentModules);
  return t;
}

// =================================================================
// Component-level tests: dispatch.runTool runs whatever you give it
// (no auth in the component; auth lives in the host's HTTP handler).
// =================================================================

describe("dispatch.runTool", () => {
  test("runs a registered tool and returns its data", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    await t.run(async (ctx) => {
      await ctx.db.insert("invoices", { status: "open", amount: 7 });
    });

    const result = await t.action(components.mcpGateway.dispatch.runTool, {
      name: "invoices_summary",
      args: {},
      auditIdentitySubject: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ total: 1 });
  });

  test("unknown tool returns -32602 and writes no audit row", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    const result = await t.action(components.mcpGateway.dispatch.runTool, {
      name: "no.such.tool",
      args: {},
      auditIdentitySubject: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(-32602);
      expect(result.error.message).toMatch(/no\.such\.tool/);
    }

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
    );
    expect(entries.find((e) => e.toolName === "no.such.tool")).toBeUndefined();
  });

  test("writes audit row with auditIdentitySubject for allowed calls", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    await t.action(components.mcpGateway.dispatch.runTool, {
      name: "invoices_summary",
      args: {},
      auditIdentitySubject: "alice",
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
    );
    const row = entries.find((e) => e.toolName === "invoices_summary");
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("allowed");
    expect(row?.identitySubject).toBe("alice");
  });

  test("metadata.auditArgs.redact replaces listed top-level fields", async () => {
    const t = newTest();
    // Register a mutation tagged for field-level redaction.
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.markPaid);
      await ctx.runMutation(components.mcpGateway.registry.replaceTools, {
        tools: [
          {
            name: "secret_write",
            description: "Demo of declarative field redaction.",
            kind: "mutation",
            functionHandle: handle,
            inputSchema: { type: "object" },
            metadata: { auditArgs: { redact: ["password", "token"] } },
          },
        ],
      });
    });

    // The dispatch will fail because invoices_markPaid expects an `id`,
    // but the audit row is written either way. We're testing redaction,
    // not success.
    await t.action(components.mcpGateway.dispatch.runTool, {
      name: "secret_write",
      args: { password: "p@ss", token: "t0k3n", username: "alice" },
      auditIdentitySubject: null,
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "secret_write",
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.args).toEqual({
      password: "[redacted]",
      token: "[redacted]",
      username: "alice",
    });
  });

  test("audits the MRTR idempotency key like any other argument", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const invoiceId = await t.run(async (ctx) =>
      ctx.db.insert("invoices", { status: "open", amount: 7 }),
    );

    // Simulate a hook-approved gateway continuation: the only injected
    // argument is the chain's idempotency key. Continuation state and
    // input responses never reach dispatch, so nothing needs to be
    // withheld from the audit row.
    const result = await t.action(components.mcpGateway.dispatch.runTool, {
      name: "invoices_archiveAfterConfirmation",
      args: {
        id: invoiceId,
        continuationKey: "continuation-key-1",
      },
      auditIdentitySubject: "alice",
    });
    expect(result.ok).toBe(true);

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "invoices_archiveAfterConfirmation",
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.args).toEqual({
      id: invoiceId,
      continuationKey: "continuation-key-1",
    });
  });

  test("metadata.auditErrorMessage=false omits persisted error text", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.markPaid);
      await ctx.runMutation(components.mcpGateway.registry.replaceTools, {
        tools: [
          {
            name: "secret_failure",
            description: "Demo of error-message redaction.",
            kind: "mutation",
            functionHandle: handle,
            inputSchema: { type: "object" },
            metadata: { auditErrorMessage: false },
          },
        ],
      });
    });

    const result = await t.action(components.mcpGateway.dispatch.runTool, {
      name: "secret_failure",
      args: { id: "not-a-valid-invoice-id" },
      auditIdentitySubject: null,
    });
    expect(result.ok).toBe(false);

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "secret_failure",
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe("error");
    expect(entries[0]!.errorCode).toBe(-32000);
    expect(entries[0]!.errorMessage).toBeUndefined();
  });
});

// =================================================================
// dispatch.recordAuthDenial: hosts call this when the authorize
// callback returns allowed=false so the audit log captures rejections.
// =================================================================

describe("dispatch.recordAuthDenial", () => {
  test("writes a denied audit row for a known tool", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    await t.mutation(components.mcpGateway.dispatch.recordAuthDenial, {
      name: "invoices_list",
      args: { status: "open" },
      auditIdentitySubject: null,
      outcome: "denied",
      errorCode: -32001,
      errorMessage: "Unauthorized",
      durationMs: 3,
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
    );
    expect(entries.find((e) => e.toolName === "invoices_list")).toMatchObject({
      outcome: "denied",
      errorCode: -32001,
      errorMessage: "Unauthorized",
      identitySubject: null,
    });
  });

  test("keeps denied reasons when auditErrorMessage is false", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.summary);
      await ctx.runMutation(components.mcpGateway.registry.registerTool, {
        name: "invoices_summary",
        description: "Summarize invoices.",
        kind: "query",
        functionHandle: handle,
        inputSchema: { type: "object" },
        metadata: { auditErrorMessage: false },
      });
    });

    await t.mutation(components.mcpGateway.dispatch.recordAuthDenial, {
      name: "invoices_summary",
      args: {},
      auditIdentitySubject: null,
      outcome: "denied",
      errorCode: -32001,
      errorMessage: "Unauthorized",
      durationMs: 3,
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "invoices_summary",
      }),
    );
    expect(entries[0]).toMatchObject({
      outcome: "denied",
      errorCode: -32001,
      errorMessage: "Unauthorized",
    });
  });
});

// =================================================================
// End-to-end via t.fetch through the host's http.ts. Verifies the
// integrated Streamable-HTTP flow including session lifecycle,
// content negotiation, and the host's authorize callback.
// =================================================================

async function initialize(t: ReturnType<typeof newTest>): Promise<string> {
  const res = await t.fetch("/mcp/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }),
  });
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function rpc(
  t: ReturnType<typeof newTest>,
  sessionId: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await t.fetch("/mcp/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("HTTP envelope (host-mounted /mcp/)", () => {
  test("POST without session id returns 400", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("POST without Accept header returns 406", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    expect(res.status).toBe(406);
  });

  test("initialize returns Mcp-Session-Id header", async () => {
    const t = newTest();
    const session = await initialize(t);
    expect(session).toMatch(/^[0-9a-f]{32}$/);
  });

  test("DELETE by an anonymous caller cannot tear down an authenticated session", async () => {
    // Open a session as the userinfo-resolved subject (the example's
    // resolveIdentity accepts `valid-userinfo-token` →
    // "validator-resolved-sub"). The gateway binds the session row to
    // that subject. An anonymous DELETE (no Bearer) must be refused
    // with 403, otherwise a leaked session id alone would suffice to
    // DoS the authenticated user's session.
    const t = newTest();
    const initRes = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer valid-userinfo-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    expect(initRes.status).toBe(200);
    const session = initRes.headers.get("mcp-session-id")!;

    const delAnon = await t.fetch("/mcp/", {
      method: "DELETE",
      headers: { "mcp-session-id": session },
    });
    expect(delAnon.status).toBe(403);

    // The original caller (same Bearer) can still tear it down.
    const delOwner = await t.fetch("/mcp/", {
      method: "DELETE",
      headers: {
        "mcp-session-id": session,
        authorization: "Bearer valid-userinfo-token",
      },
    });
    expect(delOwner.status).toBe(200);
  });

  test("DELETE terminates session, subsequent request returns 404", async () => {
    const t = newTest();
    const session = await initialize(t);
    const del = await t.fetch("/mcp/", {
      method: "DELETE",
      headers: { "mcp-session-id": session },
    });
    expect(del.status).toBe(200);

    const next = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/list",
    });
    expect(next.status).toBe(404);
  });

  test("GET /mcp/ returns 405 with allow header", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp/", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });

  test("POST /mcp (no trailing slash) also works", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toMatch(/^[0-9a-f]{32}$/);
  });

  test("OPTIONS preflight returns CORS headers when cors: true", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp/", {
      method: "OPTIONS",
      headers: {
        origin: "https://claude.ai",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "content-type",
    );
    expect(res.headers.get("access-control-expose-headers")).toContain(
      "mcp-session-id",
    );
  });

  test("POST responses include CORS headers when cors: true", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const res = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://claude.ai",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toContain(
      "mcp-session-id",
    );
  });

  test("Accept with SSE listed first returns SSE-framed response", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);
    // Both content types are listed (spec-compliant) but the client
    // signals SSE preference by listing it first. Reversing the
    // order would give back a plain application/json response.
    const res = await rpc(
      t,
      session,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "invoices_summary", arguments: {} },
      },
      { accept: "text/event-stream, application/json" },
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toMatch(/^id: 1\nevent: message\ndata: /);
    expect(text).toContain('"jsonrpc":"2.0"');
  });
});

describe("authorize callback (host's http.ts)", () => {
  test("anonymous tools/list shows only public tools", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema?: { properties?: Record<string, unknown> };
        }>;
      };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "invoices_summary",
    ]);
  });

  test("anonymous tools/call on a public tool succeeds", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "invoices_summary", arguments: {} },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: unknown } };
    expect(body.result.content).toBeDefined();
  });

  test("anonymous tools/call on a private tool returns 401 + WWW-Authenticate", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    // Configure OAuth so the 401 carries the discovery header.
    await t.run(async (ctx) => {
      await ctx.runMutation(components.mcpGateway.registry.setOAuthConfig, {
        authServerUrl: "https://idp.example.com/",
      });
    });

    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "invoices_list", arguments: {} },
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toMatch(/^Bearer resource_metadata="/);
  });

  test("authenticated tools/list shows the full catalog the user can call", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    const session = await initialize(
      t.withIdentity({ subject: "alice" }) as ReturnType<typeof newTest>,
    );
    const res = await (
      t.withIdentity({ subject: "alice" }) as ReturnType<typeof newTest>
    ).fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/list",
      }),
    });
    const body = (await res.json()) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema?: { properties?: Record<string, unknown> };
        }>;
      };
    };
    // alice has no admin role → markPaid is hidden. The MRTR example, list,
    // summary, and identity-gated whoami are visible to authenticated users.
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "invoices_archiveAfterConfirmation",
      "invoices_bulkMarkPaid",
      "invoices_list",
      "invoices_recount",
      "invoices_summary",
      "invoices_whoami",
    ]);
    expect(
      body.result.tools.find(
        (tool) => tool.name === "invoices_archiveAfterConfirmation",
      )?.inputSchema?.properties,
    ).toEqual({
      id: { type: "string", format: "convex-id", "x-convex-table": "invoices" },
    });
  });

  test("admin sees the full catalog including the role-gated mutation", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const tWithRoles = t.withIdentity({
      subject: "carol",
      roles: ["finance.admin"],
    } as unknown as Parameters<typeof t.withIdentity>[0]) as ReturnType<
      typeof newTest
    >;

    const session = await initialize(tWithRoles);
    const res = await tWithRoles.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/list",
      }),
    });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "invoices_archiveAfterConfirmation",
      "invoices_bulkMarkPaid",
      "invoices_list",
      "invoices_markPaid",
      "invoices_recount",
      "invoices_summary",
      "invoices_whoami",
    ]);
  });

  test("audit log records denied calls (subject + reason)", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);

    await rpc(t, session, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "invoices_list", arguments: {} },
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
    );
    const denied = entries.find(
      (e) => e.toolName === "invoices_list" && e.outcome === "denied",
    );
    expect(denied).toBeDefined();
    expect(denied?.errorCode).toBe(-32001);
    expect(denied?.identitySubject).toBeNull();
  });

  test("audit log skips unknown-tool calls (anti-DoS)", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);

    await rpc(t, session, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "does.not.exist", arguments: {} },
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
    );
    expect(
      entries.find((e) => e.toolName === "does.not.exist"),
    ).toBeUndefined();
  });
});

describe("outputSchema / structuredContent (MCP returns)", () => {
  test("tools/list includes outputSchema for tools registered with returns", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);

    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: {
        tools: Array<{
          name: string;
          outputSchema?: { type?: string };
        }>;
      };
    };
    const summary = body.result.tools.find(
      (t) => t.name === "invoices_summary",
    );
    expect(summary?.outputSchema).toEqual({
      type: "object",
      properties: { total: { type: "number" } },
      required: ["total"],
      additionalProperties: false,
    });
  });

  test("icons reach every catalog, and stay absent when undeclared", async () => {
    const t = newTest();
    const session = await initialize(t);
    // Same fixture token the sibling tests in this file authenticate with.
    const BEARER = { authorization: "Bearer valid-userinfo-token" };

    const tools = (await (
      await rpc(
        t,
        session,
        { jsonrpc: "2.0", id: 20, method: "tools/list" },
        BEARER,
      )
    ).json()) as { result: { tools: Array<{ name: string; icons?: unknown }> } };
    expect(
      tools.result.tools.find((tool) => tool.name === "invoices_summary")?.icons,
    ).toEqual([
      { src: "https://example.com/icons/summary.png", mimeType: "image/png" },
    ]);
    // Absent must stay absent: no empty array materialised for the rest.
    for (const tool of tools.result.tools) {
      if (tool.name !== "invoices_summary") {
        expect("icons" in tool).toBe(false);
      }
    }

    const resources = (await (
      await rpc(
        t,
        session,
        { jsonrpc: "2.0", id: 21, method: "resources/list" },
        BEARER,
      )
    ).json()) as {
      result: { resources: Array<{ uri: string; icons?: unknown }> };
    };
    expect(
      resources.result.resources.find(
        (resource) => resource.uri === "invoices://summary",
      )?.icons,
    ).toEqual([
      {
        src: "https://example.com/icons/invoices-48.png",
        mimeType: "image/png",
        sizes: ["48x48"],
      },
      {
        src: "https://example.com/icons/invoices-dark.svg",
        mimeType: "image/svg+xml",
        sizes: ["any"],
        theme: "dark",
      },
    ]);

    const templates = (await (
      await rpc(
        t,
        session,
        { jsonrpc: "2.0", id: 22, method: "resources/templates/list" },
        BEARER,
      )
    ).json()) as {
      result: {
        resourceTemplates: Array<{ uriTemplate: string; icons?: unknown }>;
      };
    };
    expect(
      templates.result.resourceTemplates.find(
        (template) => template.uriTemplate === "invoice://{id}",
      )?.icons,
    ).toEqual([
      { src: "https://example.com/icons/invoice.png", sizes: ["96x96"] },
    ]);
  });

  test("tools/list omits outputSchema for tools without returns", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    const tAuth = t.withIdentity({ subject: "alice" }) as ReturnType<
      typeof newTest
    >;
    const session = await initialize(tAuth);
    const res = await tAuth.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const body = (await res.json()) as {
      result: {
        tools: Array<{ name: string; outputSchema?: unknown }>;
      };
    };
    const list = body.result.tools.find((t) => t.name === "invoices_list");
    // Tools without `returns:` MUST NOT have outputSchema at all
    // (not null, not {}; spec-strict clients reject those forms).
    expect(list).toBeDefined();
    expect("outputSchema" in (list ?? {})).toBe(false);
  });

  test("tools/call ships structuredContent when outputSchema declared", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    await t.run(async (ctx) => {
      await ctx.db.insert("invoices", { status: "open", amount: 12 });
      await ctx.db.insert("invoices", { status: "paid", amount: 7 });
    });

    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "invoices_summary", arguments: {} },
    });
    const body = (await res.json()) as {
      result: {
        content: Array<{ type: string; text?: string }>;
        structuredContent?: { total?: number };
      };
    };
    // Both representations: text-JSON for legacy clients ...
    expect(body.result.content[0]?.type).toBe("text");
    expect(body.result.content[0]?.text).toContain('"total": 2');
    // ... and the typed `structuredContent` per MCP 2025-06-18.
    expect(body.result.structuredContent).toEqual({ total: 2 });
  });

  test("tools/call omits structuredContent when no outputSchema", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    await t.run(async (ctx) => {
      await ctx.db.insert("invoices", { status: "open", amount: 1 });
    });

    const tAuth = t.withIdentity({ subject: "alice" }) as ReturnType<
      typeof newTest
    >;
    const session = await initialize(tAuth);
    const res = await tAuth.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "invoices_list", arguments: {} },
      }),
    });
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result.content).toBeDefined();
    expect("structuredContent" in body.result).toBe(false);
  });
});

describe("OAuth bridge mode (DCR + AS metadata + resolveIdentity)", () => {
  test("handleClientRegistration returns the configured upstream client_id", async () => {
    const t = newTest();
    const res = await t.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "claude.ai",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      client_id: string;
      redirect_uris: string[];
    };
    expect(body.client_id).toBe("upstream-client-id-fixed");
    expect(body.redirect_uris).toEqual([
      "https://claude.ai/api/mcp/auth_callback",
    ]);
  });

  test("handleClientRegistration rejects redirect_uris outside the allowlist", async () => {
    const t = newTest();
    const res = await t.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "evil",
        redirect_uris: ["https://attacker.example.com/callback"],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  test("resolveIdentity path: identity from validator, not Convex auth", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);
    // The host's mcpHandler routes through `resolveIdentity` when a Bearer
    // is present. The example wires it to accept the literal token
    // "valid-userinfo-token" → subject "validator-resolved-sub".
    const res = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
        authorization: "Bearer valid-userinfo-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "invoices_list", arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
    );
    const row = entries.find((e) => e.toolName === "invoices_list");
    expect(row?.identitySubject).toBe("validator-resolved-sub");
  });
});

describe("audit listEntries (filter regression coverage)", () => {
  // `audit.recordEntry` is `internalMutation` so the component's public
  // surface (and the generated `components.mcpGateway.audit` types) hide
  // it. Tests seed audit rows directly because going through the real
  // dispatch path would add unrelated side effects; `convex-test` does
  // not enforce the component-boundary check, so this cast is safe in
  // tests only.
  type SeedAuditArgs = {
    toolName: string;
    toolKind: "query" | "mutation" | "action";
    args: unknown;
    outcome: "allowed" | "denied" | "error";
    identitySubject: string | null;
    durationMs: number;
    errorCode?: number;
    errorMessage?: string;
  };
  const seedAuditEntry = (
    components.mcpGateway.audit as unknown as {
      recordEntry: FunctionReference<
        "mutation",
        "internal",
        SeedAuditArgs,
        string,
        "mcpGateway"
      >;
    }
  ).recordEntry;

  test("finds older matches when newer entries don't match the outcome filter", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    await t.run(async (ctx) => {
      // 3 ancient errors first.
      for (let i = 0; i < 3; i++) {
        await ctx.runMutation(seedAuditEntry, {
          toolName: "x",
          toolKind: "query",
          args: { i },
          outcome: "error",
          identitySubject: null,
          durationMs: 1,
          errorCode: -32000,
          errorMessage: "old error",
        });
      }
      // 50 recent allowed rows hide the errors past any small window.
      for (let i = 0; i < 50; i++) {
        await ctx.runMutation(seedAuditEntry, {
          toolName: "x",
          toolKind: "query",
          args: { i },
          outcome: "allowed",
          identitySubject: null,
          durationMs: 1,
        });
      }
    });

    const errors = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "x",
        outcome: "error",
        limit: 10,
      }),
    );
    expect(errors).toHaveLength(3);
  });

  test("audit pruning drops rows older than the cutoff", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    await t.run(async (ctx) => {
      await ctx.runMutation(seedAuditEntry, {
        toolName: "old_tool",
        toolKind: "query",
        args: null,
        outcome: "allowed",
        identitySubject: null,
        durationMs: 1,
      });
    });
    const farFuture = Date.now() + 10 * 60 * 1000;
    const deleted = await t.mutation(
      components.mcpGateway.audit.pruneOlderThan,
      { cutoffMs: farFuture },
    );
    expect(deleted).toBeGreaterThanOrEqual(1);
  });
});

// =================================================================
// Argument redaction: covers auditArgs: false / true / nested-path
// redaction added by Cluster C #11.
// =================================================================

describe("argument redaction", () => {
  test("auditArgs: false drops the args entirely", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.noopAny);
      await ctx.runMutation(components.mcpGateway.registry.replaceTools, {
        tools: [
          {
            name: "sensitive_drop",
            description: "tool that opts out of arg storage",
            kind: "query",
            functionHandle: handle,
            inputSchema: { type: "object" },
            metadata: { auditArgs: false },
          },
        ],
      });
    });

    await t.action(components.mcpGateway.dispatch.runTool, {
      name: "sensitive_drop",
      args: { payload: { password: "hunter2", token: "xyz" } },
      auditIdentitySubject: "alice",
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "sensitive_drop",
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.args).toBeNull();
    expect(entries[0]!.outcome).toBe("allowed");
  });

  test("auditArgs.redact walks nested dotted paths", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.noopAny);
      await ctx.runMutation(components.mcpGateway.registry.replaceTools, {
        tools: [
          {
            name: "nested_redact",
            description: "redact a nested path",
            kind: "query",
            functionHandle: handle,
            inputSchema: { type: "object" },
            metadata: {
              auditArgs: {
                redact: ["payload.credentials.token", "payload.topLevel"],
              },
            },
          },
        ],
      });
    });

    await t.action(components.mcpGateway.dispatch.runTool, {
      name: "nested_redact",
      args: {
        payload: {
          topLevel: "should-vanish",
          credentials: { token: "secret123", user: "alice" },
          other: { keep: "me" },
        },
      },
      auditIdentitySubject: null,
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "nested_redact",
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe("allowed");
    expect(entries[0]!.args).toEqual({
      payload: {
        topLevel: "[redacted]",
        credentials: { token: "[redacted]", user: "alice" },
        other: { keep: "me" },
      },
    });
  });
});

// =================================================================
// Tool-execution error envelope: covers Cluster D #19 (errors from
// the tool handler surface as MCP `result.isError: true`, NOT as a
// JSON-RPC error envelope) and the matching audit row outcome.
// =================================================================

describe("tool execution failures", () => {
  test("plain Error thrown by handler: wire gets generic, audit keeps verbose", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.throwsAlways);
      await ctx.runMutation(components.mcpGateway.registry.replaceTools, {
        tools: [
          {
            name: "broken_query",
            description: "always throws",
            kind: "query",
            functionHandle: handle,
            inputSchema: { type: "object" },
          },
        ],
      });
    });

    const result = await t.action(components.mcpGateway.dispatch.runTool, {
      name: "broken_query",
      args: {},
      auditIdentitySubject: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Wire message is the generic placeholder, the verbose
      // "boom, should not reach the wire" string stays out of the
      // unauthenticated caller's response.
      expect(result.error.code).toBe(-32000);
      expect(result.error.message).toBe("Tool execution failed");
      expect(result.error.message).not.toContain("boom");
    }

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "broken_query",
      }),
    );
    expect(entries[0]?.outcome).toBe("error");
    expect(entries[0]?.errorCode).toBe(-32000);
    // Audit row retains the full message so operators can debug.
    expect(entries[0]?.errorMessage).toContain("boom");
  });

  test("ConvexError thrown by handler: full message reaches the wire", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.throwsConvexError);
      await ctx.runMutation(components.mcpGateway.registry.replaceTools, {
        tools: [
          {
            name: "user_facing_throw",
            description: "throws ConvexError",
            kind: "query",
            functionHandle: handle,
            inputSchema: { type: "object" },
          },
        ],
      });
    });

    const result = await t.action(components.mcpGateway.dispatch.runTool, {
      name: "user_facing_throw",
      args: {},
      auditIdentitySubject: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(-32000);
      // ConvexError is the deliberate user-facing channel; its
      // message reaches the wire so the LLM can reason about
      // "Invoice not found" and react.
      expect(result.error.message).toContain("Invoice not found");
    }
  });

  test("tools/call surfaces handler throw as result.isError:true (not JSON-RPC error)", async () => {
    const t = newTest();
    const session = await initialize(t);
    // Register the throwing tool AND wire authorize to allow it. Done
    // after initialize because the /mcp/ mount auto-syncs the default
    // catalog on initialize, which would otherwise replace this tool.
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.throwsAlways);
      await ctx.runMutation(components.mcpGateway.registry.replaceTools, {
        tools: [
          {
            name: "broken_query",
            description: "always throws",
            kind: "query",
            functionHandle: handle,
            inputSchema: { type: "object" },
            metadata: { public: true },
          },
        ],
      });
    });

    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "broken_query", arguments: {} },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };
      error?: { code: number; message: string };
    };
    // Spec: tool execution failures arrive as a `result` with
    // `isError: true`, so the LLM can react. JSON-RPC `error`
    // envelopes are reserved for protocol errors.
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.type).toBe("text");
    // The wire content is the sanitized generic message; "boom"
    // stays in the audit log only.
    expect(body.result?.content?.[0]?.text).toBe("Tool execution failed");
  });
});

// =================================================================
// JSON-RPC envelope edge cases: parse error, notification, invalid
// request. Covers Cluster D #20, #48 + Cluster G #26.
// =================================================================

describe("JSON-RPC envelope edge cases", () => {
  test("parse error returns HTTP 400 with -32700 body", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  test("notification (no id) returns HTTP 202 with no body", async () => {
    const t = newTest();
    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("invalid request (no method, no id) returns HTTP 400 with -32600 body", async () => {
    const t = newTest();
    const session = await initialize(t);
    const res = await rpc(t, session, { jsonrpc: "2.0" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  test("batched JSON-RPC array body returns HTTP 400", async () => {
    const t = newTest();
    const session = await initialize(t);
    const res = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
      },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/[Bb]atched/);
  });

  test("unsupported MCP-Protocol-Version header returns 400", async () => {
    const t = newTest();
    const session = await initialize(t);
    const res = await rpc(
      t,
      session,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { "mcp-protocol-version": "9999-01-01" },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Unsupported MCP-Protocol-Version/);
  });

  test("initialize negotiates the supported protocol version in the response body", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "1999-01-01" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { protocolVersion: string };
    };
    // Server falls back to its newest supported version when the
    // client asks for something it doesn't speak.
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });
});

// =================================================================
// resolveIdentity branches: covers Cluster G #25. The example wires
// `resolveIdentity` to (a) accept "valid-userinfo-token", (b) throw
// on "boom-token", (c) return null otherwise. Together those cover
// the gateway's three behaviours: identity attached, anonymous on
// rejection, anonymous on throw (with a warn log).
// =================================================================

describe("resolveIdentity branches", () => {
  test("unknown bearer is treated as anonymous (Unauthorized denial)", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    // Configure OAuth so an Unauthorized denial maps to HTTP 401 with
    // WWW-Authenticate; without it the gateway still denies but
    // wraps the response in a JSON-RPC error envelope on HTTP 200.
    await t.run(async (ctx) => {
      await ctx.runMutation(components.mcpGateway.registry.setOAuthConfig, {
        authServerUrl: "https://idp.example.com/",
      });
    });
    const session = await initialize(t);
    const res = await rpc(
      t,
      session,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "invoices_list", arguments: {} },
      },
      { authorization: "Bearer some-unknown-token" },
    );
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toMatch(/^Bearer /);
  });

  test("validator-throws is treated as anonymous (NOT 500)", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);
    const res = await rpc(
      t,
      session,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "invoices_summary", arguments: {} },
      },
      { authorization: "Bearer boom-token" },
    );
    // invoices_summary is public, so anonymous succeeds. The point
    // is that boom-token's thrown validator does NOT propagate as a
    // 500; it falls through to anonymous handling.
    expect(res.status).toBe(200);
  });
});

// =================================================================
// RFC 9728 protected-resource metadata: 404 without OAuth config,
// auto-derived resource URL, explicit override, OPTIONS preflight.
// Covers cluster G #24.
// =================================================================

describe("RFC 9728 protected-resource metadata", () => {
  test("GET without OAuth config returns 404", async () => {
    const t = newTest();
    const res = await t.fetch("/.well-known/oauth-protected-resource/mcp", {
      method: "GET",
    });
    expect(res.status).toBe(404);
  });

  test("auto-derives resource URL from the request when no override is set", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.runMutation(components.mcpGateway.registry.setOAuthConfig, {
        authServerUrl: "https://idp.example.com/",
      });
    });
    const res = await t.fetch("/.well-known/oauth-protected-resource/mcp", {
      method: "GET",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      bearer_methods_supported: string[];
    };
    expect(body.resource).toMatch(/\/mcp\/?$/);
    expect(body.authorization_servers).toEqual(["https://idp.example.com/"]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  test("uses explicit resourceUrl override verbatim", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.runMutation(components.mcpGateway.registry.setOAuthConfig, {
        authServerUrl: "https://idp.example.com/",
        resourceUrl: "https://canonical.example.com/mcp/",
      });
    });
    const res = await t.fetch("/.well-known/oauth-protected-resource/mcp", {
      method: "GET",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe("https://canonical.example.com/mcp/");
  });

  test("OPTIONS preflight returns 204 with CORS allow-methods", async () => {
    const t = newTest();
    const res = await t.fetch("/.well-known/oauth-protected-resource/mcp", {
      method: "OPTIONS",
      headers: {
        origin: "https://claude.ai",
        "access-control-request-method": "GET",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});

// =================================================================
// OAuth bridge: handleClientRegistration branches. Covers #45,
// empty redirect_uris, malformed JSON, non-POST, OPTIONS preflight.
// =================================================================

describe("OAuth bridge: handleClientRegistration branches", () => {
  test("missing redirect_uris field returns 400 invalid_redirect_uri", async () => {
    const t = newTest();
    const res = await t.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "no-redirects" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  test("empty redirect_uris array returns 400 invalid_redirect_uri", async () => {
    const t = newTest();
    const res = await t.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [], client_name: "empty" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  test("malformed JSON body returns 400 invalid_client_metadata", async () => {
    const t = newTest();
    const res = await t.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });

  test("GET on /oauth/register returns 405 with allow header", async () => {
    const t = newTest();
    const res = await t.fetch("/oauth/register", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });

  test("OPTIONS preflight returns 204 with CORS allow-methods POST", async () => {
    const t = newTest();
    const res = await t.fetch("/oauth/register", {
      method: "OPTIONS",
      headers: {
        origin: "https://claude.ai",
        "access-control-request-method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("attacker payload of long redirect_uris is truncated in the error", async () => {
    const t = newTest();
    const longUri = "https://attacker.example.com/" + "A".repeat(1000);
    const res = await t.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [longUri],
        client_name: "evil",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_description: string };
    // The echoed URI must be truncated; the raw 1000-char path must
    // not appear verbatim in the response body.
    expect(body.error_description.length).toBeLessThan(500);
    expect(body.error_description).not.toContain("A".repeat(500));
  });
});

// =================================================================
// CORS `string[]` allowlist branch (#44). The example's main /mcp/
// mount uses `cors: true`; this test exercises `cors: [...]` via the
// test-only `/mcp-cors-array/` mount in http.ts.
// =================================================================

describe("CORS allowlist (string[] branch)", () => {
  async function initializeCors(t: ReturnType<typeof newTest>, origin: string) {
    const res = await t.fetch("/mcp-cors-array/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    return res;
  }

  test("matching origin gets Access-Control-Allow-Origin echoed back", async () => {
    const t = newTest();
    const res = await initializeCors(t, "https://allowed.example.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://allowed.example.com",
    );
  });

  test("second allowlist entry also matches", async () => {
    const t = newTest();
    const res = await initializeCors(t, "https://also-allowed.example.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://also-allowed.example.com",
    );
  });

  test("non-matching origin gets no CORS headers (browser blocks)", async () => {
    const t = newTest();
    const res = await initializeCors(t, "https://attacker.example.com");
    // The request still completes server-side; the response simply
    // omits CORS headers, leaving the browser to enforce the policy.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("OPTIONS preflight from matching origin echoes the allow methods", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp-cors-array/", {
      method: "OPTIONS",
      headers: {
        origin: "https://allowed.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://allowed.example.com",
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

// =================================================================
// Authorize-callback throws (#27): the gateway translates the throw
// to `-32603 INTERNAL_ERROR`, audit row outcome "error" with
// errorMessage matching /Authorizer threw/. Test uses the dedicated
// `/mcp-throws/` mount whose authorize callback always throws.
// =================================================================

describe("authorize callback throws (end-to-end)", () => {
  test("tools/call against a throwing authorize → -32603 + audit error row", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    // initialize against the throwing-authorize route. The
    // initialize method does not invoke authorize, so this succeeds.
    const initRes = await t.fetch("/mcp-throws/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    expect(initRes.status).toBe(200);
    const session = initRes.headers.get("mcp-session-id")!;

    // tools/call DOES invoke authorize → it throws → -32603.
    const callRes = await t.fetch("/mcp-throws/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "invoices_summary", arguments: {} },
      }),
    });
    expect(callRes.status).toBe(200);
    const callBody = (await callRes.json()) as {
      error?: { code: number; message: string };
    };
    expect(callBody.error?.code).toBe(-32603);
    // The caller learns the check failed, not why: the reason is
    // `Authorizer threw: <exception text>` and stays server-side.
    expect(callBody.error?.message).toBe("Authorization check failed");
    expect(callBody.error?.message).not.toMatch(/Authorizer threw/);

    // The denial path writes an audit row with outcome "error".
    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "invoices_summary",
      }),
    );
    const errorEntry = entries.find((e) => e.outcome === "error");
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.errorCode).toBe(-32603);
    expect(errorEntry?.errorMessage).toMatch(/Authorizer threw/);
  });

  test("auditErrorMessage=false omits a throwing authorizer's error text", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.summary);
      await ctx.runMutation(components.mcpGateway.registry.registerTool, {
        name: "invoices_summary",
        description: "Summarize invoices.",
        kind: "query",
        functionHandle: handle,
        inputSchema: { type: "object" },
        metadata: { auditErrorMessage: false },
      });
    });

    const initRes = await t.fetch("/mcp-throws/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    const session = initRes.headers.get("mcp-session-id")!;
    await t.fetch("/mcp-throws/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "invoices_summary", arguments: {} },
      }),
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "invoices_summary",
      }),
    );
    const errorEntry = entries.find((entry) => entry.outcome === "error");
    expect(errorEntry).toMatchObject({ outcome: "error", errorCode: -32603 });
    expect(errorEntry?.errorMessage).toBeUndefined();
  });

  test("tools/list against a throwing authorize drops every tool silently (logged)", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    const initRes = await t.fetch("/mcp-throws/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    const session = initRes.headers.get("mcp-session-id")!;

    const listRes = await t.fetch("/mcp-throws/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }),
    });
    const listBody = (await listRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    // Every tool gets dropped from the catalog when authorize throws
    // for each entry, no client should see a tool it cannot invoke.
    expect(listBody.result.tools).toEqual([]);
  });
});

// =================================================================
// AS metadata bridge (#23). Stubs `globalThis.fetch` so the
// upstream OIDC discovery document is deterministic.
// =================================================================

describe("RFC 8414 AS metadata bridge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The OIDC cache is a module-level Map keyed by issuer; once a test
  // primes it for `https://upstream.example.com`, subsequent tests
  // hit the cache and bypass `fetch`. The 502 test must therefore
  // run before the happy-path test (or use a distinct issuer).
  // OPTIONS short-circuits before touching the cache, so its order
  // is independent.

  test("OPTIONS preflight returns 204 with CORS headers", async () => {
    const t = newTest();
    const res = await t.fetch("/.well-known/oauth-authorization-server", {
      method: "OPTIONS",
      headers: {
        origin: "https://claude.ai",
        "access-control-request-method": "GET",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  test("upstream fetch failure returns 502 upstream_metadata_unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Bad Gateway", { status: 502 }),
    );

    const t = newTest();
    const res = await t.fetch("/.well-known/oauth-authorization-server", {
      method: "GET",
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("upstream_metadata_unreachable");
  });

  test("happy path: substitutes registration_endpoint with bridge origin", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issuer: "https://upstream.example.com",
          authorization_endpoint: "https://upstream.example.com/authorize",
          token_endpoint: "https://upstream.example.com/token",
          userinfo_endpoint: "https://upstream.example.com/userinfo",
          jwks_uri: "https://upstream.example.com/jwks",
          client_id_metadata_document_supported: true,
          scopes_supported: ["openid", "profile"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const t = newTest();
    const res = await t.fetch("/.well-known/oauth-authorization-server", {
      method: "GET",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The bridge advertises ITSELF as the issuer and substitutes the
    // registration endpoint so MCP clients DCR against the gateway.
    expect(body.token_endpoint).toBe("https://upstream.example.com/token");
    expect(body.authorization_endpoint).toBe(
      "https://upstream.example.com/authorize",
    );
    expect(body.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(body.client_id_metadata_document_supported).toBe(true);
    // Public-client (PKCE), secrets stay upstream.
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
});

// =================================================================
// identityArg: the gateway injects the resolved caller into the tool's
// declared arg, excludes it from the advertised inputSchema, strips any
// client-supplied value (no spoofing), and denies calls with no caller.
// Enables per-caller scoping despite ctx.auth being stripped across the
// component boundary.
// =================================================================

describe("identityArg (caller injection)", () => {
  test("runTool injects the resolved identity into the tool's caller arg", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const result = await t.action(components.mcpGateway.dispatch.runTool, {
      name: "invoices_whoami",
      args: {},
      auditIdentitySubject: "alice",
      identity: { subject: "alice", claims: { email: "alice@example.com" } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ subject: "alice", hasClaims: true });
    }
  });

  test("the injected caller / claims never reach the audit log", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    // Inject an identity carrying claims (potential PII / tokens). The
    // dispatch strips identityArg before auditing, so neither the
    // subject nor the claims object may appear in the stored args.
    await t.action(components.mcpGateway.dispatch.runTool, {
      name: "invoices_whoami",
      args: {},
      auditIdentitySubject: "alice",
      identity: { subject: "alice", claims: { email: "alice@example.com" } },
    });
    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "invoices_whoami",
      }),
    );
    expect(entries).toHaveLength(1);
    // The caller arg is stripped; args carries only what the client sent ({}).
    expect(entries[0]!.args).toEqual({});
    // Subject is still recorded in the dedicated audit column, not in args.
    expect(entries[0]!.identitySubject).toBe("alice");
  });

  test("runTool overwrites a caller value smuggled into args (no spoofing)", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const result = await t.action(components.mcpGateway.dispatch.runTool, {
      name: "invoices_whoami",
      args: { caller: { subject: "attacker" } },
      auditIdentitySubject: "alice",
      identity: { subject: "alice" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ subject: "alice", hasClaims: false });
    }
  });

  test("runTool denies an identityArg tool when no caller is provided", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    // No `identity` passed: the component must deny rather than inject
    // null and trip the function's arg validator.
    const result = await t.action(components.mcpGateway.dispatch.runTool, {
      name: "invoices_whoami",
      args: {},
      auditIdentitySubject: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(-32001);
      expect(result.error.message).toMatch(/authenticated caller/i);
    }
  });

  test("tools/list omits the injected caller arg from inputSchema", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);
    const res = await rpc(
      t,
      session,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { authorization: "Bearer valid-userinfo-token" },
    );
    const body = (await res.json()) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: { properties?: Record<string, unknown> };
        }>;
      };
    };
    const whoami = body.result.tools.find(
      (tool) => tool.name === "invoices_whoami",
    );
    expect(whoami).toBeDefined();
    expect(whoami!.inputSchema.properties ?? {}).not.toHaveProperty("caller");
  });

  test("tools/call injects the userinfo-resolved subject", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);
    const res = await rpc(
      t,
      session,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "invoices_whoami", arguments: {} },
      },
      { authorization: "Bearer valid-userinfo-token" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { structuredContent?: { subject?: string; hasClaims?: boolean } };
    };
    expect(body.result.structuredContent).toEqual({
      subject: "validator-resolved-sub",
      hasClaims: false,
    });
  });

  test("tools/call ignores a client-supplied caller argument", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);
    const res = await rpc(
      t,
      session,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "invoices_whoami",
          arguments: { caller: { subject: "attacker" } },
        },
      },
      { authorization: "Bearer valid-userinfo-token" },
    );
    const body = (await res.json()) as {
      result: { structuredContent?: { subject?: string } };
    };
    expect(body.result.structuredContent?.subject).toBe(
      "validator-resolved-sub",
    );
  });

  test("identityArg tool with no caller is denied (-32001) even when authorize allows", async () => {
    // The /mcp-cors-array/ mount's authorize allows everything and has no
    // resolveIdentity, so ctx.auth is the only identity source (null in
    // tests). The gateway's identityArg guard must still deny.
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const initRes = await t.fetch("/mcp-cors-array/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://allowed.example.com",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    const session = initRes.headers.get("mcp-session-id")!;
    const res = await t.fetch("/mcp-cors-array/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
        origin: "https://allowed.example.com",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "invoices_whoami", arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error?: { code: number; message: string };
    };
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toMatch(/authenticated caller/i);
  });

  test("non-object args on an identityArg tool fail gracefully (no uncaught throw)", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    // A client can send `arguments: "x"` (a primitive). Stripping the
    // identity key must not crash with a TypeError before the try/catch;
    // runTool must return a structured error, not reject.
    const result = await t.action(components.mcpGateway.dispatch.runTool, {
      name: "invoices_whoami",
      args: "not-an-object",
      auditIdentitySubject: "alice",
      identity: { subject: "alice" },
    });
    expect(result.ok).toBe(false);
  });

  test("host strips a client-supplied caller before the denial audit", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    // /mcp-cors-array/ allows everything and has no resolveIdentity, so an
    // identityArg call with no Bearer is denied (-32001) by the HOST before
    // dispatch ever runs. The denial audit is therefore written host-side;
    // a smuggled caller absent from that row proves the host-layer strip.
    const initRes = await t.fetch("/mcp-cors-array/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://allowed.example.com",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    const session = initRes.headers.get("mcp-session-id")!;
    await t.fetch("/mcp-cors-array/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
        origin: "https://allowed.example.com",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "invoices_whoami",
          arguments: { caller: { subject: "attacker" } },
        },
      }),
    });
    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "invoices_whoami",
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe("denied");
    expect(entries[0]!.args).not.toHaveProperty("caller");
  });

  test("tools/call propagates resolved claims through to the tool", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);
    // valid-userinfo-claims-token resolves to a caller WITH claims, so the
    // claims half of the identity must survive the full HTTP -> inject path.
    const res = await rpc(
      t,
      session,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "invoices_whoami", arguments: {} },
      },
      { authorization: "Bearer valid-userinfo-claims-token" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { structuredContent?: { subject?: string; hasClaims?: boolean } };
    };
    expect(body.result.structuredContent).toEqual({
      subject: "claims-resolved-sub",
      hasClaims: true,
    });
  });

  test("identityArg strip composes with auditArgs.redact in the audit row", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.markPaid);
      await ctx.runMutation(components.mcpGateway.registry.replaceTools, {
        tools: [
          {
            name: "secret_identity",
            description: "identityArg + field redaction",
            kind: "mutation",
            functionHandle: handle,
            inputSchema: { type: "object" },
            identityArg: "caller",
            metadata: { auditArgs: { redact: ["password"] } },
          },
        ],
      });
    });
    // dispatch fails (markPaid expects an id), but the audit row is written
    // regardless. It must carry neither the injected caller (stripped) nor
    // the secret (redacted).
    await t.action(components.mcpGateway.dispatch.runTool, {
      name: "secret_identity",
      args: {
        caller: { subject: "attacker" },
        password: "p@ss",
        username: "alice",
      },
      auditIdentitySubject: "alice",
      identity: { subject: "alice", claims: { email: "x@example.com" } },
    });
    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "secret_identity",
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.args).toEqual({
      password: "[redacted]",
      username: "alice",
    });
  });
});

// =================================================================
// requireAuth gate (host-mounted /mcp-require-auth/). An all-private
// server with requireAuth:true challenges anonymous POSTs with 401 so
// browser MCP clients (claude.ai) begin the OAuth flow instead of
// seeing a 200 empty tools/list.
// =================================================================

describe("requireAuth gate (/mcp-require-auth/)", () => {
  async function postRequireAuth(
    t: ReturnType<typeof newTest>,
    body: object,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return await t.fetch("/mcp-require-auth/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  async function setOAuth(t: ReturnType<typeof newTest>): Promise<void> {
    await t.run(async (ctx) => {
      await ctx.runMutation(components.mcpGateway.registry.setOAuthConfig, {
        authServerUrl: "https://idp.example.com/",
      });
    });
  }

  test("anonymous initialize is challenged with 401 + WWW-Authenticate", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    await setOAuth(t);

    const res = await postRequireAuth(t, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toMatch(
      /^Bearer resource_metadata="/,
    );
    // No session is created for a gated anonymous request.
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32001);
  });

  test("anonymous tools/list is challenged with 401 instead of 200-empty", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    await setOAuth(t);

    // No Mcp-Session-Id needed: the gate fires before session handling.
    const res = await postRequireAuth(t, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toMatch(
      /^Bearer resource_metadata="/,
    );
  });

  test("authenticated request passes the gate and runs the normal flow", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    await setOAuth(t);
    const auth = { authorization: "Bearer valid-userinfo-token" };

    const initRes = await postRequireAuth(
      t,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      auth,
    );
    expect(initRes.status).toBe(200);
    const session = initRes.headers.get("mcp-session-id");
    expect(session).toBeTruthy();

    const listRes = await postRequireAuth(
      t,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { ...auth, "mcp-session-id": session! },
    );
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  test("requireAuth without OAuth config returns 401 without WWW-Authenticate", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    // Deliberately no setOAuthConfig.

    const res = await postRequireAuth(t, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  test("default mount stays opt-out: anonymous initialize + tools/list still 200", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    // initialize() asserts the /mcp/ status is 200 internally.
    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(res.status).toBe(200);
  });
});

// =================================================================
// Declarative `tools` option: the /mcp/ mount passes `tools` to
// handleMcpRequest, so the registry is reconciled on initialize with
// no separate registerDefaults mutation.
// =================================================================

describe("declarative tools option (auto-sync on initialize)", () => {
  test("initialize populates the registry without registerDefaults", async () => {
    const t = newTest();
    // Deliberately NOT calling registerDefaults: the /mcp/ mount declares
    // `tools`, so initialize reconciles the registry on its own.
    const session = await initialize(t);

    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    // Anonymous caller sees only the public tool, which proves the
    // catalog was synced (the registry would be empty otherwise).
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "invoices_summary",
    ]);
  });

  test("a tools/call works after auto-sync (no manual registration)", async () => {
    const t = newTest();
    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "invoices_summary", arguments: {} },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { isError?: boolean } };
    expect(body.result?.isError).toBe(false);
  });

  test("initialize reconciles: a stale tool registered out-of-band is removed", async () => {
    const t = newTest();
    // Seed a stale public tool that is NOT in the declared catalog,
    // simulating a registration left over from an earlier deploy.
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.summary);
      await ctx.runMutation(components.mcpGateway.registry.replaceTools, {
        tools: [
          {
            name: "stale_tool",
            description: "left over",
            kind: "query",
            functionHandle: handle,
            inputSchema: { type: "object" },
            metadata: { public: true },
          },
        ],
      });
    });

    // initialize triggers the change-detected sync, which replaces the
    // registry with the declared catalog (stale_tool gone).
    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "invoices_summary",
    ]);
  });

  test("change detection skips the rewrite when the list is unchanged", async () => {
    const t = newTest();
    // First initialize syncs the declared catalog and records its
    // fingerprint.
    await initialize(t);

    // Inject drift directly via registerTool, which does NOT touch the
    // fingerprint. If the second initialize re-synced unconditionally,
    // this drift tool would be wiped; change detection must skip it.
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.summary);
      await ctx.runMutation(components.mcpGateway.registry.registerTool, {
        name: "drift_tool",
        description: "injected out-of-band",
        kind: "query",
        functionHandle: handle,
        inputSchema: { type: "object" },
        metadata: { public: true },
      });
    });

    // Second initialize: the declared list is unchanged, so the sync is
    // a no-op and the out-of-band drift_tool survives.
    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "drift_tool",
      "invoices_summary",
    ]);
  });

  test("a changed list (non-null fingerprint) re-syncs the registry", async () => {
    const t = newTest();
    // Simulate a PRIOR declarative sync of a different list: a stale tool
    // with a stale, non-null fingerprint. This is the A -> B transition
    // (the from-empty case is covered by the reconcile test above).
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.summary);
      await ctx.runMutation(components.mcpGateway.registry.replaceTools, {
        tools: [
          {
            name: "old_tool",
            description: "from a previous list",
            kind: "query",
            functionHandle: handle,
            inputSchema: { type: "object" },
            metadata: { public: true },
          },
        ],
        fingerprint: "stale-fingerprint-A",
      });
    });

    // initialize: the declared list differs from fingerprint "A", so the
    // sync re-applies (old_tool gone, declared catalog in).
    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "invoices_summary",
    ]);

    // The stored fingerprint advanced from the stale value to the
    // declared list's real fingerprint.
    const fp = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.registry.getToolsFingerprint, {}),
    );
    expect(fp).toBeTruthy();
    expect(fp).not.toBe("stale-fingerprint-A");
  });

  test("clearTools also clears the fingerprint so a later initialize re-syncs", async () => {
    const t = newTest();
    // First initialize syncs and stamps the fingerprint.
    await initialize(t);

    // Clear the registry (the documented escape hatch). Without clearing
    // the fingerprint too, the next initialize would skip the sync and
    // leave the registry empty.
    await t.run(async (ctx) => {
      await ctx.runMutation(components.mcpGateway.registry.clearAllTools, {});
    });

    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    // Registry was repopulated by the sync (not left empty).
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "invoices_summary",
    ]);
  });

  test("setOAuthConfig preserves the fingerprint (no forced re-sync)", async () => {
    const t = newTest();
    // First initialize stamps the fingerprint.
    await initialize(t);

    // An OAuth-config write must not drop the fingerprint.
    await t.run(async (ctx) => {
      await ctx.runMutation(components.mcpGateway.registry.setOAuthConfig, {
        authServerUrl: "https://idp.example.com/",
      });
    });

    // Inject out-of-band drift that does NOT touch the fingerprint.
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.summary);
      await ctx.runMutation(components.mcpGateway.registry.registerTool, {
        name: "drift_tool",
        description: "injected after setOAuthConfig",
        kind: "query",
        functionHandle: handle,
        inputSchema: { type: "object" },
        metadata: { public: true },
      });
    });

    // Second initialize: because setOAuthConfig preserved the fingerprint,
    // the sync is skipped and the drift survives. (If the fingerprint had
    // been dropped, this initialize would re-sync and wipe drift_tool.)
    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "drift_tool",
      "invoices_summary",
    ]);
  });
});

// =================================================================
// Tool protocol metadata (title / annotations / _meta /
// securitySchemes). These run against the component's real argument
// validators, unlike the mocked-component unit tests in
// src/client/*.test.ts. Convex `v.object` rejects unknown fields, so a
// field that reaches the registry write path without a matching
// validator entry fails here and only here.
// =================================================================
describe("tool protocol metadata", () => {
  const EXPECTED = {
    title: "Invoice summary",
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { "example.com/category": "invoices" },
    securitySchemes: [{ type: "noauth" }],
  };

  test("declarative sync stores it and tools/list advertises it", async () => {
    const t = newTest();
    // No registerDefaults: initialize reconciles the declared catalog
    // through replaceTools, the mutation whose validator must accept
    // protocolMetadata.
    const session = await initialize(t);

    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools).toEqual([
      expect.objectContaining({ name: "invoices_summary", ...EXPECTED }),
    ]);
  });

  test("imperative register stores it and tools/list advertises it", async () => {
    const t = newTest();
    // registerDefaults goes through gateway.register, a separate write
    // path from the declarative sync above.
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);

    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools).toEqual([
      expect.objectContaining({ name: "invoices_summary", ...EXPECTED }),
    ]);
  });

  test("registerTool accepts protocolMetadata and getTool round-trips it", async () => {
    const t = newTest();
    // The single-tool mutation is reachable from gateway.registerTool
    // and has its own argument validator, so it needs its own coverage.
    const stored = await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.summary);
      await ctx.runMutation(components.mcpGateway.registry.registerTool, {
        name: "solo_tool",
        description: "registered one at a time",
        kind: "query",
        functionHandle: handle,
        inputSchema: { type: "object" },
        protocolMetadata: EXPECTED,
      });
      return await ctx.runQuery(components.mcpGateway.registry.getTool, {
        name: "solo_tool",
      });
    });

    expect(stored?.protocolMetadata).toEqual(EXPECTED);
  });

  test("tools without protocol metadata stay free of the extra keys", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const tAdmin = t.withIdentity({
      subject: "carol",
      roles: ["finance.admin"],
    } as unknown as Parameters<typeof t.withIdentity>[0]) as ReturnType<
      typeof newTest
    >;
    const session = await initialize(tAdmin);

    const res = await rpc(tAdmin, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: { tools: Array<Record<string, unknown>> };
    };
    const listed = body.result.tools.find(
      (tool) => tool.name === "invoices_list",
    );
    expect(listed).toBeDefined();
    // An empty protocolMetadata object must not leak `title: undefined`
    // style keys onto the wire.
    for (const key of ["title", "annotations", "_meta", "securitySchemes"]) {
      expect(listed).not.toHaveProperty(key);
    }

    // ...and the row itself carries no empty `protocolMetadata` object,
    // so a tool that declares nothing stores nothing.
    const stored = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.registry.getTool, {
        name: "invoices_list",
      }),
    );
    expect(stored).not.toBeNull();
    expect(stored).not.toHaveProperty("protocolMetadata");
  });

  test("protocol metadata cannot shadow the registry's own columns", async () => {
    const t = newTest();
    // Only reachable by calling the component mutation directly, where
    // `protocolMetadata` is `v.any()` and the client-side whitelist in
    // `toolProtocolMetadata` is bypassed. tools/list must still report
    // the stored name and inputSchema, not the injected ones.
    //
    // Registered *after* initialize: initialize reconciles the declared
    // catalog through replaceTools, which would drop this row again.
    const session = await initialize(t);
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.summary);
      await ctx.runMutation(components.mcpGateway.registry.registerTool, {
        name: "spoof_probe",
        description: "the real description",
        kind: "query",
        functionHandle: handle,
        inputSchema: { type: "object" },
        protocolMetadata: {
          title: "Probe",
          name: "spoofed_tool",
          description: "spoofed description",
          inputSchema: { type: "string" },
        },
        metadata: { public: true },
      });
    });

    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: { tools: Array<Record<string, unknown>> };
    };
    const listed = body.result.tools.find(
      (tool) => tool.name === "spoof_probe",
    );
    expect(listed).toBeDefined();
    expect(listed?.description).toBe("the real description");
    expect(listed?.inputSchema).toEqual({ type: "object" });
    // The one non-colliding key still passes through.
    expect(listed?.title).toBe("Probe");
    expect(
      body.result.tools.find((tool) => tool.name === "spoofed_tool"),
    ).toBeUndefined();
  });
});

// =================================================================
// Resources: the example mounts a concrete resource (invoices://summary),
// an RFC 6570 template (invoice://{id}), a per-resource authorizer, opt-in
// read audit, and the subscription capability. These exercise the full
// resource surface through the host's /mcp/ route.
// =================================================================
describe("resources (host-mounted /mcp/)", () => {
  const AUTH = { authorization: "Bearer valid-userinfo-token" };
  const ADMIN = { authorization: "Bearer valid-admin-token" };

  test("initialize advertises the resource subscription capability", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    const body = (await res.json()) as {
      result: {
        capabilities: {
          resources?: { subscribe?: boolean; listChanged?: boolean };
        };
      };
    };
    expect(body.result.capabilities.resources).toEqual({
      subscribe: true,
      listChanged: true,
    });
  });

  test("resources/list requires auth and returns the summary resource", async () => {
    const t = newTest();
    const session = await initialize(t);

    const anon = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/list",
    });
    expect(
      ((await anon.json()) as { error?: { code: number } }).error?.code,
    ).toBe(-32001);

    const res = await rpc(
      t,
      session,
      { jsonrpc: "2.0", id: 3, method: "resources/list" },
      AUTH,
    );
    const body = (await res.json()) as {
      result: {
        resources: Array<{ uri: string; name: string; title?: string }>;
      };
    };
    expect(body.result.resources).toMatchObject([
      {
        uri: "invoices://summary",
        name: "invoice-summary",
        title: "Invoice summary",
      },
    ]);
  });

  test("resources/read returns the summary content stamped with the caller", async () => {
    const t = newTest();
    await t.mutation(api.invoices.seed, {});
    const session = await initialize(t);
    const res = await rpc(
      t,
      session,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "resources/read",
        params: { uri: "invoices://summary" },
      },
      AUTH,
    );
    const body = (await res.json()) as {
      result: { contents: Array<{ uri: string; text: string }> };
    };
    const parsed = JSON.parse(body.result.contents[0]!.text) as {
      total: number;
      caller: string;
    };
    expect(parsed.total).toBe(1);
    expect(parsed.caller).toBe("validator-resolved-sub");
  });

  test("resources/templates/list returns the invoice template", async () => {
    const t = newTest();
    const session = await initialize(t);
    const res = await rpc(
      t,
      session,
      { jsonrpc: "2.0", id: 5, method: "resources/templates/list" },
      AUTH,
    );
    const body = (await res.json()) as {
      result: {
        resourceTemplates: Array<{ uriTemplate: string; name: string }>;
      };
    };
    expect(body.result.resourceTemplates).toMatchObject([
      { uriTemplate: "invoice://{id}", name: "invoice" },
    ]);
  });

  test("template read of an invoice requires the finance.admin role", async () => {
    const t = newTest();
    const id = await t.mutation(api.invoices.seed, {});
    const session = await initialize(t);
    const uri = `invoice://${id}`;

    // Authenticated but non-admin → Forbidden.
    const denied = await rpc(
      t,
      session,
      { jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri } },
      AUTH,
    );
    expect(
      ((await denied.json()) as { error?: { code: number } }).error?.code,
    ).toBe(-32003);

    // Admin caller → content.
    const ok = await rpc(
      t,
      session,
      { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri } },
      ADMIN,
    );
    const body = (await ok.json()) as {
      result: { contents: Array<{ text: string }> };
    };
    const parsed = JSON.parse(body.result.contents[0]!.text) as {
      id: string;
      amount: number;
    };
    expect(parsed.id).toBe(id);
    expect(parsed.amount).toBe(42);
  });

  test("resources/subscribe is accepted for the session owner", async () => {
    const t = newTest();
    // Initialize WITH the Bearer so the session is owned by the caller;
    // resources/subscribe is identity-bound to the session owner.
    const initRes = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...AUTH,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    const session = initRes.headers.get("mcp-session-id")!;
    const res = await rpc(
      t,
      session,
      {
        jsonrpc: "2.0",
        id: 8,
        method: "resources/subscribe",
        params: { uri: "invoices://summary" },
      },
      AUTH,
    );
    const body = (await res.json()) as { result?: object; error?: object };
    expect(body.result).toEqual({});
    expect(body.error).toBeUndefined();
  });
});

// =================================================================
// MRTR end to end (modern, real crypto + one-time redemption): the
// gateway-side beforeCall state machine confirms, declines, re-asks,
// and blocks decline→accept replays; the Convex mutation stays
// MCP-unaware and idempotent on the injected continuation key.
// =================================================================

describe("MRTR (modern, e2e)", () => {
  const CAPS = { elicitation: { form: {} } };

  async function mrtrRpc(
    t: ReturnType<typeof newTest>,
    id: number,
    params: Record<string, unknown>,
  ): Promise<Response> {
    return await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "invoices_archiveAfterConfirmation",
        authorization: "Bearer valid-userinfo-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "invoices_archiveAfterConfirmation",
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": CAPS,
          },
          ...params,
        },
      }),
    });
  }

  type MrtrBody = {
    result?: {
      resultType?: string;
      requestState?: string;
      inputRequests?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: string }>;
      structuredContent?: unknown;
    };
    error?: { code: number; message: string };
  };

  async function seedInvoice(t: ReturnType<typeof newTest>) {
    return await t.run(async (ctx) =>
      ctx.db.insert("invoices", { status: "open", amount: 7 }),
    );
  }

  test("accept: confirmation round-trip, mutation runs once, replay is idempotent", async () => {
    const t = newTest();
    const invoiceId = await seedInvoice(t);

    const first = (await (
      await mrtrRpc(t, 1, { arguments: { id: invoiceId } })
    ).json()) as MrtrBody;
    expect(first.error, JSON.stringify(first.error)).toBeUndefined();
    expect(first.result?.resultType).toBe("input_required");
    expect(Object.keys(first.result?.inputRequests ?? {})).toEqual([
      "confirm",
    ]);
    // Nothing ran yet.
    expect(
      await t.run(async (ctx) => ctx.db.query("mrtrExecutions").collect()),
    ).toHaveLength(0);

    const accept = {
      arguments: { id: invoiceId },
      requestState: first.result!.requestState,
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
    };
    const accepted = (await (await mrtrRpc(t, 2, accept)).json()) as MrtrBody;
    expect(accepted.result?.isError).toBe(false);
    const text = accepted.result?.content?.[0]?.text ?? "";
    expect(text).toContain('"archived": true');

    // Byte-identical replay (client network retry): re-processes
    // deterministically, the keyed mutation does not double-apply.
    const replayed = (await (await mrtrRpc(t, 3, accept)).json()) as MrtrBody;
    expect(replayed.result?.isError).toBe(false);
    const executions = await t.run(async (ctx) =>
      ctx.db.query("mrtrExecutions").collect(),
    );
    expect(executions).toHaveLength(1);
  });

  test("a settled decline cannot be flipped through a forked sibling", async () => {
    const t = newTest();
    const invoiceId = await seedInvoice(t);

    const first = (await (
      await mrtrRpc(t, 1, { arguments: { id: invoiceId } })
    ).json()) as MrtrBody;
    const c1 = first.result!.requestState;

    // A state-only retry forks a second, independently sealed
    // continuation of the same chain while nothing is decided yet.
    const resumed = (await (
      await mrtrRpc(t, 2, { arguments: { id: invoiceId }, requestState: c1 })
    ).json()) as MrtrBody;
    const sibling = resumed.result!.requestState;
    expect(sibling).toBeDefined();
    expect(sibling).not.toBe(c1);

    // The user declines on the original continuation.
    const declined = (await (
      await mrtrRpc(t, 3, {
        arguments: { id: invoiceId },
        requestState: c1,
        inputResponses: { confirm: { action: "decline" } },
      })
    ).json()) as MrtrBody;
    expect(declined.result?.content?.[0]?.text).toBe(
      "Invoice was not archived.",
    );

    // The sibling is a different jti, so per-continuation redemption
    // has nothing to say about it. Only the chain claim stops it, and
    // this is the layer where the real component enforces that.
    const flipped = (await (
      await mrtrRpc(t, 4, {
        arguments: { id: invoiceId },
        requestState: sibling,
        inputResponses: {
          confirm: { action: "accept", content: { confirm: true } },
        },
      })
    ).json()) as MrtrBody;
    expect(flipped.error?.code).toBe(-32602);
    expect(
      await t.run(async (ctx) => ctx.db.query("mrtrExecutions").collect()),
    ).toHaveLength(0);
    expect(
      await t.run(async (ctx) => ctx.db.get("invoices", invoiceId)),
    ).toMatchObject({ status: "open" });
  });

  test("decline finishes gateway-side and cannot be replayed into an accept", async () => {
    const t = newTest();
    const invoiceId = await seedInvoice(t);

    const first = (await (
      await mrtrRpc(t, 1, { arguments: { id: invoiceId } })
    ).json()) as MrtrBody;
    const requestState = first.result!.requestState;

    const declined = (await (
      await mrtrRpc(t, 2, {
        arguments: { id: invoiceId },
        requestState,
        inputResponses: { confirm: { action: "decline" } },
      })
    ).json()) as MrtrBody;
    expect(declined.result?.content?.[0]?.text).toBe(
      "Invoice was not archived.",
    );
    // The mutation never ran.
    expect(
      await t.run(async (ctx) => ctx.db.query("mrtrExecutions").collect()),
    ).toHaveLength(0);

    // Replaying the SAME continuation with a different answer must not
    // flip the resolved decline into an accepted archive.
    const flipped = (await (
      await mrtrRpc(t, 3, {
        arguments: { id: invoiceId },
        requestState,
        inputResponses: {
          confirm: { action: "accept", content: { confirm: true } },
        },
      })
    ).json()) as MrtrBody;
    expect(flipped.error?.code).toBe(-32602);
    expect(flipped.error?.message).toMatch(/already used/);
    expect(
      await t.run(async (ctx) => ctx.db.query("mrtrExecutions").collect()),
    ).toHaveLength(0);
  });

  test("a malformed answer is asked again instead of erroring", async () => {
    const t = newTest();
    const invoiceId = await seedInvoice(t);
    const first = (await (
      await mrtrRpc(t, 1, { arguments: { id: invoiceId } })
    ).json()) as MrtrBody;

    const reasked = (await (
      await mrtrRpc(t, 2, {
        arguments: { id: invoiceId },
        requestState: first.result!.requestState,
        inputResponses: { unrelated: { action: "accept" } },
      })
    ).json()) as MrtrBody;
    expect(reasked.result?.resultType).toBe("input_required");

    // Answering the re-issued round completes the flow.
    const accepted = (await (
      await mrtrRpc(t, 3, {
        arguments: { id: invoiceId },
        requestState: reasked.result!.requestState,
        inputResponses: {
          confirm: { action: "accept", content: { confirm: true } },
        },
      })
    ).json()) as MrtrBody;
    expect(accepted.result?.isError).toBe(false);
  });
});

// =================================================================
// Bounded $ref resolution at registration: authored schemas may use
// local #/$defs/<name> references; the registry stores and advertises
// the inlined, self-contained schema, and the runtime Mcp-Param-*
// walk sees exactly what registration validated.
// =================================================================

describe("bounded $ref resolution (registration + advertisement)", () => {
  const authoredTool = {
    name: "regional_summary",
    description: "Summary pinned to a region routing header.",
    kind: "query" as const,
    functionReference: {},
    inputSchema: {
      type: "object",
      properties: { region: { $ref: "#/$defs/Region" } },
      $defs: {
        Region: { type: "string", "x-mcp-header": "region" },
      },
    },
    outputSchema: {
      type: "object",
      properties: { total: { $ref: "#/$defs/Total" } },
      $defs: { Total: { type: "number" } },
    },
    metadata: { public: true },
  };

  test("registerTool stores both schemas inlined, with $defs dropped", async () => {
    const t = newTest();
    const gateway = new McpGateway(components.mcpGateway);
    await t.run(async (ctx) => {
      await gateway.registerTool(ctx, {
        ...authoredTool,
        fn: api.invoices.summary,
      } as unknown as Parameters<typeof gateway.registerTool>[1]);
      const stored = await ctx.runQuery(
        components.mcpGateway.registry.listTools,
        {},
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]!.inputSchema).toEqual({
        type: "object",
        properties: {
          region: { type: "string", "x-mcp-header": "region" },
        },
      });
      expect(stored[0]!.outputSchema).toEqual({
        type: "object",
        properties: { total: { type: "number" } },
      });
    });
  });

  test("the advertised catalog serves the authored schema, keywords intact", async () => {
    const t = newTest();
    const gateway = new McpGateway(components.mcpGateway);
    // Initialize FIRST so the mount's declarative sync has already run;
    // the imperative upsert below then survives until the next sync.
    const session = await initialize(t);
    await t.run(async (ctx) => {
      await gateway.registerTool(ctx, {
        ...authoredTool,
        fn: api.invoices.summary,
      } as unknown as Parameters<typeof gateway.registerTool>[1]);
    });

    // tools/list advertises what the host authored, references and all,
    // per SEP-1613. Runtime Mcp-Param-* enforcement keeps walking the
    // STORED schema, which the test above proves is the inlined one (the
    // header-mismatch -32020 path is covered by the modern contract
    // tests), so a binding authored behind a $ref cannot silently vanish
    // between registration and enforcement even though the client sees
    // the reference.
    const list = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const listBody = (await list.json()) as {
      result: { tools: Array<{ name: string; inputSchema: unknown }> };
    };
    const advertised = listBody.result.tools.find(
      (tool) => tool.name === "regional_summary",
    );
    expect(advertised).toBeDefined();
    expect(advertised!.inputSchema).toEqual(authoredTool.inputSchema);
  });

  test("a tool declaring its JSON Schema dialect registers and advertises it", async () => {
    // Issue #48: `$schema` reached the registry write verbatim, and
    // Convex reserves field names starting with `$`, so registration
    // threw from inside the write and every request to the mount 500'd.
    const t = newTest();
    const gateway = new McpGateway(components.mcpGateway);
    const dialectTool = {
      ...authoredTool,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { region: { type: "string" } },
      },
      outputSchema: undefined,
    };
    const session = await initialize(t);
    await t.run(async (ctx) => {
      await gateway.registerTool(ctx, {
        ...dialectTool,
        fn: api.invoices.summary,
      } as unknown as Parameters<typeof gateway.registerTool>[1]);
      // Stored without the reserved keyword, which is what makes the
      // write legal at all.
      const stored = await ctx.runQuery(
        components.mcpGateway.registry.getTool,
        { name: "regional_summary" },
      );
      expect(stored!.inputSchema).toEqual({
        type: "object",
        properties: { region: { type: "string" } },
      });
    });

    const list = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const listBody = (await list.json()) as {
      result: { tools: Array<{ name: string; inputSchema: unknown }> };
    };
    expect(
      listBody.result.tools.find((tool) => tool.name === "regional_summary")
        ?.inputSchema,
    ).toEqual(dialectTool.inputSchema);
  });

  test("a cyclic schema fails registration loudly with the tool named", async () => {
    const t = newTest();
    const gateway = new McpGateway(components.mcpGateway);
    await t.run(async (ctx) => {
      await expect(
        gateway.registerTool(ctx, {
          ...authoredTool,
          inputSchema: {
            properties: { a: { $ref: "#/$defs/A" } },
            $defs: { A: { $ref: "#/$defs/A" } },
          },
          fn: api.invoices.summary,
        } as unknown as Parameters<typeof gateway.registerTool>[1]),
      ).rejects.toThrow(/"regional_summary" has an unresolvable inputSchema/);
    });
  });
});

// =================================================================
// MCP Tasks (io.modelcontextprotocol/tasks): task-augmented modern
// tools/call, owner-bound polling, cancellation, failure, and the
// legacy/non-negotiated rejections. Uses the built-in scheduled
// executor, driven by convex-test's scheduler controls.
// =================================================================

describe("MCP tasks (modern, e2e)", () => {
  // Several tests below drive the scheduler with fake timers. Restore them
  // here rather than at the end of each test: an assertion that fails
  // mid-test would otherwise leave fake timers installed for every later
  // test in this file, turning one real failure into a cascade.
  afterEach(() => {
    vi.useRealTimers();
  });

  const TASK_CAPS = { "io.modelcontextprotocol/tasks": {} };

  function statelessBody(
    id: number,
    method: string,
    params: Record<string, unknown>,
    clientCapabilities: Record<string, unknown> = TASK_CAPS,
  ) {
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
        },
      },
    });
  }

  // The main /mcp/ mount resolves identity via `resolveIdentity`
  // (userinfo-bridge mode), so modern callers authenticate with the
  // fixture Bearer tokens from http.ts, not `t.withIdentity`.
  const TOKENS: Record<string, string> = {
    alice: "valid-userinfo-token", // subject: validator-resolved-sub
    bob: "valid-admin-token", // subject: admin-resolved-sub
  };

  async function statelessRpc(
    t: ReturnType<typeof newTest>,
    id: number,
    method: string,
    params: Record<string, unknown>,
    options: {
      name?: string;
      clientCapabilities?: Record<string, unknown>;
      as?: keyof typeof TOKENS;
      path?: string;
    } = {},
  ): Promise<Response> {
    return await t.fetch(options.path ?? "/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(options.name !== undefined ? { "mcp-name": options.name } : {}),
        ...(options.as !== undefined
          ? { authorization: `Bearer ${TOKENS[options.as]}` }
          : {}),
      },
      body: statelessBody(id, method, params, options.clientCapabilities),
    });
  }

  async function startRecountTask(
    t: ReturnType<typeof newTest>,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await statelessRpc(
      t,
      1,
      "tools/call",
      { name: "invoices_recount", arguments: args, task: {} },
      { name: "invoices_recount", as: "alice" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { resultType: string; task: { taskId: string; status: string } };
      error?: unknown;
    };
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    expect(body.result.resultType).toBe("task");
    expect(body.result.task.status).toBe("working");
    return body.result.task.taskId;
  }

  async function getTask(
    t: ReturnType<typeof newTest>,
    taskId: string,
    as: keyof typeof TOKENS = "alice",
    path?: string,
  ) {
    const res = await statelessRpc(t, 9, "tasks/get", { taskId }, {
      name: taskId,
      as,
      path,
    });
    return (await res.json()) as {
      result?: {
        resultType: string;
        task: {
          status: string;
          result?: unknown;
          error?: { code: number; message: string };
          pollIntervalMs?: number;
        };
      };
      error?: { code: number; message: string };
    };
  }

  test("task-augmented call defers execution and completes on poll", async () => {
    // Fake timers keep the runAfter(0) executor pending until the test
    // releases it, making the "still working" assertion deterministic.
    vi.useFakeTimers();
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("invoices", { status: "open", amount: 1 });
      await ctx.db.insert("invoices", { status: "paid", amount: 2 });
    });

    const taskId = await startRecountTask(t);

    // Deferred: the mutation has not run yet, the task is polling-ready.
    const pending = await getTask(t, taskId);
    expect(pending.result?.task.status).toBe("working");
    expect(pending.result?.task.pollIntervalMs).toBe(2000);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    const done = await getTask(t, taskId);
    expect(done.result?.task.status).toBe("completed");
    // The stored result is the same CallToolResult a synchronous call
    // returns: renderable `content`, `structuredContent` because the tool
    // declares an outputSchema, and `isError`.
    expect(done.result?.task.result).toEqual({
      // Compact rather than pretty-printed: the task envelope is derived
      // inside a Convex query on every poll, where indentation that
      // multiplies with nesting depth would eventually make a completed
      // task unreadable.
      content: [{ type: "text", text: '{"total":2}' }],
      structuredContent: { total: 2 },
      isError: false,
    });

    // Lifecycle audit: create + complete, no payloads.
    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, { taskId }),
    );
    expect(entries.map((e) => e.taskOperation).sort()).toEqual([
      "complete",
      "create",
    ]);
    expect(entries.every((e) => e.args === null)).toBe(true);

    // The execution itself goes through dispatch.runTool, so a task-run
    // tool leaves the SAME entryType: "tool" row a synchronous call does.
    // The task rows above are bookkeeping around it, not a replacement.
    const toolEntries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "invoices_recount",
      }),
    );
    expect(
      toolEntries.filter((e) => e.entryType === "tool"),
    ).toMatchObject([
      {
        entryType: "tool",
        toolName: "invoices_recount",
        toolKind: "mutation",
        outcome: "allowed",
        identitySubject: "validator-resolved-sub",
      },
    ]);
  });

  test("an MRTR-gated task tool negotiates first, then inherits the chain key", async () => {
    vi.useFakeTimers();
    try {
      const t = newTest();
      const invoiceId = await t.run(async (ctx) =>
        ctx.db.insert("invoices", { status: "open", amount: 7 }),
      );

      // Round 1: the hook asks for confirmation. No task row is created:
      // MRTR owns the negotiation until it approves.
      const first = (await (
        await statelessRpc(
          t,
          40,
          "tools/call",
          {
            name: "invoices_archiveAfterConfirmation",
            arguments: { id: invoiceId },
            task: {},
          },
          {
            name: "invoices_archiveAfterConfirmation",
            as: "alice",
            clientCapabilities: {
              "io.modelcontextprotocol/tasks": {},
              elicitation: { form: {} },
            },
          },
        )
      ).json()) as {
        result: { resultType: string; requestState: string };
      };
      expect(first.result.resultType).toBe("input_required");
      // No durable task yet: a `create` lifecycle row is written in the
      // same mutation as the task row, so its absence proves none exists.
      expect(
        await t.run(async (ctx) =>
          ctx.runQuery(components.mcpGateway.audit.listEntries, {
            entryType: "task",
          }),
        ),
      ).toHaveLength(0);

      // Round 2: the approved continuation becomes a task.
      const second = (await (
        await statelessRpc(
          t,
          41,
          "tools/call",
          {
            name: "invoices_archiveAfterConfirmation",
            arguments: { id: invoiceId },
            task: {},
            requestState: first.result.requestState,
            inputResponses: {
              confirm: { action: "accept", content: { confirm: true } },
            },
          },
          {
            name: "invoices_archiveAfterConfirmation",
            as: "alice",
            clientCapabilities: {
              "io.modelcontextprotocol/tasks": {},
              elicitation: { form: {} },
            },
          },
        )
      ).json()) as { result: { resultType: string; task: { taskId: string } } };
      expect(second.result.resultType).toBe("task");
      const taskId = second.result.task.taskId;

      const row = (await t.run(async (ctx) =>
        ctx.runQuery(components.mcpGateway.tasks.getTaskInternal, { taskId }),
      )) as { idempotencyKey: string; mrtrApproved?: boolean };
      // The hook approved this row, which is what lets the executor run a
      // tool the registry marks mrtrGated.
      expect(row.mrtrApproved).toBe(true);

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const done = await getTask(t, taskId);
      expect(done.result?.task.status).toBe("completed");
      // This tool declares no `returns`, so it advertises no outputSchema
      // and its task result must carry no `structuredContent` either. The
      // synchronous path is asserted the same way elsewhere; that symmetry
      // is the whole point of wrapping in the executor.
      const envelope = done.result!.task.result as Record<string, unknown>;
      expect(envelope.isError).toBe(false);
      expect(Array.isArray(envelope.content)).toBe(true);
      expect("structuredContent" in envelope).toBe(false);

      // The mutation is MCP-unaware: it only ever sees `continuationKey`.
      // That value must be the TASK ROW's key, or a replayed continuation
      // (which legitimately creates a second task) would double-archive.
      const executions = await t.run(async (ctx) =>
        ctx.db.query("mrtrExecutions").collect(),
      );
      expect(executions).toHaveLength(1);
      expect(executions[0]!.key).toBe(row.idempotencyKey);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a value that would inflate when wrapped survives the executor", async () => {
    vi.useFakeTimers();
    try {
      const t = newTest();
      // End to end through the real executor, which is the path that had no
      // coverage when the previous design stored the envelope: a legal value
      // whose wrapped form is several times larger must complete, not fail
      // after the tool has committed.
      const taskId = await startRecountTask(t, { padResult: 200 * 1024 });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const done = await getTask(t, taskId);
      expect(done.result?.task.status).toBe("completed");
      const envelope = done.result!.task.result as {
        content: Array<{ text: string }>;
        structuredContent: { pad?: string };
      };
      expect(envelope.structuredContent.pad).toHaveLength(200 * 1024);
      expect(envelope.content[0]!.text.length).toBeGreaterThan(200 * 1024);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an oversized tool value fails the task, naming the documented cap", async () => {
    vi.useFakeTimers();
    try {
      const t = newTest();
      // 256 KiB is the cap on the TOOL'S value. Measuring the envelope
      // against it instead would reject legal results, since the envelope
      // repeats the value (escaped text plus structuredContent).
      const taskId = await startRecountTask(t, {
        padResult: 256 * 1024 + 1,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const failed = await getTask(t, taskId);
      expect(failed.result?.task.status).toBe("failed");
      expect(failed.result?.task.error?.message).toMatch(/262144 serialized/);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an unrepresentable tool value is named as that, not as a size", async () => {
    vi.useFakeTimers();
    try {
      const t = newTest();
      // The tool SUCCEEDS and commits, then returns a `v.int64()` the
      // envelope cannot carry. The executor measures the value after the
      // fact, so this is the one place a seven-byte result gets refused:
      // reporting it against the 256 KiB cap would send an operator
      // hunting for a size problem that does not exist.
      const taskId = await startRecountTask(t, { bigintResult: true });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const failed = await getTask(t, taskId);
      expect(failed.result?.task.status).toBe("failed");
      expect(failed.result?.task.error?.message).toMatch(/cannot be serialized/);
      expect(failed.result?.task.error?.message).not.toMatch(/262144/);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the task result is byte-identical to the synchronous result", async () => {
    vi.useFakeTimers();
    try {
      const t = newTest();
      await t.run(async (ctx) => {
        await ctx.db.insert("invoices", { status: "open", amount: 1 });
      });

      // Same tool, same args, both paths.
      const taskId = await startRecountTask(t);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const viaTask = (await getTask(t, taskId)).result?.task.result;

      const sync = (await (
        await statelessRpc(
          t,
          50,
          "tools/call",
          { name: "invoices_recount", arguments: {} },
          { name: "invoices_recount", as: "alice" },
        )
      ).json()) as {
        result: {
          content: unknown;
          structuredContent: unknown;
          isError: boolean;
        };
      };
      // The whole point of routing task execution through dispatch.runTool:
      // a client cannot tell which path produced the result, so its
      // rendering and its outputSchema validation work either way.
      //
      // Structural rather than byte equality: the task path serializes the
      // text block compactly on purpose (see callToolResult), because that
      // envelope is materialized in a query on every poll. Same values,
      // same keys, different whitespace.
      const task = viaTask as {
        content: Array<{ type: string; text: string }>;
        structuredContent: unknown;
        isError: boolean;
      };
      const inline = sync.result as unknown as {
        content: Array<{ type: string; text: string }>;
        structuredContent: unknown;
        isError: boolean;
      };
      expect(task.structuredContent).toEqual(inline.structuredContent);
      expect(task.isError).toBe(inline.isError);
      expect(task.content.map((c) => c.type)).toEqual(
        inline.content.map((c) => c.type),
      );
      expect(JSON.parse(task.content[0]!.text)).toEqual(
        JSON.parse(inline.content[0]!.text),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failing tool surfaces on the polled task, sanitized", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const taskId = await startRecountTask(t, { failWith: "Recount exploded" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    const failed = await getTask(t, taskId);
    // A tool that ran and reported an error is a COMPLETED call whose
    // result says isError, exactly as on the synchronous path: the model
    // can read it and retry. `failed` is reserved for the task itself
    // failing (unknown tool, kind drift, a dispatch that never ran).
    expect(failed.result?.task.status).toBe("completed");
    const errorResult = failed.result?.task.result as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    expect(errorResult.isError).toBe(true);
    // ConvexError is the deliberate channel, so the text passes verbatim.
    expect(errorResult.content[0]!.text).toBe("Recount exploded");
  });

  test("a non-ConvexError failure is generic on the wire, verbose in the audit row", async () => {
    vi.useFakeTimers();
    try {
      const t = newTest();
      const taskId = await startRecountTask(t, {
        failPlain: "postgres://user:pw@host exploded",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const failed = await getTask(t, taskId);
      expect(failed.result?.task.status).toBe("completed");
      const sanitized = failed.result?.task.result as {
        content: Array<{ text: string }>;
        isError: boolean;
      };
      expect(sanitized.isError).toBe(true);
      // The polling client must not receive arbitrary exception text: it
      // is durable, owner-readable, and can quote credentials.
      expect(sanitized.content[0]!.text).toBe("Tool execution failed");
      expect(sanitized.content[0]!.text).not.toMatch(/postgres/);
      // The operator still gets the full text, on the tool row.
      const toolRows = await t.run(async (ctx) =>
        ctx.runQuery(components.mcpGateway.audit.listEntries, {
          toolName: "invoices_recount",
        }),
      );
      expect(
        toolRows.some(
          (row) =>
            row.entryType === "tool" &&
            (row.errorMessage ?? "").includes("postgres"),
        ),
      ).toBe(true);
      // ...and the task lifecycle row keeps its no-payload contract.
      const taskRows = await t.run(async (ctx) =>
        ctx.runQuery(components.mcpGateway.audit.listEntries, { taskId }),
      );
      expect(
        taskRows.every((row) => !(row.errorMessage ?? "").includes("postgres")),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancellation before execution wins; repeat cancel is idempotent", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const taskId = await startRecountTask(t);

    const cancel = await statelessRpc(
      t,
      2,
      "tasks/update",
      { taskId, action: "cancel" },
      { name: taskId, as: "alice" },
    );
    const cancelBody = (await cancel.json()) as {
      result: { task: { status: string } };
    };
    expect(cancelBody.result.task.status).toBe("cancelled");

    // The scheduled executor observes the cancel and leaves the row alone.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    const after = await getTask(t, taskId);
    expect(after.result?.task.status).toBe("cancelled");
    expect(after.result?.task.result).toBeUndefined();

    const repeat = await statelessRpc(
      t,
      3,
      "tasks/update",
      { taskId, action: "cancel" },
      { name: taskId, as: "alice" },
    );
    const repeatBody = (await repeat.json()) as {
      result: { task: { status: string } };
    };
    expect(repeatBody.result.task.status).toBe("cancelled");
  });

  test("tasks never leak across callers", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const taskId = await startRecountTask(t);
    const foreign = await getTask(t, taskId, "bob");
    expect(foreign.result).toBeUndefined();
    expect(foreign.error?.code).toBe(-32602);
    expect(foreign.error?.message).toContain("Unknown task");
    // Drain the pending executor so it cannot leak across tests.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
  });

  test("legacy requests cannot use tasks", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const tAuth = t.withIdentity({ subject: "alice" }) as ReturnType<
      typeof newTest
    >;
    const session = await initialize(tAuth);

    // Task-augmented legacy call: rejected loudly, never run silently.
    const call = await rpc(tAuth, session, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "invoices_recount", arguments: {}, task: {} },
    });
    const callBody = (await call.json()) as {
      error?: { code: number; message: string };
    };
    expect(callBody.error?.code).toBe(-32602);
    expect(callBody.error?.message).toMatch(/2026-07-28/);

    // Legacy task methods are unknown methods.
    const poll = await rpc(tAuth, session, {
      jsonrpc: "2.0",
      id: 5,
      method: "tasks/get",
      params: { taskId: "whatever" },
    });
    const pollBody = (await poll.json()) as { error?: { code: number } };
    expect(pollBody.error?.code).toBe(-32601);
  });

  test("negotiation gates: capability, tool support, identity", async () => {
    const t = newTest();

    // Client did not declare the tasks capability.
    const noCap = await statelessRpc(
      t,
      6,
      "tools/call",
      { name: "invoices_recount", arguments: {}, task: {} },
      { name: "invoices_recount", clientCapabilities: {}, as: "alice" },
    );
    const noCapBody = (await noCap.json()) as {
      error?: { code: number; message: string };
    };
    expect(noCapBody.error?.code).toBe(-32602);
    expect(noCapBody.error?.message).toMatch(/client capability/);

    // Tool without taskSupport.
    const wrongTool = await statelessRpc(
      t,
      7,
      "tools/call",
      { name: "invoices_markPaid", arguments: {}, task: {} },
      { name: "invoices_markPaid", as: "bob" },
    );
    const wrongToolBody = (await wrongTool.json()) as {
      error?: { code: number; message: string };
    };
    expect(wrongToolBody.error?.code).toBe(-32602);
    expect(wrongToolBody.error?.message).toMatch(/does not support task/);

    // Anonymous caller cannot own a task.
    const anonymous = await statelessRpc(
      t,
      8,
      "tools/call",
      { name: "invoices_recount", arguments: {}, task: {} },
      { name: "invoices_recount" },
    );
    const anonymousBody = (await anonymous.json()) as {
      error?: { code: number };
    };
    expect(anonymousBody.error?.code).toBe(-32001);

    // Anonymous polling is rejected before any lookup.
    const anonymousPoll = await statelessRpc(
      t,
      9,
      "tasks/get",
      { taskId: "whatever" },
      { name: "whatever" },
    );
    expect(
      ((await anonymousPoll.json()) as { error?: { code: number } }).error
        ?.code,
    ).toBe(-32001);
  });

  test("a deeply nested task args value is a clean error, not a 500", async () => {
    const t = newTest();
    // Past the handler's depth bound (64) but shallow enough that the
    // request body itself serializes/parses everywhere: the guard walks
    // with an explicit stack and rejects before createTask's
    // serialization could overflow into an unhandled error. (A truly
    // stack-overflowing depth can't be sent over the wire at all, since
    // building the JSON body would overflow first.)
    let deep: unknown = 0;
    for (let i = 0; i < 200; i++) deep = [deep];
    const res = await statelessRpc(
      t,
      1,
      "tools/call",
      { name: "invoices_recount", arguments: { deep }, task: {} },
      { name: "invoices_recount", as: "alice" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toMatch(/nest too deeply/);
  });

  test("discovery and catalog advertise tasks only when configured", async () => {
    const t = newTest();
    const discover = await statelessRpc(t, 10, "server/discover", {}, { as: "alice" });
    const discoverBody = (await discover.json()) as {
      result: { capabilities: Record<string, unknown> };
    };
    expect(
      discoverBody.result.capabilities["io.modelcontextprotocol/tasks"],
    ).toEqual({ pollIntervalMs: 2000 });

    const list = await statelessRpc(t, 11, "tools/list", {}, { as: "alice" });
    const listBody = (await list.json()) as {
      result: {
        tools: Array<{ name: string; execution?: { taskSupport?: string } }>;
      };
    };
    const recount = listBody.result.tools.find(
      (tool) => tool.name === "invoices_recount",
    );
    expect(recount?.execution).toEqual({ taskSupport: "optional" });
    const plainTool = listBody.result.tools.find(
      (tool) => tool.name === "invoices_list",
    );
    expect(plainTool?.execution).toBeUndefined();
  });
});

// =================================================================
// Host-executed MCP tasks (the @convex-dev/workflow integration shape):
// the /mcp-host-tasks/ mount pauses for confirmation via
// requireTaskInput, resumes through onInputResponses, and keys the side
// effect on the task's idempotency key. Exercises the input_required
// round-trip end to end without a protocol session.
// =================================================================

describe("MCP tasks (host executor, e2e)", () => {
  // Several tests below drive the scheduler with fake timers. Restore them
  // here rather than at the end of each test: an assertion that fails
  // mid-test would otherwise leave fake timers installed for every later
  // test in this file, turning one real failure into a cascade.
  afterEach(() => {
    vi.useRealTimers();
  });

  const PATH = "/mcp-host-tasks/";
  const TASK_CAPS = { "io.modelcontextprotocol/tasks": {} };

  async function hostRpc(
    t: ReturnType<typeof newTest>,
    id: number,
    method: string,
    params: Record<string, unknown>,
    options: { name?: string } = {},
  ): Promise<Response> {
    return await t.fetch(PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        authorization: "Bearer valid-userinfo-token",
        ...(options.name !== undefined ? { "mcp-name": options.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": TASK_CAPS,
          },
        },
      }),
    });
  }

  async function startBulkTask(t: ReturnType<typeof newTest>) {
    const res = await hostRpc(
      t,
      1,
      "tools/call",
      { name: "invoices_bulkMarkPaid", arguments: {}, task: {} },
      { name: "invoices_bulkMarkPaid" },
    );
    const body = (await res.json()) as {
      result: { resultType: string; task: { taskId: string } };
      error?: unknown;
    };
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    expect(body.result.resultType).toBe("task");
    return body.result.task.taskId;
  }

  async function pollTask(t: ReturnType<typeof newTest>, taskId: string) {
    const res = await hostRpc(t, 2, "tasks/get", { taskId }, { name: taskId });
    return (
      (await res.json()) as {
        result?: {
          task: {
            status: string;
            inputRequests?: Record<string, unknown>;
            inputRound?: number;
            result?: unknown;
            error?: { message: string };
          };
        };
      }
    ).result?.task;
  }

  async function answer(
    t: ReturnType<typeof newTest>,
    taskId: string,
    action: string,
    inputRound = 1,
  ) {
    return await hostRpc(
      t,
      3,
      "tasks/update",
      {
        taskId,
        inputResponses: { confirm: { action, content: { confirm: true } } },
        inputRound,
      },
      { name: taskId },
    );
  }

  test("input_required round-trip: confirm, execute once, complete", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("invoices", { status: "open", amount: 1 });
      await ctx.db.insert("invoices", { status: "open", amount: 2 });
      await ctx.db.insert("invoices", { status: "paid", amount: 3 });
    });

    const taskId = await startBulkTask(t);

    // The executor paused the task before doing any work.
    const pending = await pollTask(t, taskId);
    expect(pending?.status).toBe("input_required");
    expect(Object.keys(pending?.inputRequests ?? {})).toEqual(["confirm"]);
    // The descriptor carries the round the client must echo back.
    expect(pending?.inputRound).toBe(1);
    const untouched = await t.run(async (ctx) =>
      (await ctx.db.query("invoices").collect()).filter(
        (invoice) => invoice.status === "open",
      ),
    );
    expect(untouched).toHaveLength(2);

    // Accepting runs the keyed mutation and completes the task.
    const accepted = await answer(t, taskId, "accept");
    expect(accepted.status).toBe(200);
    const done = await pollTask(t, taskId);
    expect(done?.status).toBe("completed");
    // The host executor stores the same CallToolResult envelope as the
    // built-in one, so a client reads both identically.
    // No structuredContent: this tool advertises no outputSchema, and the
    // component derives that from the registry rather than trusting the
    // host to pass a flag.
    expect(done?.result).toEqual({
      content: [{ type: "text", text: '{"updated":2}' }],
      isError: false,
    });

    // Idempotency: re-sending the same responses re-fires the hook
    // (at-least-once), but the keyed side effect does not double-apply
    // and the completed outcome stands.
    const repeat = await answer(t, taskId, "accept");
    expect(repeat.status).toBe(200);
    const still = await pollTask(t, taskId);
    expect(still?.status).toBe("completed");
    expect(
      (still?.result as { content?: Array<{ text: string }> } | undefined)
        ?.content?.[0]?.text,
    ).toContain('"updated":2');
    const executions = await t.run(async (ctx) =>
      ctx.db.query("taskExecutions").collect(),
    );
    expect(executions).toHaveLength(1);
  });

  test("a declined confirmation completes without isError or side effects", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("invoices", { status: "open", amount: 1 });
    });
    const taskId = await startBulkTask(t);
    await answer(t, taskId, "decline");
    const declined = await pollTask(t, taskId);
    // A decline completes the task: the negotiation succeeded and its
    // outcome was negative. Not `isError`, which is for a call that ran and
    // failed, and which the synchronous MRTR path also withholds for the
    // same decline (convex/mcp.ts uses completeCall({ isError: false })).
    // Both sides of the example have to answer this the same way.
    expect(declined?.status).toBe("completed");
    const result = declined?.result as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toBe("Confirmation declined.");
    const open = await t.run(async (ctx) =>
      (await ctx.db.query("invoices").collect()).filter(
        (invoice) => invoice.status === "open",
      ),
    );
    expect(open).toHaveLength(1);
  });

  test("mount scope isolates the two mounts' tasks", async () => {
    const t = newTest();
    const taskId = await startBulkTask(t);
    // The host-tasks mount owns this task (scope "host-tasks"). The main
    // mount resolves the SAME subject from the same fixture token, so
    // before scoping it could poll, cancel, and answer this task even
    // though its own executor knows nothing about it.
    //
    // Note what this does and does not pin: the refusal comes from the
    // scope MISMATCH, which exists whether or not the main mount sets its
    // own `scope`. So this test protects `scope: "host-tasks"`, not
    // `scope: "main"`, which is defence in depth against a future
    // third, unscoped mount, and no two-mount topology can observe it.
    const fromOtherMount = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tasks/get",
        "mcp-name": taskId,
        authorization: "Bearer valid-userinfo-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 60,
        method: "tasks/get",
        params: {
          taskId,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": TASK_CAPS,
          },
        },
      }),
    });
    const body = (await fromOtherMount.json()) as {
      error?: { code: number; message: string };
    };
    // Answered exactly like an unknown id, so the isolation does not leak
    // that the task exists.
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toMatch(/Unknown task/);

    // Its own mount still sees it.
    const own = (await (
      await hostRpc(t, 61, "tasks/get", { taskId }, { name: taskId })
    ).json()) as { result?: { task: { status: string } } };
    expect(own.result?.task.status).toBe("input_required");
  });

  test("a synchronous call of the task-only tool refuses to run", async () => {
    const t = newTest();
    const res = await hostRpc(
      t,
      4,
      "tools/call",
      { name: "invoices_bulkMarkPaid", arguments: {} },
      { name: "invoices_bulkMarkPaid" },
    );
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/must be invoked as an MCP task/);
  });
});

describe("conformance fixtures (MCP_CONFORMANCE mount)", () => {
  // The conformance mount is the one place `anonymousResources` is set, and
  // it is gated on an env var that no test sets, so none of this is
  // otherwise exercised by `pnpm test`. What it protects is an external
  // suite whose failure mode is invisible here: if the anonymous branch
  // ever denied a fixture, `resources-list` would come back empty, and if
  // it denied with an `unauth`-shaped reason the gateway would answer 401
  // instead of the catalog.
  test("the anonymous branch allows every fixture, and never asks for a login", async () => {
    const anonymous = (
      resourceUri: string,
      operation: "list" | "templates_list" | "read",
      resourceMetadata: unknown = null,
    ) =>
      authorizeResource({} as never, {
        mode: "resource_anonymous",
        operation,
        resourceUri,
        resourceMetadata,
        identity: null,
      });

    for (const resource of conformanceResources) {
      // Layer one: the fixtures carry `metadata: { public: true }`.
      expect(
        await anonymous(resource.resource.uri, "list", resource.resource.metadata),
      ).toEqual({ allowed: true });
      // Layer two: the `test://` scheme, which is what a read of an
      // unregistered URI relies on, since a read carries no metadata.
      expect(await anonymous(resource.resource.uri, "read")).toEqual({
        allowed: true,
      });
    }
    for (const provider of conformanceResourceTemplates) {
      expect(
        await anonymous(provider.template.uriTemplate, "templates_list"),
      ).toEqual({ allowed: true });
    }
    // SEP-2164 wants the not-found answer, so an unknown `test://` URI has
    // to reach resolution rather than stopping at a 403.
    expect(
      await anonymous("test://nonexistent-resource-for-conformance-testing", "read"),
    ).toEqual({ allowed: true });

    // Layer three: nothing outside the scheme is public, and the refusal
    // is deliberately NOT `unauth`-shaped, so an empty list answers 200
    // rather than challenging.
    const refused = await anonymous("docs://private", "list");
    expect(refused.allowed).toBe(false);
    expect(refused.reason ?? "").not.toMatch(/^unauth/i);
  });
});
