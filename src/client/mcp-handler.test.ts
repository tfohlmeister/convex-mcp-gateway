import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  defineMcpResource,
  defineMcpResourceTemplate,
  McpGateway,
  type McpServerInfo,
} from "./index.js";
import {
  describeAnnotationsProblem,
  describeIconsProblem,
  describeResourceContentsProblem,
  describeResourceProblem,
  describeResourceTemplateProblem,
  describeServerInfoProblem,
  handleMcpRequest,
  type McpResourceProvider,
  type McpResourceTemplateProvider,
} from "./mcp-handler.js";

function createComponent() {
  return {
    sessions: {
      createSession: Symbol("createSession"),
      getSession: Symbol("getSession"),
      touchSession: Symbol("touchSession"),
      subscribeResource: Symbol("subscribeResource"),
      unsubscribeResource: Symbol("unsubscribeResource"),
    },
    registry: {
      getOAuthConfig: Symbol("getOAuthConfig"),
      listTools: Symbol("listTools"),
      getTool: Symbol("getTool"),
      listResources: Symbol("listResources"),
      getResourcesFingerprint: Symbol("getResourcesFingerprint"),
      replaceResources: Symbol("replaceResources"),
      listResourceTemplates: Symbol("listResourceTemplates"),
      getResourceTemplatesFingerprint: Symbol(
        "getResourceTemplatesFingerprint",
      ),
      replaceResourceTemplates: Symbol("replaceResourceTemplates"),
    },
    audit: {
      recordResourceEntry: Symbol("recordResourceEntry"),
    },
    dispatch: {
      runTool: Symbol("runTool"),
      recordAuthDenial: Symbol("recordAuthDenial"),
    },
  } as unknown as ComponentApi;
}

type RegisteredTool = {
  name: string;
  description: string;
  kind: "query" | "mutation" | "action";
  functionHandle: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  protocolMetadata?: Record<string, unknown>;
};

function createCtx(component: ComponentApi, tools: RegisteredTool[] = []) {
  // What `dispatch.runTool` answers. Tests that exercise a dispatch set
  // this; everything else never reaches it.
  let dispatchResult: unknown = {
    ok: false as const,
    error: { code: -32000, message: "no dispatch result configured" },
  };
  let resourcesFingerprint: string | null = null;
  let resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    metadata?: unknown;
  }> = [];
  const resourceAuditEntries: Record<string, unknown>[] = [];
  const subscriptions = new Map<string, Set<string>>();
  let templatesFingerprint: string | null = null;
  let resourceTemplates: Array<{
    uriTemplate: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    annotations?: unknown;
    icons?: unknown;
  }> = [];
  const sessions = new Map<
    string,
    {
      sessionId: string;
      protocolVersion: string;
      clientCapabilities?: Record<string, unknown>;
      identitySubject: string | null;
    }
  >();

  return {
    sessions,
    ctx: {
      runQuery: async (ref: unknown, args: Record<string, unknown>) => {
        if (ref === component.sessions.getSession) {
          return sessions.get(String(args.sessionId)) ?? null;
        }
        if (ref === component.registry.getOAuthConfig) {
          return null;
        }
        if (ref === component.registry.listTools) {
          return tools;
        }
        if (ref === component.registry.getTool) {
          return tools.find((tool) => tool.name === String(args.name)) ?? null;
        }
        if (ref === component.registry.listResources) {
          return resources;
        }
        if (ref === component.registry.getResourcesFingerprint) {
          return resourcesFingerprint;
        }
        if (ref === component.registry.listResourceTemplates) {
          return resourceTemplates;
        }
        if (ref === component.registry.getResourceTemplatesFingerprint) {
          return templatesFingerprint;
        }
        throw new Error("unexpected query");
      },
      runMutation: async (ref: unknown, args: Record<string, unknown>) => {
        if (ref === component.sessions.createSession) {
          sessions.set(String(args.sessionId), {
            sessionId: String(args.sessionId),
            protocolVersion: String(args.protocolVersion),
            clientCapabilities: args.clientCapabilities as
              | Record<string, unknown>
              | undefined,
            identitySubject:
              typeof args.identitySubject === "string"
                ? args.identitySubject
                : null,
          });
          return args.sessionId;
        }
        if (ref === component.sessions.touchSession) {
          return sessions.has(String(args.sessionId));
        }
        if (ref === component.registry.replaceResources) {
          const incoming = args.resources as Array<Record<string, unknown>>;
          // Mirror the component's strict v.object validator: the registry
          // accepts only these catalog fields. This guards against runtime-
          // only fields (title/annotations/size) leaking into the descriptor
          // that is persisted, which the real Convex validator would reject.
          const allowed = new Set([
            "uri",
            "name",
            "description",
            "mimeType",
            "metadata",
          ]);
          for (const resource of incoming) {
            for (const key of Object.keys(resource)) {
              if (!allowed.has(key)) {
                throw new Error(
                  `replaceResources received unexpected field "${key}"`,
                );
              }
            }
          }
          resources = incoming.map((resource) => ({
            ...resource,
          })) as typeof resources;
          resourcesFingerprint =
            typeof args.fingerprint === "string" ? args.fingerprint : null;
          return null;
        }
        if (ref === component.registry.replaceResourceTemplates) {
          const incoming = args.templates as Array<Record<string, unknown>>;
          // Mirror the component's strict v.object validator: reject any
          // field outside the persisted template shape.
          const allowed = new Set([
            "uriTemplate",
            "name",
            "title",
            "description",
            "mimeType",
            "annotations",
            "icons",
          ]);
          for (const template of incoming) {
            for (const key of Object.keys(template)) {
              if (!allowed.has(key)) {
                throw new Error(
                  `replaceResourceTemplates received unexpected field "${key}"`,
                );
              }
            }
          }
          resourceTemplates = incoming.map((template) => ({
            ...template,
          })) as typeof resourceTemplates;
          templatesFingerprint =
            typeof args.fingerprint === "string" ? args.fingerprint : null;
          return null;
        }
        if (ref === component.audit.recordResourceEntry) {
          resourceAuditEntries.push({ ...args });
          return "audit-id";
        }
        if (ref === component.sessions.subscribeResource) {
          const sessionId = String(args.sessionId);
          const uri = String(args.uri);
          const set = subscriptions.get(sessionId) ?? new Set<string>();
          if (set.has(uri)) return "exists";
          set.add(uri);
          subscriptions.set(sessionId, set);
          return "subscribed";
        }
        if (ref === component.sessions.unsubscribeResource) {
          const set = subscriptions.get(String(args.sessionId));
          return set ? set.delete(String(args.uri)) : false;
        }
        throw new Error("unexpected mutation");
      },
      runAction: async (ref: unknown) => {
        if (ref === component.dispatch.runTool) {
          return dispatchResult;
        }
        throw new Error("unexpected action");
      },
      auth: {
        getUserIdentity: async () => ({
          subject: "user-1",
          email: "user@example.com",
        }),
      },
    },
    get resources() {
      return resources;
    },
    get subscriptions() {
      return subscriptions;
    },
    get resourceTemplates() {
      return resourceTemplates;
    },
    get templatesFingerprint() {
      return templatesFingerprint;
    },
    resourceAuditEntries,
    setDispatchResult(value: unknown) {
      dispatchResult = value;
    },
  };
}

function jsonRpcRequest(
  body: Record<string, unknown>,
  sessionId?: string,
): Request {
  return new Request("https://app.example.com/mcp/", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
}

function statelessJsonRpcRequest(body: Record<string, unknown>): Request {
  const method = String(body.method);
  const params = (body.params ?? {}) as Record<string, unknown>;
  const name =
    method === "tools/call"
      ? params.name
      : method === "resources/read"
        ? params.uri
        : undefined;
  return new Request("https://app.example.com/mcp/", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(typeof name === "string" && /^[\x20-\x7e]+$/.test(name)
        ? { "mcp-name": name }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...body,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "mcp-handler-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

function withHeaders(
  request: Request,
  additions: Record<string, string>,
): Request {
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(additions)) {
    headers.set(name, value);
  }
  return new Request(request, { headers });
}

async function readJson(response: Response) {
  return (await response.json()) as {
    id?: number | string | null;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

describe("handleMcpRequest metadata and resources", () => {
  test("serves stateless modern discovery without creating a session", async () => {
    const component = createComponent();
    const state = createCtx(component);

    const response = await handleMcpRequest(
      state.ctx,
      statelessJsonRpcRequest({ id: 1, method: "server/discover" }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(state.sessions.size).toBe(0);
    expect(await readJson(response)).toMatchObject({
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
        capabilities: { tools: {} },
        ttlMs: 0,
        cacheScope: "private",
      },
    });
  });

  test("syncs a declarative catalog before modern discovery", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const gateway = new McpGateway(component);
    const resource = defineMcpResource({
      uri: "docs://modern",
      name: "Modern Docs",
      read: async () => [{ uri: "docs://modern", text: "ok" }],
    });

    const response = await gateway.handleMcpRequest(
      state.ctx,
      statelessJsonRpcRequest({ id: 1, method: "server/discover" }),
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );

    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(state.sessions.size).toBe(0);
    expect(state.resources).toMatchObject([
      { uri: "docs://modern", name: "Modern Docs" },
    ]);
  });

  test("serves modern tools/list statelessly with private cache hints", async () => {
    const component = createComponent();
    const state = createCtx(component, [
      {
        name: "zebra",
        description: "Zebra tool",
        kind: "query",
        functionHandle: "function://zebra",
        inputSchema: { type: "object" },
      },
      {
        name: "alpha",
        description: "Alpha tool",
        kind: "query",
        functionHandle: "function://alpha",
        inputSchema: { type: "object" },
      },
    ]);

    const response = await handleMcpRequest(
      state.ctx,
      statelessJsonRpcRequest({ id: 1, method: "tools/list" }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    const body = await readJson(response);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(state.sessions.size).toBe(0);
    expect(body.result).toMatchObject({
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "convex-mcp-gateway",
          // Not the literal version: release-please rewrites it on every
          // release, and pinning it here would break the suite each time.
          version: expect.stringMatching(/^\d+\.\d+\.\d+/),
        },
      },
    });
    expect(
      (body.result?.tools as Array<{ name: string }>).map((tool) => tool.name),
    ).toEqual(["alpha", "zebra"]);
  });

  test("rejects modern header mismatches before authorization", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    let authorized = false;
    const request = statelessJsonRpcRequest({ id: 1, method: "tools/list" });
    const headers = new Headers(request.headers);
    headers.set("mcp-method", "tools/call");
    const response = await handleMcpRequest(
      ctx,
      new Request(request, { headers }),
      component,
      {
        authorize: async () => {
          authorized = true;
          return { allowed: true };
        },
      },
    );

    expect(response.status).toBe(400);
    expect(authorized).toBe(false);
    expect(await readJson(response)).toMatchObject({
      error: { code: -32020 },
    });
  });

  test("rejects a disallowed origin before authorization", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    let authorized = false;
    const request = statelessJsonRpcRequest({ id: 1, method: "tools/list" });
    const response = await handleMcpRequest(
      ctx,
      withHeaders(request, { origin: "https://untrusted.example.com" }),
      component,
      {
        allowedOrigins: ["https://app.example.com"],
        authorize: async () => {
          authorized = true;
          return { allowed: true };
        },
      },
    );

    expect(response.status).toBe(403);
    expect(authorized).toBe(false);
    // The spec allows a JSON-RPC error body with no id on this 403.
    expect(await readJson(response)).toMatchObject({
      id: null,
      error: { code: -32003 },
    });
  });

  test("allows an origin on the allowlist", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const request = statelessJsonRpcRequest({ id: 1, method: "tools/list" });
    const response = await handleMcpRequest(
      ctx,
      withHeaders(request, { origin: "https://app.example.com" }),
      component,
      {
        allowedOrigins: ["https://app.example.com"],
        authorize: async () => ({ allowed: true }),
      },
    );

    expect(response.status).toBe(200);
  });

  // Regression: the origin gate used to be derived from `cors`, where
  // `cors: true` resolves every origin to "*" and the 403 never fired,
  // while an unset `cors` rejected every request carrying an Origin.
  test("permissive cors does not weaken the origin allowlist", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const request = statelessJsonRpcRequest({ id: 1, method: "tools/list" });
    const response = await handleMcpRequest(
      ctx,
      withHeaders(request, { origin: "https://untrusted.example.com" }),
      component,
      {
        cors: true,
        allowedOrigins: ["https://app.example.com"],
        authorize: async () => ({ allowed: true }),
      },
    );

    expect(response.status).toBe(403);
  });

  test("an unset allowlist does not reject requests carrying an Origin", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const request = statelessJsonRpcRequest({ id: 1, method: "tools/list" });
    const response = await handleMcpRequest(
      ctx,
      withHeaders(request, { origin: "https://anything.example.com" }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    expect(response.status).toBe(200);
  });

  test("a throwing origin matcher fails closed", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    let authorized = false;
    const response = await handleMcpRequest(
      ctx,
      withHeaders(statelessJsonRpcRequest({ id: 1, method: "tools/list" }), {
        // Sandboxed iframes and some redirects send this literal value,
        // which throws in a `new URL(origin)`-style matcher.
        origin: "null",
      }),
      component,
      {
        allowedOrigins: (origin) => new URL(origin).hostname === "app.example",
        authorize: async () => {
          authorized = true;
          return { allowed: true };
        },
      },
    );

    expect(response.status).toBe(403);
    expect(authorized).toBe(false);
  });

  test("a disallowed origin is rejected at preflight, without CORS headers", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const preflight = new Request("https://app.example.com/mcp/", {
      method: "OPTIONS",
      headers: {
        origin: "https://untrusted.example.com",
        "access-control-request-method": "POST",
      },
    });

    const response = await handleMcpRequest(ctx, preflight, component, {
      cors: true,
      allowedOrigins: ["https://app.example.com"],
      authorize: async () => ({ allowed: true }),
    });

    // Answering the preflight with allow-origin and only then 403ing the
    // POST would tell the browser the call is permitted.
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the origin allowlist also guards legacy requests", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const response = await handleMcpRequest(
      ctx,
      withHeaders(
        jsonRpcRequest({
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        }),
        { origin: "https://untrusted.example.com" },
      ),
      component,
      {
        allowedOrigins: (origin) => origin.endsWith(".app.example.com"),
        authorize: async () => ({ allowed: true }),
      },
    );

    expect(response.status).toBe(403);
  });

  test("omits the SSE event id on modern streams and disables proxy buffering", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const sseAccept = { accept: "text/event-stream, application/json" };

    const modern = await handleMcpRequest(
      ctx,
      withHeaders(
        statelessJsonRpcRequest({ id: 1, method: "tools/list" }),
        sseAccept,
      ),
      component,
      { authorize: async () => ({ allowed: true }) },
    );
    expect(modern.headers.get("content-type")).toBe("text/event-stream");
    expect(modern.headers.get("x-accel-buffering")).toBe("no");
    // 2026-07-28 removed Last-Event-ID resumability, so an id is noise.
    expect(await modern.text()).not.toContain("id:");

    const legacy = await handleMcpRequest(
      ctx,
      withHeaders(
        jsonRpcRequest({
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        }),
        sseAccept,
      ),
      component,
      { authorize: async () => ({ allowed: true }) },
    );
    expect(legacy.headers.get("x-accel-buffering")).toBe("no");
    expect(await legacy.text()).toContain("id: 1");
  });

  test("every session-based revision gets the identical id:1 SSE frame, no priming", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const sseAccept = { accept: "text/event-stream, application/json" };

    // 2025-11-25 does NOT get a priming event or retry hint: those are
    // optional SSE resumability additions the reference server emits only
    // with an event store + GET replay, which this gateway lacks (GET is
    // 405). Emitting them would advertise resumability it cannot honor.
    // So its frame is byte-identical to every older legacy revision.
    const frames: string[] = [];
    for (const [id, version] of [
      [1, "2025-11-25"],
      [2, "2025-06-18"],
      [3, "2025-03-26"],
    ] as const) {
      const init = await handleMcpRequest(
        ctx,
        withHeaders(
          jsonRpcRequest({
            id,
            method: "initialize",
            params: { protocolVersion: version },
          }),
          sseAccept,
        ),
        component,
        { authorize: async () => ({ allowed: true }) },
      );
      const frame = await init.text();
      expect(frame.startsWith("id: 1\nevent: message\ndata: ")).toBe(true);
      expect(frame).not.toContain("retry:");
      // The only `id:` line is the message's own `id: 1`; no `id: 0`
      // priming event precedes it.
      expect(frame).not.toContain("id: 0");
      expect(frame.match(/^id: /gm)).toHaveLength(1);
      // Strip the per-request JSON-RPC id and the version-specific
      // payload so the three frames can be compared for structural
      // identity.
      frames.push(
        frame
          .replace(/"id":\d+/, '"id":X')
          .replace(/"protocolVersion":"[^"]+"/, ""),
      );
    }
    expect(frames[0]).toBe(frames[1]);
    expect(frames[1]).toBe(frames[2]);
  });

  test("a 2025-11-25 session's post-initialize SSE frame is also plain id:1", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const sseAccept = { accept: "text/event-stream, application/json" };
    const init = await handleMcpRequest(
      ctx,
      withHeaders(
        jsonRpcRequest({
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25" },
        }),
        sseAccept,
      ),
      component,
      { authorize: async () => ({ allowed: true }) },
    );
    const sessionId = init.headers.get("mcp-session-id")!;
    const followUp = await handleMcpRequest(
      ctx,
      withHeaders(jsonRpcRequest({ id: 2, method: "tools/list" }), {
        ...sseAccept,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-11-25",
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );
    const frame = await followUp.text();
    expect(frame.startsWith("id: 1\nevent: message\ndata: ")).toBe(true);
    expect(frame).not.toContain("retry:");
    expect(frame).not.toContain("id: 0");
  });

  test("negotiates the newest supported revision for unknown or omitted versions", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    // An explicit request for a supported version echoes it regardless of
    // array order, so the default claim needs its own assertions: an
    // unsupported version and a missing one must BOTH land on 2025-11-25.
    for (const params of [{ protocolVersion: "1999-01-01" }, {}]) {
      const response = await handleMcpRequest(
        ctx,
        jsonRpcRequest({ id: 1, method: "initialize", params }),
        component,
        { authorize: async () => ({ allowed: true }) },
      );
      expect(await readJson(response)).toMatchObject({
        result: { protocolVersion: "2025-11-25" },
      });
    }
  });

  test("negotiates 2025-11-25 when requested and accepts its header afterwards", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );
    expect(await readJson(init)).toMatchObject({
      result: { protocolVersion: "2025-11-25" },
    });
    const sessionId = init.headers.get("mcp-session-id")!;

    // Per-request header validation must accept every supported legacy
    // revision, incl. the one the current official SDK pins as latest.
    const accepted = await handleMcpRequest(
      ctx,
      withHeaders(jsonRpcRequest({ id: 2, method: "tools/list" }), {
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-11-25",
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );
    expect(accepted.status).toBe(200);

    // An unsupported pinned header still 400s per spec, naming all
    // supported revisions.
    const rejected = await handleMcpRequest(
      ctx,
      withHeaders(jsonRpcRequest({ id: 3, method: "tools/list" }), {
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-12-31",
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain(
      "2025-11-25, 2025-06-18, 2025-03-26",
    );
  });

  test("persists legacy initialize capabilities for later hook requests", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const capabilities = { sampling: { models: true } };
    const response = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities,
        },
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );
    const sessionId = response.headers.get("mcp-session-id")!;

    expect(state.sessions.get(sessionId)?.clientCapabilities).toEqual(
      capabilities,
    );
  });

  test("rejects malformed legacy initialize capabilities before creating a session", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const response = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: [] },
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    expect(await readJson(response)).toMatchObject({
      error: { code: -32602 },
    });
    expect(state.sessions.size).toBe(0);
  });

  test("rejects a modern request without client capabilities metadata", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const request = statelessJsonRpcRequest({ id: 1, method: "tools/list" });
    const body = await request.json();
    delete (body.params._meta as Record<string, unknown>)[
      "io.modelcontextprotocol/clientCapabilities"
    ];

    const response = await handleMcpRequest(
      ctx,
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error: { code: -32602 } });
  });

  test("accepts a modern request without optional client info metadata", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const request = statelessJsonRpcRequest({ id: 1, method: "tools/list" });
    const body = await request.json();
    delete (body.params._meta as Record<string, unknown>)[
      "io.modelcontextprotocol/clientInfo"
    ];

    const response = await handleMcpRequest(
      ctx,
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      result: { resultType: "complete" },
    });
  });

  test("rejects malformed modern client info before authorization", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    let authorized = false;
    const request = statelessJsonRpcRequest({ id: 1, method: "tools/list" });
    const body = await request.json();
    (body.params._meta as Record<string, unknown>)[
      "io.modelcontextprotocol/clientInfo"
    ] = { name: "missing-version" };

    const response = await handleMcpRequest(
      ctx,
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      }),
      component,
      {
        authorize: async () => {
          authorized = true;
          return { allowed: true };
        },
      },
    );

    expect(response.status).toBe(400);
    expect(authorized).toBe(false);
    expect(await readJson(response)).toMatchObject({ error: { code: -32602 } });
  });

  test("keeps initialize session-based when legacy headers carry modern metadata", async () => {
    const component = createComponent();
    const state = createCtx(component);

    const response = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    expect(state.sessions.size).toBe(1);
    expect(await readJson(response)).toMatchObject({
      result: { protocolVersion: "2025-06-18" },
    });
  });

  test("does not synchronize the catalog before rejecting an anonymous modern request", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    let synchronized = false;

    const response = await handleMcpRequest(
      ctx,
      statelessJsonRpcRequest({ id: 1, method: "tools/list" }),
      component,
      {
        requireAuth: true,
        resolveIdentity: async () => null,
        authorize: async () => ({ allowed: true }),
        ensureCatalogSynced: async () => {
          synchronized = true;
        },
      },
    );

    expect(response.status).toBe(401);
    expect(synchronized).toBe(false);
  });

  test("reports the requested version in an unsupported modern version error", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const request = statelessJsonRpcRequest({ id: 1, method: "tools/list" });
    const headers = new Headers(request.headers);
    headers.set("mcp-protocol-version", "2099-01-01");
    const body = await request.json();
    (body.params._meta as Record<string, unknown>)[
      "io.modelcontextprotocol/protocolVersion"
    ] = "2099-01-01";

    const response = await handleMcpRequest(
      ctx,
      new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: -32022,
        data: {
          requested: "2099-01-01",
          supported: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
        },
      },
    });
  });

  test("accepts a base64-encoded modern Mcp-Name", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const request = statelessJsonRpcRequest({
      id: 1,
      method: "tools/call",
      params: { name: "weather/世界", arguments: {} },
    });
    const headers = new Headers(request.headers);
    headers.set("mcp-name", "=?base64?d2VhdGhlci/kuJbnlYw=?=");
    let authorized = false;

    const response = await handleMcpRequest(
      state.ctx,
      new Request(request, { headers }),
      component,
      {
        authorize: async () => {
          authorized = true;
          return { allowed: true };
        },
      },
    );

    expect(authorized).toBe(false);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      error: { code: -32602, message: "Unknown tool: weather/世界" },
    });
  });

  test("accepts a literal modern Mcp-Name ending in base64 marker text", async () => {
    const component = createComponent();
    const state = createCtx(component, [
      {
        name: "literal?=",
        description: "Literal name",
        kind: "query",
        functionHandle: "function://literal",
        inputSchema: { type: "object" },
      },
    ]);

    const response = await handleMcpRequest(
      state.ctx,
      statelessJsonRpcRequest({
        id: 1,
        method: "tools/call",
        params: { name: "literal?=", arguments: {} },
      }),
      component,
      { authorize: async () => ({ allowed: false, reason: "Forbidden" }) },
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      error: { code: -32003 },
    });
  });

  test("rejects a modern base64 routing header that decodes to a control character", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    let authorized = false;
    const request = withHeaders(
      statelessJsonRpcRequest({
        id: 1,
        method: "tools/call",
        params: { name: "bad\u0000name", arguments: {} },
      }),
      { "mcp-name": "=?base64?YmFkAG5hbWU=?=" },
    );

    const response = await handleMcpRequest(ctx, request, component, {
      authorize: async () => {
        authorized = true;
        return { allowed: true };
      },
    });

    expect(response.status).toBe(400);
    expect(authorized).toBe(false);
    expect(await readJson(response)).toMatchObject({
      error: { code: -32020 },
    });
  });

  test("returns a modern JSON-RPC method error with HTTP 404", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);

    const response = await handleMcpRequest(
      ctx,
      statelessJsonRpcRequest({ id: 1, method: "unknown/method" }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ error: { code: -32601 } });
  });

  test("validates modern x-mcp-header values before authorization", async () => {
    const component = createComponent();
    const state = createCtx(component, [
      {
        name: "search",
        description: "Search",
        kind: "query",
        functionHandle: "function://search",
        inputSchema: {
          type: "object",
          properties: {
            region: { type: "string", "x-mcp-header": "Region" },
            filters: {
              type: "object",
              properties: {
                limit: { type: "integer", "x-mcp-header": "Limit" },
              },
            },
          },
        },
      },
    ]);
    let authorized = false;
    const requestBody = {
      id: 1,
      method: "tools/call",
      params: {
        name: "search",
        arguments: { region: "us-east-1", filters: { limit: 25 } },
      },
    };

    const rejected = await handleMcpRequest(
      state.ctx,
      statelessJsonRpcRequest(requestBody),
      component,
      {
        authorize: async () => {
          authorized = true;
          return { allowed: true };
        },
      },
    );
    expect(rejected.status).toBe(400);
    expect(authorized).toBe(false);
    expect(await readJson(rejected)).toMatchObject({
      error: { code: -32020 },
    });

    const accepted = await handleMcpRequest(
      state.ctx,
      withHeaders(statelessJsonRpcRequest(requestBody), {
        "mcp-param-region": "us-east-1",
        "mcp-param-limit": "25",
      }),
      component,
      { authorize: async () => ({ allowed: false, reason: "Forbidden" }) },
    );
    expect(accepted.status).toBe(200);
    expect(await readJson(accepted)).toMatchObject({
      error: { code: -32003 },
    });
  });

  test("compares integer x-mcp-header values numerically", async () => {
    const component = createComponent();
    const state = createCtx(component, [
      {
        name: "search",
        description: "Search",
        kind: "query",
        functionHandle: "function://search",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", "x-mcp-header": "Limit" } },
        },
      },
    ]);
    const requestBody = {
      id: 1,
      method: "tools/call",
      params: { name: "search", arguments: { limit: 25 } },
    };

    // Spec: "servers SHOULD compare the header value and the body value
    // numerically rather than as strings (e.g., 42.0 and 42 are equal)".
    const accepted = await handleMcpRequest(
      state.ctx,
      withHeaders(statelessJsonRpcRequest(requestBody), {
        "mcp-param-limit": "25.0",
      }),
      component,
      { authorize: async () => ({ allowed: false, reason: "Forbidden" }) },
    );
    expect(accepted.status).toBe(200);
    expect(await readJson(accepted)).toMatchObject({ error: { code: -32003 } });

    const rejected = await handleMcpRequest(
      state.ctx,
      withHeaders(statelessJsonRpcRequest(requestBody), {
        "mcp-param-limit": "26",
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );
    expect(rejected.status).toBe(400);
    expect(await readJson(rejected)).toMatchObject({ error: { code: -32020 } });

    // Numeric comparison must not inherit Number()'s coercions:
    // Number("0x19") is 25, but that is not a decimal integer literal.
    const coerced = await handleMcpRequest(
      state.ctx,
      withHeaders(statelessJsonRpcRequest(requestBody), {
        "mcp-param-limit": "0x19",
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );
    expect(coerced.status).toBe(400);
    expect(await readJson(coerced)).toMatchObject({ error: { code: -32020 } });
  });

  test("rejects x-mcp-header declarations hidden in schema composition", async () => {
    const component = createComponent();
    const state = createCtx(component, [
      {
        name: "search",
        description: "Search",
        kind: "query",
        functionHandle: "function://search",
        inputSchema: {
          allOf: [
            {
              type: "object",
              properties: {
                region: { type: "string", "x-mcp-header": "Region" },
              },
            },
          ],
        },
      },
    ]);
    let authorized = false;

    const response = await handleMcpRequest(
      state.ctx,
      statelessJsonRpcRequest({
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { region: "us-east-1" } },
      }),
      component,
      {
        authorize: async () => {
          authorized = true;
          return { allowed: true };
        },
      },
    );

    // A malformed tool schema is a server configuration error, not a
    // client header mismatch, so it must not be reported as -32020.
    expect(response.status).toBe(500);
    expect(authorized).toBe(false);
    expect(await readJson(response)).toMatchObject({ error: { code: -32603 } });
  });

  test("decodes base64 modern x-mcp-header values", async () => {
    const component = createComponent();
    const state = createCtx(component, [
      {
        name: "search",
        description: "Search",
        kind: "query",
        functionHandle: "function://search",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", "x-mcp-header": "Query" },
          },
        },
      },
    ]);
    const request = statelessJsonRpcRequest({
      id: 1,
      method: "tools/call",
      params: { name: "search", arguments: { query: "Hello, 世界" } },
    });

    const response = await handleMcpRequest(
      state.ctx,
      withHeaders(request, {
        "mcp-name": "search",
        "mcp-param-query": "=?base64?SGVsbG8sIOS4lueVjA==?=",
      }),
      component,
      { authorize: async () => ({ allowed: false, reason: "Forbidden" }) },
    );
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      error: { code: -32003 },
    });
  });

  test.each(["resources/list", "resources/templates/list", "resources/read"])(
    "returns HTTP 404 when modern %s is not configured",
    async (method) => {
      const component = createComponent();
      const { ctx } = createCtx(component);

      const response = await handleMcpRequest(
        ctx,
        statelessJsonRpcRequest({
          id: 1,
          method,
          ...(method === "resources/read"
            ? { params: { uri: "docs://x" } }
            : {}),
        }),
        component,
        { authorize: async () => ({ allowed: true }) },
      );

      expect(response.status).toBe(404);
      expect(await readJson(response)).toMatchObject({
        error: { code: -32601 },
      });
    },
  );

  test("returns HTTP 500 when modern catalog sync fails", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);

    const response = await handleMcpRequest(
      ctx,
      statelessJsonRpcRequest({ id: 1, method: "tools/list" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        ensureCatalogSynced: async () => {
          throw new Error("catalog contains a secret URL");
        },
      },
    );

    expect(response.status).toBe(500);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: -32603,
        message: "Failed to synchronize the declarative catalog",
      },
    });
  });

  test("rejects modern notifications instead of silently accepting them", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);

    const response = await handleMcpRequest(
      ctx,
      statelessJsonRpcRequest({ method: "notifications/cancelled" }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error: { code: -32600 } });
  });

  test("checks Mcp-Name before rejecting an unsupported modern prompts/get", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);

    const response = await handleMcpRequest(
      ctx,
      statelessJsonRpcRequest({
        id: 1,
        method: "prompts/get",
        params: { name: "x" },
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error: { code: -32020 } });
  });

  test("tools/list preserves registered protocol metadata", async () => {
    const component = createComponent();
    const protocolMetadata = {
      title: "Get entity context",
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: "ui://lonir/entity-context.html" } },
      securitySchemes: [{ type: "oauth2", scopes: ["openid"] }],
    };
    const { ctx } = createCtx(component, [
      {
        name: "get_context",
        description: "Read entity context",
        kind: "query",
        functionHandle: "function://get_context",
        inputSchema: { type: "object" },
        protocolMetadata,
      },
    ]);

    const initialized = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );
    const response = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        { id: 2, method: "tools/list" },
        initialized.headers.get("mcp-session-id")!,
      ),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    expect(await readJson(response)).toMatchObject({
      result: { tools: [{ name: "get_context", ...protocolMetadata }] },
    });
  });

  test("initialize returns instructions when initializeInstructions is set", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);

    const response = await handleMcpRequest(
      ctx,
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        initializeInstructions: "Call kira_load_skill before answering.",
      },
    );

    const body = await readJson(response);
    expect(body.result?.instructions).toBe(
      "Call kira_load_skill before answering.",
    );
  });

  test("initialize omits instructions when initializeInstructions is unset", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);

    const response = await handleMcpRequest(
      ctx,
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    const body = await readJson(response);
    expect(body.result).not.toHaveProperty("instructions");
  });

  test("answers ping with an empty result on a session-era connection", async () => {
    // Not capability-gated anywhere in the spec, and the reference SDK
    // registers its handler in the `Protocol` constructor, so every client
    // may assume a liveness check works on a connection it already holds.
    const component = createComponent();
    const { ctx } = createCtx(component);
    const options = { authorize: async () => ({ allowed: true as const }) };

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      options,
    );
    const response = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        { id: 2, method: "ping" },
        init.headers.get("mcp-session-id")!,
      ),
      component,
      options,
    );

    const body = await readJson(response);
    expect(body.error).toBeUndefined();
    expect(body.result).toEqual({});
  });

  test("refuses ping on the stateless path, where the spec removed it", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);

    const response = await handleMcpRequest(
      ctx,
      statelessJsonRpcRequest({ id: 1, method: "ping" }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    expect(response.status).toBe(404);
    const body = await readJson(response);
    expect(body.error?.code).toBe(-32601);
    expect(body.error?.message).toMatch(/legacy-only/);
  });

  test("advertises resources capability", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);

    const response = await handleMcpRequest(
      ctx,
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [
          {
            name: "docs",
            list: async () => [],
            read: async () => null,
          },
        ],
      },
    );

    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    const body = await readJson(response);
    expect(body.result?.capabilities).toEqual({
      tools: {},
      resources: {},
    });
  });

  test("advertises resources on initialize for a hook-only mount", async () => {
    // The `server/discover` half of this is covered in mrtr.test.ts. Both
    // handshakes compute the flag separately, so advertising from only one
    // would make the capability depend on which one the client used.
    const component = createComponent();
    const { ctx } = createCtx(component);

    const response = await handleMcpRequest(
      ctx,
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        // No providers, no templates, no registry rows: the read hook is
        // the entire resource implementation.
        beforeResourceRead: async () => null,
      },
    );

    const body = await readJson(response);
    expect(body.result?.capabilities).toEqual({
      tools: {},
      resources: {},
    });
  });

  test("lists an empty catalog on a hook-only mount rather than refusing", async () => {
    // `resources/list` is the advertised capability's base method, so a
    // client that lists on connect must not meet a -32601 for a feature
    // the handshake just promised. Nothing is registered, so it lists
    // empty.
    const component = createComponent();
    const { ctx } = createCtx(component);
    const options = {
      authorize: async () => ({ allowed: true as const }),
      beforeResourceRead: async () => null,
    };

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      options,
    );
    const sessionId = init.headers.get("mcp-session-id");
    const response = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      options,
    );

    const body = await readJson(response);
    expect(body.error).toBeUndefined();
    expect(body.result).toEqual({ resources: [] });
  });

  test("still refuses resources/list when nothing backs it at all", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const options = { authorize: async () => ({ allowed: true as const }) };

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      options,
    );
    const response = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        { id: 2, method: "resources/list" },
        init.headers.get("mcp-session-id")!,
      ),
      component,
      options,
    );

    const body = await readJson(response);
    expect(body.error?.code).toBe(-32601);
  });

  test("serves resources/list and resources/read through providers", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const provider: McpResourceProvider = {
      name: "docs",
      list: async (_ctx, args) => [
        {
          uri: `skill://${args.identity.subject}/overview`,
          name: "Overview",
          description: "Tenant skill overview",
          mimeType: "application/json",
        },
      ],
      read: async (_ctx, args) =>
        args.uri === "skill://user-1/overview"
          ? [
              {
                uri: args.uri,
                mimeType: "application/json",
                text: JSON.stringify({ ok: true }),
              },
            ]
          : null,
    };

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [provider],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [provider],
      },
    );
    expect(await readJson(list)).toMatchObject({
      result: {
        resources: [
          {
            uri: "skill://user-1/overview",
            name: "Overview",
            description: "Tenant skill overview",
            mimeType: "application/json",
          },
        ],
      },
    });

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 3,
          method: "resources/read",
          params: { uri: "skill://user-1/overview" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [provider],
      },
    );
    expect(await readJson(read)).toMatchObject({
      result: {
        contents: [
          {
            uri: "skill://user-1/overview",
            mimeType: "application/json",
            text: '{"ok":true}',
          },
        ],
      },
    });
  });

  test("serves resources declared with defineMcpResource", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const resource = defineMcpResource({
      uri: "docs://tenant-handbook",
      name: "Tenant Handbook",
      description: "Operator handbook",
      mimeType: "text/markdown",
      read: async (_ctx, args) => [
        {
          uri: args.uri,
          mimeType: "text/markdown",
          text: "# Tenant Handbook",
        },
      ],
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    expect(await readJson(list)).toMatchObject({
      result: {
        resources: [
          {
            uri: "docs://tenant-handbook",
            name: "Tenant Handbook",
            description: "Operator handbook",
            mimeType: "text/markdown",
          },
        ],
      },
    });

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 3,
          method: "resources/read",
          params: { uri: "docs://tenant-handbook" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    expect(await readJson(read)).toMatchObject({
      result: {
        contents: [
          {
            uri: "docs://tenant-handbook",
            mimeType: "text/markdown",
            text: "# Tenant Handbook",
          },
        ],
      },
    });
  });

  test("lists resources persisted in the registry", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const gateway = new McpGateway(component);

    const init = await gateway.handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      {
        authorize: async () => ({ allowed: true }),
        resources: [
          defineMcpResource({
            uri: "docs://registered",
            name: "Registered",
            read: async () => [
              { uri: "docs://registered", text: "registered" },
            ],
          }),
        ],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
      },
    );
    expect(await readJson(list)).toMatchObject({
      result: {
        resources: [
          {
            uri: "docs://registered",
            name: "Registered",
          },
        ],
      },
    });

    const readWithoutProvider = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 3,
          method: "resources/read",
          params: { uri: "docs://registered" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
      },
    );
    expect(await readJson(readWithoutProvider)).toMatchObject({
      error: {
        code: -32602,
        message: "Resource not found: docs://registered",
        // The spec's not-found example carries the URI in `data` so a
        // client can correlate the miss without parsing the message.
        data: { uri: "docs://registered" },
      },
    });
  });

  test("McpGateway declaratively syncs static resources on initialize", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const gateway = new McpGateway(component);
    const resource = defineMcpResource({
      uri: "docs://synced",
      name: "Synced",
      description: "Synced docs",
      mimeType: "text/plain",
      read: async () => [{ uri: "docs://synced", text: "ok" }],
    });

    const response = await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );

    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    expect(state.resources).toEqual([
      {
        uri: "docs://synced",
        name: "Synced",
        description: "Synced docs",
        mimeType: "text/plain",
      },
    ]);
  });

  test("McpGateway clears stale declarative resources when resources is empty", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const gateway = new McpGateway(component);

    await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      {
        authorize: async () => ({ allowed: true }),
        resources: [
          defineMcpResource({
            uri: "docs://stale",
            name: "Stale",
            read: async () => [{ uri: "docs://stale", text: "old" }],
          }),
        ],
      },
    );
    expect(state.resources).toHaveLength(1);

    await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "initialize" }),
      {
        authorize: async () => ({ allowed: true }),
        resources: [],
      },
    );

    expect(state.resources).toEqual([]);
  });

  test("authorizeResource filters resources/list per resource", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const gateway = new McpGateway(component);

    const init = await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      {
        authorize: async () => ({ allowed: true }),
        resources: [
          defineMcpResource({
            uri: "docs://public",
            name: "Public",
            metadata: { scope: "public" },
            read: async () => [{ uri: "docs://public", text: "public" }],
          }),
          defineMcpResource({
            uri: "docs://private",
            name: "Private",
            metadata: { scope: "private" },
            read: async () => [{ uri: "docs://private", text: "private" }],
          }),
        ],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const seen: Array<{ uri: string; metadata: unknown }> = [];
    const list = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        authorizeResource: async (_ctx, args) => {
          seen.push({
            uri: args.resourceUri,
            metadata: args.resourceMetadata,
          });
          return {
            allowed:
              (args.resourceMetadata as { scope?: string } | null)?.scope !==
              "private",
          };
        },
      },
    );

    expect(await readJson(list)).toMatchObject({
      result: {
        resources: [
          {
            uri: "docs://public",
            name: "Public",
          },
        ],
      },
    });
    expect(seen).toEqual([
      { uri: "docs://public", metadata: { scope: "public" } },
      { uri: "docs://private", metadata: { scope: "private" } },
    ]);
  });

  test("authorizeResource denies resources/read before provider execution", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    let readCalls = 0;
    const resource = defineMcpResource({
      uri: "docs://secret",
      name: "Secret",
      read: async () => {
        readCalls += 1;
        return [{ uri: "docs://secret", text: "secret" }];
      },
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "docs://secret" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
        authorizeResource: async () => ({
          allowed: false,
          reason: "Forbidden: missing scope",
        }),
      },
    );

    expect(await readJson(read)).toMatchObject({
      error: { code: -32003, message: "Forbidden: missing scope" },
    });
    expect(readCalls).toBe(0);
  });

  test("a throwing authorizeResource keeps its exception text off the wire", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const resource = defineMcpResource({
      uri: "docs://secret",
      name: "Secret",
      read: async () => [{ uri: "docs://secret", text: "secret" }],
    });
    const options = {
      authorize: async () => ({ allowed: true }),
      resources: [resource],
      authorizeResource: async () => {
        throw new Error("scope lookup failed: bearer sk-live-abc123");
      },
      auditResources: { read: true },
    };

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      options,
    );
    const sessionId = init.headers.get("mcp-session-id");

    const read = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "docs://secret" },
        },
        sessionId!,
      ),
      component,
      options,
    );

    const body = await readJson(read);
    expect(body).toMatchObject({
      error: { code: -32603, message: "Authorization check failed" },
    });
    expect(JSON.stringify(body)).not.toContain("sk-live-abc123");
    // Operators still get the full reason, server-side.
    expect(state.resourceAuditEntries).toMatchObject([
      {
        resourceUri: "docs://secret",
        outcome: "error",
        errorCode: -32603,
        errorMessage: expect.stringContaining("sk-live-abc123"),
      },
    ]);
  });

  test("a deliberate authorizeResource denial keeps its reason on the wire", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const resource = defineMcpResource({
      uri: "docs://secret",
      name: "Secret",
      read: async () => [{ uri: "docs://secret", text: "secret" }],
    });
    const options = {
      authorize: async () => ({ allowed: true }),
      resources: [resource],
      authorizeResource: async () => ({
        allowed: false,
        reason: "Unauthorized: sign in first",
      }),
    };

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      options,
    );
    const sessionId = init.headers.get("mcp-session-id");

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "docs://secret" },
        },
        sessionId!,
      ),
      component,
      options,
    );

    expect(await readJson(read)).toMatchObject({
      error: { code: -32001, message: "Unauthorized: sign in first" },
    });
  });

  test("authorizeResource throw hides only that resource during resources/list", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const resources = [
      defineMcpResource({
        uri: "docs://ok",
        name: "OK",
        read: async () => [{ uri: "docs://ok", text: "ok" }],
      }),
      defineMcpResource({
        uri: "docs://throws",
        name: "Throws",
        read: async () => [{ uri: "docs://throws", text: "throws" }],
      }),
    ];

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources,
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources,
        authorizeResource: async (_ctx, args) => {
          if (args.resourceUri === "docs://throws") {
            throw new Error("policy failed");
          }
          return { allowed: true };
        },
      },
    );

    expect(await readJson(list)).toMatchObject({
      result: {
        resources: [
          {
            uri: "docs://ok",
            name: "OK",
          },
        ],
      },
    });
  });

  test("resource audit is opt-in and does not store read contents", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const resource = defineMcpResource({
      uri: "docs://audited",
      name: "Audited",
      read: async () => [
        {
          uri: "docs://audited",
          mimeType: "text/plain",
          text: "sensitive content",
        },
      ],
    });

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "docs://audited" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    expect(state.resourceAuditEntries).toEqual([]);

    await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        {
          id: 3,
          method: "resources/read",
          params: { uri: "docs://audited" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
        auditResources: { read: true },
      },
    );

    expect(state.resourceAuditEntries).toMatchObject([
      {
        resourceUri: "docs://audited",
        resourceOperation: "read",
        args: null,
        outcome: "allowed",
        identitySubject: "user-1",
      },
    ]);
    expect(JSON.stringify(state.resourceAuditEntries)).not.toContain(
      "sensitive content",
    );
  });

  test("resource audit records denied reads before provider execution", async () => {
    const component = createComponent();
    const state = createCtx(component);
    let readCalls = 0;
    const resource = defineMcpResource({
      uri: "docs://denied-audit",
      name: "Denied Audit",
      read: async () => {
        readCalls += 1;
        return [{ uri: "docs://denied-audit", text: "secret" }];
      },
    });

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "docs://denied-audit" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
        auditResources: true,
        authorizeResource: async () => ({
          allowed: false,
          reason: "Forbidden: no scope",
        }),
      },
    );

    expect(readCalls).toBe(0);
    expect(state.resourceAuditEntries).toMatchObject([
      {
        resourceUri: "docs://denied-audit",
        resourceOperation: "read",
        args: null,
        outcome: "denied",
        identitySubject: "user-1",
        errorCode: -32003,
        errorMessage: "Forbidden: no scope",
      },
    ]);
  });

  test("resource audit records list summaries and read errors", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const resources = [
      defineMcpResource({
        uri: "docs://one",
        name: "One",
        read: async () => {
          throw new Error("read failed");
        },
      }),
      defineMcpResource({
        uri: "docs://two",
        name: "Two",
        read: async () => [{ uri: "docs://two", text: "two" }],
      }),
    ];

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources,
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources,
        auditResources: { list: true },
      },
    );

    await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        {
          id: 3,
          method: "resources/read",
          params: { uri: "docs://one" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources,
        auditResources: { read: true },
      },
    );

    expect(state.resourceAuditEntries).toMatchObject([
      {
        resourceOperation: "list",
        args: { resourceCount: 2 },
        outcome: "allowed",
        identitySubject: "user-1",
      },
      {
        resourceUri: "docs://one",
        resourceOperation: "read",
        args: null,
        outcome: "error",
        identitySubject: "user-1",
        errorCode: -32603,
        errorMessage: "read failed",
      },
    ]);
  });

  test("returns a JSON-RPC error when a resource read handler throws", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const resource = defineMcpResource({
      uri: "docs://broken",
      name: "Broken",
      read: async () => {
        throw new Error("read failed: token=sk-live-abc123");
      },
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "docs://broken" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    // The caller gets the fault, not the exception text: a thrown
    // message can quote credentials, and the caller is an LLM.
    const body = await readJson(read);
    expect(body).toMatchObject({
      error: { code: -32603, message: "Resource read failed" },
    });
    expect(JSON.stringify(body)).not.toContain("sk-live-abc123");
  });

  test("a resource read handler's ConvexError still reaches the caller", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const resource = defineMcpResource({
      uri: "docs://missing",
      name: "Missing",
      read: async () => {
        throw new ConvexError("Document is archived");
      },
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "docs://missing" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    expect(await readJson(read)).toMatchObject({
      error: { code: -32603, message: "Document is archived" },
    });
  });

  test("resources/list isolates a throwing provider from healthy ones", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const broken: McpResourceProvider = {
      name: "broken",
      list: async () => {
        throw new Error("provider exploded");
      },
      read: async () => null,
    };
    const healthy: McpResourceProvider = {
      name: "healthy",
      list: async () => [{ uri: "docs://ok", name: "OK" }],
      read: async () => null,
    };

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [broken, healthy],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [broken, healthy],
      },
    );
    // The broken provider's throw must not collapse the whole catalog;
    // the healthy provider's resource is still listed.
    expect(await readJson(list)).toMatchObject({
      result: { resources: [{ uri: "docs://ok", name: "OK" }] },
    });
  });

  test("resources/read: a throwing provider does not mask a later provider", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const broken: McpResourceProvider = {
      name: "broken",
      list: async () => [],
      read: async () => {
        throw new Error("provider exploded");
      },
    };
    const healthy: McpResourceProvider = {
      name: "healthy",
      list: async () => [],
      read: async (_ctx, args) =>
        args.uri === "docs://served"
          ? [{ uri: args.uri, text: "served" }]
          : null,
    };

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [broken, healthy],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        { id: 2, method: "resources/read", params: { uri: "docs://served" } },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [broken, healthy],
      },
    );
    // The first provider throwing must not abort the read: the second
    // provider still serves the resource.
    expect(await readJson(read)).toMatchObject({
      result: { contents: [{ uri: "docs://served", text: "served" }] },
    });
  });

  test("resources/templates/list returns configured templates", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const template = defineMcpResourceTemplate({
      uriTemplate: "weather://{city}/current",
      name: "Current weather",
      description: "Live weather by city",
      mimeType: "application/json",
      read: async (_ctx, args) => [
        { uri: args.uri, text: JSON.stringify(args.params) },
      ],
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    // Templates alone advertise the resources capability.
    expect((await readJson(init)).result?.capabilities).toMatchObject({
      resources: {},
    });
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/templates/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    expect(await readJson(list)).toMatchObject({
      result: {
        resourceTemplates: [
          {
            uriTemplate: "weather://{city}/current",
            name: "Current weather",
            description: "Live weather by city",
            mimeType: "application/json",
          },
        ],
      },
    });
  });

  test("resources/templates/list is unsupported when no templates configured", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const resource = defineMcpResource({
      uri: "docs://concrete",
      name: "Concrete",
      read: async () => [{ uri: "docs://concrete", text: "x" }],
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      { authorize: async () => ({ allowed: true }), resources: [resource] },
    );
    const sessionId = init.headers.get("mcp-session-id");

    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/templates/list" }, sessionId!),
      component,
      { authorize: async () => ({ allowed: true }), resources: [resource] },
    );
    // Concrete resources exist but templates do not: the dedicated method
    // is unsupported rather than returning an empty list.
    expect(await readJson(list)).toMatchObject({
      error: { code: -32601 },
    });
  });

  test("resources/read resolves a URI through a matching template", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const template = defineMcpResourceTemplate({
      uriTemplate: "weather://{city}/current",
      name: "Current weather",
      read: async (_ctx, args) => [
        {
          uri: args.uri,
          mimeType: "application/json",
          text: JSON.stringify({ city: args.params.city }),
        },
      ],
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "weather://london/current" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    expect(await readJson(read)).toMatchObject({
      result: {
        contents: [
          {
            uri: "weather://london/current",
            mimeType: "application/json",
            text: '{"city":"london"}',
          },
        ],
      },
    });

    // A URI that matches no template (and no concrete provider) is not found.
    const miss = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 3,
          method: "resources/read",
          params: { uri: "weather://london/history" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    expect(await readJson(miss)).toMatchObject({
      error: {
        code: -32602,
        message: "Resource not found: weather://london/history",
        data: { uri: "weather://london/history" },
      },
    });
  });

  test("concrete resources take precedence over a matching template", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const concrete = defineMcpResource({
      uri: "weather://london/current",
      name: "London weather",
      read: async () => [{ uri: "weather://london/current", text: "concrete" }],
    });
    const template = defineMcpResourceTemplate({
      uriTemplate: "weather://{city}/current",
      name: "Current weather",
      read: async () => [
        { uri: "weather://london/current", text: "from-template" },
      ],
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [concrete],
        resourceTemplates: [template],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "weather://london/current" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [concrete],
        resourceTemplates: [template],
      },
    );
    // The concrete provider serves first; the template never runs.
    expect(await readJson(read)).toMatchObject({
      result: { contents: [{ text: "concrete" }] },
    });
  });

  test("authorizeResource filters resources/templates/list and audits it", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const visible = defineMcpResourceTemplate({
      uriTemplate: "weather://{city}/current",
      name: "Weather",
      read: async () => null,
    });
    const hidden = defineMcpResourceTemplate({
      uriTemplate: "secret://{id}",
      name: "Secret",
      read: async () => null,
    });

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [visible, hidden],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");

    const list = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "resources/templates/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [visible, hidden],
        authorizeResource: async (_ctx, args) => ({
          allowed:
            args.mode === "resource_templates_list" &&
            args.resourceUri.startsWith("secret://")
              ? false
              : true,
        }),
        auditResources: { templatesList: true },
      },
    );
    expect(await readJson(list)).toMatchObject({
      result: {
        resourceTemplates: [{ uriTemplate: "weather://{city}/current" }],
      },
    });
    expect(state.resourceAuditEntries).toMatchObject([
      {
        resourceOperation: "templates_list",
        outcome: "allowed",
        identitySubject: "user-1",
        args: { resourceTemplateCount: 1 },
      },
    ]);
  });

  test("resources/read: a throwing template surfaces -32603, not a benign miss", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const template = defineMcpResourceTemplate({
      uriTemplate: "weather://{city}/current",
      name: "Weather",
      read: async () => {
        throw new Error("upstream weather API down");
      },
    });

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");

    const read = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "weather://london/current" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
        auditResources: { read: true },
      },
    );
    // A template throw is a real fault, not a "not found". The caller
    // learns that much and no more; the audit row keeps the full text.
    expect(await readJson(read)).toMatchObject({
      error: { code: -32603, message: "Resource read failed" },
    });
    expect(state.resourceAuditEntries).toMatchObject([
      {
        resourceUri: "weather://london/current",
        resourceOperation: "read",
        outcome: "error",
        errorCode: -32603,
        errorMessage: "upstream weather API down",
      },
    ]);
  });

  test("resources/read: a template's ConvexError still reaches the caller", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const template = defineMcpResourceTemplate({
      uriTemplate: "weather://{city}/current",
      name: "Weather",
      read: async () => {
        throw new ConvexError("No station for that city");
      },
    });
    const options = {
      authorize: async () => ({ allowed: true }),
      resourceTemplates: [template],
    };

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      options,
    );
    const sessionId = init.headers.get("mcp-session-id");

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "weather://london/current" },
        },
        sessionId!,
      ),
      component,
      options,
    );
    expect(await readJson(read)).toMatchObject({
      error: { code: -32603, message: "No station for that city" },
    });
  });

  test("resources/read: a throwing template does not mask a later serving template", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const broken = defineMcpResourceTemplate({
      uriTemplate: "weather://{city}/current",
      name: "Broken",
      read: async () => {
        throw new Error("boom");
      },
    });
    const healthy = defineMcpResourceTemplate({
      uriTemplate: "weather://{city}/current",
      name: "Healthy",
      read: async (_ctx, args) => [{ uri: args.uri, text: args.params.city }],
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [broken, healthy],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "weather://paris/current" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [broken, healthy],
      },
    );
    expect(await readJson(read)).toMatchObject({
      result: { contents: [{ uri: "weather://paris/current", text: "paris" }] },
    });
  });

  test("resources/read: a template that matches but declines (null) falls through to not-found", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const template = defineMcpResourceTemplate({
      uriTemplate: "weather://{city}/current",
      name: "Weather",
      read: async () => null,
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "weather://berlin/current" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    // A clean decline is a miss, not a fault.
    expect(await readJson(read)).toMatchObject({
      error: {
        code: -32602,
        message: "Resource not found: weather://berlin/current",
      },
    });
  });

  test("resources/read: a listing-only template (no read) does not resolve reads", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const template = defineMcpResourceTemplate({
      uriTemplate: "weather://{city}/current",
      name: "Weather",
      // no read handler → listing-only
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "weather://rome/current" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    expect(await readJson(read)).toMatchObject({
      error: {
        code: -32602,
        message: "Resource not found: weather://rome/current",
      },
    });
  });

  test("resources/templates/list rejects anonymous callers without auditing (anti-DoS)", async () => {
    const component = createComponent();
    const state = createCtx(component);
    // Make this caller anonymous for the whole exchange.
    (
      state.ctx.auth as { getUserIdentity: () => Promise<unknown> }
    ).getUserIdentity = async () => null;
    const template = defineMcpResourceTemplate({
      uriTemplate: "weather://{city}/current",
      name: "Weather",
      read: async () => null,
    });

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");

    const list = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "resources/templates/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
        auditResources: { templatesList: true },
      },
    );
    expect(await readJson(list)).toMatchObject({
      error: { code: -32001, message: "Unauthorized: authentication required" },
    });
    // Anonymous denials are NOT audited: auditing them would let an
    // unauthenticated client grow the audit table without bound (mirrors the
    // unknown-tool path in dispatch.ts).
    expect(state.resourceAuditEntries).toEqual([]);
  });

  test("templates-only deployment: resources/list returns an empty list, not -32601", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const template = defineMcpResourceTemplate({
      uriTemplate: "weather://{city}/current",
      name: "Weather",
      read: async () => null,
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");

    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    // Templates make the resources capability "supported", so resources/list
    // is a normal empty list rather than an unsupported-method error.
    expect(await readJson(list)).toMatchObject({ result: { resources: [] } });
  });

  test("subscription capability is advertised only when opted in", async () => {
    const component = createComponent();
    const resource = defineMcpResource({
      uri: "docs://a",
      name: "A",
      read: async () => [{ uri: "docs://a", text: "a" }],
    });

    // Default: resources present but no subscription flags → resources: {}.
    const off = await handleMcpRequest(
      createCtx(component).ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      { authorize: async () => ({ allowed: true }), resources: [resource] },
    );
    expect((await readJson(off)).result?.capabilities).toEqual({
      tools: {},
      resources: {},
    });

    // Opted in → flags surface.
    const on = await handleMcpRequest(
      createCtx(component).ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
        resourceSubscriptions: { subscribe: true, listChanged: true },
      },
    );
    expect((await readJson(on)).result?.capabilities).toEqual({
      tools: {},
      resources: { subscribe: true, listChanged: true },
    });
  });

  test("resources/subscribe & unsubscribe return a descriptive -32601 when disabled", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const resource = defineMcpResource({
      uri: "docs://a",
      name: "A",
      read: async () => [{ uri: "docs://a", text: "a" }],
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      { authorize: async () => ({ allowed: true }), resources: [resource] },
    );
    const sessionId = init.headers.get("mcp-session-id");

    for (const method of ["resources/subscribe", "resources/unsubscribe"]) {
      const res = await handleMcpRequest(
        ctx,
        jsonRpcRequest(
          { id: 2, method, params: { uri: "docs://a" } },
          sessionId!,
        ),
        component,
        { authorize: async () => ({ allowed: true }), resources: [resource] },
      );
      const body = await readJson(res);
      expect(body.error?.code).toBe(-32601);
      expect(body.error?.message).toContain(method);
      expect(body.error?.message).toContain("resources.subscribe capability");
    }
  });

  test("resources/subscribe & unsubscribe track per-session state when enabled", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const resource = defineMcpResource({
      uri: "docs://a",
      name: "A",
      read: async () => [{ uri: "docs://a", text: "a" }],
    });
    const options = {
      authorize: async () => ({ allowed: true }),
      resources: [resource],
      resourceSubscriptions: { subscribe: true },
    };

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      options,
    );
    const sessionId = init.headers.get("mcp-session-id")!;

    const sub = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        { id: 2, method: "resources/subscribe", params: { uri: "docs://a" } },
        sessionId,
      ),
      component,
      options,
    );
    expect(await readJson(sub)).toMatchObject({ result: {} });
    expect(state.subscriptions.get(sessionId)?.has("docs://a")).toBe(true);

    // Idempotent re-subscribe is still a success.
    const subAgain = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        { id: 3, method: "resources/subscribe", params: { uri: "docs://a" } },
        sessionId,
      ),
      component,
      options,
    );
    expect(await readJson(subAgain)).toMatchObject({ result: {} });

    const unsub = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        { id: 4, method: "resources/unsubscribe", params: { uri: "docs://a" } },
        sessionId,
      ),
      component,
      options,
    );
    expect(await readJson(unsub)).toMatchObject({ result: {} });
    expect(state.subscriptions.get(sessionId)?.has("docs://a")).toBe(false);
  });

  test("resources/subscribe rejects anonymous callers and missing uri when enabled", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const options = {
      authorize: async () => ({ allowed: true }),
      resourceSubscriptions: { subscribe: true },
    };

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      options,
    );
    const sessionId = init.headers.get("mcp-session-id")!;

    // Missing uri → INVALID_PARAMS.
    const noUri = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "resources/subscribe" }, sessionId),
      component,
      options,
    );
    expect((await readJson(noUri)).error?.code).toBe(-32602);

    // Anonymous → UNAUTHORIZED.
    (
      state.ctx.auth as { getUserIdentity: () => Promise<unknown> }
    ).getUserIdentity = async () => null;
    const anon = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        { id: 3, method: "resources/subscribe", params: { uri: "docs://a" } },
        sessionId,
      ),
      component,
      options,
    );
    expect((await readJson(anon)).error?.code).toBe(-32001);
  });

  test("resources/subscribe is identity-bound to the session owner", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const options = {
      authorize: async () => ({ allowed: true }),
      resourceSubscriptions: { subscribe: true },
    };

    // Session created by user-1 (the harness default identity).
    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      options,
    );
    const sessionId = init.headers.get("mcp-session-id")!;

    // A different authenticated caller reusing the (leaked) session id must
    // not be able to mutate the owner's subscription state.
    (
      state.ctx.auth as { getUserIdentity: () => Promise<unknown> }
    ).getUserIdentity = async () => ({ subject: "user-2" });
    const res = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        { id: 2, method: "resources/subscribe", params: { uri: "docs://a" } },
        sessionId,
      ),
      component,
      options,
    );
    expect((await readJson(res)).error?.code).toBe(-32003);
    // Nothing was recorded under the victim's session.
    expect(state.subscriptions.get(sessionId)?.has("docs://a")).not.toBe(true);
  });

  test("notification builders produce MCP-compatible payloads", () => {
    const gateway = new McpGateway(createComponent());
    expect(gateway.buildResourceListChangedNotification()).toEqual({
      jsonrpc: "2.0",
      method: "notifications/resources/list_changed",
    });
    expect(gateway.buildResourceUpdatedNotification("docs://a")).toEqual({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: "docs://a" },
    });
  });

  test("resources/list forwards extended provider metadata", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const provider: McpResourceProvider = {
      name: "p",
      list: async () => [
        {
          uri: "docs://a",
          name: "A",
          title: "Doc A",
          size: 42,
          annotations: { audience: ["user"], priority: 0.3 },
        },
      ],
      read: async () => null,
    };
    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      { authorize: async () => ({ allowed: true }), resources: [provider] },
    );
    const sessionId = init.headers.get("mcp-session-id")!;
    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId),
      component,
      { authorize: async () => ({ allowed: true }), resources: [provider] },
    );
    expect(await readJson(list)).toMatchObject({
      result: {
        resources: [
          {
            uri: "docs://a",
            name: "A",
            title: "Doc A",
            size: 42,
            annotations: { audience: ["user"], priority: 0.3 },
          },
        ],
      },
    });
  });

  test("resources/list returns -32603 on an invalid provider descriptor", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    // A provider that returns a descriptor with no uri (bypassing the typed
    // helper) must not ship malformed JSON-RPC.
    const provider = {
      name: "p",
      list: async () => [{ name: "no uri" }],
      read: async () => null,
    } as unknown as McpResourceProvider;
    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      { authorize: async () => ({ allowed: true }), resources: [provider] },
    );
    const sessionId = init.headers.get("mcp-session-id")!;
    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId),
      component,
      { authorize: async () => ({ allowed: true }), resources: [provider] },
    );
    const body = await readJson(list);
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toMatch(/resource\.uri must be a non-empty/);
  });

  test("resources/read returns -32603 on invalid content", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    // Content item with neither text nor blob.
    const emptyItem: McpResourceProvider = {
      name: "p",
      list: async () => [],
      read: async (_ctx, args) => [{ uri: args.uri }],
    };
    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      { authorize: async () => ({ allowed: true }), resources: [emptyItem] },
    );
    const sessionId = init.headers.get("mcp-session-id")!;
    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        { id: 2, method: "resources/read", params: { uri: "docs://a" } },
        sessionId,
      ),
      component,
      { authorize: async () => ({ allowed: true }), resources: [emptyItem] },
    );
    const body = await readJson(read);
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toMatch(/must include text or blob/);

    // Read result that isn't an array at all.
    const notArray = {
      name: "p",
      list: async () => [],
      read: async () => ({ uri: "docs://a", text: "x" }),
    } as unknown as McpResourceProvider;
    const init2 = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 3, method: "initialize" }),
      component,
      { authorize: async () => ({ allowed: true }), resources: [notArray] },
    );
    const sessionId2 = init2.headers.get("mcp-session-id")!;
    const read2 = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        { id: 4, method: "resources/read", params: { uri: "docs://a" } },
        sessionId2,
      ),
      component,
      { authorize: async () => ({ allowed: true }), resources: [notArray] },
    );
    const body2 = await readJson(read2);
    expect(body2.error?.code).toBe(-32603);
    expect(body2.error?.message).toMatch(/must be an array/);
  });

  test("resources/templates/list returns -32603 on an invalid template", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    // A hand-built template provider (bypassing defineMcpResourceTemplate)
    // with an empty uriTemplate.
    const provider = {
      template: { uriTemplate: "", name: "Bad" },
      match: () => null,
    } as unknown as McpResourceTemplateProvider;
    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [provider],
      },
    );
    const sessionId = init.headers.get("mcp-session-id")!;
    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/templates/list" }, sessionId),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [provider],
      },
    );
    const body = await readJson(list);
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toMatch(/template\.uriTemplate/);
  });

  test("declaratively syncs an extended resource without leaking runtime fields to the registry", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const gateway = new McpGateway(component);
    const handbook = defineMcpResource({
      uri: "docs://handbook",
      name: "Handbook",
      title: "Operator handbook",
      annotations: { audience: ["assistant"], priority: 0.9 },
      size: 2048,
      read: async () => [{ uri: "docs://handbook", text: "..." }],
    });

    // initialize runs the declarative sync → replaceResources. The strict
    // mock throws if title/annotations/size leak into the persisted
    // descriptor, so a successful initialize proves the registry descriptor
    // is narrow.
    const init = await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      { authorize: async () => ({ allowed: true }), resources: [handbook] },
    );
    expect(init.headers.get("mcp-session-id")).toBeTruthy();
    expect(state.resources).toEqual([
      {
        uri: "docs://handbook",
        name: "Handbook",
      },
    ]);

    // The provider still surfaces the extended fields in resources/list
    // (the provider candidate wins dedup over the registry row).
    const sessionId = init.headers.get("mcp-session-id")!;
    const list = await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId),
      { authorize: async () => ({ allowed: true }), resources: [handbook] },
    );
    expect(await readJson(list)).toMatchObject({
      result: {
        resources: [
          {
            uri: "docs://handbook",
            name: "Handbook",
            title: "Operator handbook",
            annotations: { audience: ["assistant"], priority: 0.9 },
            size: 2048,
          },
        ],
      },
    });
  });

  test("resources/templates/list forwards valid annotations and title", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const template = defineMcpResourceTemplate({
      uriTemplate: "weather://{city}/current",
      name: "Weather",
      title: "Current weather",
      annotations: { audience: ["user"], priority: 0.4 },
      read: async () => null,
    });
    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    const sessionId = init.headers.get("mcp-session-id")!;
    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/templates/list" }, sessionId),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [template],
      },
    );
    expect(await readJson(list)).toMatchObject({
      result: {
        resourceTemplates: [
          {
            uriTemplate: "weather://{city}/current",
            name: "Weather",
            title: "Current weather",
            annotations: { audience: ["user"], priority: 0.4 },
          },
        ],
      },
    });
  });

  test("resources/templates/list serves registry-only templates (no runtime provider)", async () => {
    const component = createComponent();
    const state = createCtx(component);
    // Seed the registry directly (as a declarative sync or registerResource-
    // Templates would), with NO runtime resourceTemplates option.
    await state.ctx.runMutation(component.registry.replaceResourceTemplates, {
      templates: [
        {
          uriTemplate: "invoice://{id}",
          name: "Invoice",
          title: "Invoice by id",
          annotations: { priority: 0.7 },
          icons: [{ src: "https://example.com/invoice.png", sizes: ["96x96"] }],
        },
      ],
      fingerprint: "fp",
    });

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );
    // The resources capability is advertised on the strength of the
    // registered template alone.
    expect((await readJson(init)).result?.capabilities).toMatchObject({
      resources: {},
    });
    const sessionId = init.headers.get("mcp-session-id")!;

    const list = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "resources/templates/list" }, sessionId),
      component,
      { authorize: async () => ({ allowed: true }) },
    );
    expect(await readJson(list)).toMatchObject({
      result: {
        resourceTemplates: [
          {
            uriTemplate: "invoice://{id}",
            name: "Invoice",
            title: "Invoice by id",
            annotations: { priority: 0.7 },
            // The guarantee that justifies persisting icons for templates
            // (a concrete resource's are runtime-only): a registry-only
            // template still lists its full descriptor.
            icons: [
              { src: "https://example.com/invoice.png", sizes: ["96x96"] },
            ],
          },
        ],
      },
    });
  });

  test("resources/templates/list merges registered + runtime, runtime wins on a shared uriTemplate", async () => {
    const component = createComponent();
    const state = createCtx(component);
    await state.ctx.runMutation(component.registry.replaceResourceTemplates, {
      templates: [
        { uriTemplate: "shared://{x}", name: "Registered" },
        { uriTemplate: "registry-only://{x}", name: "Registry only" },
      ],
      fingerprint: "fp",
    });
    const runtime = defineMcpResourceTemplate({
      uriTemplate: "shared://{x}",
      name: "Runtime",
      title: "Runtime wins",
      read: async () => null,
    });

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [runtime],
      },
    );
    const sessionId = init.headers.get("mcp-session-id")!;
    const list = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "resources/templates/list" }, sessionId),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [runtime],
      },
    );
    const body = await readJson(list);
    const templates = (
      body.result as {
        resourceTemplates: Array<{ uriTemplate: string; name: string }>;
      }
    ).resourceTemplates;
    // Both URIs present, deduped; the runtime provider wins shared://{x}.
    expect(templates.map((t) => t.uriTemplate).sort()).toEqual([
      "registry-only://{x}",
      "shared://{x}",
    ]);
    expect(templates.find((t) => t.uriTemplate === "shared://{x}")!.name).toBe(
      "Runtime",
    );
  });

  test("McpGateway declaratively syncs templates and clears them when empty", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const gateway = new McpGateway(component);

    await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      {
        authorize: async () => ({ allowed: true }),
        resourceTemplates: [
          defineMcpResourceTemplate({
            uriTemplate: "synced://{x}",
            name: "Synced",
            read: async () => null,
          }),
        ],
      },
    );
    expect(state.resourceTemplates).toMatchObject([
      { uriTemplate: "synced://{x}", name: "Synced" },
    ]);

    // Re-initialize with an empty template list → the registry is cleared.
    await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "initialize" }),
      { authorize: async () => ({ allowed: true }), resourceTemplates: [] },
    );
    expect(state.resourceTemplates).toEqual([]);
  });

  test("resources/list strips unknown fields from provider output", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    // A hand-built provider that returns stray/internal keys must not leak
    // them to the client (the response carries only known McpResource fields).
    const provider = {
      name: "p",
      list: async () => [
        { uri: "docs://a", name: "A", secret: "do-not-leak", _id: "row1" },
      ],
      read: async () => null,
    } as unknown as McpResourceProvider;
    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      { authorize: async () => ({ allowed: true }), resources: [provider] },
    );
    const sessionId = init.headers.get("mcp-session-id")!;
    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId),
      component,
      { authorize: async () => ({ allowed: true }), resources: [provider] },
    );
    const body = await readJson(list);
    expect(body.result?.resources).toEqual([{ uri: "docs://a", name: "A" }]);
  });

  test("resources/read: a provider returning [] declines rather than serving empty", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    // The concrete provider returns [] (an easy mistake for "not mine");
    // the template should still get a chance and serve the real content.
    const empty: McpResourceProvider = {
      name: "empty",
      list: async () => [],
      read: async () => [],
    };
    const template = defineMcpResourceTemplate({
      uriTemplate: "docs://{id}",
      name: "Docs",
      read: async (_ctx, args) => [{ uri: args.uri, text: "served" }],
    });
    const options = {
      authorize: async () => ({ allowed: true }),
      resources: [empty],
      resourceTemplates: [template],
    };
    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      options,
    );
    const sessionId = init.headers.get("mcp-session-id")!;
    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        { id: 2, method: "resources/read", params: { uri: "docs://x" } },
        sessionId,
      ),
      component,
      options,
    );
    // The empty-array provider did not shadow the template.
    expect(await readJson(read)).toMatchObject({
      result: { contents: [{ uri: "docs://x", text: "served" }] },
    });

    // And when nothing serves non-empty content, it's a clean not-found.
    const readMiss = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        { id: 3, method: "resources/read", params: { uri: "other://x" } },
        sessionId,
      ),
      component,
      { authorize: async () => ({ allowed: true }), resources: [empty] },
    );
    expect((await readJson(readMiss)).error?.code).toBe(-32602);
  });
});

describe("resources/read not-found error payload", () => {
  const provider = {
    name: "docs",
    list: async () => [{ uri: "docs://a", name: "a" }],
    read: async () => null,
  };

  async function readUri(
    uri: string,
    resources: unknown[] = [provider],
  ): Promise<{
    error?: { code: number; message: string; data?: Record<string, unknown> };
    result?: unknown;
  }> {
    const component = createComponent();
    const ctx = createCtx(component).ctx;
    const options = {
      authorize: async () => ({ allowed: true as const }),
      resources: resources as never,
    };
    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      options,
    );
    const sessionId = init.headers.get("mcp-session-id");
    const res = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        { id: 2, method: "resources/read", params: { uri } },
        sessionId!,
      ),
      component,
      options,
    );
    return (await readJson(res)) as never;
  }

  test("a URI that needs escaping survives the data payload intact", async () => {
    // The message interpolates the URI, so quotes and newlines are the case
    // where reading it out of the prose breaks and `data` does not.
    const uri = 'docs://a"b\nc';
    const body = await readUri(uri);
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.data).toEqual({ uri });
  });

  test("the modern path answers identically, since this is a result shape", async () => {
    const component = createComponent();
    const ctx = createCtx(component).ctx;
    const res = await handleMcpRequest(
      ctx,
      statelessJsonRpcRequest({
        id: 2,
        method: "resources/read",
        params: { uri: "docs://missing" },
      }),
      component,
      {
        authorize: async () => ({ allowed: true as const }),
        resources: [provider] as never,
      },
    );
    const body = (await readJson(res)) as {
      error: { code: number; data?: Record<string, unknown> };
    };
    // No era difference: the not-found branch is one code path, and the
    // sibling tests above assert the same payload after `initialize`.
    expect(body.error.code).toBe(-32602);
    expect(body.error.data).toEqual({ uri: "docs://missing" });
  });

  test("a provider fault carries no data, since the URI is not the problem", async () => {
    const throwing = {
      name: "throwing",
      list: async () => [],
      read: async () => {
        throw new Error("upstream timeout at https://internal/creds");
      },
    };
    const body = await readUri("docs://boom", [throwing]);
    // -32603: ours, not the caller's. This path exists to keep provider
    // detail off the wire, so it stays message-only.
    //
    // Asserted on the whole object rather than through optional chaining:
    // `error?.data` would also be undefined if `error` itself vanished, so
    // a refactor that turned this fault into a result would slip through.
    expect(body.error).toEqual({
      code: -32603,
      message: expect.any(String),
    });
    expect(body.error?.message).not.toContain("internal/creds");
  });
});

describe("icons and the declarative template fingerprint", () => {
  test("changing icons re-syncs the template row", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const gateway = new McpGateway(component);
    const options = (icons: unknown[]) => ({
      authorize: async () => ({ allowed: true as const }),
      resourceTemplates: [
        defineMcpResourceTemplate({
          uriTemplate: "docs://{id}",
          name: "docs",
          icons: icons as never,
          read: async () => null,
        }),
      ],
    });
    const first = [{ src: "https://example.com/a.png" }];
    await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      options(first),
    );
    // Persisted, unlike a concrete resource's icons, so a registry-only
    // template still lists its full descriptor.
    expect(state.resourceTemplates[0]?.icons).toEqual(first);
    const afterFirst = state.templatesFingerprint;

    // Same catalog: the fingerprint short-circuit must hold.
    await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "initialize" }),
      options(first),
    );
    expect(state.templatesFingerprint).toBe(afterFirst);

    // Changed icons: the fingerprint has to churn or the row would keep
    // serving the old ones forever.
    const second = [{ src: "https://example.com/b.png", theme: "dark" }];
    await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 3, method: "initialize" }),
      options(second),
    );
    expect(state.templatesFingerprint).not.toBe(afterFirst);
    expect(state.resourceTemplates[0]?.icons).toEqual(second);
  });
});

describe("icons validation", () => {
  test("accepts the spec's Icon shape and rejects each malformed field", () => {
    expect(
      describeIconsProblem(
        [
          {
            src: "https://example.com/i.png",
            mimeType: "image/png",
            sizes: ["48x48"],
          },
          { src: "data:image/svg+xml;base64,AAA=", sizes: ["any"], theme: "dark" },
        ],
        "resource",
      ),
    ).toBeNull();
    // Absent is fine; an empty array is a host saying "no icons", also fine.
    expect(describeIconsProblem(undefined, "tool")).toBeNull();
    expect(describeIconsProblem([], "tool")).toBeNull();

    // Each message names the field so a typo is findable.
    expect(describeIconsProblem({}, "tool")).toBe("tool.icons must be an array");
    expect(describeIconsProblem(["x"], "tool")).toBe(
      "tool.icons entries must be objects",
    );
    expect(describeIconsProblem([{}], "resource")).toBe(
      "resource.icons[].src must be a non-empty string",
    );
    expect(describeIconsProblem([{ src: "" }], "resource")).toBe(
      "resource.icons[].src must be a non-empty string",
    );
    expect(describeIconsProblem([{ src: "a", mimeType: 1 }], "template")).toBe(
      "template.icons[].mimeType must be a string",
    );
    expect(
      describeIconsProblem([{ src: "a", sizes: "48x48" }], "template"),
    ).toBe("template.icons[].sizes must be an array of strings");
    expect(describeIconsProblem([{ src: "a", sizes: [48] }], "template")).toBe(
      "template.icons[].sizes must be an array of strings",
    );
    expect(describeIconsProblem([{ src: "a", theme: "sepia" }], "tool")).toBe(
      'tool.icons[].theme must be "light" or "dark"',
    );
  });

  test("the resource and template validators reject bad icons", () => {
    // Reached through the descriptor validators, which is where a
    // declarative catalog is checked.
    expect(
      describeResourceProblem({
        uri: "docs://a",
        name: "a",
        icons: [{ mimeType: "image/png" }],
      }),
    ).toBe("resource.icons[].src must be a non-empty string");
    expect(
      describeResourceTemplateProblem({
        uriTemplate: "docs://{id}",
        name: "a",
        icons: "nope",
      }),
    ).toBe("template.icons must be an array");
  });
});

describe("serverInfo carries the full Implementation shape", () => {
  // Annotated rather than inferred: this also pins that a full spec block
  // is assignable to the public type, through the entry point a host imports.
  const fullServerInfo: McpServerInfo = {
    name: "acme-gateway",
    title: "Acme Gateway",
    version: "3.1.4",
    description: "Acme's MCP front door",
    websiteUrl: "https://acme.example.com",
    icons: [
      { src: "https://acme.example.com/icon.png", sizes: ["48x48"] },
      { src: "data:image/svg+xml;base64,AAA=", sizes: ["any"], theme: "dark" },
    ],
  };

  test("reaches the initialize result whole", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const response = await handleMcpRequest(
      ctx,
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        serverInfo: fullServerInfo,
      },
    );

    const body = await readJson(response);
    // Not toMatchObject: the point is that no field is dropped on the way
    // through, so compare the whole block.
    expect(body.result?.serverInfo).toEqual(fullServerInfo);
  });

  test("reaches the stateless _meta block whole", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const response = await handleMcpRequest(
      ctx,
      statelessJsonRpcRequest({ id: 1, method: "tools/list" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        serverInfo: fullServerInfo,
      },
    );

    const body = await readJson(response);
    expect(
      (body.result?._meta as Record<string, unknown>)[
        "io.modelcontextprotocol/serverInfo"
      ],
    ).toEqual(fullServerInfo);
  });

  test("omitting the new fields leaves the default block unchanged", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const response = await handleMcpRequest(
      ctx,
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      }),
      component,
      { authorize: async () => ({ allowed: true }) },
    );

    const body = await readJson(response);
    // Exactly two keys, so widening the type did not start emitting
    // `title: undefined` or an empty `icons` array to every client.
    expect(Object.keys(body.result?.serverInfo as object).sort()).toEqual([
      "name",
      "version",
    ]);
  });

  test("a two-field override still works and is not merged into", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const response = await handleMcpRequest(
      ctx,
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        serverInfo: { name: "acme", version: "1.0.0" },
      },
    );

    const body = await readJson(response);
    expect(body.result?.serverInfo).toEqual({ name: "acme", version: "1.0.0" });
  });

  test("a malformed block fails the mount rather than the client", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    // A bare-string `sizes` is what a spec-conformant client rejects the
    // whole response over, so it must never reach the wire and the throw
    // names the field. It is NOT the old-SDK hazard: 1.18.0-1.18.2 would
    // accept this and break on the spec-correct array instead, which the
    // validator accepts by design and the fixture above covers.
    await expect(
      handleMcpRequest(
        ctx,
        jsonRpcRequest({
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25" },
        }),
        component,
        {
          authorize: async () => ({ allowed: true }),
          serverInfo: {
            name: "acme",
            version: "1.0.0",
            icons: [{ src: "a", sizes: "48x48" }] as never,
          },
        },
      ),
    ).rejects.toThrow("serverInfo.icons[].sizes must be an array of strings");

    // Every method rides the same block, so the guard is not
    // initialize-only.
    await expect(
      handleMcpRequest(
        ctx,
        statelessJsonRpcRequest({ id: 1, method: "tools/list" }),
        component,
        {
          authorize: async () => ({ allowed: true }),
          serverInfo: { name: "acme", version: "" },
        },
      ),
    ).rejects.toThrow("serverInfo.version must be a non-empty string");
  });

  test("describeServerInfoProblem: accepts valid blocks, names each bad field", () => {
    expect(describeServerInfoProblem(undefined)).toBeNull();
    expect(describeServerInfoProblem(fullServerInfo)).toBeNull();
    expect(describeServerInfoProblem({ name: "a", version: "1" })).toBeNull();

    expect(describeServerInfoProblem("acme")).toBe(
      "serverInfo must be an object",
    );
    expect(describeServerInfoProblem({ version: "1" })).toBe(
      "serverInfo.name must be a non-empty string",
    );
    expect(describeServerInfoProblem({ name: "a" })).toBe(
      "serverInfo.version must be a non-empty string",
    );
    expect(describeServerInfoProblem({ name: "a", version: "1", title: 1 })).toBe(
      "serverInfo.title must be a string",
    );
    expect(
      describeServerInfoProblem({ name: "a", version: "1", description: [] }),
    ).toBe("serverInfo.description must be a string");
    expect(
      describeServerInfoProblem({ name: "a", version: "1", websiteUrl: 1 }),
    ).toBe("serverInfo.websiteUrl must be a string");
    // Delegated, and the label follows through so the message points at
    // `serverInfo` rather than at a tool.
    expect(
      describeServerInfoProblem({ name: "a", version: "1", icons: [{}] }),
    ).toBe("serverInfo.icons[].src must be a non-empty string");
  });
});

describe("resource shape validators", () => {
  test("describeResourceProblem: valid minimal and extended descriptors", () => {
    expect(describeResourceProblem({ uri: "x://a", name: "A" })).toBeNull();
    expect(
      describeResourceProblem({
        uri: "x://a",
        name: "A",
        title: "T",
        description: "d",
        mimeType: "text/plain",
        size: 0,
        annotations: { audience: ["user"], priority: 0, lastModified: "now" },
      }),
    ).toBeNull();
  });

  test("describeResourceProblem: rejects bad descriptors", () => {
    expect(describeResourceProblem(null)).toMatch(/must be an object/);
    expect(describeResourceProblem([])).toMatch(/must be an object/);
    expect(describeResourceProblem({ name: "A" })).toMatch(/uri/);
    expect(describeResourceProblem({ uri: "x://a" })).toMatch(/name/);
    expect(describeResourceProblem({ uri: "", name: "A" })).toMatch(/uri/);
    expect(
      describeResourceProblem({ uri: "x://a", name: "A", description: 1 }),
    ).toMatch(/description must be a string/);
    expect(
      describeResourceProblem({ uri: "x://a", name: "A", mimeType: 1 }),
    ).toMatch(/mimeType must be a string/);
    expect(
      describeResourceProblem({ uri: "x://a", name: "A", size: -1 }),
    ).toMatch(/size/);
    expect(
      describeResourceProblem({ uri: "x://a", name: "A", size: NaN }),
    ).toMatch(/size/);
    expect(
      describeResourceProblem({ uri: "x://a", name: "A", size: Infinity }),
    ).toMatch(/size/);
  });

  test("describeAnnotationsProblem: valid and invalid", () => {
    expect(describeAnnotationsProblem(undefined)).toBeNull();
    expect(describeAnnotationsProblem({})).toBeNull();
    expect(describeAnnotationsProblem({ priority: 0 })).toBeNull();
    expect(describeAnnotationsProblem({ priority: 1 })).toBeNull();
    expect(describeAnnotationsProblem("x")).toMatch(/must be an object/);
    expect(describeAnnotationsProblem([])).toMatch(/must be an object/);
    expect(describeAnnotationsProblem({ priority: -0.1 })).toMatch(/priority/);
    expect(describeAnnotationsProblem({ priority: 1.1 })).toMatch(/priority/);
    expect(describeAnnotationsProblem({ audience: ["nope"] })).toMatch(
      /audience/,
    );
    expect(describeAnnotationsProblem({ audience: "user" })).toMatch(
      /audience/,
    );
    expect(describeAnnotationsProblem({ lastModified: 1 })).toMatch(
      /lastModified must be a string/,
    );
  });

  test("describeResourceTemplateProblem: valid and invalid", () => {
    expect(
      describeResourceTemplateProblem({ uriTemplate: "x://{a}", name: "A" }),
    ).toBeNull();
    expect(describeResourceTemplateProblem({ name: "A" })).toMatch(
      /uriTemplate/,
    );
    expect(
      describeResourceTemplateProblem({ uriTemplate: "x://{a}", name: "" }),
    ).toMatch(/name/);
    expect(
      describeResourceTemplateProblem({
        uriTemplate: "x://{a}",
        name: "A",
        description: 5,
      }),
    ).toMatch(/description must be a string/);
  });

  test("describeResourceContentsProblem: valid and invalid", () => {
    expect(describeResourceContentsProblem([])).toBeNull();
    expect(
      describeResourceContentsProblem([{ uri: "x://a", text: "t" }]),
    ).toBeNull();
    expect(
      describeResourceContentsProblem([{ uri: "x://a", blob: "b" }]),
    ).toBeNull();
    expect(
      describeResourceContentsProblem([
        { uri: "x://a", mimeType: "text/plain", text: "t", blob: "b" },
      ]),
    ).toBeNull();
    expect(describeResourceContentsProblem({})).toMatch(/must be an array/);
    expect(describeResourceContentsProblem(["x"])).toMatch(/must be an object/);
    expect(describeResourceContentsProblem([null])).toMatch(
      /must be an object/,
    );
    expect(describeResourceContentsProblem([{ text: "t" }])).toMatch(
      /content\.uri/,
    );
    expect(
      describeResourceContentsProblem([{ uri: "x://a", mimeType: 1 }]),
    ).toMatch(/mimeType must be a string/);
    expect(
      describeResourceContentsProblem([{ uri: "x://a", text: 1 }]),
    ).toMatch(/text must be a string/);
    expect(
      describeResourceContentsProblem([{ uri: "x://a", blob: 1 }]),
    ).toMatch(/blob must be a string/);
    expect(describeResourceContentsProblem([{ uri: "x://a" }])).toMatch(
      /must include text or blob/,
    );
  });
});

describe("structuredContent shape on a dispatch", () => {
  function scalarTool(outputSchema: unknown): RegisteredTool {
    return {
      name: "scalar_tool",
      description: "returns a string",
      kind: "query",
      functionHandle: "function://scalar",
      inputSchema: { type: "object" },
      outputSchema,
    };
  }

  async function call(state: ReturnType<typeof createCtx>, component: ComponentApi) {
    const response = await handleMcpRequest(
      state.ctx,
      statelessJsonRpcRequest({
        id: 1,
        method: "tools/call",
        params: { name: "scalar_tool", arguments: {} },
      }),
      component,
      { authorize: async () => ({ allowed: true as const }) },
    );
    return (await readJson(response)) as {
      result?: { content?: { text?: string }[]; structuredContent?: unknown };
    };
  }

  async function legacyCall(
    state: ReturnType<typeof createCtx>,
    component: ComponentApi,
    method: "tools/call" | "tools/list" = "tools/call",
  ) {
    const options = { authorize: async () => ({ allowed: true as const }) };
    // The legacy era is session-based, so the request has to follow an
    // `initialize` that negotiates the revision under test.
    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      }),
      component,
      options,
    );
    const sessionId = init.headers.get("mcp-session-id")!;
    const response = await handleMcpRequest(
      state.ctx,
      withHeaders(
        jsonRpcRequest({
          id: 2,
          method,
          ...(method === "tools/call"
            ? { params: { name: "scalar_tool", arguments: {} } }
            : {}),
        }),
        {
          "mcp-session-id": sessionId,
          "mcp-protocol-version": "2025-11-25",
        },
      ),
      component,
      options,
    );
    return (await readJson(response)) as {
      result?: {
        content?: { text?: string }[];
        structuredContent?: unknown;
        tools?: { name: string; outputSchema?: unknown }[];
      };
    };
  }

  test("a scalar return still ships structuredContent", async () => {
    // The 2026-07-28 revision types `structuredContent` as `unknown`
    // ("object, array, string, number, boolean, or null"), and a
    // validating client raises a protocol error when a tool advertising
    // an `outputSchema` answers WITHOUT the block. Withholding it for a
    // scalar therefore breaks exactly the clients it looks like it
    // protects, so `returns: v.string()` keeps emitting one.
    const component = createComponent();
    const state = createCtx(component, [scalarTool({ type: "string" })]);
    state.setDispatchResult({ ok: true, data: "hello" });

    const body = await call(state, component);
    expect(body.result?.content?.[0]?.text).toBe(
      JSON.stringify("hello", null, 2),
    );
    expect(body.result?.structuredContent).toBe("hello");
  });

  test("a null return ships structuredContent rather than omitting it", async () => {
    // `2026-07-28` lists `null` among the legal structured values, so a
    // `v.union(v.object({...}), v.null())` tool answering null on the
    // miss still gets a block on the modern path.
    const component = createComponent();
    const state = createCtx(component, [scalarTool({ type: ["object", "null"] })]);
    state.setDispatchResult({ ok: true, data: null });

    const body = await call(state, component);
    expect(body.result).toHaveProperty("structuredContent");
    expect(body.result?.structuredContent).toBeNull();
  });

  test("a legacy client is not shown a scalar-rooted outputSchema", async () => {
    // Through 2025-11-25 `Tool.outputSchema` must be rooted at
    // `type: "object"`. A client validating to that revision rejects the
    // WHOLE tools/list response over one bad schema, so a single
    // `returns: v.string()` tool would hide every other tool from it.
    const component = createComponent();
    const state = createCtx(component, [scalarTool({ type: "string" })]);

    const body = await legacyCall(state, component, "tools/list");
    const tool = body.result?.tools?.find((t) => t.name === "scalar_tool");
    expect(tool).toBeDefined();
    expect(tool).not.toHaveProperty("outputSchema");
  });

  test("an object-rooted outputSchema is still shown to a legacy client", async () => {
    const component = createComponent();
    const state = createCtx(component, [
      scalarTool({ type: "object", properties: { total: { type: "number" } } }),
    ]);

    const body = await legacyCall(state, component, "tools/list");
    const tool = body.result?.tools?.find((t) => t.name === "scalar_tool");
    expect(tool?.outputSchema).toEqual({
      type: "object",
      properties: { total: { type: "number" } },
    });
  });

  test("a legacy client gets no structuredContent for a scalar", async () => {
    // Must track the advertisement exactly: that client was shown no
    // schema, and its own revision types `structuredContent` as an
    // object, so a bare string here fails its result parse outright.
    const component = createComponent();
    const state = createCtx(component, [scalarTool({ type: "string" })]);
    state.setDispatchResult({ ok: true, data: "hello" });

    const body = await legacyCall(state, component);
    expect(body.result?.content?.[0]?.text).toBe(
      JSON.stringify("hello", null, 2),
    );
    expect(body.result).not.toHaveProperty("structuredContent");
  });

  test("a legacy client still gets structuredContent for an object", async () => {
    const component = createComponent();
    const state = createCtx(component, [
      scalarTool({ type: "object", properties: { total: { type: "number" } } }),
    ]);
    state.setDispatchResult({ ok: true, data: { total: 2 } });

    const body = await legacyCall(state, component);
    expect(body.result?.structuredContent).toEqual({ total: 2 });
  });

  test("an object return still ships structuredContent", async () => {
    const component = createComponent();
    const state = createCtx(component, [
      scalarTool({ type: "object", properties: { total: { type: "number" } } }),
    ]);
    state.setDispatchResult({ ok: true, data: { total: 2 } });

    const body = await call(state, component);
    expect(body.result?.structuredContent).toEqual({ total: 2 });
  });

  test("a value that cannot be serialized fails the call instead of the request", async () => {
    // `v.int64()` is a supported `returns` validator and JSON.stringify
    // throws on a bigint. Unwrapped, that escaped the switch as a raw
    // 500 with no JSON-RPC envelope and no CORS headers.
    const component = createComponent();
    const state = createCtx(component, [scalarTool(undefined)]);
    state.setDispatchResult({ ok: true, data: { count: BigInt(7) } });

    const body = (await call(state, component)) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
      error?: unknown;
    };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/cannot be represented/);
  });
});
