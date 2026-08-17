import { describe, expect, test, vi } from "vitest";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  completeCall,
  completeRead,
  declineRead,
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
      // Read by the resources path; the MRTR-on-reads tests below use it.
      listResources: Symbol("listResources"),
      listResourceTemplates: Symbol("listResourceTemplates"),
    },
    dispatch: {
      runTool: Symbol("runTool"),
      recordAuthDenial: Symbol("recordAuthDenial"),
    },
    mrtr: {
      redeemContinuation: Symbol("redeemContinuation"),
      claimChain: Symbol("claimChain"),
      getChainResolution: Symbol("getChainResolution"),
    },
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
  // Chain claims model `expiresAt` too, so a test can drive the prune
  // and prove the claim outlives every continuation of its chain. A map
  // without expiry cannot express that failure at all.
  const chains = new Map<
    string,
    {
      resolution: string;
      resolvedByJti: string;
      resolvedByDigest?: string;
      expiresAt: number;
    }
  >();
  /** Mirrors `pruneMrtrRedemptions`: drop claims that expired before `now`. */
  const pruneChains = (now: number) => {
    for (const [key, row] of chains) {
      if (row.expiresAt < now) chains.delete(key);
    }
  };
  const ctx = {
    runQuery: async (ref: unknown, args: Record<string, unknown> = {}) => {
      if (ref === api.registry.getTool) {
        return overrides.tool ?? registeredTool;
      }
      if (
        ref === api.registry.listResources ||
        ref === api.registry.listResourceTemplates
      ) {
        return [];
      }
      // Legacy requests look the session up; the read tests below use one
      // to exercise the legacy half of the fail-closed rule.
      if (ref === api.sessions.getSession) {
        return {
          sessionId: "s".repeat(32),
          protocolVersion: "2025-06-18",
          identitySubject: "user-1",
        };
      }
      if (ref === api.registry.getOAuthConfig) {
        return overrides.oauthConfig ?? null;
      }
      if (ref === api.mrtr.getChainResolution) {
        const row = chains.get(args.chainKey as string);
        if (!row) return null;
        return {
          resolution: row.resolution,
          resolvedByJti: row.resolvedByJti,
          ...(row.resolvedByDigest !== undefined
            ? { resolvedByDigest: row.resolvedByDigest }
            : {}),
        };
      }
      throw new Error("unexpected query");
    },
    runMutation: async (ref: unknown, args: Record<string, unknown>) => {
      if (ref === api.mrtr.redeemContinuation) {
        const jti = args.jti as string;
        const digest = args.responsesDigest as string | undefined;
        // No responses decides nothing, so nothing is pinned.
        if (digest === undefined) return "fresh";
        const existing = redemptions.get(jti);
        if (existing === undefined) {
          redemptions.set(jti, digest);
          return "fresh";
        }
        return existing === digest ? "replay" : "conflict";
      }
      if (ref === api.mrtr.claimChain) {
        const chainKey = args.chainKey as string;
        // Mirrors the component: losing the claim reports the WINNER's
        // resolution, so the handler can tell an idempotent repeat from
        // a cross-resolution flip, and never shortens the window.
        const existing = chains.get(chainKey);
        const expiresAt = args.expiresAt as number;
        if (existing !== undefined) {
          if (expiresAt > existing.expiresAt) existing.expiresAt = expiresAt;
          return {
            resolution: existing.resolution,
            resolvedByJti: existing.resolvedByJti,
            ...(existing.resolvedByDigest !== undefined
              ? { resolvedByDigest: existing.resolvedByDigest }
              : {}),
          };
        }
        chains.set(chainKey, {
          resolution: args.resolution as string,
          resolvedByJti: args.jti as string,
          ...(args.responsesDigest !== undefined
            ? { resolvedByDigest: args.responsesDigest as string }
            : {}),
          expiresAt,
        });
        return "claimed";
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
  return { api, ctx, dispatched, denials, pruneChains };
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
  test("a hook whose registry row lost its mrtrArgs fails closed", async () => {
    // The mirror of the case below, and the only place both facts are
    // visible: the hook comes from this handler's catalog, the reserved
    // key from the row. Dispatching here would run a confirmed mutation
    // with nothing to deduplicate the allowed replay against.
    const { api, ctx, dispatched } = harness({
      tool: { ...registeredTool, mrtrArgs: undefined, mrtrGated: true },
    });
    const tool = declarativeTool(async () => null);
    const body = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toMatch(/missing the idempotency key/);
    expect(dispatched).toHaveLength(0);
  });

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

  test("supported input uses the request even when a fallback is provided", async () => {
    for (const clientCapabilities of [
      { elicitation: { form: {} } },
      { elicitation: {} },
    ]) {
      const { api, ctx, dispatched } = harness();
      const tool = declarativeTool(async () =>
        inputRequired(CONFIRM_REQUEST, undefined, {
          onUnsupported: completeCall({
            content: [{ type: "text", text: "Use the calling agent." }],
          }),
        }),
      );
      const body = await json(
        await handleMcpRequest(
          ctx,
          request(1, {}, clientCapabilities),
          api,
          options(tool),
        ),
      );

      expect(body.result?.resultType).toBe("input_required");
      expect(body.result?.content).toBeUndefined();
      expect(dispatched).toHaveLength(0);
    }
  });

  test("unsupported input uses the fallback without dispatching", async () => {
    for (const clientCapabilities of [
      { elicitation: { url: {} } },
      {},
    ]) {
      const { api, ctx, dispatched } = harness();
      const tool = declarativeTool(async () =>
        inputRequired(CONFIRM_REQUEST, undefined, {
          onUnsupported: completeCall({
            content: [{ type: "text", text: "Use the calling agent." }],
            structuredContent: { outcome: "interaction_required" },
          }),
        }),
      );
      const body = await json(
        await handleMcpRequest(
          ctx,
          request(1, {}, clientCapabilities),
          api,
          options(tool),
        ),
      );

      expect(body.error).toBeUndefined();
      expect(body.result?.content?.[0]?.text).toBe("Use the calling agent.");
      expect(body.result?.requestState).toBeUndefined();
      expect(dispatched).toHaveLength(0);
    }
  });

  test("sampling and roots can use the same unsupported fallback", async () => {
    for (const method of ["sampling/createMessage", "roots/list"]) {
      const { api, ctx, dispatched } = harness();
      const tool = declarativeTool(async () =>
        inputRequired(
          { request: { method } },
          undefined,
          {
            onUnsupported: completeCall({
              content: [{ type: "text", text: "Handled by the agent." }],
            }),
          },
        ),
      );
      const body = await json(
        await handleMcpRequest(ctx, request(1, {}, {}), api, options(tool)),
      );

      expect(body.result?.content?.[0]?.text).toBe("Handled by the agent.");
      expect(dispatched).toHaveLength(0);
    }
  });

  test("a nullish fallback is no fallback, never a pass", async () => {
    // `null` is the value that means "continue to the Convex function",
    // so substituting it would silently drop the gate the hook asked
    // for. TypeScript rejects it, an untyped host can still get here.
    for (const onUnsupported of [null, undefined]) {
      const { api, ctx, dispatched } = harness();
      const tool = declarativeTool(async () =>
        inputRequired(CONFIRM_REQUEST, undefined, {
          onUnsupported: onUnsupported as never,
        }),
      );
      const body = await json(
        await handleMcpRequest(ctx, request(1, {}, {}), api, options(tool)),
      );

      expect(body.error?.code).toBe(-32021);
      expect(body.error?.data?.requiredCapabilities).toEqual({
        elicitation: { form: {} },
      });
      expect(dispatched).toHaveLength(0);
    }
  });

  test("an unvouchable request stays a named hook bug, fallback or not", async () => {
    // A typo'd method is a host bug on every era, so it must not be
    // dressed up as the `-32601` "upgrade your protocol" answer a
    // session-era client would otherwise get: an upgrade cannot fix it.
    for (const onUnsupported of [
      null,
      completeCall({ content: [{ type: "text", text: "Ask the agent." }] }),
    ]) {
      const api = component();
      let dispatched = false;
      const tool = declarativeTool(async () =>
        inputRequired(
          { confirm: { method: "elicitaton/create" } },
          undefined,
          { onUnsupported: onUnsupported as never },
        ),
      );
      const body = await json(
        await handleMcpRequest(
          {
            runQuery: async (ref: unknown) => {
              if (ref === api.sessions.getSession)
                return {
                  sessionId: "s".repeat(32),
                  protocolVersion: "2025-06-18",
                  identitySubject: "user-1",
                  lastSeenAt: 0,
                };
              if (ref === api.registry.getTool) return registeredTool;
              if (ref === api.registry.getOAuthConfig) return null;
              throw new Error("unexpected query");
            },
            runMutation: async () => null,
            runAction: async () => {
              dispatched = true;
              return { ok: true as const, data: {} };
            },
            auth: { getUserIdentity: async () => ({ subject: "user-1" }) },
          } as never,
          legacyRequest(1, "s".repeat(32)),
          api,
          options(tool),
        ),
      );

      expect(body.error?.code).toBe(-32603);
      expect(body.error?.message).toMatch(/unsupported input requests/);
      expect(dispatched).toBe(false);
    }
  });

  test("an invalid selected fallback is a gateway error", async () => {
    const { api, ctx, dispatched } = harness();
    const tool = declarativeTool(async () =>
      inputRequired(CONFIRM_REQUEST, undefined, {
        onUnsupported: {
          __mcpCompleteCall: true,
          result: {},
        } as never,
      }),
    );
    const body = await json(
      await handleMcpRequest(ctx, request(1, {}, {}), api, options(tool)),
    );

    expect(body.error?.code).toBe(-32603);
    expect(dispatched).toHaveLength(0);
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

  test("a completeCall result JSON cannot represent stays a JSON-RPC response", async () => {
    // Hook code runs in the host isolate, so a `v.int64()` field read
    // straight off a document reaches the wire as a bigint. The shape
    // check passes (there IS a content array), so only serialization
    // catches it, and by this point the MRTR chain claim is written:
    // escaping as a raw 500 would leave the client with no envelope, no
    // CORS header and no retry.
    const { api, ctx, dispatched } = harness();
    const tool = declarativeTool(async (_ctx, { inputResponses }) => {
      if (inputResponses === undefined) return inputRequired(CONFIRM_REQUEST);
      return completeCall({
        content: [{ type: "text", text: "Not archived." }],
        structuredContent: { attempts: BigInt(2) },
        isError: false,
      } as never);
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
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/cannot be represented/);
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

  function legacyCtx(
    api: ComponentApi,
    onDispatch: () => void,
    sessionRow: typeof session = session,
  ) {
    return {
      runQuery: async (ref: unknown) => {
        if (ref === api.sessions.getSession) return sessionRow;
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

  test("a legacy hook can use an unsupported fallback without dispatching", async () => {
    const api = component();
    let dispatched = false;
    const tool = declarativeTool(async () =>
      inputRequired(CONFIRM_REQUEST, undefined, {
        onUnsupported: completeCall({
          content: [{ type: "text", text: "Handled by the calling agent." }],
        }),
      }),
    );
    const body = await json(
      await handleMcpRequest(
        legacyCtx(api, () => (dispatched = true)),
        legacyRequest(1, session.sessionId),
        api,
        options(tool),
      ),
    );

    expect(body.result?.content?.[0]?.text).toBe(
      "Handled by the calling agent.",
    );
    expect(dispatched).toBe(false);
  });

  test("a nullish legacy fallback still fails closed", async () => {
    const api = component();
    let dispatched = false;
    const tool = declarativeTool(async () =>
      inputRequired(CONFIRM_REQUEST, undefined, {
        onUnsupported: null as never,
      }),
    );
    const body = await json(
      await handleMcpRequest(
        legacyCtx(api, () => (dispatched = true)),
        legacyRequest(1, session.sessionId),
        api,
        options(tool),
      ),
    );

    expect(body.error?.code).toBe(-32601);
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

/**
 * A chain resolves exactly once. The per-continuation redemption above
 * cannot provide this: `jti` is fresh per round, so every
 * `inputRequired()` seals an independent continuation, and any path
 * that makes the hook ask again forks a branch that no sibling's
 * redemption covers. See issue #27.
 */
describe("chain resolution", () => {
  /** The confirmation hook shape shipped in README + example. */
  const confirmHook = async (
    _ctx: unknown,
    hookArgs: McpBeforeCallArgs,
  ): Promise<unknown> => {
    if (hookArgs.round === undefined) return inputRequired(CONFIRM_REQUEST);
    const confirm = hookArgs.inputResponses?.confirm as
      | { action?: string }
      | undefined;
    if (confirm === undefined) return inputRequired(CONFIRM_REQUEST);
    if (confirm.action !== "accept") {
      return completeCall({
        content: [{ type: "text", text: "declined" }],
        isError: false,
      });
    }
    return null;
  };

  test("a replay cannot fork a branch that outlives the resolved decision", async () => {
    const { api, ctx, dispatched } = harness();
    const tool = declarativeTool(
      confirmHook as McpToolRegistration["beforeCall"],
    );
    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const c1 = first.result!.requestState!;

    // Round 1 answered with a payload carrying no usable answer, so the
    // hook asks again and round 2 mints c2. c1 is pinned with that
    // payload's digest, which is what makes the replay below "valid".
    const incomplete = { unrelated: { action: "accept" } };
    const second = await json(
      await handleMcpRequest(
        ctx,
        request(2, { requestState: c1, inputResponses: incomplete }),
        api,
        options(tool),
      ),
    );
    const c2 = second.result!.requestState!;
    expect(c2).toBeDefined();

    // The user declines on c2. The chain is now resolved.
    const declined = await json(
      await handleMcpRequest(
        ctx,
        request(3, {
          requestState: c2,
          inputResponses: { confirm: { action: "decline" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(declined.result?.content?.[0]?.text).toBe("declined");
    expect(dispatched).toHaveLength(0);

    // An attacker who captured c1 re-sends it byte-identically. The
    // redemption calls that an idempotent replay and re-runs the hook,
    // which asks again: without a chain claim that mints a brand-new,
    // unpinned continuation the attacker could answer with "accept".
    const forked = await json(
      await handleMcpRequest(
        ctx,
        request(4, { requestState: c1, inputResponses: incomplete }),
        api,
        options(tool),
      ),
    );
    expect(forked.result?.requestState).toBeUndefined();
    expect(forked.error?.code).toBe(-32602);
    expect(dispatched).toHaveLength(0);

    // And the already-issued sibling c2 cannot be answered again either.
    const reused = await json(
      await handleMcpRequest(
        ctx,
        request(5, {
          requestState: c2,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(reused.error?.code).toBe(-32602);
    expect(dispatched).toHaveLength(0);
  });

  test("a state-only retry resumes the chain, and the answer still lands", async () => {
    const { api, ctx, dispatched } = harness();
    const tool = declarativeTool(
      confirmHook as McpToolRegistration["beforeCall"],
    );
    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const c1 = first.result!.requestState!;

    // Resuming with state but no answer must not pin the continuation
    // with an empty answer: nothing has been decided yet.
    const resumed = await json(
      await handleMcpRequest(
        ctx,
        request(2, { requestState: c1 }),
        api,
        options(tool),
      ),
    );
    expect(resumed.error).toBeUndefined();
    expect(resumed.result?.requestState).toBeDefined();

    // The real answer arrives on that same continuation and resolves
    // the chain by dispatching.
    const accepted = await json(
      await handleMcpRequest(
        ctx,
        request(3, {
          requestState: c1,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(accepted.error).toBeUndefined();
    expect(dispatched).toHaveLength(1);

    // The sibling minted by the state-only round is refused: only a
    // byte-identical re-send of the continuation that actually resolved
    // the chain may repeat the outcome, never a different branch.
    const sibling = await json(
      await handleMcpRequest(
        ctx,
        request(4, {
          requestState: resumed.result!.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(sibling.error?.code).toBe(-32602);
    expect(dispatched).toHaveLength(1);

    // The continuation that DID resolve it may be re-sent verbatim: a
    // client whose response was lost dispatches again under the same
    // chain key, which is what the tool deduplicates on.
    const lostResponse = await json(
      await handleMcpRequest(
        ctx,
        request(5, {
          requestState: c1,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(lostResponse.error).toBeUndefined();
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]!.args).toEqual(dispatched[0]!.args);
  });

  test("a replayed sibling cannot pass its own answer off as the resolution", async () => {
    const { api, ctx, dispatched } = harness();
    // A hook whose decision depends on state outside the chain, which
    // is the realistic case (it reads the database). The same round-1
    // payload therefore asks again now and completes later.
    let external: "asking" | "ready" = "asking";
    const tool = declarativeTool(async (_ctx, hookArgs) => {
      if (hookArgs.round === undefined) return inputRequired(CONFIRM_REQUEST);
      const confirm = hookArgs.inputResponses?.confirm as
        | { action?: string }
        | undefined;
      if (external === "asking" && confirm === undefined) {
        return inputRequired(CONFIRM_REQUEST);
      }
      return completeCall({
        content: [{ type: "text", text: `settled-in-round-${hookArgs.round}` }],
        isError: false,
      });
    });
    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const c1 = first.result!.requestState!;

    // Round 1 answered with nothing usable, so a sibling c2 is minted.
    const incomplete = { unrelated: { action: "accept" } };
    const second = await json(
      await handleMcpRequest(
        ctx,
        request(2, { requestState: c1, inputResponses: incomplete }),
        api,
        options(tool),
      ),
    );
    const c2 = second.result!.requestState!;

    // c2 resolves the chain.
    const settled = await json(
      await handleMcpRequest(
        ctx,
        request(3, {
          requestState: c2,
          inputResponses: { confirm: { action: "decline" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(settled.result?.content?.[0]?.text).toBe("settled-in-round-2");

    // Now the same round-1 payload would COMPLETE rather than ask again.
    external = "ready";

    // Re-sending c1 byte-identically is a genuine redemption "replay",
    // but c1 is not the continuation that resolved the chain. Handing
    // back its hook output would report an answer that was never the
    // settled one.
    const replayedSibling = await json(
      await handleMcpRequest(
        ctx,
        request(4, { requestState: c1, inputResponses: incomplete }),
        api,
        options(tool),
      ),
    );
    expect(replayedSibling.result?.content?.[0]?.text).not.toBe(
      "settled-in-round-1",
    );
    expect(replayedSibling.error?.code).toBe(-32602);

    // The continuation that DID resolve it still reproduces its result.
    const lostResponse = await json(
      await handleMcpRequest(
        ctx,
        request(5, {
          requestState: c2,
          inputResponses: { confirm: { action: "decline" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(lostResponse.result?.content?.[0]?.text).toBe("settled-in-round-2");
    expect(dispatched).toHaveLength(0);
  });

  test("a state-only chain can still retry its lost response", async () => {
    const { api, ctx, dispatched } = harness();
    // Resolves on state alone: no inputResponses ever, so there is no
    // redemption row to recognise the retry by.
    const tool = declarativeTool(async (_ctx, hookArgs) =>
      hookArgs.round === undefined ? inputRequired(CONFIRM_REQUEST) : null,
    );
    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const c1 = first.result!.requestState!;

    const dispatchedOnce = await json(
      await handleMcpRequest(
        ctx,
        request(2, { requestState: c1 }),
        api,
        options(tool),
      ),
    );
    expect(dispatchedOnce.error).toBeUndefined();
    expect(dispatched).toHaveLength(1);

    // The client never saw the response and retries the same state. It
    // must dispatch again under the SAME chain key, which is what the
    // tool deduplicates on, rather than being told to start over (which
    // would mint a new key and re-apply the side effect for real).
    const retried = await json(
      await handleMcpRequest(
        ctx,
        request(3, { requestState: c1 }),
        api,
        options(tool),
      ),
    );
    expect(retried.error).toBeUndefined();
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]!.args).toEqual(dispatched[0]!.args);
  });

  test("the claim outlives every continuation, so pruning cannot re-open it", async () => {
    const { api, ctx, dispatched, pruneChains } = harness();
    const tool = declarativeTool(
      confirmHook as McpToolRegistration["beforeCall"],
    );
    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const c1 = first.result!.requestState!;

    // A state-only retry forks a sibling LATER than c1, so the sibling
    // stays cryptographically valid after c1 has expired. If the claim
    // were written with the resolving continuation's expiry, the prune
    // would drop it while this sibling can still be answered.
    const resumed = await json(
      await handleMcpRequest(
        ctx,
        request(2, { requestState: c1 }),
        api,
        options(tool),
      ),
    );
    const sibling = resumed.result!.requestState!;

    // The user declines on c1, resolving the chain.
    const declined = await json(
      await handleMcpRequest(
        ctx,
        request(3, {
          requestState: c1,
          inputResponses: { confirm: { action: "decline" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(declined.result?.content?.[0]?.text).toBe("declined");

    // Run the prune well past c1's own five-minute expiry. The claim
    // must survive: the sibling has not expired yet.
    pruneChains(Date.now() + 10 * 60 * 1000);

    const flipped = await json(
      await handleMcpRequest(
        ctx,
        request(4, {
          requestState: sibling,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(flipped.error?.code).toBe(-32602);
    expect(dispatched).toHaveLength(0);
  });

  test("a settled decline cannot be dispatched through a sibling", async () => {
    const { api, ctx, dispatched } = harness();
    const tool = declarativeTool(
      confirmHook as McpToolRegistration["beforeCall"],
    );
    const first = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const c1 = first.result!.requestState!;

    // A state-only retry forks a sibling while nothing is decided yet.
    const resumed = await json(
      await handleMcpRequest(
        ctx,
        request(2, { requestState: c1 }),
        api,
        options(tool),
      ),
    );
    const sibling = resumed.result!.requestState!;

    // The user declines on the original continuation.
    const declined = await json(
      await handleMcpRequest(
        ctx,
        request(3, {
          requestState: c1,
          inputResponses: { confirm: { action: "decline" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(declined.result?.content?.[0]?.text).toBe("declined");

    // Answering the sibling with an accept must not run the tool: that
    // is the decline-to-accept flip, taken through a forked branch.
    const flipped = await json(
      await handleMcpRequest(
        ctx,
        request(4, {
          requestState: sibling,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options(tool),
      ),
    );
    expect(flipped.error?.code).toBe(-32602);
    expect(dispatched).toHaveLength(0);
  });
});

/**
 * MRTR on `resources/read`. The spec allows a read to answer with an
 * `InputRequiredResult`, and the mechanics are the tool path's: a sealed
 * `requestState`, a one-time `jti` redemption, and a chain that resolves
 * exactly once. These tests cover what is specific to reads, namely the
 * two read-shaped terminal decisions and the URI binding.
 */
describe("MRTR on resources/read", () => {
  const URI = "docs://confidential";
  const CONTENTS = [{ uri: URI, mimeType: "text/plain", text: "full text" }];

  function readRequest(
    id: number,
    params: Record<string, unknown> = {},
    clientCapabilities: Record<string, unknown> = { elicitation: { form: {} } },
    uri: string = URI,
  ): Request {
    return new Request("https://gateway.example/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "resources/read",
        "mcp-name": uri,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "resources/read",
        params: {
          uri,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
          },
          ...params,
        },
      }),
    });
  }

  function readHarness(
    beforeResourceRead: (
      ctx: unknown,
      args: {
        uri: string;
        resourceMetadata: unknown;
        identity: { subject: string };
        state?: unknown;
        inputResponses?: Record<string, unknown>;
        round?: number;
      },
    ) => unknown,
  ) {
    const { api, ctx } = harness();
    const reads: string[] = [];
    const options = {
      authorize: async () => ({ allowed: true as const }),
      mrtr: { secret: "x".repeat(32) },
      beforeResourceRead: beforeResourceRead as never,
      resources: [
        {
          name: "docs",
          list: async () => [{ uri: URI, name: "confidential" }],
          read: async () => {
            reads.push(URI);
            return CONTENTS;
          },
        },
      ] as never,
    };
    return { api, ctx, options, reads };
  }

  test("asks, then serves the resource once the answer arrives", async () => {
    const hookCalls: Array<Record<string, unknown>> = [];
    const { api, ctx, options, reads } = readHarness((_ctx, args) => {
      hookCalls.push(args as unknown as Record<string, unknown>);
      if (args.inputResponses === undefined) {
        return inputRequired(CONFIRM_REQUEST, { uri: args.uri });
      }
      return null;
    });

    const first = await json(
      await handleMcpRequest(ctx, readRequest(1), api, options),
    );
    expect(first.result?.resultType).toBe("input_required");
    expect(first.result?.inputRequests).toEqual(CONFIRM_REQUEST);
    // Nothing was read: the gate ran before any provider.
    expect(reads).toHaveLength(0);
    // The hook sees the resource identity, not tool arguments.
    expect(hookCalls[0]).toMatchObject({ uri: URI, resourceMetadata: null });

    const second = await json(
      await handleMcpRequest(
        ctx,
        readRequest(2, {
          requestState: first.result!.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options,
      ),
    );
    expect(second.result).toMatchObject({ contents: CONTENTS });
    expect(reads).toEqual([URI]);
    // The continuation carried the decoded state and the round.
    expect(hookCalls[1]).toMatchObject({
      state: { uri: URI },
      inputResponses: { confirm: { action: "accept" } },
      round: 1,
    });
  });

  test("an unsupported resource input uses completeRead before the provider", async () => {
    const summary = [{ uri: URI, mimeType: "text/plain", text: "summary" }];
    const { api, ctx, options, reads } = readHarness(() =>
      inputRequired(CONFIRM_REQUEST, undefined, {
        onUnsupported: completeRead(summary),
      }),
    );
    const body = await json(
      await handleMcpRequest(ctx, readRequest(1, {}, {}), api, options),
    );

    expect(body.result).toMatchObject({ contents: summary });
    expect(body.result?.requestState).toBeUndefined();
    expect(reads).toHaveLength(0);
  });

  test("a nullish resource fallback does not serve the resource", async () => {
    // The read path's equivalent of the tool path's nullish-fallback
    // rule: `null` falls through to the providers, so it must not be
    // usable as a fallback that quietly bypasses the gate.
    const { api, ctx, options, reads } = readHarness(() =>
      inputRequired(CONFIRM_REQUEST, undefined, {
        onUnsupported: null as never,
      }),
    );
    const body = await json(
      await handleMcpRequest(ctx, readRequest(1, {}, {}), api, options),
    );

    expect(body.error?.code).toBe(-32021);
    expect(reads).toHaveLength(0);
  });

  test("declineRead refuses on the error channel, without reading", async () => {
    const { api, ctx, options, reads } = readHarness((_ctx, args) =>
      args.inputResponses === undefined
        ? inputRequired(CONFIRM_REQUEST)
        : declineRead("Owner declined to share this document"),
    );
    const first = await json(
      await handleMcpRequest(ctx, readRequest(1), api, options),
    );
    const declined = await json(
      await handleMcpRequest(
        ctx,
        readRequest(2, {
          requestState: first.result!.requestState,
          inputResponses: { confirm: { action: "decline" } },
        }),
        api,
        options,
      ),
    );
    // -32003, the same family as an authorizeResource denial: the caller
    // asked for a resource and is getting none.
    expect(declined.error?.code).toBe(-32003);
    expect(declined.error?.message).toBe(
      "Owner declined to share this document",
    );
    expect(reads).toHaveLength(0);
  });

  test("completeRead serves the hook's own contents instead of the provider's", async () => {
    const summary = [{ uri: URI, mimeType: "text/plain", text: "summary only" }];
    const { api, ctx, options, reads } = readHarness((_ctx, args) =>
      args.inputResponses === undefined
        ? inputRequired(CONFIRM_REQUEST)
        : completeRead(summary),
    );
    const first = await json(
      await handleMcpRequest(ctx, readRequest(1), api, options),
    );
    const served = await json(
      await handleMcpRequest(
        ctx,
        readRequest(2, {
          requestState: first.result!.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options,
      ),
    );
    expect(served.result).toMatchObject({ contents: summary });
    expect(reads).toHaveLength(0);
  });

  test("a continuation is bound to its URI and cannot be replayed at another", async () => {
    const { api, ctx, options } = readHarness((_ctx, args) =>
      args.inputResponses === undefined ? inputRequired(CONFIRM_REQUEST) : null,
    );
    const first = await json(
      await handleMcpRequest(ctx, readRequest(1), api, options),
    );
    // Same sealed state, different URI: the seal binds
    // `resources/read:<uri>`, so verification must reject it rather than
    // serve a resource the negotiation was never about.
    const elsewhere = await json(
      await handleMcpRequest(
        ctx,
        readRequest(
          2,
          {
            requestState: first.result!.requestState,
            inputResponses: { confirm: { action: "accept" } },
          },
          { elicitation: { form: {} } },
          "docs://other",
        ),
        api,
        options,
      ),
    );
    expect(elsewhere.error?.code).toBe(-32602);
    expect(elsewhere.error?.message).toMatch(/Invalid, expired, or mismatched/);
  });

  test("a settled read refuses a forked branch without re-running the hook", async () => {
    // Answering "again" makes the hook ask again, which forks the chain: a
    // second jti under the same chain key. The branch that serves the read
    // settles it, and the older branch, replayed with the same answer it
    // was redeemed with, must then be refused rather than handed a fresh
    // continuation for a decision that is over.
    let hookRuns = 0;
    const { api, ctx, options } = readHarness((_ctx, args) => {
      hookRuns++;
      const confirm = args.inputResponses?.confirm as
        | { action?: string }
        | undefined;
      if (confirm === undefined) return inputRequired(CONFIRM_REQUEST);
      if (confirm.action === "again") return inputRequired(CONFIRM_REQUEST);
      return null;
    });
    const first = await json(
      await handleMcpRequest(ctx, readRequest(1), api, options),
    );
    const second = await json(
      await handleMcpRequest(
        ctx,
        readRequest(2, {
          requestState: first.result!.requestState,
          inputResponses: { confirm: { action: "again" } },
        }),
        api,
        options,
      ),
    );
    expect(second.result?.resultType).toBe("input_required");
    // Branch B settles the chain by serving the read.
    const settled = await json(
      await handleMcpRequest(
        ctx,
        readRequest(3, {
          requestState: second.result!.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options,
      ),
    );
    expect(settled.result).toMatchObject({ contents: CONTENTS });
    // Branch A replayed with the answer it was redeemed with: the
    // redemption allows it (same digest), and the chain check is what
    // refuses it. Without that check the hook would mint a fresh
    // continuation for a chain another branch already settled.
    const forked = await json(
      await handleMcpRequest(
        ctx,
        readRequest(4, {
          requestState: first.result!.requestState,
          inputResponses: { confirm: { action: "again" } },
        }),
        api,
        options,
      ),
    );
    expect(forked.error?.code).toBe(-32602);
    expect(forked.error?.message).toMatch(/already been resolved/);
    // The refusal happens BEFORE the hook. The hook is not documented as
    // side-effect-free, so a client holding sibling continuations must not
    // be able to drive it once per sibling on a settled decision.
    expect(hookRuns).toBe(3);
  });

  test("a read that demands input fails closed where no continuation can travel", async () => {
    const { api, ctx, options, reads } = readHarness(() =>
      inputRequired(CONFIRM_REQUEST),
    );
    // Same shape as the tool path: a hook that demands input on a mount
    // with no `mrtr` cannot be answered, so the read must fail rather than
    // be served with the gate skipped.
    const { mrtr: _dropped, ...withoutMrtr } = options;
    const body = await json(
      await handleMcpRequest(ctx, readRequest(1), api, withoutMrtr as never),
    );
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toMatch(/MRTR is not configured/);
    expect(reads).toHaveLength(0);
  });

  test("a legacy read whose hook asks fails closed with an actionable code", async () => {
    const { api, ctx, options, reads } = readHarness(() =>
      inputRequired(CONFIRM_REQUEST),
    );
    // The other half of the fail-closed rule, and deliberately a different
    // answer from the misconfiguration above: this one is the client's to
    // fix, so it gets -32601 naming the protocol rather than -32603.
    const legacy = await json(
      await handleMcpRequest(
        ctx,
        new Request("https://gateway.example/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-06-18",
            "mcp-session-id": "s".repeat(32),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "resources/read",
            params: { uri: URI },
          }),
        }),
        api,
        options,
      ),
    );
    expect(legacy.error?.code).toBe(-32601);
    expect(legacy.error?.message).toMatch(/2026-07-28 or later/);
    expect(reads).toHaveLength(0);
  });

  test("a legacy resource hook can use an unsupported fallback", async () => {
    const summary = [{ uri: URI, mimeType: "text/plain", text: "summary" }];
    const { api, ctx, options, reads } = readHarness(() =>
      inputRequired(CONFIRM_REQUEST, undefined, {
        onUnsupported: completeRead(summary),
      }),
    );
    const body = await json(
      await handleMcpRequest(
        ctx,
        new Request("https://gateway.example/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-06-18",
            "mcp-session-id": "s".repeat(32),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "resources/read",
            params: { uri: URI },
          }),
        }),
        api,
        options,
      ),
    );

    expect(body.result).toMatchObject({ contents: summary });
    expect(reads).toHaveLength(0);
  });

  test("a redemption that cannot run is an envelope, not a thrown 500", async () => {
    // The invariant the guard's own comment states: a component deployment
    // that predates `mrtrRedemptions` must yield a logged -32603, not a raw
    // throw that skips the CORS wrapper. One test covers both call paths,
    // since the redemption lives in the shared helper.
    const { api, ctx, options, reads } = readHarness((_ctx, args) =>
      args.inputResponses === undefined ? inputRequired(CONFIRM_REQUEST) : null,
    );
    const first = await json(
      await handleMcpRequest(ctx, readRequest(1), api, options),
    );
    const inner = ctx.runMutation;
    (ctx as { runMutation: unknown }).runMutation = async (
      ref: unknown,
      args: Record<string, unknown>,
    ) => {
      if (ref === api.mrtr.redeemContinuation) {
        throw new Error("mrtrRedemptions table does not exist");
      }
      return await inner(ref, args);
    };
    const response = await handleMcpRequest(
      ctx,
      readRequest(2, {
        requestState: first.result!.requestState,
        inputResponses: { confirm: { action: "accept" } },
      }),
      api,
      options,
    );
    // The load-bearing assertions: a parseable body at HTTP 200, which is
    // exactly what a raw throw destroys.
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toMatch(/MRTR verification failed/);
    expect(reads).toHaveLength(0);
  });

  test("a continuation cannot be answered by a different identity", async () => {
    // The seal binds the caller's subject. Without that binding a captured
    // requestState lets user B read a document under user A's negotiated
    // consent, which is the whole point of sealing the subject in.
    const { api, ctx, options, reads } = readHarness((_ctx, args) =>
      args.inputResponses === undefined ? inputRequired(CONFIRM_REQUEST) : null,
    );
    const first = await json(
      await handleMcpRequest(ctx, readRequest(1), api, options),
    );
    (ctx as { auth: unknown }).auth = {
      getUserIdentity: async () => ({ subject: "someone-else" }),
    };
    const stolen = await json(
      await handleMcpRequest(
        ctx,
        readRequest(2, {
          requestState: first.result!.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options,
      ),
    );
    expect(stolen.error?.code).toBe(-32602);
    expect(stolen.error?.message).toMatch(/Invalid, expired, or mismatched/);
    expect(reads).toHaveLength(0);
  });

  test("authorizeResource denies before the hook can prompt", async () => {
    // Ordering is a confidentiality property: if the hook ran first, the
    // elicitation would confirm the existence and name of a resource the
    // caller may not read, in the client's UI, before any authorization.
    const hookCalls: string[] = [];
    const { api, ctx, options, reads } = readHarness((_ctx, args) => {
      hookCalls.push(args.uri);
      return inputRequired(CONFIRM_REQUEST);
    });
    const denied = await json(
      await handleMcpRequest(ctx, readRequest(1), api, {
        ...options,
        authorizeResource: async () => ({
          allowed: false as const,
          reason: "nope",
        }),
      } as never),
    );
    expect(denied.error?.code).toBe(-32003);
    expect(denied.error?.message).toBe("nope");
    expect(hookCalls).toHaveLength(0);
    expect(reads).toHaveLength(0);
  });

  test("a terminal read reproduces itself for a lost response", async () => {
    // MRTR's core promise. If the resolution label ever collapses to one
    // value, `isChainRepeat` stops matching and an honest retry is told the
    // chain "has already been resolved", pushing the client into a new
    // chain, i.e. a new idempotency key, i.e. the duplicate the key exists
    // to prevent.
    const { api, ctx, options } = readHarness((_ctx, args) =>
      args.inputResponses === undefined
        ? inputRequired(CONFIRM_REQUEST)
        : declineRead("owner said no"),
    );
    const first = await json(
      await handleMcpRequest(ctx, readRequest(1), api, options),
    );
    const answer = {
      requestState: first.result!.requestState,
      inputResponses: { confirm: { action: "decline" } },
    };
    const once = await json(
      await handleMcpRequest(ctx, readRequest(2, answer), api, options),
    );
    const again = await json(
      await handleMcpRequest(ctx, readRequest(3, answer), api, options),
    );
    expect(once.error).toEqual(again.error);
    expect(again.error?.message).toBe("owner said no");
  });

  test("a malformed completeRead fails loudly and stays reproducible", async () => {
    const { api, ctx, options, reads } = readHarness((_ctx, args) =>
      args.inputResponses === undefined
        ? inputRequired(CONFIRM_REQUEST)
        : completeRead(["not-a-content-block"]),
    );
    const first = await json(
      await handleMcpRequest(ctx, readRequest(1), api, options),
    );
    const answer = {
      requestState: first.result!.requestState,
      inputResponses: { confirm: { action: "accept" } },
    };
    const bad = await json(
      await handleMcpRequest(ctx, readRequest(2, answer), api, options),
    );
    expect(bad.error?.code).toBe(-32603);
    expect(bad.error?.message).toMatch(/invalid contents/);
    expect(bad.result).toBeUndefined();
    expect(reads).toHaveLength(0);
    // Contents are validated BEFORE the chain is settled, so a host that
    // fixes its hook can still be answered on the same continuation rather
    // than being told the decision is over.
    const retry = await json(
      await handleMcpRequest(ctx, readRequest(3, answer), api, options),
    );
    expect(retry.error?.message).toMatch(/invalid contents/);
  });

  test("a hook that returns nonsense is a host bug, not a served read", async () => {
    const { api, ctx, options, reads } = readHarness(
      () => ({ nonsense: true }) as never,
    );
    const body = await json(
      await handleMcpRequest(ctx, readRequest(1), api, options),
    );
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toMatch(/returned an invalid result/);
    expect(reads).toHaveLength(0);
  });

  test("a tools/call continuation cannot be presented at resources/read", async () => {
    // The seal binds `resources/read:<uri>`; a tool's binds the tool name.
    const tool = declarativeTool(async (_ctx, hookArgs) =>
      hookArgs.inputResponses === undefined
        ? inputRequired(CONFIRM_REQUEST)
        : null,
    );
    const { api, ctx } = harness();
    const toolAsk = await json(
      await handleMcpRequest(ctx, request(1, {}), api, options(tool)),
    );
    const { api: readApi, ctx: readCtx, options: readOptions, reads } =
      readHarness((_ctx, args) =>
        args.inputResponses === undefined
          ? inputRequired(CONFIRM_REQUEST)
          : null,
      );
    const crossed = await json(
      await handleMcpRequest(
        readCtx,
        readRequest(2, {
          requestState: toolAsk.result!.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        readApi,
        readOptions,
      ),
    );
    expect(crossed.error?.code).toBe(-32602);
    expect(crossed.error?.message).toMatch(/Invalid, expired, or mismatched/);
    expect(reads).toHaveLength(0);
  });

  test("a hook-only mount advertises resources and serves a read", async () => {
    // No providers, no templates, no registry rows: the hook is the entire
    // read implementation (ask, then answer with completeRead). The absence
    // of this test is what let the escape hatch land on resources/list.
    const { api, ctx } = harness();
    const contents = [{ uri: URI, mimeType: "text/plain", text: "from hook" }];
    const options = {
      authorize: async () => ({ allowed: true as const }),
      mrtr: { secret: "x".repeat(32) },
      beforeResourceRead: (async (
        _ctx: unknown,
        args: { inputResponses?: Record<string, unknown> },
      ) =>
        args.inputResponses === undefined
          ? inputRequired(CONFIRM_REQUEST)
          : completeRead(contents)) as never,
    };

    // The capability has to be advertised, or a client never tries a read.
    const discovery = await json(
      await handleMcpRequest(
        ctx,
        new Request("https://gateway.example/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "server/discover",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "server/discover",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
        api,
        options,
      ),
    );
    expect(
      (discovery.result as { capabilities?: Record<string, unknown> })
        ?.capabilities,
    ).toHaveProperty("resources");

    // And the read must reach the hook rather than -32601.
    const asked = await json(
      await handleMcpRequest(ctx, readRequest(2), api, options),
    );
    expect(asked.result?.resultType).toBe("input_required");
    const served = await json(
      await handleMcpRequest(
        ctx,
        readRequest(3, {
          requestState: asked.result!.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options,
      ),
    );
    expect(served.result).toMatchObject({ contents });
  });

  test("a continuation without a configured hook is refused, not ignored", async () => {
    const { api, ctx } = harness();
    const body = await json(
      await handleMcpRequest(ctx, readRequest(1, { requestState: "x.y" }), api, {
        authorize: async () => ({ allowed: true as const }),
        mrtr: { secret: "x".repeat(32) },
        resources: [
          { name: "docs", list: async () => [], read: async () => CONTENTS },
        ] as never,
      }),
    );
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toMatch(/does not support MRTR continuations/);
  });
});
