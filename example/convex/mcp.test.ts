/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { createFunctionHandle, type FunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema.js";
import { api, components, internal } from "./_generated/api.js";

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
      result: { tools: Array<{ name: string }> };
    };
    // alice has no admin role → markPaid is hidden, list + summary +
    // whoami visible (whoami is identity-gated but alice is authenticated).
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "invoices_list",
      "invoices_summary",
      "invoices_whoami",
    ]);
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
      "invoices_list",
      "invoices_markPaid",
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
