import { describe, expect, test, vi } from "vitest";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  completeCall,
  inputRequired,
  type McpToolRegistration,
} from "../shared.js";
import { handleMcpRequest, type McpTasksOptions } from "./mcp-handler.js";

/**
 * Handler-level tests for the host-executor side of MCP tasks: the
 * `execute` callback, the update hooks, and the wire negotiation that
 * the example e2e suite (which uses the built-in executor) does not
 * reach. The component is mocked; its behavior is covered by
 * src/component/tasks.test.ts.
 */

const registeredTool = {
  name: "reports_generate",
  description: "Generates a report",
  kind: "action" as const,
  functionHandle: "function-handle",
  inputSchema: { type: "object" },
  taskSupport: true,
};

/**
 * The same tool at the level that has something to refuse. An `optional`
 * tool never refuses a caller who cannot have a task: nobody asked for
 * one, so it answers inline. A `required` one cannot run any other way,
 * which is what makes the missing capability, the missing identity and
 * the unconfigured mount reportable at all.
 */
const requiredTaskTool = {
  ...registeredTool,
  name: "reports_generate_required",
  taskSupport: "required" as const,
};

function component() {
  return {
    registry: {
      getTool: Symbol("getTool"),
      getOAuthConfig: Symbol("getOAuthConfig"),
    },
    sessions: {
      getSession: Symbol("getSession"),
      touchSession: Symbol("touchSession"),
    },
    dispatch: {
      runTool: Symbol("runTool"),
      recordAuthDenial: Symbol("recordAuthDenial"),
    },
    tasks: {
      createTask: Symbol("createTask"),
      getTaskForOwner: Symbol("getTaskForOwner"),
      cancelTaskForOwner: Symbol("cancelTaskForOwner"),
      submitInputResponsesForOwner: Symbol("submitInputResponsesForOwner"),
      failTask: Symbol("failTask"),
    },
  } as unknown as ComponentApi;
}

function request(
  id: number,
  method: string,
  params: Record<string, unknown>,
  options: {
    name?: string;
    clientCapabilities?: Record<string, unknown>;
  } = {},
): Request {
  return new Request("https://gateway.example/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
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
          "io.modelcontextprotocol/clientCapabilities":
            options.clientCapabilities ?? {
              extensions: { "io.modelcontextprotocol/tasks": {} },
            },
        },
      },
    }),
  });
}

type Call = { ref: unknown; args: Record<string, unknown> };

function harness(tasks: McpTasksOptions | undefined) {
  const api = component();
  const mutations: Call[] = [];
  let cancelOutcome: Record<string, unknown> | null = null;
  const taskRow = {
    taskId: "task-1",
    toolName: registeredTool.name,
    status: "working",
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
  };
  const ctx = {
    runQuery: async (ref: unknown, args?: Record<string, unknown>) => {
      if (ref === api.registry.getTool) {
        return (args as { name?: string })?.name === requiredTaskTool.name
          ? requiredTaskTool
          : registeredTool;
      }
      if (ref === api.tasks.getTaskForOwner) return taskRow;
      if (ref === api.registry.getOAuthConfig) return null;
      if (ref === api.sessions.getSession) {
        return { sessionId: "session-1", protocolVersion: "2025-06-18" };
      }
      throw new Error("unexpected query");
    },
    runMutation: async (ref: unknown, args: Record<string, unknown>) => {
      mutations.push({ ref, args });
      if (ref === api.tasks.createTask) {
        return { created: true, task: taskRow };
      }
      if (ref === api.tasks.cancelTaskForOwner) {
        return (
          cancelOutcome ?? {
            outcome: "cancelled",
            task: { ...taskRow, status: "cancelled" },
          }
        );
      }
      if (ref === api.tasks.submitInputResponsesForOwner) {
        return { outcome: "accepted", task: taskRow };
      }
      return null;
    },
    runAction: async () => {
      throw new Error("dispatch must not run for task calls");
    },
    auth: { getUserIdentity: async () => ({ subject: "user-1" }) },
  };
  const options = {
    authorize: async () => ({ allowed: true as const }),
    ...(tasks !== undefined ? { tasks } : {}),
  };
  return {
    api,
    ctx,
    mutations,
    options,
    // Mutable so a test can age the row or settle it without a second
    // harness: the timestamps and the cancel outcome are exactly what
    // the wire shape is derived from.
    taskRow,
    setCancelOutcome: (outcome: Record<string, unknown>) => {
      cancelOutcome = outcome;
    },
  };
}

describe("task-augmented tools/call with a host executor", () => {
  test("execute receives the task context and dispatch never runs", async () => {
    const started: unknown[] = [];
    const { api, ctx, mutations, options } = harness({
      execute: async (_ctx, task) => {
        started.push(task);
      },
      pollIntervalMs: 500,
    });

    const response = await handleMcpRequest(
      ctx,
      request(
        1,
        "tools/call",
        {
          name: registeredTool.name,
          arguments: { month: "2026-08" },
          task: {},
        },
        { name: registeredTool.name },
      ),
      api,
      options,
    );

    const body = (await response.json()) as {
      result: {
        resultType: string;
        taskId: string;
        status: string;
        pollIntervalMs: number;
        createdAt: string;
        lastUpdatedAt: string;
        ttlMs: number;
        task?: unknown;
      };
    };
    // SEP-2663: `Result & Task`, flat, with no nested wrapper.
    expect(body.result.resultType).toBe("task");
    expect(body.result.task).toBeUndefined();
    expect(body.result.pollIntervalMs).toBe(500);
    expect(body.result.taskId).toBe("task-1");
    expect(body.result.status).toBe("working");
    // The fixture row is long expired, so the remaining lifetime floors
    // at zero rather than going negative. The arithmetic itself is
    // pinned by "ttlMs counts the lifetime that is left" below.
    expect(body.result.ttlMs).toBe(0);
    // ISO-8601, not the milliseconds the component stores.
    expect(body.result.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(body.result.lastUpdatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      toolName: registeredTool.name,
      toolKind: "action",
      args: { month: "2026-08" },
      identity: { subject: "user-1" },
    });
    expect(
      typeof (started[0] as { idempotencyKey: string }).idempotencyKey,
    ).toBe("string");
    const createCall = mutations.find((m) => m.ref === api.tasks.createTask);
    expect(createCall?.args.executor).toBe("host");
  });

  test("an executor that fails to start fails the task, not silently", async () => {
    const { api, ctx, mutations, options } = harness({
      execute: async () => {
        throw new Error("workflow.start unavailable");
      },
    });

    const response = await handleMcpRequest(
      ctx,
      request(
        2,
        "tools/call",
        { name: registeredTool.name, arguments: {}, task: {} },
        { name: registeredTool.name },
      ),
      api,
      options,
    );

    expect(
      ((await response.json()) as { error: { code: number } }).error.code,
    ).toBe(-32603);
    const failCall = mutations.find((m) => m.ref === api.tasks.failTask);
    expect(failCall?.args.auditErrorMessage).toBe("workflow.start unavailable");
  });
});

  test("a denied caller creates no task and never starts the executor", async () => {
    const started: unknown[] = [];
    const { api, ctx, mutations, options } = harness({
      execute: async (_ctx, task) => {
        started.push(task);
      },
    });
    // The task block sits deliberately last, after authorize: a denied
    // caller must not be able to mint a durable row that later executes a
    // tool they were forbidden to call.
    const denied = {
      ...options,
      authorize: async () => ({ allowed: false as const, reason: "Forbidden" }),
    };
    const response = await handleMcpRequest(
      ctx,
      request(
        10,
        "tools/call",
        { name: registeredTool.name, arguments: {}, task: {} },
        { name: registeredTool.name },
      ),
      api,
      denied,
    );
    expect(
      ((await response.json()) as { error?: { code: number } }).error,
    ).toBeDefined();
    expect(mutations.some((m) => m.ref === api.tasks.createTask)).toBe(false);
    expect(started).toHaveLength(0);
  });

describe("tasks/update hooks", () => {
  test("a fresh cancel fires onCancel once", async () => {
    const cancelled: string[] = [];
    const { api, ctx, options } = harness({
      onCancel: (_ctx, event) => {
        cancelled.push(event.taskId);
      },
    });
    const response = await handleMcpRequest(
      ctx,
      request(3, "tasks/cancel", { taskId: "task-1" }, { name: "task-1" }),
      api,
      options,
    );
    // An empty ack: the settled status is observed on the next tasks/get.
    expect(await response.json()).toMatchObject({
      result: { resultType: "complete" },
    });
    expect(cancelled).toEqual(["task-1"]);
  });

  test("a repeated cancel re-fires onCancel (notification retry path)", async () => {
    const cancelled: string[] = [];
    const { api, ctx, options } = harness({
      onCancel: (_ctx, event) => {
        cancelled.push(event.taskId);
      },
    });
    // Simulate the idempotent repeat: the component answers
    // already_cancelled, and the hook must still fire so a previously
    // failed cancel notification can be retried from the wire.
    (ctx as { runMutation: unknown }).runMutation = async (ref: unknown) => {
      if (ref === api.tasks.cancelTaskForOwner) {
        return {
          outcome: "already_cancelled",
          task: {
            taskId: "task-1",
            toolName: registeredTool.name,
            status: "cancelled",
            createdAt: 1,
            updatedAt: 1,
            expiresAt: 2,
          },
        };
      }
      return null;
    };
    const response = await handleMcpRequest(
      ctx,
      request(3, "tasks/cancel", { taskId: "task-1" }, { name: "task-1" }),
      api,
      options,
    );
    expect(response.status).toBe(200);
    expect(cancelled).toEqual(["task-1"]);
  });

  test("a duplicate input update re-fires onInputResponses", async () => {
    const resumed: string[] = [];
    const { api, ctx, options } = harness({
      onInputResponses: (_ctx, event) => {
        resumed.push(event.taskId);
      },
    });
    (ctx as { runMutation: unknown }).runMutation = async (ref: unknown) => {
      if (ref === api.tasks.submitInputResponsesForOwner) {
        return {
          outcome: "duplicate",
          task: {
            taskId: "task-1",
            toolName: registeredTool.name,
            status: "working",
            createdAt: 1,
            updatedAt: 1,
            expiresAt: 2,
          },
        };
      }
      return null;
    };
    const response = await handleMcpRequest(
      ctx,
      request(
        4,
        "tasks/update",
        { taskId: "task-1", inputResponses: { confirm: { action: "accept" } } },
        { name: "task-1" },
      ),
      api,
      options,
    );
    expect(response.status).toBe(200);
    expect(resumed).toEqual(["task-1"]);
  });

  test("accepted input responses reach onInputResponses", async () => {
    const resumed: Record<string, unknown>[] = [];
    const { api, ctx, options } = harness({
      onInputResponses: (_ctx, event) => {
        resumed.push(event.inputResponses);
      },
    });
    const responses = { confirm: { action: "accept" } };
    const response = await handleMcpRequest(
      ctx,
      request(
        4,
        "tasks/update",
        { taskId: "task-1", inputResponses: responses },
        { name: "task-1" },
      ),
      api,
      options,
    );
    expect(response.status).toBe(200);
    expect(resumed).toEqual([responses]);
  });

  test("update requires inputResponses, and takes no action parameter", async () => {
    const { api, ctx, options } = harness({});
    for (const params of [
      { taskId: "task-1" },
      // `action` was this gateway's own spelling of cancellation before
      // SEP-2663 gave it a method. It is not a way to reach `tasks/cancel`.
      { taskId: "task-1", action: "cancel" },
      { taskId: "task-1", action: "pause" },
    ]) {
      const response = await handleMcpRequest(
        ctx,
        request(5, "tasks/update", params, { name: "task-1" }),
        api,
        options,
      );
      expect(
        ((await response.json()) as { error: { code: number } }).error.code,
      ).toBe(-32602);
    }
  });
});

describe("tasks/update outcomes that are not a plain acceptance", () => {
  test("responses that all cancel notify onCancel, not onInputResponses", async () => {
    const cancelled: string[] = [];
    const resumed: string[] = [];
    const { api, ctx, options } = harness({
      onCancel: (_ctx, event) => {
        cancelled.push(event.taskId);
      },
      onInputResponses: (_ctx, event) => {
        resumed.push(event.taskId);
      },
    });
    (ctx as { runMutation: unknown }).runMutation = async (ref: unknown) => {
      if (ref === api.tasks.submitInputResponsesForOwner) {
        return {
          outcome: "cancelled",
          task: {
            taskId: "task-1",
            toolName: registeredTool.name,
            status: "cancelled",
            createdAt: 1,
            updatedAt: 1,
            expiresAt: 2,
          },
        };
      }
      return null;
    };
    const response = await handleMcpRequest(
      ctx,
      request(
        20,
        "tasks/update",
        {
          taskId: "task-1",
          inputResponses: { confirm: { action: "cancel" } },
          inputRound: 1,
        },
        { name: "task-1" },
      ),
      api,
      options,
    );
    // An all-cancel submission is still a `tasks/update`, so it acks
    // empty like any other; the cancelled status shows up on the next get.
    expect(await response.json()).toMatchObject({
      result: { resultType: "complete" },
    });
    // Stopping the host's run is the whole point: resuming it would apply
    // the side effect the owner just refused.
    expect(cancelled).toEqual(["task-1"]);
    expect(resumed).toEqual([]);
  });

  test("a stale round tells the client which round to answer", async () => {
    const { api, ctx, options } = harness({});
    (ctx as { runMutation: unknown }).runMutation = async (ref: unknown) =>
      ref === api.tasks.submitInputResponsesForOwner
        ? { outcome: "stale_round", expectedRound: 2 }
        : null;
    const response = await handleMcpRequest(
      ctx,
      request(
        21,
        "tasks/update",
        {
          taskId: "task-1",
          inputResponses: { confirm: { action: "accept" } },
          inputRound: 1,
        },
        { name: "task-1" },
      ),
      api,
      options,
    );
    const body = (await response.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32602);
    // Without the round in the message the client has no recovery path.
    expect(body.error.message).toMatch(/round 2/);
  });

  test("a malformed inputRound is rejected, not read as absent", async () => {
    const { api, ctx, options } = harness({});
    const response = await handleMcpRequest(
      ctx,
      request(
        22,
        "tasks/update",
        {
          taskId: "task-1",
          inputResponses: { confirm: { action: "accept" } },
          inputRound: "1",
        },
        { name: "task-1" },
      ),
      api,
      options,
    );
    const body = (await response.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toMatch(/inputRound must be/);
  });
});

describe("mount scope", () => {
  test("an empty scope is a configuration error, not an unscoped mount", async () => {
    const { api, ctx, options } = harness({ scope: "" });
    // Stored verbatim, "" would be its own third namespace: unreachable
    // from both scoped and unscoped mounts. Fail at the mount instead.
    await expect(
      handleMcpRequest(
        ctx,
        request(30, "tasks/get", { taskId: "task-1" }, { name: "task-1" }),
        api,
        options,
      ),
    ).rejects.toThrow(/tasks.scope must be a non-empty string/);
  });

  test("the mount's scope is threaded into creation and every owner-facing call", async () => {
    const { api, ctx, mutations, options } = harness({ scope: "main" });
    await handleMcpRequest(
      ctx,
      request(
        31,
        "tools/call",
        { name: registeredTool.name, arguments: {}, task: {} },
        { name: registeredTool.name },
      ),
      api,
      options,
    );
    const create = mutations.find((m) => m.ref === api.tasks.createTask);
    expect(create?.args.scope).toBe("main");

    await handleMcpRequest(
      ctx,
      request(32, "tasks/cancel", { taskId: "task-1" }, { name: "task-1" }),
      api,
      options,
    );
    const cancel = mutations.find(
      (m) => m.ref === api.tasks.cancelTaskForOwner,
    );
    expect(cancel?.args.scope).toBe("main");
  });
});

describe("SEP-2663 wire shape", () => {
  test("a required tool names the capability a client is missing", async () => {
    const { api, ctx, options } = harness({});
    const response = await handleMcpRequest(
      ctx,
      request(
        55,
        "tools/call",
        { name: requiredTaskTool.name, arguments: {} },
        { name: requiredTaskTool.name, clientCapabilities: {} },
      ),
      api,
      options,
    );
    // The same diagnosis the task methods give: same missing
    // declaration, named in machine-readable form.
    const body = (await response.json()) as {
      error: { code: number; data: { requiredCapabilities: unknown } };
    };
    expect(body.error.code).toBe(-32021);
    expect(body.error.data.requiredCapabilities).toEqual({
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
  });

  test("an optional tool answers inline for a client that cannot have a task", async () => {
    const { api, ctx, mutations, options } = harness({});
    // The harness refuses to dispatch, because every other test here is
    // about NOT dispatching. This one is the opposite.
    (ctx as { runAction: unknown }).runAction = async () => ({
      ok: true,
      value: "generated",
    });
    const response = await handleMcpRequest(
      ctx,
      request(
        56,
        "tools/call",
        { name: registeredTool.name, arguments: {} },
        { name: registeredTool.name, clientCapabilities: {} },
      ),
      api,
      options,
    );
    // Nobody asked for a task, so there is nothing to refuse: the call
    // runs synchronously rather than erroring over a capability the
    // client never needed.
    expect(response.status).toBe(200);
    expect(mutations.some((m) => m.ref === api.tasks.createTask)).toBe(false);
  });

  test("a client that never declared the extension is told what it lacks", async () => {
    const { api, ctx, options } = harness({});
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
      const response = await handleMcpRequest(
        ctx,
        request(
          51,
          method,
          { taskId: "task-1", inputResponses: {} },
          { name: "task-1", clientCapabilities: {} },
        ),
        api,
        options,
      );
      const body = (await response.json()) as {
        error: { code: number; data: { requiredCapabilities: unknown } };
      };
      expect(body.error.code).toBe(-32021);
      // Only what is MISSING, in the shape the client would have sent.
      expect(body.error.data.requiredCapabilities).toEqual({
        extensions: { "io.modelcontextprotocol/tasks": {} },
      });
    }
  });

  test("the capability gate runs before the identity challenge", async () => {
    const { api, ctx, options } = harness({});
    (ctx as { auth: unknown }).auth = { getUserIdentity: async () => null };
    const response = await handleMcpRequest(
      ctx,
      request(
        52,
        "tasks/get",
        { taskId: "task-1" },
        { name: "task-1", clientCapabilities: {} },
      ),
      api,
      options,
    );
    // Not a 401: telling an unauthenticated caller to log in for a
    // feature it never negotiated answers the wrong question.
    expect(response.status).not.toBe(401);
    expect(
      ((await response.json()) as { error: { code: number } }).error.code,
    ).toBe(-32021);
  });

  test("ttlMs counts the lifetime that is left, not the one it had", async () => {
    const { api, ctx, options, taskRow } = harness({});
    const now = Date.now();
    taskRow.createdAt = now - 60_000;
    taskRow.updatedAt = now - 30_000;
    taskRow.expiresAt = now + 120_000;

    const response = await handleMcpRequest(
      ctx,
      request(53, "tasks/get", { taskId: "task-1" }, { name: "task-1" }),
      api,
      options,
    );
    const body = (await response.json()) as {
      result: {
        resultType: string;
        ttlMs: number;
        createdAt: string;
        lastUpdatedAt: string;
        task?: unknown;
      };
    };
    // A poll is an ordinary answer, so `complete`; only a creating call
    // carries the `task` discriminator.
    expect(body.result.resultType).toBe("complete");
    expect(body.result.task).toBeUndefined();
    expect(body.result.ttlMs).toBeGreaterThan(100_000);
    expect(body.result.ttlMs).toBeLessThanOrEqual(120_000);
    expect(body.result.createdAt).toBe(new Date(now - 60_000).toISOString());
    expect(body.result.lastUpdatedAt).toBe(
      new Date(now - 30_000).toISOString(),
    );
    // SEP-2549 and SEP-2663 both spell a duration on a result `ttlMs`.
    // A task result carries the task's meaning, so the caching hint must
    // not be injected here: a `cacheScope` beside a task lifetime would
    // read as "cache this poll for the task's whole life", and polling is
    // exactly what must not be cached.
    expect(
      (body.result as { cacheScope?: string }).cacheScope,
    ).toBeUndefined();
  });

  test("cancelling an already terminal task acks like a live one", async () => {
    const { api, ctx, options, setCancelOutcome } = harness({});
    setCancelOutcome({ outcome: "conflict", status: "completed" });

    const response = await handleMcpRequest(
      ctx,
      request(54, "tasks/cancel", { taskId: "task-1" }, { name: "task-1" }),
      api,
      options,
    );
    // Idempotent: SEP-2663 reserves an error for an id the server does
    // not know, not for work that already finished.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { resultType: "complete" },
    });
  });
});

describe("wire negotiation", () => {
  test("task methods are unknown (404) when tasks are not configured", async () => {
    const { api, ctx, options } = harness(undefined);
    const response = await handleMcpRequest(
      ctx,
      request(6, "tasks/get", { taskId: "task-1" }, { name: "task-1" }),
      api,
      options,
    );
    expect(response.status).toBe(404);
    expect(
      ((await response.json()) as { error: { code: number } }).error.code,
    ).toBe(-32601);
  });

  test("an anonymous task-augmented call is audited, not only refused", async () => {
    const { api, ctx, mutations, options } = harness({});
    (ctx as { auth: unknown }).auth = { getUserIdentity: async () => null };
    const response = await handleMcpRequest(
      ctx,
      request(
        40,
        "tools/call",
        { name: requiredTaskTool.name, arguments: {} },
        { name: requiredTaskTool.name },
      ),
      api,
      options,
    );
    // This branch sits before `safeAuthorize`, so without its own audit row
    // an anonymous caller could probe which tools accept tasks and leave no
    // trace at all.
    const denial = mutations.find(
      (m) => m.ref === api.dispatch.recordAuthDenial,
    );
    expect(denial?.args).toMatchObject({
      name: requiredTaskTool.name,
      auditIdentitySubject: null,
      outcome: "denied",
      errorMessage: "Task-augmented calls require authentication",
    });
    // ...and it must still be the real challenge, not a 200 with an error.
    expect(response.status).toBe(401);
    expect(mutations.some((m) => m.ref === api.tasks.createTask)).toBe(false);
  });

  test("an audit failure on that path does not swallow the challenge", async () => {
    const { api, ctx, options } = harness({});
    (ctx as { auth: unknown }).auth = { getUserIdentity: async () => null };
    const inner = ctx.runMutation;
    (ctx as { runMutation: unknown }).runMutation = async (
      ref: unknown,
      args: Record<string, unknown>,
    ) => {
      if (ref === api.dispatch.recordAuthDenial) {
        throw new Error("audit table unavailable");
      }
      return await inner(ref, args);
    };
    // Audit must never change the outcome (see safeRecordAudit in
    // dispatch.ts): the caller still gets the 401 challenge.
    const response = await handleMcpRequest(
      ctx,
      request(
        41,
        "tools/call",
        { name: requiredTaskTool.name, arguments: {} },
        { name: requiredTaskTool.name },
      ),
      api,
      options,
    );
    expect(response.status).toBe(401);
  });

  test("a required tool refuses on the session era instead of running inline", async () => {
    const { api, ctx, mutations, options } = harness({});
    // Not `statelessJsonRpcRequest`: a legacy session request, which is
    // the era with no tasks at all.
    const response = await handleMcpRequest(
      ctx,
      new Request("https://gateway.example/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": "session-1",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 57,
          method: "tools/call",
          params: { name: requiredTaskTool.name, arguments: {} },
        }),
      }),
      api,
      options,
    );

    // The tool has no synchronous answer, so dispatching it would run
    // the side effect the level exists to defer. `tools/list` does not
    // advertise `execution` on this era either, so the client could not
    // have known without being told.
    const body = (await response.json()) as {
      error?: { code: number; message: string };
    };
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toMatch(/runs only as a task/);
    expect(mutations.some((m) => m.ref === api.tasks.createTask)).toBe(false);
  });

  test("shouldCreate decides an optional call, and never sees a denied one", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const inline = { ...harness({}) };
    (inline.ctx as { runAction: unknown }).runAction = async () => ({
      ok: true,
      value: "generated",
    });
    const inlineOptions = {
      ...inline.options,
      tasks: {
        shouldCreate: (_ctx: unknown, call: Record<string, unknown>) => {
          seen.push(call);
          return false;
        },
      },
    };
    const declined = await handleMcpRequest(
      inline.ctx,
      request(
        58,
        "tools/call",
        { name: registeredTool.name, arguments: { month: "2026-08" } },
        { name: registeredTool.name },
      ),
      inline.api,
      inlineOptions as never,
    );
    expect(declined.status).toBe(200);
    expect(
      inline.mutations.some((m) => m.ref === inline.api.tasks.createTask),
    ).toBe(false);
    // The payload is the call, not the request: enough to judge "is this
    // one going to be slow" without parsing the wire.
    expect(seen).toEqual([
      {
        toolName: registeredTool.name,
        toolKind: registeredTool.kind,
        args: { month: "2026-08" },
        identity: { subject: "user-1", claims: { subject: "user-1" } },
      },
    ]);

    // Returning true is the same as omitting it.
    const accepted = harness({ shouldCreate: () => true });
    await handleMcpRequest(
      accepted.ctx,
      request(
        59,
        "tools/call",
        { name: registeredTool.name, arguments: {} },
        { name: registeredTool.name },
      ),
      accepted.api,
      accepted.options,
    );
    expect(
      accepted.mutations.some((m) => m.ref === accepted.api.tasks.createTask),
    ).toBe(true);

    // A denied call never reaches host policy: the predicate runs after
    // `authorize`, so it judges calls that are actually going to happen.
    const deniedSeen: unknown[] = [];
    const denied = harness({
      shouldCreate: () => {
        deniedSeen.push(true);
        return true;
      },
    });
    const deniedResponse = await handleMcpRequest(
      denied.ctx,
      request(
        60,
        "tools/call",
        { name: registeredTool.name, arguments: {} },
        { name: registeredTool.name },
      ),
      denied.api,
      { ...denied.options, authorize: async () => ({ allowed: false }) },
    );
    expect((await deniedResponse.json()) as unknown).toMatchObject({
      error: { code: -32003 },
    });
    expect(deniedSeen).toEqual([]);
  });

  test("a required tool does not consult shouldCreate", async () => {
    const seen: unknown[] = [];
    const { api, ctx, mutations, options } = harness({
      shouldCreate: () => {
        seen.push(true);
        return false;
      },
    });
    await handleMcpRequest(
      ctx,
      request(
        61,
        "tools/call",
        { name: requiredTaskTool.name, arguments: {} },
        { name: requiredTaskTool.name },
      ),
      api,
      options,
    );
    // "Required" is not a default a host may override: a `false` here
    // would leave the call with no way to run at all.
    expect(seen).toEqual([]);
    expect(mutations.some((m) => m.ref === api.tasks.createTask)).toBe(true);
  });

  test("a shouldCreate that throws still answers, with a task", async () => {
    const { api, ctx, mutations, options } = harness({
      shouldCreate: () => {
        throw new Error("host policy exploded");
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let response: Response;
    try {
      response = await handleMcpRequest(
        ctx,
        request(
          62,
          "tools/call",
          { name: registeredTool.name, arguments: {} },
          { name: registeredTool.name },
        ),
        api,
        options,
      );
    } finally {
      spy.mockRestore();
    }
    // Not a raw 500: every other host callback on this path is guarded,
    // and the fallback is the durable direction.
    expect(response.status).toBe(200);
    expect(mutations.some((m) => m.ref === api.tasks.createTask)).toBe(true);
  });

  test("a required tool 404s when tasks are not configured", async () => {
    const { api, ctx, options } = harness(undefined);
    const response = await handleMcpRequest(
      ctx,
      request(
        7,
        "tools/call",
        { name: requiredTaskTool.name, arguments: {} },
        { name: requiredTaskTool.name },
      ),
      api,
      options,
    );
    // The capability was never advertised and this tool cannot run any
    // other way, so it is an unknown method rather than a refusal.
    expect(response.status).toBe(404);
  });

  test("Mcp-Name must carry the task id for task methods", async () => {
    const { api, ctx, options } = harness({});
    const response = await handleMcpRequest(
      ctx,
      request(8, "tasks/get", { taskId: "task-1" }, { name: "other-task" }),
      api,
      options,
    );
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { code: number } }).error.code,
    ).toBe(-32020);
  });

  test("the host's retention ceiling is the whole answer", async () => {
    const { api, ctx, mutations, options } = harness({
      execute: async () => {},
      retentionMs: 5 * 60 * 1000,
    });
    await handleMcpRequest(
      ctx,
      request(
        10,
        "tools/call",
        {
          name: registeredTool.name,
          arguments: {},
          // A legacy hint. SEP-2663 removed the shape a client used to
          // shorten retention with, so this says nothing.
          task: { ttlMs: 7 * 24 * 60 * 60 * 1000 },
        },
        { name: registeredTool.name },
      ),
      api,
      options,
    );
    const createCall = mutations.find((m) => m.ref === api.tasks.createTask);
    expect(createCall?.args.ttlMs).toBe(5 * 60 * 1000);
  });

  test("a legacy task param is ignored, not rejected", async () => {
    const { api, ctx, mutations, options } = harness({});
    const response = await handleMcpRequest(
      ctx,
      request(
        9,
        "tools/call",
        // Malformed by the old contract's rules, and meaningless by the
        // new one: the server decides, so there is nothing here to
        // validate and nothing to refuse.
        { name: registeredTool.name, arguments: {}, task: { ttlMs: "soon" } },
        { name: registeredTool.name },
      ),
      api,
      options,
    );
    expect(response.status).toBe(200);
    expect(mutations.some((m) => m.ref === api.tasks.createTask)).toBe(true);
  });
});

/**
 * A tool can be both MRTR-gated and task-capable. The host-side hook runs
 * at task-creation time, so the negotiation happens over `requestState`
 * BEFORE any durable task row exists: the two input channels never
 * compete for the same call.
 */
describe("a task-capable tool with an MRTR beforeCall hook", () => {
  const mrtrTool = {
    ...registeredTool,
    kind: "mutation" as const,
    mrtrArgs: { idempotencyKey: "continuationKey" },
    mrtrGated: true,
  };

  const CONFIRM_REQUEST = {
    confirm: {
      method: "elicitation/create",
      params: { mode: "form", message: "Generate the report?" },
    },
  };

  function mrtrHarness(
    beforeCall: NonNullable<McpToolRegistration["beforeCall"]>,
  ) {
    const api = {
      registry: {
        getTool: Symbol("getTool"),
        getOAuthConfig: Symbol("getOAuthConfig"),
      },
      dispatch: { runTool: Symbol("runTool") },
      mrtr: {
        redeemContinuation: Symbol("redeemContinuation"),
        claimChain: Symbol("claimChain"),
        getChainResolution: Symbol("getChainResolution"),
      },
      tasks: { createTask: Symbol("createTask") },
    } as unknown as ComponentApi;
    const mutations: Call[] = [];
    const redemptions = new Map<string, string>();
    // Faithful stand-in for the component's one-resolution-per-chain
    // store (see src/client/mrtr.test.ts): whoever claims first wins, and
    // a loser is told WHO won so the handler can tell an idempotent
    // repeat from a cross-branch flip.
    const chains = new Map<
      string,
      { resolution: string; resolvedByJti: string; resolvedByDigest?: string }
    >();
    const createdTasks = new Map<string, Record<string, unknown>>();
    const ctx = {
      runQuery: async (ref: unknown, args: Record<string, unknown>) => {
        if (ref === api.registry.getTool) return mrtrTool;
        if (ref === api.registry.getOAuthConfig) return null;
        if (ref === api.mrtr.getChainResolution) {
          return chains.get(args.chainKey as string) ?? null;
        }
        throw new Error("unexpected query");
      },
      runMutation: async (ref: unknown, args: Record<string, unknown>) => {
        mutations.push({ ref, args });
        if (ref === api.mrtr.redeemContinuation) {
          const jti = args.jti as string;
          const digest = args.responsesDigest as string;
          const seen = redemptions.get(jti);
          if (seen === undefined) {
            redemptions.set(jti, digest);
            return "fresh";
          }
          return seen === digest ? "replay" : "conflict";
        }
        if (ref === api.mrtr.claimChain) {
          const chainKey = args.chainKey as string;
          const existing = chains.get(chainKey);
          if (existing !== undefined) return existing;
          chains.set(chainKey, {
            resolution: args.resolution as string,
            resolvedByJti: args.jti as string,
            ...(args.responsesDigest !== undefined
              ? { resolvedByDigest: args.responsesDigest as string }
              : {}),
          });
          return "claimed";
        }
        if (ref === api.tasks.createTask) {
          // Mirrors the component: a live task with this idempotency key
          // is returned as-is (`reused`), never duplicated.
          const key = args.idempotencyKey as string;
          const seen = createdTasks.get(key);
          if (seen !== undefined) return { created: true, task: seen, reused: true };
          const task = {
            taskId: args.taskId as string,
            toolName: mrtrTool.name,
            status: "working",
            createdAt: 1,
            updatedAt: 1,
            expiresAt: 2,
          };
          createdTasks.set(key, task);
          return { created: true, task };
        }
        return null;
      },
      runAction: async () => {
        throw new Error("dispatch must not run for task calls");
      },
      auth: { getUserIdentity: async () => ({ subject: "user-1" }) },
    };
    return {
      api,
      ctx,
      mutations,
      options: {
        authorize: async () => ({ allowed: true as const }),
        mrtr: { secret: "x".repeat(32) },
        declarativeTools: [
          {
            ...mrtrTool,
            fn: {} as McpToolRegistration["fn"],
            functionReference: {},
            beforeCall,
          } as McpToolRegistration,
        ],
        tasks: {},
      },
    };
  }

  function taskCall(id: number, params: Record<string, unknown> = {}) {
    return request(
      id,
      "tools/call",
      {
        name: mrtrTool.name,
        arguments: { month: "2026-08" },
        task: {},
        ...params,
      },
      {
        name: mrtrTool.name,
        clientCapabilities: {
          extensions: { "io.modelcontextprotocol/tasks": {} },
          elicitation: { form: {} },
        },
      },
    );
  }

  test("the hook negotiates first and no task is created until it approves", async () => {
    const { api, ctx, mutations, options } = mrtrHarness(
      async (_ctx, hookArgs) =>
        hookArgs.inputResponses === undefined
          ? inputRequired(CONFIRM_REQUEST, { month: "2026-08" })
          : null,
    );

    const first = (await (
      await handleMcpRequest(ctx, taskCall(1), api, options)
    ).json()) as {
      result: { resultType: string; requestState: string };
    };
    // The MRTR envelope, not a task handle, and nothing durable yet.
    expect(first.result.resultType).toBe("input_required");
    expect(mutations.some((m) => m.ref === api.tasks.createTask)).toBe(false);

    const second = (await (
      await handleMcpRequest(
        ctx,
        taskCall(2, {
          requestState: first.result.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options,
      )
    ).json()) as { result: { resultType: string } };
    expect(second.result.resultType).toBe("task");
    const created = mutations.filter((m) => m.ref === api.tasks.createTask);
    expect(created).toHaveLength(1);
    expect(created[0]!.args.executor).toBe("component");
    expect(created[0]!.args.args).toEqual({ month: "2026-08" });
  });

  test("a replayed continuation returns the existing handle, not a sibling", async () => {
    const { api, ctx, mutations, options } = mrtrHarness(
      async (_ctx, hookArgs) =>
        hookArgs.inputResponses === undefined
          ? inputRequired(CONFIRM_REQUEST)
          : null,
    );
    const first = (await (
      await handleMcpRequest(ctx, taskCall(1), api, options)
    ).json()) as { result: { requestState: string } };
    const continuation = {
      requestState: first.result.requestState,
      inputResponses: { confirm: { action: "accept" } },
    };

    const second = (await (
      await handleMcpRequest(ctx, taskCall(2, continuation), api, options)
    ).json()) as { result: { taskId: string } };
    // Replaying the continuation is a legitimate lost-response retry, and
    // it reaches createTask again with the SAME key (the chain key). The
    // component answers with the task that key already owns, so the
    // client keeps one handle, one TTL and one audit trail.
    const third = (await (
      await handleMcpRequest(ctx, taskCall(3, continuation), api, options)
    ).json()) as { result: { taskId: string } };
    const keys = mutations
      .filter((m) => m.ref === api.tasks.createTask)
      .map((m) => m.args.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(third.result.taskId).toBe(second.result.taskId);
  });

  test("a forked branch cannot create a task once a sibling settled the chain", async () => {
    // The property the chain claim exists for, on the task path: creating
    // a task is a terminal resolution (it returns a handle INSTEAD of
    // dispatching, and the executor then runs the tool unguarded), so a
    // branch of a chain another continuation already settled must be
    // refused with nothing durable left behind.
    //
    // Asking again forks the chain: round 2 mints a NEW jti under the SAME
    // chain key, so two continuations of one chain are answerable at once.
    const { api, ctx, mutations, options } = mrtrHarness(
      async (_ctx, hookArgs) => {
        const confirm = hookArgs.inputResponses?.confirm as
          | { action?: string; content?: { confirm?: unknown } }
          | undefined;
        if (confirm === undefined) return inputRequired(CONFIRM_REQUEST);
        // A malformed answer asks again instead of deciding.
        if (confirm.content?.confirm !== true) return inputRequired(CONFIRM_REQUEST);
        return null;
      },
    );

    const first = (await (
      await handleMcpRequest(ctx, taskCall(1), api, options)
    ).json()) as { result: { requestState: string } };
    // Branch A: answered badly, so the hook asks again and hands out a
    // second continuation of the same chain.
    const second = (await (
      await handleMcpRequest(
        ctx,
        taskCall(2, {
          requestState: first.result.requestState,
          inputResponses: { confirm: { action: "accept" } },
        }),
        api,
        options,
      )
    ).json()) as { result: { resultType: string; requestState: string } };
    expect(second.result.resultType).toBe("input_required");

    // Branch B (the newer one) settles the chain by creating the task.
    const settled = (await (
      await handleMcpRequest(
        ctx,
        taskCall(3, {
          requestState: second.result.requestState,
          inputResponses: {
            confirm: { action: "accept", content: { confirm: true } },
          },
        }),
        api,
        options,
      )
    ).json()) as { result: { resultType: string } };
    expect(settled.result.resultType).toBe("task");
    expect(
      mutations.filter((m) => m.ref === api.tasks.createTask),
    ).toHaveLength(1);

    // Branch A comes back with a good answer. Without the claim it would
    // create a second task and run the tool again; the chain is settled,
    // so it is refused and nothing is created.
    const forked = (await (
      await handleMcpRequest(
        ctx,
        taskCall(4, {
          requestState: first.result.requestState,
          inputResponses: {
            confirm: { action: "accept", content: { confirm: true } },
          },
        }),
        api,
        options,
      )
    ).json()) as { error?: { code: number; message: string } };
    expect(forked.error?.code).toBe(-32602);
    expect(
      mutations.filter((m) => m.ref === api.tasks.createTask),
    ).toHaveLength(1);
  });

  test("a completeCall decision finishes the call without a task", async () => {
    const { api, ctx, mutations, options } = mrtrHarness(async () =>
      completeCall({
        content: [{ type: "text", text: "Not generated." }],
        isError: false,
      }),
    );
    const body = (await (
      await handleMcpRequest(ctx, taskCall(1), api, options)
    ).json()) as { result: { isError: boolean; resultType?: string } };
    expect(body.result.isError).toBe(false);
    // An ordinary completed call, not a task handle.
    expect(body.result.resultType).toBe("complete");
    expect(mutations.some((m) => m.ref === api.tasks.createTask)).toBe(false);
  });
});
