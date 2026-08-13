import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { api } from "./_generated/api.js";
import {
  TASK_DEFAULT_TTL_MS,
  TASK_MAX_RESULT_BYTES,
  TASK_MAX_TTL_MS,
  TASK_MIN_TTL_MS,
  TASK_OWNER_ACTIVE_CAP,
} from "./tasks.js";

/**
 * Storage-level lifecycle tests. Execution end-to-end (the scheduled
 * executor running a real registered function) lives in
 * example/convex/mcp.test.ts, where real function handles exist; these
 * tests use `executor: "host"` so no execution is scheduled.
 */

const BASE = {
  ownerSubject: "alice",
  toolName: "invoices_recount",
  toolKind: "mutation" as const,
  args: { scope: "all" },
  executor: "host" as const,
};

function newTest() {
  return convexTest(schema, modules);
}

/**
 * Creates a task with an idempotency key derived from its id, matching
 * production where the key is either a fresh UUID per request or an MRTR
 * chain key. Tests that mean "the same request, replayed" pass an
 * explicit `idempotencyKey` to opt into the reuse path.
 */
async function createTask(
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  overrides: Record<string, unknown> = {},
) {
  const taskId = (overrides.taskId as string | undefined) ?? "task-1";
  return await ctx.runMutation(api.tasks.createTask, {
    taskId,
    idempotencyKey: `idem-${taskId}`,
    ...BASE,
    ...overrides,
  });
}

describe("tasks: creation and polling", () => {
  test("create + owner poll round-trip exposes only wire fields", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const created = await createTask(ctx);
      expect(created.created).toBe(true);

      const task = await ctx.runQuery(api.tasks.getTaskForOwner, {
        taskId: "task-1",
        ownerSubject: "alice",
      });
      expect(task).toMatchObject({
        taskId: "task-1",
        toolName: "invoices_recount",
        status: "working",
      });
      // Execution data never crosses to the polling surface.
      expect(task).not.toHaveProperty("args");
      expect(task).not.toHaveProperty("caller");
      expect(task).not.toHaveProperty("idempotencyKey");
      expect(task!.expiresAt - task!.createdAt).toBe(TASK_DEFAULT_TTL_MS);

      // The lifecycle is audited without payloads.
      const audit = await ctx.runQuery(api.audit.listEntries, {
        taskId: "task-1",
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        entryType: "task",
        taskOperation: "create",
        outcome: "allowed",
        identitySubject: "alice",
        args: null,
      });
    });
  });

  test("duplicate task ids and oversized args are rejected", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      expect((await createTask(ctx)).created).toBe(true);
      expect(await createTask(ctx)).toEqual({
        created: false,
        reason: "duplicate_id",
      });
      expect(
        await createTask(ctx, {
          taskId: "task-2",
          args: { blob: "x".repeat(64 * 1024 + 1) },
        }),
      ).toEqual({ created: false, reason: "args_too_large" });
    });
  });

  test("an oversized caller snapshot is rejected", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      expect(
        await createTask(ctx, {
          caller: { subject: "alice", claims: { blob: "x".repeat(8 * 1024) } },
        }),
      ).toEqual({ created: false, reason: "caller_too_large" });
    });
  });

  test("a value past the stringify depth bound is rejected as over-cap", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      // Past the component's TASK_MAX_STRINGIFY_DEPTH (100) but shallow
      // enough that convex-test's own arg serialization handles it; the
      // HTTP boundary (handler nestsTooDeep, tested end to end in
      // example/convex/mcp.test.ts) catches the extreme case earlier.
      let deep: unknown = 0;
      for (let i = 0; i < 200; i++) deep = [deep];
      expect(await createTask(ctx, { args: deep })).toEqual({
        created: false,
        reason: "args_too_large",
      });
    });
  });

  test("per-owner active-task cap is enforced and terminal tasks free room", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      for (let i = 0; i < TASK_OWNER_ACTIVE_CAP; i++) {
        expect((await createTask(ctx, { taskId: `t${i}` })).created).toBe(true);
      }
      // The next creation is over the cap.
      expect(await createTask(ctx, { taskId: "over" })).toEqual({
        created: false,
        reason: "limit_exceeded",
      });
      // Finishing one live task frees a slot.
      await ctx.runMutation(api.tasks.completeTask, {
        taskId: "t0",
        result: {},
      });
      expect((await createTask(ctx, { taskId: "after" })).created).toBe(true);
      // A different owner is unaffected.
      expect(
        (await createTask(ctx, { taskId: "bob-1", ownerSubject: "bob" }))
          .created,
      ).toBe(true);
    });
  });

  test("cancelPendingTasksForOwner cancels only that owner's live tasks", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx, { taskId: "live-1" });
      await createTask(ctx, { taskId: "live-2" });
      await createTask(ctx, { taskId: "done" });
      await ctx.runMutation(api.tasks.completeTask, {
        taskId: "done",
        result: {},
      });
      await createTask(ctx, { taskId: "bob-live", ownerSubject: "bob" });

      let cancelled = 0;
      const taskIds: string[] = [];
      let cursor: number | null | undefined = undefined;
      for (;;) {
        // Explicit type: `cursor` feeds the next call's args while being
        // assigned from this call's result, which would otherwise make
        // `batch` circularly self-referential (TS7022) through the
        // convex-test runMutation inference.
        const batch: {
          cancelled: number;
          taskIds: string[];
          cursor: number | null;
        } = await ctx.runMutation(
          api.tasks.cancelPendingTasksForOwner,
          cursor !== undefined && cursor !== null
            ? { ownerSubject: "alice", cursorCreationTime: cursor }
            : { ownerSubject: "alice" },
        );
        cancelled += batch.cancelled;
        taskIds.push(...batch.taskIds);
        if (batch.cursor === null) break;
        cursor = batch.cursor;
      }
      expect(cancelled).toBe(2);
      expect(taskIds.sort()).toEqual(["live-1", "live-2"]);
      // The completed task keeps its terminal outcome; bob is untouched.
      expect(
        (
          await ctx.runQuery(api.tasks.getTaskForOwner, {
            taskId: "done",
            ownerSubject: "alice",
          })
        )?.status,
      ).toBe("completed");
      expect(
        (
          await ctx.runQuery(api.tasks.getTaskForOwner, {
            taskId: "bob-live",
            ownerSubject: "bob",
          })
        )?.status,
      ).toBe("working");
    });
  });

  test("ttl is clamped to [1 minute, 7 days]", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const short = await createTask(ctx, { taskId: "short", ttlMs: 1 });
      expect(short.task.expiresAt - short.task.createdAt).toBe(TASK_MIN_TTL_MS);
      const long = await createTask(ctx, {
        taskId: "long",
        ttlMs: 365 * 24 * 60 * 60 * 1000,
      });
      expect(long.task.expiresAt - long.task.createdAt).toBe(TASK_MAX_TTL_MS);
    });
  });

  test("owner binding: a foreign subject observes nothing", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      expect(
        await ctx.runQuery(api.tasks.getTaskForOwner, {
          taskId: "task-1",
          ownerSubject: "mallory",
        }),
      ).toBeNull();
      expect(
        await ctx.runMutation(api.tasks.cancelTaskForOwner, {
          taskId: "task-1",
          ownerSubject: "mallory",
        }),
      ).toEqual({ outcome: "not_found" });
      expect(
        await ctx.runMutation(api.tasks.submitInputResponsesForOwner, {
          taskId: "task-1",
          ownerSubject: "mallory",
          inputResponses: {},
        }),
      ).toEqual({ outcome: "not_found" });
    });
  });

  test("expired tasks answer like unknown ids and are pruned", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-12T00:00:00Z"));
      const t = newTest();
      await t.run(async (ctx) => {
        await createTask(ctx, { ttlMs: TASK_MIN_TTL_MS });
        vi.advanceTimersByTime(TASK_MIN_TTL_MS + 1);
        expect(
          await ctx.runQuery(api.tasks.getTaskForOwner, {
            taskId: "task-1",
            ownerSubject: "alice",
          }),
        ).toBeNull();
        expect(
          await ctx.runMutation(api.tasks.cancelTaskForOwner, {
            taskId: "task-1",
            ownerSubject: "alice",
          }),
        ).toEqual({ outcome: "not_found" });
        expect(await ctx.runMutation(api.tasks.pruneTasks, {})).toBe(1);
        expect(await ctx.runMutation(api.tasks.pruneTasks, {})).toBe(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tasks: cancellation", () => {
  test("cancel is idempotent; terminal outcomes conflict", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      const first = await ctx.runMutation(api.tasks.cancelTaskForOwner, {
        taskId: "task-1",
        ownerSubject: "alice",
      });
      expect(first.outcome).toBe("cancelled");
      const repeat = await ctx.runMutation(api.tasks.cancelTaskForOwner, {
        taskId: "task-1",
        ownerSubject: "alice",
      });
      expect(repeat.outcome).toBe("already_cancelled");

      // The idempotent repeat writes no second audit row.
      const audit = await ctx.runQuery(api.audit.listEntries, {
        taskId: "task-1",
      });
      expect(
        audit.filter((row) => row.taskOperation === "cancel"),
      ).toHaveLength(1);

      // A cancel that raced ahead beats completion: cancel wins.
      expect(
        await ctx.runMutation(api.tasks.completeTask, {
          taskId: "task-1",
          result: { late: true },
        }),
      ).toBe("conflict");

      await createTask(ctx, { taskId: "task-2" });
      await ctx.runMutation(api.tasks.completeTask, {
        taskId: "task-2",
        result: {},
      });
      expect(
        await ctx.runMutation(api.tasks.cancelTaskForOwner, {
          taskId: "task-2",
          ownerSubject: "alice",
        }),
      ).toEqual({ outcome: "conflict", status: "completed" });
    });
  });
});

/**
 * Mount scoping. The task table is component-wide and `authorize` runs
 * only at creation, so without a scope a caller permitted on a broad
 * mount could start a privileged task there and collect its result
 * through a narrower one.
 */
describe("tasks: idempotency-key reuse", () => {
  test("a repeat with the same key returns the live task, creating nothing", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const first = await createTask(ctx);
      expect(first.created).toBe(true);
      expect(first.reused).toBeUndefined();

      // The replayed request: new task id, same idempotency key.
      const repeat = await createTask(ctx, {
        taskId: "task-2",
        idempotencyKey: "idem-task-1",
      });
      expect(repeat.created).toBe(true);
      expect(repeat.reused).toBe(true);
      expect(repeat.task.taskId).toBe("task-1");

      // Nothing was inserted and nothing was audited a second time, so
      // the client cannot end up driving two rows out of step.
      expect(
        await ctx.runQuery(api.tasks.getTaskForOwner, {
          taskId: "task-2",
          ownerSubject: "alice",
        }),
      ).toBeNull();
      const audit = await ctx.runQuery(api.audit.listEntries, {
        entryType: "task",
      });
      expect(audit.filter((row) => row.taskOperation === "create")).toHaveLength(
        1,
      );
    });
  });

  test("a key cannot surface another caller's, another mount's, or an expired task", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx, { scope: "main" });
      // Foreign owner, and the right owner on the wrong mount: both must
      // insert their own row rather than adopt the existing one.
      const foreign = await createTask(ctx, {
        taskId: "task-bob",
        ownerSubject: "bob",
        idempotencyKey: "idem-task-1",
      });
      expect(foreign.reused).toBeUndefined();
      const otherMount = await createTask(ctx, {
        taskId: "task-partner",
        scope: "partner",
        idempotencyKey: "idem-task-1",
      });
      expect(otherMount.reused).toBeUndefined();
    });
  });

  test("a terminal task is reused, not re-created", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      await ctx.runMutation(api.tasks.cancelTaskForOwner, {
        taskId: "task-1",
        ownerSubject: "alice",
      });
      // Same request, replayed. Its outcome, the cancel the owner asked
      // for, is the honest answer; creating a new row would re-run the
      // tool whose task they just cancelled.
      const replay = await createTask(ctx, {
        taskId: "task-2",
        idempotencyKey: "idem-task-1",
      });
      expect(replay.reused).toBe(true);
      expect(replay.task.taskId).toBe("task-1");
      expect(replay.task.status).toBe("cancelled");
      expect(replay.startPending).toBeUndefined();
    });
  });

  test("a host-executed row that never started is reported as startPending", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      // No `startedAt`: the original request created the row and then died
      // before execution began, so the replay must start it instead of
      // assuming the original did.
      const replay = await createTask(ctx, {
        taskId: "task-2",
        idempotencyKey: "idem-task-1",
      });
      expect(replay.reused).toBe(true);
      expect(replay.startPending).toBe(true);

      await ctx.runMutation(api.tasks.markTaskStarted, { taskId: "task-1" });
      const afterStart = await createTask(ctx, {
        taskId: "task-3",
        idempotencyKey: "idem-task-1",
      });
      expect(afterStart.reused).toBe(true);
      expect(afterStart.startPending).toBeUndefined();
    });
  });

  test("an input_required row that never recorded a start is not startPending", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      // The window this guards: `execute` put the row into input_required
      // and then the start marker failed to record (logged, not fatal). The
      // row is non-terminal with no startedAt, but it demonstrably STARTED,
      // because its executor is what asked for input.
      await ctx.runMutation(api.tasks.requireTaskInput, {
        taskId: "task-1",
        inputRequests: {
          confirm: { method: "elicitation/create", params: { mode: "form" } },
        },
      });
      const replay = await createTask(ctx, {
        taskId: "task-2",
        idempotencyKey: "idem-task-1",
      });
      // Load-bearing: without this the next assertion could pass because
      // the row was not reused at all.
      expect(replay.reused).toBe(true);
      // Starting it again would re-run the executor against a task the
      // owner is mid-way through answering, and re-fire the elicitation.
      expect(replay.startPending).toBeUndefined();
    });
  });

  test("a row created under the other executor or approval is not reused", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      // Inserted directly so the component executor is not scheduled: the
      // point is the reuse predicate, not execution.
      const now = Date.now();
      await ctx.db.insert("tasks", {
        ...BASE,
        taskId: "task-component",
        executor: "component",
        idempotencyKey: "shared",
        mrtrApproved: true,
        status: "working",
        createdAt: now,
        updatedAt: now,
        expiresAt: now + TASK_DEFAULT_TTL_MS,
      });
      // Reusing across a change of execution model would leave the work
      // unstarted or started twice; reusing across an approval change
      // would let the executor's gate read a decision this request did
      // not make. Both insert their own row instead.
      const otherExecutor = await createTask(ctx, {
        taskId: "task-host",
        idempotencyKey: "shared",
        mrtrApproved: true,
      });
      expect(otherExecutor.reused).toBeUndefined();
      const otherApproval = await createTask(ctx, {
        taskId: "task-approval",
        idempotencyKey: "shared",
      });
      expect(otherApproval.reused).toBeUndefined();
    });
  });

  test("a stale same-key row does not shadow the live one", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const past = Date.now() - 1000;
      // Index order is oldest-first, so a single-row read would keep
      // finding this expired leftover and mint the sibling that reuse
      // exists to prevent.
      await ctx.db.insert("tasks", {
        taskId: "stale",
        ownerSubject: "alice",
        toolName: "invoices_recount",
        toolKind: "mutation",
        args: {},
        status: "working",
        idempotencyKey: "shared-key",
        executor: "host",
        createdAt: past - 1000,
        updatedAt: past - 1000,
        expiresAt: past,
      });
      const live = await createTask(ctx, {
        taskId: "task-live",
        idempotencyKey: "shared-key",
      });
      expect(live.reused).toBeUndefined();
      const replay = await createTask(ctx, {
        taskId: "task-replay",
        idempotencyKey: "shared-key",
      });
      expect(replay.reused).toBe(true);
      expect(replay.task.taskId).toBe("task-live");
    });
  });

  test("an expired task with the same key is not reused", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const past = Date.now() - 1000;
      await ctx.db.insert("tasks", {
        taskId: "stale",
        ownerSubject: "alice",
        toolName: "invoices_recount",
        toolKind: "mutation",
        args: {},
        status: "working",
        idempotencyKey: "idem-1",
        executor: "host",
        createdAt: past - 1000,
        updatedAt: past - 1000,
        expiresAt: past,
      });
      // Expired rows are gone as far as the owner is concerned, so
      // adopting one would hand back a handle that answers not_found.
      const fresh = await createTask(ctx, {
        taskId: "task-fresh",
        idempotencyKey: "idem-1",
      });
      expect(fresh.reused).toBeUndefined();
      expect(fresh.task.taskId).toBe("task-fresh");
    });
  });
});

describe("tasks: mount scope", () => {
  test("a scoped task is invisible to another scope and to no scope", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx, { scope: "main" });
      for (const scope of [undefined, "partner"]) {
        // Answered exactly like an unknown id: scoping must not reveal
        // that someone else's task exists.
        expect(
          await ctx.runQuery(api.tasks.getTaskForOwner, {
            taskId: "task-1",
            ownerSubject: "alice",
            ...(scope !== undefined ? { scope } : {}),
          }),
        ).toBeNull();
        expect(
          (
            await ctx.runMutation(api.tasks.cancelTaskForOwner, {
              taskId: "task-1",
              ownerSubject: "alice",
              ...(scope !== undefined ? { scope } : {}),
            })
          ).outcome,
        ).toBe("not_found");
        expect(
          (
            await ctx.runMutation(api.tasks.submitInputResponsesForOwner, {
              taskId: "task-1",
              ownerSubject: "alice",
              ...(scope !== undefined ? { scope } : {}),
              inputResponses: { confirm: { action: "accept" } },
              inputRound: 1,
            })
          ).outcome,
        ).toBe("not_found");
      }
      // The owning mount still sees it.
      expect(
        await ctx.runQuery(api.tasks.getTaskForOwner, {
          taskId: "task-1",
          ownerSubject: "alice",
          scope: "main",
        }),
      ).toMatchObject({ taskId: "task-1", status: "working" });
    });
  });

  test("an unscoped task is invisible to a scoped mount", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      // The other direction matters too: it is also the pre-existing-row
      // case, so a host adopting `scope` must expect in-flight tasks to
      // stay readable only by an unscoped mount until they expire.
      await createTask(ctx);
      expect(
        await ctx.runQuery(api.tasks.getTaskForOwner, {
          taskId: "task-1",
          ownerSubject: "alice",
          scope: "main",
        }),
      ).toBeNull();
      expect(
        await ctx.runQuery(api.tasks.getTaskForOwner, {
          taskId: "task-1",
          ownerSubject: "alice",
        }),
      ).toMatchObject({ taskId: "task-1" });
    });
  });

  test("revocation sweeps every scope unless narrowed", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx, { taskId: "task-main", scope: "main" });
      await createTask(ctx, { taskId: "task-partner", scope: "partner" });
      await createTask(ctx, { taskId: "task-plain" });
    });
    // Narrowed: only that mount's task.
    const narrowed = await t.mutation(api.tasks.cancelPendingTasksForOwner, {
      ownerSubject: "alice",
      scope: "partner",
    });
    expect(narrowed.taskIds).toEqual(["task-partner"]);
    // Unnarrowed: a revocation is about the subject, not the mount, so it
    // takes the remaining tasks whatever their scope.
    const all = await t.mutation(api.tasks.cancelPendingTasksForOwner, {
      ownerSubject: "alice",
    });
    expect(all.taskIds.sort()).toEqual(["task-main", "task-plain"]);
  });
});

describe("tasks: revocation and prune bookkeeping", () => {
  test("cancellation pages past a window full of terminal rows", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const now = Date.now();
      // A full batch of terminal rows first, then the live ones. A plain
      // repeated `.take()` from the front would keep re-reading this
      // window, report `cancelled: 0`, and never reach the live tasks.
      for (let i = 0; i < 200; i++) {
        await ctx.db.insert("tasks", {
          taskId: `done-${i}`,
          ownerSubject: "alice",
          toolName: "invoices_recount",
          toolKind: "mutation",
          args: {},
          status: "completed",
          idempotencyKey: `idem-done-${i}`,
          executor: "host",
          createdAt: now,
          updatedAt: now,
          expiresAt: now + TASK_DEFAULT_TTL_MS,
        });
      }
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("tasks", {
          taskId: `live-${i}`,
          ownerSubject: "alice",
          toolName: "invoices_recount",
          toolKind: "mutation",
          args: {},
          status: "working",
          idempotencyKey: `idem-live-${i}`,
          executor: "host",
          createdAt: now,
          updatedAt: now,
          expiresAt: now + TASK_DEFAULT_TTL_MS,
        });
      }
    });

    const cancelledIds: string[] = [];
    let cursor: number | null | undefined = undefined;
    let batches = 0;
    do {
      const batch: {
        cancelled: number;
        taskIds: string[];
        cursor: number | null;
      } = await t.mutation(api.tasks.cancelPendingTasksForOwner, {
        ownerSubject: "alice",
        ...(cursor !== undefined && cursor !== null
          ? { cursorCreationTime: cursor }
          : {}),
      });
      cancelledIds.push(...batch.taskIds);
      cursor = batch.cursor;
      batches++;
      // The cursor must terminate the loop, not the count: the first page
      // is all terminal rows and legitimately cancels nothing.
      expect(batches).toBeLessThan(10);
    } while (cursor !== null);

    expect(cancelledIds.sort()).toEqual([
      "live-0",
      "live-1",
      "live-2",
      "live-3",
      "live-4",
    ]);
    expect(batches).toBeGreaterThan(1);
  });

  test("pruning a task that never finalized records how it ended", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const past = Date.now() - 1000;
      await ctx.db.insert("tasks", {
        taskId: "abandoned",
        ownerSubject: "alice",
        toolName: "invoices_recount",
        toolKind: "mutation",
        args: {},
        status: "working",
        idempotencyKey: "idem-abandoned",
        executor: "host",
        createdAt: past - 1000,
        updatedAt: past - 1000,
        expiresAt: past,
      });
    });
    expect(await t.mutation(api.tasks.pruneTasks, {})).toBe(1);
    // Without this row the audit trail would stop at `create`, leaving
    // "still running", "crashed", and "never existed" indistinguishable.
    const audit = await t.query(api.audit.listEntries, {
      taskId: "abandoned",
    });
    const fail = audit.find((row) => row.taskOperation === "fail");
    expect(fail).toMatchObject({ entryType: "task", outcome: "error" });
    expect(fail?.errorMessage).toMatch(/expired in status "working"/);
  });
});

describe("tasks: input_required round-trip", () => {
  const INPUT_REQUESTS = {
    confirm: {
      method: "elicitation/create",
      params: { mode: "form", message: "Proceed?" },
    },
  };

  test("require input, answer once, duplicates are idempotent", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      expect(
        await ctx.runMutation(api.tasks.requireTaskInput, {
          taskId: "task-1",
          inputRequests: INPUT_REQUESTS,
        }),
      ).toBe("updated");

      const pending = await ctx.runQuery(api.tasks.getTaskForOwner, {
        taskId: "task-1",
        ownerSubject: "alice",
      });
      expect(pending?.status).toBe("input_required");
      expect(pending?.inputRequests).toEqual(INPUT_REQUESTS);

      const responses = {
        confirm: { action: "accept", content: { confirm: true } },
      };
      const accepted = await ctx.runMutation(
        api.tasks.submitInputResponsesForOwner,
        {
          taskId: "task-1",
          ownerSubject: "alice",
          inputResponses: responses,
          inputRound: 1,
        },
      );
      expect(accepted.outcome).toBe("accepted");
      expect(accepted.task?.status).toBe("working");

      // Duplicate update: byte-identical responses are acknowledged
      // without another transition or audit row.
      const duplicate = await ctx.runMutation(
        api.tasks.submitInputResponsesForOwner,
        {
          taskId: "task-1",
          ownerSubject: "alice",
          inputResponses: responses,
          inputRound: 1,
        },
      );
      expect(duplicate.outcome).toBe("duplicate");
      const audit = await ctx.runQuery(api.audit.listEntries, {
        taskId: "task-1",
      });
      expect(audit.filter((row) => row.taskOperation === "input")).toHaveLength(
        2, // requireTaskInput + the single accepted submission
      );

      // A different answer after acceptance is a conflict, not a
      // silent overwrite.
      expect(
        (
          await ctx.runMutation(api.tasks.submitInputResponsesForOwner, {
            taskId: "task-1",
            ownerSubject: "alice",
            inputResponses: {
              confirm: { action: "decline" },
            },
            inputRound: 1,
          })
        ).outcome,
      ).toBe("conflict");
    });
  });

  test("mismatched keys, bad verbs, oversized payloads are rejected", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      await ctx.runMutation(api.tasks.requireTaskInput, {
        taskId: "task-1",
        inputRequests: INPUT_REQUESTS,
      });
      for (const bad of [
        { other: { action: "accept" } }, // wrong key
        { confirm: { action: "accept" }, extra: { action: "accept" } },
        { confirm: { action: "maybe" } }, // unknown verb
        { confirm: "yes" }, // not an object
      ]) {
        expect(
          (
            await ctx.runMutation(api.tasks.submitInputResponsesForOwner, {
              taskId: "task-1",
              ownerSubject: "alice",
              inputResponses: bad,
              inputRound: 1,
            })
          ).outcome,
        ).toBe("mismatch");
      }
      expect(
        (
          await ctx.runMutation(api.tasks.submitInputResponsesForOwner, {
            taskId: "task-1",
            ownerSubject: "alice",
            inputResponses: {
              confirm: { action: "accept", content: "x".repeat(64 * 1024) },
            },
            inputRound: 1,
          })
        ).outcome,
      ).toBe("too_large");
    });
  });

  test("responses that all cancel cancel the task", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      await ctx.runMutation(api.tasks.requireTaskInput, {
        taskId: "task-1",
        inputRequests: INPUT_REQUESTS,
      });
      const cancelled = await ctx.runMutation(
        api.tasks.submitInputResponsesForOwner,
        {
          taskId: "task-1",
          ownerSubject: "alice",
          inputResponses: { confirm: { action: "cancel" } },
          inputRound: 1,
        },
      );
      expect(cancelled.outcome).toBe("cancelled");
      expect(cancelled.task?.status).toBe("cancelled");
    });
  });

  test("a submission must name the pending round", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      await ctx.runMutation(api.tasks.requireTaskInput, {
        taskId: "task-1",
        inputRequests: INPUT_REQUESTS,
      });
      const responses = { confirm: { action: "accept" } };
      // Omitting inputRound is itself stale: a round-1 retry that dropped
      // the field would otherwise sail through after a re-ask.
      expect(
        await ctx.runMutation(api.tasks.submitInputResponsesForOwner, {
          taskId: "task-1",
          ownerSubject: "alice",
          inputResponses: responses,
        }),
      ).toEqual({ outcome: "stale_round", expectedRound: 1 });
      expect(
        await ctx.runMutation(api.tasks.submitInputResponsesForOwner, {
          taskId: "task-1",
          ownerSubject: "alice",
          inputResponses: responses,
          inputRound: 2,
        }),
      ).toEqual({ outcome: "stale_round", expectedRound: 1 });
    });
  });

  test("a repeated all-cancel submission replays the cancellation", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      await ctx.runMutation(api.tasks.requireTaskInput, {
        taskId: "task-1",
        inputRequests: INPUT_REQUESTS,
      });
      const args = {
        taskId: "task-1",
        ownerSubject: "alice",
        inputResponses: { confirm: { action: "cancel" } },
        inputRound: 1,
      };
      expect(
        (await ctx.runMutation(api.tasks.submitInputResponsesForOwner, args))
          .outcome,
      ).toBe("cancelled");
      // Re-sending the same all-cancel responses must stay "cancelled"
      // rather than becoming a conflict: that is what re-fires the host's
      // onCancel when the first notification threw.
      const replay = await ctx.runMutation(
        api.tasks.submitInputResponsesForOwner,
        args,
      );
      expect(replay.outcome).toBe("cancelled");
      // No second audit row for the replay.
      const audit = await ctx.runQuery(api.audit.listEntries, {
        taskId: "task-1",
      });
      expect(
        audit.filter((row) => row.taskOperation === "cancel"),
      ).toHaveLength(1);
    });
  });

  test("a terminal task answers a repeated submission with conflict", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      await ctx.runMutation(api.tasks.requireTaskInput, {
        taskId: "task-1",
        inputRequests: INPUT_REQUESTS,
      });
      const responses = { confirm: { action: "accept" } };
      const args = {
        taskId: "task-1",
        ownerSubject: "alice",
        inputResponses: responses,
        inputRound: 1,
      };
      expect(
        (await ctx.runMutation(api.tasks.submitInputResponsesForOwner, args))
          .outcome,
      ).toBe("accepted");
      await ctx.runMutation(api.tasks.cancelTaskForOwner, {
        taskId: "task-1",
        ownerSubject: "alice",
      });
      // Not "duplicate": answering again must not read as "accepted" once
      // the task has a terminal outcome the client needs to see.
      expect(
        await ctx.runMutation(api.tasks.submitInputResponsesForOwner, args),
      ).toEqual({ outcome: "conflict", status: "cancelled" });
    });
  });

  test("requireTaskInput only applies to working tasks", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      await ctx.runMutation(api.tasks.cancelTaskForOwner, {
        taskId: "task-1",
        ownerSubject: "alice",
      });
      expect(
        await ctx.runMutation(api.tasks.requireTaskInput, {
          taskId: "task-1",
          inputRequests: INPUT_REQUESTS,
        }),
      ).toBe("conflict");
    });
  });

  test("requireTaskInput rejects component-executed tasks", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      // Insert the row directly so no execution gets scheduled: the
      // point is only the executor gate. Nothing could ever resume a
      // component-executed task, so pausing it must be a rejected
      // misuse instead of an unexecutable input_required state.
      const now = Date.now();
      await ctx.db.insert("tasks", {
        ...BASE,
        executor: "component",
        taskId: "task-component",
        idempotencyKey: "idem-task-component",
        status: "working",
        createdAt: now,
        updatedAt: now,
        expiresAt: now + TASK_DEFAULT_TTL_MS,
      });
      expect(
        await ctx.runMutation(api.tasks.requireTaskInput, {
          taskId: "task-component",
          inputRequests: INPUT_REQUESTS,
        }),
      ).toBe("unsupported_executor");
    });
  });

  test("round binding: a stale earlier-round answer is rejected, current round accepted", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      // Round 1.
      await ctx.runMutation(api.tasks.requireTaskInput, {
        taskId: "task-1",
        inputRequests: INPUT_REQUESTS,
      });
      const r1 = await ctx.runQuery(api.tasks.getTaskForOwner, {
        taskId: "task-1",
        ownerSubject: "alice",
      });
      expect(r1?.inputRound).toBe(1);
      // Answer round 1, back to working.
      await ctx.runMutation(api.tasks.submitInputResponsesForOwner, {
        taskId: "task-1",
        ownerSubject: "alice",
        inputResponses: { confirm: { action: "accept" } },
        inputRound: 1,
      });
      // Host re-asks the SAME question as round 2.
      await ctx.runMutation(api.tasks.requireTaskInput, {
        taskId: "task-1",
        inputRequests: INPUT_REQUESTS,
      });
      // A stale round-1 retry (e.g. lost response) must NOT answer round 2.
      const stale = await ctx.runMutation(
        api.tasks.submitInputResponsesForOwner,
        {
          taskId: "task-1",
          ownerSubject: "alice",
          inputResponses: { confirm: { action: "accept" } },
          inputRound: 1,
        },
      );
      expect(stale.outcome).toBe("stale_round");
      expect(stale.expectedRound).toBe(2);
      // The correct round-2 answer is accepted.
      const fresh = await ctx.runMutation(
        api.tasks.submitInputResponsesForOwner,
        {
          taskId: "task-1",
          ownerSubject: "alice",
          inputResponses: { confirm: { action: "decline" } },
          inputRound: 2,
        },
      );
      expect(fresh.outcome).toBe("accepted");
    });
  });

  test("trusted APIs treat an expired-but-unpruned row as gone", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-12T00:00:00Z"));
      const t = newTest();
      await t.run(async (ctx) => {
        await createTask(ctx, { ttlMs: TASK_MIN_TTL_MS });
        vi.advanceTimersByTime(TASK_MIN_TTL_MS + 1);
        // The row still exists (not pruned) but is expired: a workflow
        // must not get a phantom success it can never surface to owner.
        expect(
          await ctx.runMutation(api.tasks.requireTaskInput, {
            taskId: "task-1",
            inputRequests: INPUT_REQUESTS,
          }),
        ).toBe("not_found");
        expect(
          await ctx.runMutation(api.tasks.completeTask, {
            taskId: "task-1",
            result: {},
          }),
        ).toBe("not_found");
        expect(
          await ctx.runMutation(api.tasks.failTask, {
            taskId: "task-1",
            error: { code: -32000, message: "x" },
          }),
        ).toBe("not_found");
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Guards the built-in executor applies BEFORE it dispatches. They all
 * matter because a scheduled action is at-most-once: a guard that
 * returns without failing the task leaves the client polling a handle
 * that will never resolve. A fake function handle is enough: none of
 * these paths reach the tool.
 */
describe("tasks: built-in executor guards", () => {
  async function registerTaskTool(
    t: ReturnType<typeof newTest>,
    overrides: Record<string, unknown> = {},
  ) {
    await t.mutation(api.registry.registerTool, {
      name: "invoices_recount",
      description: "Recount",
      kind: "mutation",
      functionHandle: "function://fake",
      inputSchema: { type: "object" },
      taskSupport: true,
      ...overrides,
    });
  }

  async function runScheduled(t: ReturnType<typeof newTest>) {
    await t.run(async (ctx) => {
      await ctx.db.insert("tasks", {
        taskId: "task-1",
        ownerSubject: "alice",
        toolName: "invoices_recount",
        toolKind: "mutation",
        args: {},
        status: "working",
        idempotencyKey: "idem-1",
        executor: "component",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + TASK_DEFAULT_TTL_MS,
      });
    });
    await t.action(api.tasks.executeScheduledTask, { taskId: "task-1" });
    return await t.query(api.tasks.getTaskForOwner, {
      taskId: "task-1",
      ownerSubject: "alice",
    });
  }

  test("an unknown tool fails the task instead of leaving it working", async () => {
    const t = newTest();
    const task = await runScheduled(t);
    expect(task?.status).toBe("failed");
    expect(task?.error?.message).toMatch(/Unknown tool/);
  });

  test("a tool whose kind changed since creation fails instead of mis-running", async () => {
    const t = newTest();
    await registerTaskTool(t, { kind: "query" });
    const task = await runScheduled(t);
    expect(task?.status).toBe("failed");
    expect(task?.error?.message).toMatch(/kind changed/);
  });

  test("a tool that became MRTR-gated after creation fails closed", async () => {
    const t = newTest();
    // The registry row now promises a host-side confirmation hook, but
    // this task was created before it existed (no `mrtrApproved`), so the
    // queued run must not execute the call the hook was added to guard.
    await registerTaskTool(t, {
      mrtrGated: true,
      mrtrArgs: { idempotencyKey: "continuationKey" },
    });
    const task = await runScheduled(t);
    expect(task?.status).toBe("failed");
    expect(task?.error?.message).toMatch(/no longer eligible/);
  });

  test("a tool withdrawn from task execution fails closed", async () => {
    const t = newTest();
    await registerTaskTool(t, { taskSupport: undefined });
    const task = await runScheduled(t);
    expect(task?.status).toBe("failed");
    expect(task?.error?.message).toMatch(/no longer eligible/);
  });

  test("a task the hook approved still runs after the tool became gated", async () => {
    const t = newTest();
    await registerTaskTool(t, {
      mrtrGated: true,
      mrtrArgs: { idempotencyKey: "continuationKey" },
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("tasks", {
        taskId: "task-2",
        ownerSubject: "alice",
        toolName: "invoices_recount",
        toolKind: "mutation",
        args: {},
        status: "working",
        idempotencyKey: "idem-2",
        executor: "component",
        mrtrApproved: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + TASK_DEFAULT_TTL_MS,
      });
    });
    await t.action(api.tasks.executeScheduledTask, { taskId: "task-2" });
    const task = await t.query(api.tasks.getTaskForOwner, {
      taskId: "task-2",
      ownerSubject: "alice",
    });
    // The fake handle cannot run, so dispatch reports a tool execution
    // error, which is a COMPLETED call carrying isError. The point is that
    // it got PAST the eligibility gate rather than being refused there.
    expect(task?.status).toBe("completed");
    expect(
      (task?.result as { isError?: boolean } | undefined)?.isError,
    ).toBe(true);
    expect(JSON.stringify(task?.result)).not.toMatch(/no longer eligible/);
  });
});

describe("tasks: completion and failure", () => {
  test("completed tasks expose the result; failed tasks the error", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      expect(
        await ctx.runMutation(api.tasks.completeTask, {
          taskId: "task-1",
          result: { total: 7 },
        }),
      ).toBe("finalized");
      const done = await ctx.runQuery(api.tasks.getTaskForOwner, {
        taskId: "task-1",
        ownerSubject: "alice",
      });
      expect(done?.status).toBe("completed");
      // The row stores the value; the descriptor derives the wire envelope,
      // with compact JSON so the derived form cannot inflate with nesting.
      expect(done?.result).toEqual({
        content: [{ type: "text", text: '{"total":7}' }],
        isError: false,
      });
      expect(done?.error).toBeUndefined();

      await createTask(ctx, { taskId: "task-2" });
      await ctx.runMutation(api.tasks.failTask, {
        taskId: "task-2",
        error: { code: -32000, message: "Tool execution failed" },
        auditErrorMessage: "secret stack trace",
      });
      const failed = await ctx.runQuery(api.tasks.getTaskForOwner, {
        taskId: "task-2",
        ownerSubject: "alice",
      });
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toEqual({
        code: -32000,
        message: "Tool execution failed",
      });
      // The verbose text lands in the audit row, not on the wire.
      const audit = await ctx.runQuery(api.audit.listEntries, {
        taskId: "task-2",
        outcome: "error",
      });
      expect(audit[0]?.errorMessage).toBe("secret stack trace");
    });
  });

  test("requireTaskInput reports a malformed request shape distinctly", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      // Not "conflict": hosts are told to read conflict as "the owner got
      // there first", so a host-side type bug must not look like one.
      expect(
        await ctx.runMutation(api.tasks.requireTaskInput, {
          taskId: "task-1",
          inputRequests: ["confirm"],
        }),
      ).toBe("invalid_requests");
    });
  });

  test("an isError result audits as an error, not a clean success", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      expect(
        await ctx.runMutation(api.tasks.completeTask, {
          taskId: "task-1",
          result: "Confirmation declined.",
          isError: true,
        }),
      ).toBe("finalized");
      const audit = await ctx.runQuery(api.audit.listEntries, {
        taskId: "task-1",
      });
      const complete = audit.find((row) => row.taskOperation === "complete");
      // For a host-executed task this is the ONLY audit row: there is no
      // dispatch.runTool row. If it said "allowed", a declined destructive
      // write would be indistinguishable from an approved one.
      expect(complete).toMatchObject({ outcome: "error", errorCode: -32000 });
      // The payload contract stands: only the flag and a code travel.
      expect(complete?.errorMessage).toBeUndefined();
      expect(complete?.args).toBeNull();
    });
  });

  test("a structured error payload survives, and carries no structuredContent", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      // The documented host path: pass the tool's own value plus isError.
      // Stringifying it as `String(value)` would hand the client
      // "[object Object]" and lose the payload for good.
      expect(
        await ctx.runMutation(api.tasks.completeTask, {
          taskId: "task-1",
          result: { reason: "quota exceeded", retryAfter: 30 },
          isError: true,
        }),
      ).toBe("finalized");
      const task = await ctx.runQuery(api.tasks.getTaskForOwner, {
        taskId: "task-1",
        ownerSubject: "alice",
      });
      const envelope = task?.result as {
        content: Array<{ text: string }>;
        isError: boolean;
        structuredContent?: unknown;
      };
      expect(envelope.isError).toBe(true);
      expect(JSON.parse(envelope.content[0]!.text)).toEqual({
        reason: "quota exceeded",
        retryAfter: 30,
      });
      // An error result carries a message, not a typed value to validate
      // against the tool's outputSchema; the synchronous path never emits
      // one either.
      expect("structuredContent" in envelope).toBe(false);
    });
  });

  test("a legal value that would inflate when wrapped still completes", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      // The shape that broke the previous design: a nested value whose
      // pretty-printed envelope is several times its own size (indentation
      // per level, plus a second copy under structuredContent). Storing the
      // value and deriving the envelope on read means only the value is
      // capped, so a documented-legal result cannot fail AFTER the tool
      // committed its writes.
      const row = Array.from({ length: 40 }, (_, i) => [i, i + 1, i + 2]);
      const value = { rows: Array.from({ length: 500 }, () => row) };
      const compact = JSON.stringify(value).length;
      // What a PRETTY-PRINTED envelope would have cost. Left in as the
      // reason the derived form is serialized compactly: this shape
      // inflates about 7x, past Convex's 1 MiB, and a derived envelope
      // that does not fit makes a COMPLETED task unreadable on every poll
      // with no code path able to report it.
      const pretty = JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
        isError: false,
      }).length;
      expect(compact).toBeLessThan(256 * 1024);
      expect(pretty).toBeGreaterThan(1024 * 1024);
      expect(
        await ctx.runMutation(api.tasks.completeTask, {
          taskId: "task-1",
          result: value,
        }),
      ).toBe("finalized");
      const task = await ctx.runQuery(api.tasks.getTaskForOwner, {
        taskId: "task-1",
        ownerSubject: "alice",
      });
      expect(task?.status).toBe("completed");
      // Readable, and derived compactly: the whole envelope stays inside
      // what a Convex query may return.
      const envelope = task?.result as Record<string, unknown>;
      expect(JSON.stringify(envelope).length).toBeLessThan(1024 * 1024);
      expect(
        JSON.parse(
          (envelope.content as Array<{ text: string }>)[0]!.text,
        ),
      ).toEqual(value);
    });
  });

  test("an oversized result fails the task instead of storing it", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await createTask(ctx);
      expect(
        await ctx.runMutation(api.tasks.completeTask, {
          taskId: "task-1",
          // One byte past the documented cap, which is the only cap now
          // that the row stores the value rather than an envelope.
          result: "x".repeat(256 * 1024 - 1),
        }),
        // NOT "finalized": the caller's work succeeded while the client
        // will be served a failure, and the caller must be able to tell.
      ).toBe("result_too_large");
      const task = await ctx.runQuery(api.tasks.getTaskForOwner, {
        taskId: "task-1",
        ownerSubject: "alice",
      });
      expect(task?.status).toBe("failed");
      expect(task?.error?.message).toMatch(/exceeds/);
    });
  });
});

describe("tasks: executor gate mirrors the synchronous one", () => {
  /**
   * Rows are inserted directly, like the sibling executor tests: going
   * through `createTask` would also SCHEDULE the executor, and the
   * pending job then writes outside the test transaction.
   */
  async function seed(
    t: ReturnType<typeof newTest>,
    row: {
      taskId: string;
      toolName: string;
      toolKind: "query" | "mutation" | "action";
      idempotencyKey: string;
      mrtrApproved?: boolean;
    },
  ) {
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("tasks", {
        ...row,
        ownerSubject: "alice",
        args: {},
        status: "working" as const,
        executor: "component" as const,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + TASK_DEFAULT_TTL_MS,
      });
    });
  }

  test("a confirmed task whose row lost mrtrArgs is refused, not dispatched", async () => {
    // The synchronous path refuses a hook without the reserved key at
    // call time, because a replay would dispatch with nothing to
    // deduplicate on. An ordinary redeploy reaches the same state for a
    // queued task, so the executor has to refuse it too.
    const t = newTest();
    await t.mutation(api.registry.registerTool, {
      name: "archive",
      description: "no longer reserves a key",
      kind: "mutation",
      functionHandle: "function://fake-archive",
      inputSchema: { type: "object" },
      taskSupport: true,
    });
    await seed(t, {
      taskId: "task-mirror-1",
      toolName: "archive",
      toolKind: "mutation",
      idempotencyKey: "idem-mirror-1",
      mrtrApproved: true,
    });

    await t.action(api.tasks.executeScheduledTask, { taskId: "task-mirror-1" });

    const task = await t.query(api.tasks.getTaskForOwner, {
      taskId: "task-mirror-1",
      ownerSubject: "alice",
    });
    expect(task?.status).toBe("failed");
    expect(task?.error?.message).toMatch(/no longer eligible/);
  });

  test("a gated QUERY without mrtrArgs is not refused by that rule", async () => {
    // `defineMcpQuery({ beforeCall })` is valid with no key, so the gate
    // must not fail its tasks: the synchronous path runs them.
    const t = newTest();
    await t.mutation(api.registry.registerTool, {
      name: "search",
      description: "gated read, no key by design",
      kind: "query",
      functionHandle: "function://fake-search",
      inputSchema: { type: "object" },
      taskSupport: true,
    });
    await seed(t, {
      taskId: "task-mirror-2",
      toolName: "search",
      toolKind: "query",
      idempotencyKey: "idem-mirror-2",
      mrtrApproved: true,
    });

    await t.action(api.tasks.executeScheduledTask, { taskId: "task-mirror-2" });

    const task = await t.query(api.tasks.getTaskForOwner, {
      taskId: "task-mirror-2",
      ownerSubject: "alice",
    });
    expect(task?.error?.message ?? "").not.toMatch(/no longer eligible/);
  });
});

describe("tasks: result shaping and size accounting", () => {
  async function seedCompleted(
    t: ReturnType<typeof newTest>,
    opts: {
      taskId: string;
      outputSchema?: unknown;
      result: unknown;
      isError?: boolean;
    },
  ) {
    await t.mutation(api.registry.registerTool, {
      name: "shaper",
      description: "shapes",
      kind: "mutation",
      functionHandle: "function://shaper",
      inputSchema: { type: "object" },
      taskSupport: true,
      ...(opts.outputSchema !== undefined
        ? { outputSchema: opts.outputSchema }
        : {}),
    });
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("tasks", {
        taskId: opts.taskId,
        ownerSubject: "alice",
        toolName: "shaper",
        toolKind: "mutation" as const,
        args: {},
        status: "working" as const,
        idempotencyKey: "idem-" + opts.taskId,
        executor: "component" as const,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + TASK_DEFAULT_TTL_MS,
      });
    });
    return await t.mutation(api.tasks.completeTask, {
      taskId: opts.taskId,
      result: opts.result,
      ...(opts.isError !== undefined ? { isError: opts.isError } : {}),
    });
  }

  test("a non-object value never becomes structuredContent", async () => {
    // The documented decline passes a plain string and deliberately no
    // isError. Stamping it as structuredContent would violate the tool's
    // own outputSchema, and the synchronous path already refuses that
    // exact shape in describeCompleteCallResultProblem.
    const t = newTest();
    await seedCompleted(t, {
      taskId: "shape-1",
      outputSchema: { type: "object", required: ["paid"] },
      result: "Confirmation declined.",
    });
    const task = await t.query(api.tasks.getTaskForOwner, {
      taskId: "shape-1",
      ownerSubject: "alice",
    });
    expect(task?.result).toEqual({
      content: [{ type: "text", text: "Confirmation declined." }],
      isError: false,
    });
    expect(task?.result).not.toHaveProperty("structuredContent");
  });

  test("an object value still becomes structuredContent", async () => {
    const t = newTest();
    await seedCompleted(t, {
      taskId: "shape-2",
      outputSchema: { type: "object", required: ["paid"] },
      result: { paid: 2 },
    });
    const task = await t.query(api.tasks.getTaskForOwner, {
      taskId: "shape-2",
      ownerSubject: "alice",
    });
    expect(task?.result).toMatchObject({ structuredContent: { paid: 2 } });
  });

  test("binary payloads count against the cap instead of measuring as {}", async () => {
    // An ArrayBuffer serializes as {}, so a megabyte of v.bytes() used to
    // measure eleven bytes, pass every cap, and then be rejected by the
    // document limit at write time, stranding the task after the tool
    // had already committed.
    const t = newTest();
    const outcome = await seedCompleted(t, {
      taskId: "shape-3",
      result: { blob: new ArrayBuffer(TASK_MAX_RESULT_BYTES + 1) },
    });
    expect(outcome).toBe("result_too_large");
  });

  test("a value JSON cannot represent is refused, not thrown past", async () => {
    // v.int64() is a bigint and JSON.stringify throws on it. Rethrowing
    // would land in the executor's catch and strand the row working.
    const t = newTest();
    const outcome = await seedCompleted(t, {
      taskId: "shape-4",
      result: { count: BigInt(7) },
    });
    expect(outcome).toBe("result_too_large");
  });
});

