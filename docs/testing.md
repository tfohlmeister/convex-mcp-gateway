# Testing

The gateway is fully exercisable from `convex-test` without spinning up
a real backend. This doc shows the patterns specific to the component;
for general convex-test usage, see the
[convex-test docs](https://www.npmjs.com/package/convex-test).

There are two layers worth covering:

1. **Component layer**: `dispatch.runTool` and `dispatch.recordAuthDenial`,
   exercised directly via `t.action(components.mcpGateway.*)`. No HTTP,
   no auth, just the registry + tool execution + audit pipeline.
2. **End-to-end layer**: drive the host's `/mcp/` route via `t.fetch`
   to cover the full Streamable-HTTP envelope, the authorize callback,
   and identity propagation through `t.withIdentity`.

## Setup

The component ships a one-line helper that registers its schema and
modules with your `convexTest` instance:

```ts
// convex/mcp.test.ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { register } from "convex-mcp-gateway/test";
import schema from "./schema.js";
import { components, internal } from "./_generated/api.js";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!**/*.test.ts"]);

function newTest() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}
```

`register(t, name?)` defaults to mounting the component as `mcpGateway`,
matching `app.use(mcpGateway)`; pass a name if you mounted it under a
different one. Do not reach for the component's schema module directly:
it is not part of the package's public exports, and the generated
`_generated/component.js` is types-only, so importing it yields
`undefined`.

> Inside this monorepo the tests import from `../../src/component/...`
> rather than through the package, because the package is not installed
> into itself. The pattern above is what a host writes.

## Layer 1: component-level tests

Use `t.action(components.mcpGateway.dispatch.runTool, {...})` to invoke
a tool by name with explicit `auditIdentitySubject`. There is no
authorization at this layer; that is the host's job.

```ts
test("runs a registered tool and returns its data", async () => {
  const t = newTest();
  await t.mutation(internal.mcp.registerDefaults, {});
  await t.run(async (ctx) => {
    await ctx.db.insert("invoices", { status: "open", amount: 7 });
  });

  const result = await t.action(components.mcpGateway.dispatch.runTool, {
    name: "invoices_summary",
    args: {},
    auditIdentitySubject: "alice",
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
  if (!result.ok) expect(result.error.code).toBe(-32602);

  const entries = await t.run(async (ctx) =>
    ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
  );
  expect(entries.find((e) => e.toolName === "no.such.tool")).toBeUndefined();
});
```

To verify the host's "deny" code path also writes an audit row, call
`recordAuthDenial` directly the way `handleMcpRequest` does:

```ts
test("recordAuthDenial writes a denied audit row", async () => {
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
  });
});
```

## Layer 2: end-to-end via `t.fetch`

`convex-test` routes the **host's** `http.ts` via `t.fetch`. Since the
gateway lives in the host's `httpAction` (not in component-mounted
routes), the full pipeline (envelope, sessions, authorize callback,
identity, dispatch, audit) is reachable in unit tests. Two helpers
remove most of the boilerplate:

> **Registration in tests.** Layer 1 above calls
> `internal.mcp.registerDefaults` to populate the registry imperatively,
> which is the right tool for component-level tests that bypass HTTP. If
> your host's `/mcp/` mount uses the declarative `tools` option (the
> recommended setup), the registry is reconciled on the `initialize`
> below, so the e2e tests need no separate registration call. If you
> export a `tools` array from a Convex module, annotate it
> `McpToolRegistration[]`, see
> [getting-started.md → Troubleshooting](./getting-started.md#troubleshooting-circular-type-error-from-your-tool-list).

```ts
async function initialize(t: ReturnType<typeof newTest>): Promise<string> {
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
      "mcp-session-id": sessionId,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
```

A few representative tests:

```ts
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
    result: { tools: Array<{ name: string }> };
  };
  expect(body.result.tools.map((tool) => tool.name)).toEqual([
    "invoices_summary",
  ]);
});

test("anonymous private call returns 401 + WWW-Authenticate", async () => {
  const t = newTest();
  await t.mutation(internal.mcp.registerDefaults, {});
  await t.run(async (ctx) => {
    await ctx.runMutation(components.mcpGateway.registry.setOAuthConfig, {
      authServerUrl: "https://idp.example.com/",
    });
  });

  const session = await initialize(t);
  const res = await rpc(t, session, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "invoices_list", arguments: {} },
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
});

test("admin sees the role-gated mutation", async () => {
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
      "mcp-session-id": session,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
  });
  const body = (await res.json()) as {
    result: { tools: Array<{ name: string }> };
  };
  expect(body.result.tools.map((t) => t.name).sort()).toEqual([
    "invoices_list",
    "invoices_markPaid",
    "invoices_summary",
  ]);
});
```

## Identities

`t.withIdentity({ subject, ... })` synthesizes the JWT-validated
identity that `ctx.auth.getUserIdentity()` returns inside the host's
`httpAction`. Any extra fields are forwarded onto the identity, so
role/scope claims work without setting up a real signer:

```ts
const tAdmin = t.withIdentity({
  subject: "carol",
  roles: ["finance.admin"],
} as unknown as Parameters<typeof t.withIdentity>[0]);
```

The `as unknown as ...` cast is a convex-test typing quirk: the public
identity type doesn't include arbitrary claims, but the runtime
forwards them. They show up on `identity.roles` etc. just like a real
JWT claim would.

## Swapping the authorize callback per test

The authorize callback is just a JS closure, so testing alternative
policies means mounting a different `/mcp/` route in a test-only
`http.ts`, or parameterising the host's `http.ts` to read the callback
from a test-injected variable. Most projects keep the production
authorize callback and rely on `t.withIdentity` to drive the
allowed/denied paths instead.

If a test really needs a custom callback, define a separate
`httpAction` in the test fixture that calls `gateway.handleMcpRequest`
with the test callback, route it under a different path
(e.g. `/test/mcp/`), and `t.fetch("/test/mcp/", ...)`.

## Asserting on the audit log

The audit log is a regular Convex query, so you can read it inside a
test:

```ts
const entries = await t.run(async (ctx) => {
  return await ctx.runQuery(components.mcpGateway.audit.listEntries, {});
});
expect(entries).toHaveLength(2);
expect(entries[0]!.outcome).toBe("denied");
```

To force-write rows (e.g. for testing the combined-filter behavior
under high volume), call `recordEntry` directly:

```ts
await t.run(async (ctx) => {
  for (let i = 0; i < 50; i++) {
    await ctx.runMutation(components.mcpGateway.audit.recordEntry, {
      toolName: "x",
      toolKind: "query",
      args: { i },
      outcome: "allowed",
      identitySubject: null,
      durationMs: 1,
    });
  }
});
```

## Real-client smoke test (MCP Inspector)

`convex-test` exercises the full pipeline including HTTP, but it does
not prove the deployed cloud build behaves identically. To verify the
protocol surface end-to-end against a real Convex backend, drive the
gateway with the official
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) in
CLI mode.

```sh
# Terminal 1: local backend (in this repo)
pnpm local:start
# Terminal 2: deploy your tools + register defaults (in your host repo)
npx convex dev --once
npx convex run mcp:registerDefaults
# Terminal 3: smoke tests
npx @modelcontextprotocol/inspector --cli \
  http://127.0.0.1:3311/mcp/ \
  --transport http \
  --method tools/list

npx @modelcontextprotocol/inspector --cli \
  http://127.0.0.1:3311/mcp/ \
  --transport http \
  --method tools/call \
  --tool-name notes_count
```

What to verify:

- `tools/list` returns the catalog the **anonymous** authorize callback
  permits (Inspector does not pass any Bearer token by default).
- `tools/call` on a public tool returns `content: [{type:"text", ...}]`.
- `tools/call` on a private tool fails with `-32001 Unauthorized` (and
  the underlying HTTP response carries `WWW-Authenticate` if OAuth
  discovery is configured).
- `tools/call` on an unknown name fails with `-32602 Unknown tool` and
  no audit row is written for it.
- Inspector handles the `initialize` handshake and `Mcp-Session-Id`
  lifecycle automatically; you only see the application-level results.

For a UI-based test, run Inspector without `--cli`; it opens a web
console where you can browse tools, edit args, and watch each
JSON-RPC frame.

## Real-client smoke test (any MCP-compatible client)

For an interactive smoke test against a real client (an IDE plugin,
an agent runtime, or any chat app that speaks MCP over Streamable
HTTP):

1. Deploy the playground (or your host) to a Convex project that has a
   reachable HTTPS URL (`npx convex deploy`).
2. In the client's MCP-server configuration, add an HTTP-transport
   entry pointing at `https://<your-deployment>.convex.site/mcp/`.
   The exact UI varies by client (config file, settings panel, or
   `mcp.json`), but the URL is the only required field for an
   unauthenticated test.
3. Reload the client. The registered tools appear in its integrations
   surface; calling them goes through the full session + authorize +
   audit pipeline.

If your deployment requires OAuth, the client follows the
`WWW-Authenticate` header to your authorization server and runs the
PKCE flow itself. Make sure your `auth.config.ts` issuer matches what
you configured via `gateway.setOAuthConfig`, and that the client is
either pre-registered at the IdP or your IdP supports Dynamic Client
Registration.

## Common pitfalls

- **Forgetting `registerComponent`.** Without it, `components.mcpGateway`
  resolves to `undefined` and tests fail with "Cannot read property
  'dispatch' of undefined".
- **Missing host `http.ts`.** `t.fetch("/mcp/", ...)` returns
  `404 No HttpAction routed for /mcp/` if the host hasn't mounted the
  route. Make sure your test's host fixture wires
  `gateway.handleMcpRequest` into `httpRouter`.
- **Calling `dispatch.runTool` without `auditIdentitySubject`.** It is
  required (the audit row needs *some* value, even `null`). The host's
  `handleMcpRequest` always passes one; tests must too.
- **Stale registry between tests.** Convex-test gives each test a fresh
  in-memory database, so this isn't an issue across files. Calling
  `gateway.register(ctx, [...])` inside each test always replaces the
  registry atomically, so cross-test contamination within a `describe`
  block is also not a concern.
