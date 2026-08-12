import { describe, expect, test, vi } from "vitest";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  completeCall,
  inputRequired,
  type McpBeforeCallArgs,
  type McpToolRegistration,
} from "../shared.js";
import { handleMcpRequest } from "./mcp-handler.js";

/**
 * Handler-level tests of the re-entrant MRTR state machine: the hook
 * runs on the first call AND on every verified continuation, decides
 * accept/decline/ask-again gateway-side, and the Convex function stays
 * MCP-unaware (only the idempotency key is injected). The component is
 * mocked, including an in-memory one-time redemption store.
 */

const registeredTool = {
  name: "confirm-delete",
  description: "Deletes after confirmation",
  kind: "mutation" as const,
  functionHandle: "function-handle",
  inputSchema: { type: "object" },
  mrtrArgs: { idempotencyKey: "continuationKey" },
  mrtrGated: true,
};

const CONFIRM_REQUEST = {
  confirm: {
    method: "elicitation/create",
    params: { mode: "form", message: "Delete report.txt?" },
  },
};

function component() {
  return {
    registry: {
      getTool: Symbol("getTool"),
      getOAuthConfig: Symbol("getOAuthConfig"),
    },
    dispatch: {
      runTool: Symbol("runTool"),
      recordAuthDenial: Symbol("recordAuthDenial"),
    },
    mrtr: { redeemContinuation: Symbol("redeemContinuation") },
    sessions: {
      getSession: Symbol("getSession"),
      touchSession: Symbol("touchSession"),
    },
  } as unknown as ComponentApi;
}

function request(
  id: number,
  params: Record<string, unknown>,
  clientCapabilities: Record<string, unknown> = { elicitation: { form: {} } },
  toolName: string = registeredTool.name,
): Request {
  return new Request("https://gateway.example/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": toolName,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: { file: "report.txt" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
        },
        ...params,
      },
    }),
  });
}

function legacyRequest(id: number, sessionId: string): Request {
  return new Request("https://gateway.example/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: registeredTool.name,
        arguments: { file: "report.txt" },
      },
    }),
  });
}

function declarativeTool(beforeCall: McpToolRegistration["beforeCall"]) {
  return {
    ...registeredTool,
    fn: {} as McpToolRegistration["fn"],
    functionReference: {},
    beforeCall,
  } as McpToolRegistration;
}

/**
 * Mocked handler context: registry lookup, dispatch recorder, and a
 * faithful in-memory implementation of the component's one-time
 * redemption semantics (fresh / replay / conflict).
 */
function harness(overrides: { tool?: unknown; oauthConfig?: unknown } = {}) {
  const api = component();
  const dispatched: Record<string, unknown>[] = [];
  const denials: Record<string, unknown>[] = [];
  const redemptions = new Map<string, string>();
  const ctx = {
    runQuery: async (ref: unknown) => {
      if (ref === api.registry.getTool) {
        return overrides.tool ?? registeredTool;
      }
      if (ref === api.registry.getOAuthConfig) {
        return overrides.oauthConfig ?? null;
      }
      throw new Error("unexpected query");
    },
    runMutation: async (ref: unknown, args: Record<string, unknown>) => {
      if (ref === api.mrtr.redeemContinuation) {
        const jti = args.jti as string;
        const digest = args.responsesDigest as string;
        const existing = redemptions.get(jti);
        if (existing === undefined) {
          redemptions.set(jti, digest);
          return "fresh";
        }
        return existing === digest ? "replay" : "conflict";
      }
      if (ref === api.dispatch.recordAuthDenial) {
        denials.push(args);
        return null;
      }
      return null;
    },
    runAction: async (ref: unknown, args: Record<string, unknown>) => {
      expect(ref).toBe(api.dispatch.runTool);
      dispatched.push(args);
      return { ok: true as const, data: { deleted: true } };
    },
    auth: { getUserIdentity: async () => ({ subject: "user-1" }) },
  };
  return { api, ctx, dispatched, denials };
}

function options(tool: McpToolRegistration, secret = "x".repeat(32)) {
  return {
    authorize: async () => ({ allowed: true as const }),
    mrtr: { secret },
    declarativeTools: [tool],
  };
}

async function json(response: Response) {
  return (await response.json()) as {
    result?: {
      resultType?: string;
      requestState?: string;
      inputRequests?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    error?: { code: number; message: string; data?: Record<string, unknown> };
  };
}

describe("re-entrant beforeCall state machine", () => {
  test("accept: hook runs on both rounds, function runs exactly once, MCP-unaware", async () => {
    const { api, ctx, dispatched } = harness();
    const hookCalls: McpBeforeCallArgs[] = [];
    const tool = declarativeTool(async (_ctx, hookArgs) => {
      hookCalls.push(hookArgs);
      if (hookArgs.inputResponses === undefined) {
        return inputRequired(CONFIRM_REQUEST, { operation: "delete" });
      }
      const confirm = hookArgs.inputResponses.confirm as { action?: string };
      if (confirm?.action !== "accept") {
        return completeCall({
          content: [{ type: "text", text: "Not deleted." }],
          isError: false,
        });
      }
      return null;
    });

    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    expect(first.result?.resultType).toBe("input_required");
    expect(first.result?.inputRequests).toEqual(CONFIRM_REQUEST);
    expect(dispatched).toHaveLength(0);
    expect(hookCalls[0]).toMatchObject({ args: { file: "report.txt" } });
    expect(hookCalls[0]!.inputResponses).toBeUndefined();

    const retry = await json(
      await handleMcpRequest(
        ctx,
        request(2, {
          requestState: first.result!.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(retry.result?.isError).toBe(false);
    expect(hookCalls).toHaveLength(2);
    // The verified continuation carries the decoded state, the
    // untrusted responses, the chain's key, and the round number.
    expect(hookCalls[1]).toMatchObject({
      state: { operation: "delete" },
      inputResponses: { confirm: { action: "accept" } },
      round: 1,
    });
    expect(typeof hookCalls[1]!.idempotencyKey).toBe("string");
    // Exactly one dispatch, and the ONLY injected extra is the key: the
    // Convex function never sees state or MCP response envelopes.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.args).toEqual({
      file: "report.txt",
      continuationKey: hookCalls[1]!.idempotencyKey,
    });
  });

  test("decline: hook completes the call and the function never runs", async () => {
    const { api, ctx, dispatched } = harness();
    let hookRounds = 0;
    const tool = declarativeTool(async (_ctx, { inputResponses }) => {
      hookRounds += 1;
      if (inputResponses === undefined) {
        return inputRequired(CONFIRM_REQUEST);
      }
      const confirm = inputResponses.confirm as { action?: string };
      return confirm?.action === "accept"
        ? null
        : completeCall({
            content: [{ type: "text", text: "Not deleted." }],
            isError: false,
          });
    });

    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const declined = await json(
      await handleMcpRequest(
        ctx,
        request(2, {
          requestState: first.result!.requestState,
          inputResponses: { confirm: { action: "decline" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(hookRounds).toBe(2);
    expect(dispatched).toHaveLength(0);
    expect(declined.result?.content?.[0]?.text).toBe("Not deleted.");
    expect(declined.result?.isError).toBe(false);
  });

  test("a retry can ask again: multi-round chains with a growing round counter", async () => {
    const { api, ctx, dispatched } = harness();
    const rounds: Array<number | undefined> = [];
    const tool = declarativeTool(async (_ctx, { inputResponses, round }) => {
      rounds.push(round);
      // Ask twice before continuing: round 1 answers are deliberately
      // treated as incomplete, per the "ask again" SHOULD.
      if (inputResponses === undefined) return inputRequired(CONFIRM_REQUEST);
      if ((round ?? 0) < 2) return inputRequired(CONFIRM_REQUEST);
      return null;
    });

    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const second = await json(
      await handleMcpRequest(
        ctx,
        request(2, {
          requestState: first.result!.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(second.result?.resultType).toBe("input_required");
    const third = await json(
      await handleMcpRequest(
        ctx,
        request(3, {
          requestState: second.result!.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(third.result?.isError).toBe(false);
    expect(dispatched).toHaveLength(1);
    expect(rounds).toEqual([undefined, 1, 2]);
  });

  test("extra or missing response keys are the hook's business, not a protocol error", async () => {
    const { api, ctx, dispatched } = harness();
    const tool = declarativeTool(async (_ctx, { inputResponses }) => {
      if (inputResponses === undefined) return inputRequired(CONFIRM_REQUEST);
      // Missing answer: ask again instead of erroring (spec SHOULD).
      if (inputResponses.confirm === undefined) {
        return inputRequired(CONFIRM_REQUEST);
      }
      return null; // unknown extra keys are simply ignored
    });

    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const missing = await json(
      await handleMcpRequest(
        ctx,
        request(2, {
          requestState: first.result!.requestState,
          inputResponses: { unrelated: { action: "accept" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(missing.result?.resultType).toBe("input_required");

    const extra = await json(
      await handleMcpRequest(
        ctx,
        request(3, {
          requestState: missing.result!.requestState,
          inputResponses: {
            confirm: { action: "accept" },
            extra: { action: "decline" },
          },
        }),
        api,
        options(tool),
      ),
    );
    expect(extra.result?.isError).toBe(false);
    expect(dispatched).toHaveLength(1);
  });

  test("hook-side argument mutation cannot poison the sealed digest", async () => {
    const { api, ctx, dispatched } = harness();
    const tool = declarativeTool(async (_ctx, hookArgs) => {
      // Normalize a nested value in place: must affect neither the
      // sealed digest nor what the retry verifies against.
      (hookArgs.args as Record<string, unknown>).file = "REPORT.TXT";
      if (hookArgs.inputResponses === undefined) {
        return inputRequired(CONFIRM_REQUEST);
      }
      return null;
    });
    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const retry = await json(
      await handleMcpRequest(
        ctx,
        request(2, {
          requestState: first.result!.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(retry.result?.isError).toBe(false);
    // Dispatch used the client-sent arguments, not the hook's mutation.
    expect(dispatched[0]!.args).toMatchObject({ file: "report.txt" });
  });
});

describe("continuation replay protection", () => {
  test("a resolved decline cannot be replayed into an accept", async () => {
    const { api, ctx, dispatched } = harness();
    const tool = declarativeTool(async (_ctx, { inputResponses }) => {
      if (inputResponses === undefined) return inputRequired(CONFIRM_REQUEST);
      const confirm = inputResponses.confirm as { action?: string };
      return confirm?.action === "accept"
        ? null
        : completeCall({
            content: [{ type: "text", text: "Not deleted." }],
            isError: false,
          });
    });

    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const requestState = first.result!.requestState;

    const declined = await json(
      await handleMcpRequest(
        ctx,
        request(2, {
          requestState,
          inputResponses: { confirm: { action: "decline" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(declined.result?.content?.[0]?.text).toBe("Not deleted.");

    // Same continuation, different answer: rejected outright.
    const flipped = await json(
      await handleMcpRequest(
        ctx,
        request(3, {
          requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(flipped.error?.code).toBe(-32602);
    expect(flipped.error?.message).toMatch(/already used/);
    expect(dispatched).toHaveLength(0);

    // Byte-identical re-send: an idempotent replay that re-processes
    // deterministically (e.g. a client network retry).
    const repeat = await json(
      await handleMcpRequest(
        ctx,
        request(4, {
          requestState,
          inputResponses: { confirm: { action: "decline" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(repeat.result?.content?.[0]?.text).toBe("Not deleted.");
    expect(dispatched).toHaveLength(0);
  });
});

describe("gating and negotiation", () => {
  test("a gated registry row without a hook fails closed, never dispatches", async () => {
    // The imperative-registration shape: `mrtrArgs` (or the stored
    // gate flag) without any declarativeTools on this handler.
    for (const row of [
      registeredTool,
      { ...registeredTool, mrtrArgs: undefined, mrtrGated: true },
    ]) {
      const { api, ctx, dispatched } = harness({ tool: row });
      const response = await handleMcpRequest(ctx, request(1, {}), api, {
        authorize: async () => ({ allowed: true as const }),
        mrtr: { secret: "x".repeat(32) },
      });
      const body = await json(response);
      expect(body.error?.code).toBe(-32603);
      expect(body.error?.message).toMatch(/confirmation hook/);
      expect(dispatched).toHaveLength(0);
    }
  });

  test("capability gate accumulates modes and reports only what is missing", async () => {
    const { api, ctx } = harness();
    // url-mode + form-mode requests against a form-only client: the
    // url requirement must survive the second (form) request.
    const tool = declarativeTool(async () =>
      inputRequired({
        connect: {
          method: "elicitation/create",
          params: { mode: "url", url: "https://example.com/connect" },
        },
        confirm: {
          method: "elicitation/create",
          params: { mode: "form", message: "Confirm?" },
        },
      }),
    );
    const response = await handleMcpRequest(
      ctx,
      request(1, {}, { elicitation: { form: {} } }),
      api,
      options(tool),
    );
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error?.code).toBe(-32021);
    // Only the MISSING half is reported, not the full required set.
    expect(body.error?.data?.requiredCapabilities).toEqual({
      elicitation: { url: {} },
    });
  });

  test("form mode is rejected for a url-only client, accepted for empty elicitation", async () => {
    const tool = declarativeTool(async () =>
      inputRequired(CONFIRM_REQUEST),
    );
    // url-only client: form requests are NOT covered.
    {
      const { api, ctx } = harness();
      const body = await json(
        await handleMcpRequest(
          ctx,
          request(1, {}, { elicitation: { url: {} } }),
          api,
          options(tool),
        ),
      );
      expect(body.error?.code).toBe(-32021);
      expect(body.error?.data?.requiredCapabilities).toEqual({
        elicitation: { form: {} },
      });
    }
    // Backwards-compat: empty elicitation declares form-only support.
    {
      const { api, ctx } = harness();
      const body = await json(
        await handleMcpRequest(
          ctx,
          request(2, {}, { elicitation: {} }),
          api,
          options(tool),
        ),
      );
      expect(body.result?.resultType).toBe("input_required");
    }
    // No elicitation at all: everything is missing.
    {
      const { api, ctx } = harness();
      const body = await json(
        await handleMcpRequest(ctx, request(3, {}, {}), api, options(tool)),
      );
      expect(body.error?.code).toBe(-32021);
      expect(body.error?.data?.requiredCapabilities).toEqual({
        elicitation: { form: {} },
      });
    }
  });

  test("an anonymous call gets the audited 401 challenge, like identityArg", async () => {
    const { api, ctx, denials, dispatched } = harness({
      oauthConfig: { authServerUrl: "https://as.example.com" },
    });
    (ctx.auth as { getUserIdentity: () => Promise<unknown> }).getUserIdentity =
      async () => null;
    const tool = declarativeTool(async () => inputRequired(CONFIRM_REQUEST));
    const response = await handleMcpRequest(
      ctx,
      request(1, {}),
      api,
      options(tool),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(
      /resource_metadata=/,
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ outcome: "denied" });
    expect(dispatched).toHaveLength(0);
  });

  test("a short secret is a -32603 server misconfiguration, on both paths", async () => {
    const tool = declarativeTool(async (_ctx, { inputResponses }) =>
      inputResponses === undefined ? inputRequired(CONFIRM_REQUEST) : null,
    );
    // Seal path.
    {
      const { api, ctx } = harness();
      const body = await json(
        await handleMcpRequest(
          ctx,
          request(1, {}),
          api,
          options(tool, "too-short"),
        ),
      );
      expect(body.error?.code).toBe(-32603);
    }
    // Verify path: a syntactically plausible state must not be blamed
    // on the client when the server cannot verify anything.
    {
      const { api, ctx } = harness();
      const body = await json(
        await handleMcpRequest(
          ctx,
          request(2, {
            requestState: "abc.def",
            inputResponses: { confirm: { action: "accept" } },
          }),
          api,
          options(tool, "too-short"),
        ),
      );
      expect(body.error?.code).toBe(-32603);
    }
  });

  test("a nonsensical ttlMs is a -32603 server misconfiguration, not -32602", async () => {
    const tool = declarativeTool(async (_ctx, { inputResponses }) =>
      inputResponses === undefined ? inputRequired(CONFIRM_REQUEST) : null,
    );
    for (const ttlMs of [0, -1, NaN, Infinity]) {
      const { api, ctx, dispatched } = harness();
      const body = await json(
        await handleMcpRequest(ctx, request(1, {}), api, {
          ...options(tool),
          mrtr: { secret: "x".repeat(32), ttlMs },
        }),
      );
      expect(body.error?.code, `ttlMs=${ttlMs}`).toBe(-32603);
      expect(dispatched).toHaveLength(0);
    }
  });

  test("a completeCall result without a content array is a -32603, not shipped", async () => {
    const { api, ctx, dispatched } = harness();
    const tool = declarativeTool(async (_ctx, { inputResponses }) => {
      if (inputResponses === undefined) return inputRequired(CONFIRM_REQUEST);
      // Malformed: no `content` array. A spec-compliant client would
      // reject this, so the gateway must not forward it verbatim.
      return completeCall({ message: "Not archived." } as never);
    });
    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const body = await json(
      await handleMcpRequest(
        ctx,
        request(2, {
          requestState: first.result!.requestState,
          inputResponses: { confirm: { action: "decline" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(body.error?.code).toBe(-32603);
    expect(body.result).toBeUndefined();
    expect(dispatched).toHaveLength(0);
  });

  test("a hook chain past the round ceiling is rejected", async () => {
    const { api, ctx, dispatched } = harness();
    // A hook that asks for input forever; the gateway caps the chain.
    const tool = declarativeTool(async () => inputRequired(CONFIRM_REQUEST));
    let response = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    let requestState = response.result!.requestState!;
    let id = 2;
    // Drive the chain until it is rejected or we exceed a safe bound.
    for (let i = 0; i < 32; i++) {
      response = await json(
        await handleMcpRequest(
          ctx,
          request(id++, {
            requestState,
            inputResponses: { confirm: { action: "accept" } },
          }),
          api,
          options(tool),
        ),
      );
      if (response.error) break;
      requestState = response.result!.requestState!;
    }
    expect(response.error?.code).toBe(-32603);
    expect(response.error?.message).toMatch(/round limit/);
    expect(dispatched).toHaveLength(0);
  });
});

describe("legacy transport", () => {
  const session = {
    sessionId: "legacy-session",
    protocolVersion: "2025-06-18",
    identitySubject: "user-1",
    createdAt: 0,
    lastSeenAt: 0,
  };

  function legacyCtx(api: ComponentApi, onDispatch: () => void) {
    return {
      runQuery: async (ref: unknown) => {
        if (ref === api.sessions.getSession) return session;
        if (ref === api.registry.getTool) return registeredTool;
        if (ref === api.registry.getOAuthConfig) return null;
        throw new Error("unexpected query");
      },
      runMutation: async (ref: unknown) => {
        if (ref === api.sessions.touchSession) return true;
        return null;
      },
      runAction: async () => {
        onDispatch();
        return { ok: true as const, data: { done: true } };
      },
      auth: { getUserIdentity: async () => ({ subject: "user-1" }) },
    };
  }

  test("a hook demanding input fails a legacy call closed", async () => {
    const api = component();
    let dispatched = false;
    const tool = declarativeTool(async () => inputRequired(CONFIRM_REQUEST));
    const body = await json(
      await handleMcpRequest(
        legacyCtx(api, () => (dispatched = true)),
        legacyRequest(1, session.sessionId),
        api,
        options(tool),
      ),
    );
    expect(body.error?.code).toBe(-32601);
    expect(body.error?.message).toMatch(/multi-round-trip/);
    expect(dispatched).toBe(false);
  });

  test("a hook that passes (or completes) still works on legacy", async () => {
    const api = component();
    let dispatched = false;
    const passthrough = declarativeTool(async () => null);
    const passBody = await json(
      await handleMcpRequest(
        legacyCtx(api, () => (dispatched = true)),
        legacyRequest(1, session.sessionId),
        api,
        options(passthrough),
      ),
    );
    expect(passBody.result?.isError).toBe(false);
    expect(dispatched).toBe(true);

    dispatched = false;
    const completing = declarativeTool(async () =>
      completeCall({
        content: [{ type: "text", text: "Handled gateway-side." }],
        isError: false,
      }),
    );
    const completeBody = await json(
      await handleMcpRequest(
        legacyCtx(api, () => (dispatched = true)),
        legacyRequest(2, session.sessionId),
        api,
        options(completing),
      ),
    );
    expect(completeBody.result?.content?.[0]?.text).toBe(
      "Handled gateway-side.",
    );
    expect(dispatched).toBe(false);
  });
});

describe("continuation integrity", () => {
  function confirmingTool() {
    return declarativeTool(async (_ctx, { inputResponses }) =>
      inputResponses === undefined ? inputRequired(CONFIRM_REQUEST) : null,
    );
  }

  test("altered arguments invalidate the continuation before any hook or dispatch", async () => {
    const { api, ctx, dispatched } = harness();
    const tool = confirmingTool();
    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const altered = await json(
      await handleMcpRequest(
        ctx,
        request(2, {
          arguments: { file: "other.txt" },
          requestState: first.result!.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(altered.error?.code).toBe(-32602);
    expect(dispatched).toHaveLength(0);
  });

  test("expired, tampered, and truncated continuations are rejected", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-12T00:00:00Z"));
      const { api, ctx, dispatched } = harness();
      const tool = confirmingTool();
      const first = await json(
        await handleMcpRequest(ctx, request(1, {}), api, {
          ...options(tool),
          mrtr: { secret: "x".repeat(32), ttlMs: 1 },
        }),
      );
      const requestState = first.result!.requestState!;

      for (const bad of [
        `${requestState}x`,
        requestState.slice(0, requestState.indexOf(".")),
      ]) {
        const body = await json(
          await handleMcpRequest(
            ctx,
            request(2, {
              requestState: bad,
              inputResponses: { confirm: { action: "accept" } },
            }),
            api,
            options(tool),
          ),
        );
        expect(body.error?.code).toBe(-32602);
      }

      vi.advanceTimersByTime(2);
      const expired = await json(
        await handleMcpRequest(
          ctx,
          request(3, {
            requestState,
            inputResponses: { confirm: { action: "accept" } },
          }),
          api,
          { ...options(tool), mrtr: { secret: "x".repeat(32), ttlMs: 1 } },
        ),
      );
      expect(expired.error?.code).toBe(-32602);
      expect(dispatched).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a continuation cannot be replayed against a different tool", async () => {
    const otherRegisteredTool = { ...registeredTool, name: "confirm-archive" };
    const api = component();
    const dispatched: unknown[] = [];
    const redemptions = new Map<string, string>();
    const ctx = {
      runQuery: async (ref: unknown, args: Record<string, unknown>) => {
        if (ref === api.registry.getTool) {
          return args.name === registeredTool.name
            ? registeredTool
            : otherRegisteredTool;
        }
        if (ref === api.registry.getOAuthConfig) return null;
        throw new Error("unexpected query");
      },
      runMutation: async (ref: unknown, args: Record<string, unknown>) => {
        if (ref === api.mrtr.redeemContinuation) {
          const existing = redemptions.get(args.jti as string);
          if (existing === undefined) {
            redemptions.set(args.jti as string, args.responsesDigest as string);
            return "fresh";
          }
          return existing === args.responsesDigest ? "replay" : "conflict";
        }
        return null;
      },
      runAction: async (_ref: unknown, args: unknown) => {
        dispatched.push(args);
        return { ok: true as const, data: {} };
      },
      auth: { getUserIdentity: async () => ({ subject: "user-1" }) },
    };
    const hook = async (
      _ctx: unknown,
      { inputResponses }: McpBeforeCallArgs,
    ) => (inputResponses === undefined ? inputRequired(CONFIRM_REQUEST) : null);
    const tool = declarativeTool(hook);
    const otherTool = {
      ...declarativeTool(hook),
      name: otherRegisteredTool.name,
    } as McpToolRegistration;
    const opts = { ...options(tool), declarativeTools: [tool, otherTool] };

    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, opts),
    );
    const replay = await json(
      await handleMcpRequest(
        ctx,
        request(
          2,
          {
            requestState: first.result!.requestState,
            inputResponses: { confirm: { action: "accept" } },
          },
          { elicitation: { form: {} } },
          otherTool.name,
        ),
        api,
        opts,
      ),
    );
    expect(replay.error?.code).toBe(-32602);
    expect(dispatched).toHaveLength(0);
  });

  test("state-only continuations remain valid without inputResponses", async () => {
    const { api, ctx, dispatched } = harness();
    const seen: unknown[] = [];
    const tool = declarativeTool(async (_ctx, hookArgs) => {
      if (hookArgs.round === undefined) {
        return inputRequired({}, { queued: true });
      }
      seen.push(hookArgs.state);
      return null;
    });
    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const resumed = await json(
      await handleMcpRequest(
        ctx,
        request(2, { requestState: first.result!.requestState }),
        api,
        options(tool),
      ),
    );
    expect(resumed.result?.isError).toBe(false);
    expect(seen).toEqual([{ queued: true }]);
    expect(dispatched).toHaveLength(1);
  });

  test("an oversized state fails sealing closed", async () => {
    const { api, ctx, dispatched } = harness();
    const tool = declarativeTool(async () =>
      inputRequired({}, "x".repeat(8 * 1024 + 1)),
    );
    const body = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    expect(body.error?.code).toBe(-32603);
    expect(dispatched).toHaveLength(0);
  });
});
