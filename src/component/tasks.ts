import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { taskStatusValidator, toolKindValidator } from "./schema.js";

/**
 * MCP Tasks (`io.modelcontextprotocol/tasks`) storage and lifecycle.
 *
 * The component owns the durable task rows and every legal status
 * transition; the host's HTTP handler owns the wire protocol
 * (`tools/call` task augmentation, `tasks/get`, `tasks/update`) and all
 * authorization. Owner-facing functions therefore take the caller's
 * resolved `ownerSubject` and answer a mismatch exactly like an unknown
 * id, so a task is never observable across callers. Trusted functions
 * (including `completeTask`, `failTask`, `requireTaskInput`,
 * `getTaskInternal`, `cancelPendingTasksForOwner`, `pruneTasks`) skip the
 * owner check:
 * only the host app can reach component functions, and the host's own
 * workflow is the intended caller.
 *
 * Functions are public `mutation` / `query` / `action` (not `internal*`)
 * for the same reason as `registry.*` and `dispatch.*`: component-internal
 * references resolve through `anyApi`, which cannot see internal markers.
 * The component boundary already prevents external callers.
 */

/** Retention defaults (documented in docs/tasks.md). */
export const TASK_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const TASK_MIN_TTL_MS = 60 * 1000;
export const TASK_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Permitted serialized sizes (documented in docs/tasks.md). */
export const TASK_MAX_ARGS_BYTES = 64 * 1024;
export const TASK_MAX_INPUT_BYTES = 64 * 1024;
export const TASK_MAX_RESULT_BYTES = 256 * 1024;

/**
 * Per-owner cap on live (non-terminal) tasks, mirroring
 * `sessions.SUBSCRIPTION_CAP`. This is a CONCURRENCY bound: it stops a
 * caller from holding unbounded simultaneous work (and unbounded pending
 * scheduler jobs), but it does not bound total volume — terminal tasks
 * do not count, so a caller looping short tasks stays under the cap
 * while retained rows accumulate. Retention (`ttlMs` + `pruneTasks`) is
 * the only bound on that; size it accordingly, and rate-limit upstream
 * if a caller can loop faster than you want to store.
 */
export const TASK_OWNER_ACTIVE_CAP = 256;

/**
 * Serialized-size cap on the stored caller identity snapshot. A fat
 * claims object would otherwise multiply per-row storage past the args
 * budget, since `args` is capped but `caller` was not.
 */
export const TASK_MAX_CALLER_BYTES = 8 * 1024;

/**
 * Max structural nesting `stableStringify` will descend before it
 * rejects the value. A client-controlled deeply nested `args` (tens of
 * thousands of `[`) that survives `JSON.parse` would otherwise overflow
 * the stack inside the mutation, before any byte cap could reject it.
 */
export const TASK_MAX_STRINGIFY_DEPTH = 100;

const PRUNE_BATCH = 200;

/**
 * How many same-idempotency-key rows `createTask` scans when looking for
 * a task to reuse. A key identifies one request (a fresh UUID, or an MRTR
 * chain key), so more than one row means expired-but-unpruned history or
 * a collision across owners/mounts; a handful is plenty, and the bound
 * keeps the read from depending on prune keeping up.
 */
const TASK_KEY_SCAN_LIMIT = 8;

const taskErrorValidator = v.object({
  code: v.number(),
  message: v.string(),
});

/**
 * Owner-facing task descriptor: what `tasks/get` returns, plus a
 * `pollIntervalMs` hint the handler adds host-side. `args`, `caller`, and
 * `idempotencyKey` are deliberately absent; they exist for execution, not
 * for the polling client.
 */
const taskDescriptorValidator = v.object({
  taskId: v.string(),
  toolName: v.string(),
  status: taskStatusValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
  expiresAt: v.number(),
  inputRequests: v.optional(v.any()),
  // Present on an `input_required` descriptor so the client echoes it in
  // its `tasks/update` submission; the round binding rejects a stale
  // answer to an earlier round.
  inputRound: v.optional(v.number()),
  result: v.optional(v.any()),
  error: v.optional(taskErrorValidator),
});

type TaskRow = {
  _id: Id<"tasks">;
  taskId: string;
  ownerSubject: string;
  toolName: string;
  toolKind: "query" | "mutation" | "action";
  args: unknown;
  caller?: { subject: string; claims?: unknown };
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  result?: unknown;
  error?: { code: number; message: string };
  inputRequests?: unknown;
  inputResponses?: unknown;
  inputRound?: number;
  idempotencyKey: string;
  executor: "component" | "host";
  startedAt?: number;
  scope?: string;
  mrtrApproved?: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Thrown when a value nests past `TASK_MAX_STRINGIFY_DEPTH`. Callers map
 * it to a clean `too_large`/`args_too_large` rejection instead of
 * letting a stack overflow escape the mutation as a raw 500.
 */
class TaskStringifyDepthError extends Error {}

/**
 * Key-order-independent serialization used for size caps and for the
 * idempotent duplicate-update comparison. Mutations cannot use
 * `crypto.subtle`, so the serialized form itself is the comparison key;
 * payloads are capped well below any size where that would matter.
 */
function stableStringify(value: unknown, depth = 0): string {
  if (depth > TASK_MAX_STRINGIFY_DEPTH) {
    throw new TaskStringifyDepthError("value nests too deeply");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, depth + 1)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify(record[key], depth + 1)}`,
    )
    .join(",")}}`;
}

function byteLength(serialized: string): number {
  // No TextEncoder in a Convex mutation, so sum UTF-8 widths per UTF-16
  // code unit. A surrogate pair counts 3+3 against a true UTF-8 cost of
  // 4, i.e. the estimate never UNDER-counts, which is what a cap needs.
  let bytes = 0;
  for (let i = 0; i < serialized.length; i++) {
    const code = serialized.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return bytes;
}

/**
 * True when `value` exceeds `cap` serialized bytes OR nests too deeply
 * to serialize safely. A too-deep value is treated as over-cap so the
 * caller rejects it cleanly rather than letting the stack overflow.
 */
function exceeds(value: unknown, cap: number): boolean {
  try {
    return byteLength(stableStringify(value ?? null)) > cap;
  } catch (err) {
    if (err instanceof TaskStringifyDepthError) return true;
    throw err;
  }
}

/**
 * Stable serialization for the idempotent duplicate-update comparison,
 * returning `null` when the value nests too deeply (the caller treats a
 * null digest as "not a duplicate", so an over-deep payload falls
 * through to the size check that rejects it).
 */
function safeStableStringify(value: unknown): string | null {
  try {
    return stableStringify(value ?? null);
  } catch (err) {
    if (err instanceof TaskStringifyDepthError) return null;
    throw err;
  }
}

/**
 * Owner binding, plus the optional mount scope.
 *
 * The task table is component-wide, so `ownerSubject` alone lets any
 * mount that resolves the same subject reach a task created through
 * another — including one whose `authorize` would have refused the
 * originating tool, since authorization runs at creation and never again
 * on `tasks/get` / `tasks/update`. A host that mounts the gateway more
 * than once with different policies sets `tasks.scope` per mount to close
 * that.
 *
 * Both sides must agree, and BOTH directions matter:
 *   - a scoped row is invisible to an unscoped mount (otherwise adding a
 *     scope to one mount would leave the others as a bypass);
 *   - an unscoped row is invisible to a scoped mount, EXCEPT that this is
 *     also the pre-existing-row case, so hosts that adopt `scope` later
 *     must expect their in-flight tasks to age out under the old rule.
 *     Documented in docs/tasks.md.
 *
 * A mismatch is reported exactly like an unknown id by every caller, so
 * scoping never reveals that someone else's task exists.
 */
function isOwnedBy(
  row: TaskRow,
  ownerSubject: string,
  scope: string | undefined,
): boolean {
  if (row.ownerSubject !== ownerSubject) return false;
  if ((row.scope ?? undefined) === scope) return true;
  // The wire answer stays identical to an unknown id, but the OPERATOR
  // needs a signal: a mount that sets `scope` where its sibling does not
  // (or that renames one, or reads it from an unset env var) makes every
  // task unreachable, and without this the console is empty while 100% of
  // polls answer "unknown task". Safe to log because the owner already
  // matched, so it says nothing about another caller's tasks.
  console.warn(
    "[mcp-gateway] task scope mismatch; answering as unknown",
    row.taskId,
    `row=${row.scope ?? "<unscoped>"}`,
    `request=${scope ?? "<unscoped>"}`,
  );
  return false;
}

function isExpired(row: TaskRow, now: number): boolean {
  return row.expiresAt <= now;
}

async function getRow(
  ctx: { db: any },
  taskId: string,
): Promise<TaskRow | null> {
  const row = await ctx.db
    .query("tasks")
    .withIndex("by_taskId", (q: any) => q.eq("taskId", taskId))
    .unique();
  return (row as TaskRow | null) ?? null;
}

function descriptor(row: TaskRow) {
  return {
    taskId: row.taskId,
    toolName: row.toolName,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    ...(row.status === "input_required" && row.inputRequests !== undefined
      ? { inputRequests: row.inputRequests }
      : {}),
    // Exposed on EVERY descriptor once a round has been asked, not just
    // while input is pending: a client that lost its local copy (or that
    // must re-send an accepted submission to retry a hook) polls
    // `tasks/get` to learn which round to echo. Hiding it after
    // acceptance would leave that client unable to construct a
    // submission that passes the round check.
    ...(row.inputRound !== undefined ? { inputRound: row.inputRound } : {}),
    ...(row.status === "completed" && row.result !== undefined
      ? { result: row.result }
      : {}),
    ...(row.status === "failed" && row.error !== undefined
      ? { error: row.error }
      : {}),
  };
}

async function recordTaskAudit(
  ctx: { db: any },
  row: Pick<TaskRow, "taskId" | "toolName" | "ownerSubject">,
  operation: "create" | "input" | "cancel" | "complete" | "fail",
  outcome: "allowed" | "error",
  durationMs: number,
  error?: { code: number; message?: string },
): Promise<void> {
  // Same-module insert mirrors dispatch.recordAuthDenial. Task payloads
  // (args, results, input requests/responses) never reach THESE rows;
  // only lifecycle metadata does. The `entryType: "tool"` row that
  // `dispatch.runTool` writes for a component-executed run does carry
  // the arguments, exactly like a synchronous call.
  await ctx.db.insert("audit", {
    entryType: "task",
    taskId: row.taskId,
    taskOperation: operation,
    toolName: row.toolName,
    args: null,
    outcome,
    identitySubject: row.ownerSubject,
    durationMs,
    ...(error !== undefined
      ? {
          errorCode: error.code,
          ...(error.message !== undefined
            ? { errorMessage: error.message }
            : {}),
        }
      : {}),
  });
}

const createTaskResultValidator = v.union(
  v.object({
    created: v.literal(true),
    task: taskDescriptorValidator,
    /**
     * True when the call matched an existing task with the same
     * idempotency key and returned it instead of inserting a row (a
     * replayed MRTR continuation). Nothing was created, no audit row was
     * written, and nothing was scheduled. The task may be in any state,
     * terminal included: it is the outcome of the same request.
     */
    reused: v.optional(v.literal(true)),
    /**
     * Set alongside `reused` when the reused row is host-executed,
     * non-terminal, and carries no `startedAt` — i.e. its original
     * request never got execution started (the executor threw and the
     * compensating `failTask` threw too). The caller must start it, or the
     * client polls a handle nothing will ever advance.
     */
    startPending: v.optional(v.literal(true)),
  }),
  v.object({
    created: v.literal(false),
    reason: v.union(
      v.literal("duplicate_id"),
      v.literal("args_too_large"),
      v.literal("caller_too_large"),
      v.literal("limit_exceeded"),
    ),
  }),
);

/** The two statuses a task can hold while it is still alive. */
const ACTIVE_STATUSES = ["working", "input_required"] as const;

/**
 * Count an owner's live tasks, reading ONLY the non-terminal rows via
 * `by_owner_status` and stopping as soon as the cap is reached. Scanning
 * `by_ownerSubject` instead would read (and take a read dependency on)
 * every task the owner ever created, so a long-lived caller would both
 * slow down linearly and start losing creations to OCC conflicts as
 * unrelated sibling tasks changed status.
 */
async function countActiveOwnerTasks(
  ctx: { db: any },
  ownerSubject: string,
): Promise<number> {
  let active = 0;
  for (const status of ACTIVE_STATUSES) {
    const rows = await ctx.db
      .query("tasks")
      .withIndex("by_owner_status", (q: any) =>
        q.eq("ownerSubject", ownerSubject).eq("status", status),
      )
      .take(TASK_OWNER_ACTIVE_CAP - active);
    active += rows.length;
    if (active >= TASK_OWNER_ACTIVE_CAP) break;
  }
  return active;
}

/**
 * Create one task row for a task-augmented modern `tools/call`. The host
 * has already authorized the call and resolved the owner; the component
 * only enforces storage invariants (unique id, size caps, TTL clamp) and
 * the per-owner live-task cap, which refuses a well-formed request with
 * `limit_exceeded`.
 *
 * When `executor` is `"component"`, execution is scheduled immediately
 * via the Convex scheduler; scheduled work is durable across restarts.
 * When `"host"`, the host starts its own durable execution (typically a
 * `@convex-dev/workflow` run) and finalizes via `completeTask` /
 * `failTask` / `requireTaskInput`.
 */
export const createTask = mutation({
  args: {
    taskId: v.string(),
    ownerSubject: v.string(),
    toolName: v.string(),
    toolKind: toolKindValidator,
    args: v.any(),
    caller: v.optional(
      v.object({ subject: v.string(), claims: v.optional(v.any()) }),
    ),
    idempotencyKey: v.string(),
    executor: v.union(v.literal("component"), v.literal("host")),
    /**
     * Mount scope, from the host's `tasks.scope`. Stored verbatim and
     * required to match on every owner-facing read or update; unset keeps
     * the pre-scope behaviour (see `isOwnedBy`).
     */
    scope: v.optional(v.string()),
    /** See the `tasks.mrtrApproved` field doc in schema.ts. */
    mrtrApproved: v.optional(v.boolean()),
    ttlMs: v.optional(v.number()),
  },
  returns: createTaskResultValidator,
  handler: async (ctx, args) => {
    if (await getRow(ctx, args.taskId)) {
      return { created: false as const, reason: "duplicate_id" as const };
    }
    // Same idempotency key as a live task means this is a repeat of the
    // request that created it — a replayed MRTR continuation, whose chain
    // key IS this key. Return that task instead of a sibling: the client
    // asked once, so it should hold one handle, one TTL, and one audit
    // trail, not two rows it can drive out of step by cancelling either.
    // Only an owner+scope match on the same tool qualifies, so a key can
    // never surface another caller's task; anything else falls through
    // and inserts a new row.
    //
    // Scanned rather than `.first()`ed: a key can legitimately have more
    // than one row (an earlier task that expired but has not been pruned,
    // or a same-key row belonging to another owner or mount), and index
    // order is oldest-first, so taking one row would keep finding the
    // stale one and mint the sibling this exists to prevent. The bound is
    // tiny because keys are UUIDs or chain keys, never shared by design.
    const now = Date.now();
    const sameKey = await ctx.db
      .query("tasks")
      .withIndex("by_idempotencyKey", (q: any) =>
        q.eq("idempotencyKey", args.idempotencyKey),
      )
      .take(TASK_KEY_SCAN_LIMIT);
    // The args are NOT compared here, and do not need to be: the only way
    // to reach this with a colliding key is a verified MRTR continuation,
    // whose `argsDigest` and one-time `jti` were already checked
    // host-side, or a fresh UUID that cannot collide. If key derivation
    // ever changes, this invariant has to be re-established.
    //
    // `executor` and `mrtrApproved` must match too: reusing a row created
    // under the other execution model would leave the work unstarted (or
    // started twice), and reusing a row that predates the tool becoming
    // MRTR-gated would let the executor's gate read an approval decision
    // this request did not make.
    const reusable = (sameKey as TaskRow[]).find(
      (row) =>
        isOwnedBy(row, args.ownerSubject, args.scope) &&
        row.toolName === args.toolName &&
        row.executor === args.executor &&
        (row.mrtrApproved ?? undefined) === (args.mrtrApproved ?? undefined) &&
        !isExpired(row, now),
    );
    if (reusable) {
      // Terminal rows are reused deliberately. This is the SAME request
      // (see the digest note above), so its outcome — including a cancel
      // the owner asked for — is the honest answer. Falling through to a
      // new row would re-run a tool whose task the owner just cancelled.
      //
      // Logged because nothing else records a reuse: no audit row is
      // written and the wire answer is indistinguishable from a fresh
      // creation, so a replay storm would otherwise be invisible.
      console.warn(
        "[mcp-gateway] returning the existing task for a repeated " +
          "idempotency key",
        reusable.taskId,
        reusable.status,
        args.toolName,
      );
      return {
        created: true as const,
        task: descriptor(reusable),
        reused: true as const,
        // The host's executor never confirmed it started this row, so the
        // caller must start it rather than assume the original did.
        ...(reusable.executor === "host" &&
        reusable.startedAt === undefined &&
        !TERMINAL_STATUSES.has(reusable.status)
          ? { startPending: true as const }
          : {}),
      };
    }
    if (sameKey.length >= TASK_KEY_SCAN_LIMIT) {
      // The window was full and nothing in it qualified, so a qualifying
      // row may exist just outside it and we are about to mint the sibling
      // this block exists to prevent. Self-reinforcing (each miss adds a
      // row), so say so loudly.
      console.error(
        "[mcp-gateway] idempotency-key scan window saturated; creating a " +
          "sibling task. Is pruneTasks scheduled?",
        args.idempotencyKey,
        args.toolName,
      );
    }
    if (exceeds(args.args, TASK_MAX_ARGS_BYTES)) {
      return { created: false as const, reason: "args_too_large" as const };
    }
    // The caller snapshot is stored per row and injected at execution;
    // cap it too, or a fat-claims JWT multiplies per-row storage past
    // the args budget.
    if (
      args.caller !== undefined &&
      exceeds(args.caller, TASK_MAX_CALLER_BYTES)
    ) {
      return { created: false as const, reason: "caller_too_large" as const };
    }
    // Per-owner cap on live tasks: bounds row / audit / scheduler growth
    // from an authenticated caller looping task-augmented calls.
    if (
      (await countActiveOwnerTasks(ctx, args.ownerSubject)) >=
      TASK_OWNER_ACTIVE_CAP
    ) {
      return { created: false as const, reason: "limit_exceeded" as const };
    }
    const ttlMs = Math.min(
      Math.max(args.ttlMs ?? TASK_DEFAULT_TTL_MS, TASK_MIN_TTL_MS),
      TASK_MAX_TTL_MS,
    );
    const row = {
      taskId: args.taskId,
      ownerSubject: args.ownerSubject,
      toolName: args.toolName,
      toolKind: args.toolKind,
      args: args.args,
      ...(args.caller !== undefined ? { caller: args.caller } : {}),
      status: "working" as const,
      idempotencyKey: args.idempotencyKey,
      executor: args.executor,
      ...(args.scope !== undefined ? { scope: args.scope } : {}),
      ...(args.mrtrApproved !== undefined
        ? { mrtrApproved: args.mrtrApproved }
        : {}),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMs,
    };
    await ctx.db.insert("tasks", row);
    await recordTaskAudit(ctx, row, "create", "allowed", 0);
    if (args.executor === "component") {
      await ctx.scheduler.runAfter(0, api.tasks.executeScheduledTask, {
        taskId: args.taskId,
      });
    }
    return { created: true as const, task: descriptor(row as TaskRow) };
  },
});

/**
 * Owner-bound poll for `tasks/get`. Returns `null` for unknown ids,
 * foreign owners, and expired rows alike: all three are answered
 * identically on the wire so existence never leaks across callers.
 */
export const getTaskForOwner = query({
  args: {
    taskId: v.string(),
    ownerSubject: v.string(),
    scope: v.optional(v.string()),
  },
  returns: v.union(taskDescriptorValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await getRow(ctx, args.taskId);
    if (!row || !isOwnedBy(row, args.ownerSubject, args.scope)) return null;
    if (isExpired(row, Date.now())) return null;
    return descriptor(row);
  },
});

/**
 * Trusted full-row read for the host's executor / workflow code. Unlike
 * `getTaskForOwner` it returns execution data (`args`, `caller`,
 * `idempotencyKey`) and skips owner binding; never expose it to clients.
 */
export const getTaskInternal = query({
  args: { taskId: v.string() },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    return await getRow(ctx, args.taskId);
  },
});

const cancelResultValidator = v.union(
  v.object({ outcome: v.literal("cancelled"), task: taskDescriptorValidator }),
  v.object({
    outcome: v.literal("already_cancelled"),
    task: taskDescriptorValidator,
  }),
  v.object({ outcome: v.literal("not_found") }),
  v.object({ outcome: v.literal("conflict"), status: taskStatusValidator }),
);

/**
 * Owner-initiated cancellation (`tasks/update` with `action: "cancel"`).
 * Cancelling an already-cancelled task is idempotent
 * (`"already_cancelled"`, no new audit row); cancelling a completed or
 * failed task is a `"conflict"` because the outcome already exists and
 * must stay observable.
 */
export const cancelTaskForOwner = mutation({
  args: {
    taskId: v.string(),
    ownerSubject: v.string(),
    scope: v.optional(v.string()),
  },
  returns: cancelResultValidator,
  handler: async (ctx, args) => {
    const row = await getRow(ctx, args.taskId);
    const now = Date.now();
    if (
      !row ||
      !isOwnedBy(row, args.ownerSubject, args.scope) ||
      isExpired(row, now)
    ) {
      return { outcome: "not_found" as const };
    }
    if (row.status === "cancelled") {
      return { outcome: "already_cancelled" as const, task: descriptor(row) };
    }
    if (TERMINAL_STATUSES.has(row.status)) {
      return { outcome: "conflict" as const, status: row.status };
    }
    await ctx.db.patch("tasks", row._id, {
      status: "cancelled",
      updatedAt: now,
    });
    const updated = { ...row, status: "cancelled" as const, updatedAt: now };
    await recordTaskAudit(ctx, row, "cancel", "allowed", now - row.createdAt);
    return { outcome: "cancelled" as const, task: descriptor(updated) };
  },
});

const submitInputResultValidator = v.union(
  v.object({ outcome: v.literal("accepted"), task: taskDescriptorValidator }),
  v.object({ outcome: v.literal("duplicate"), task: taskDescriptorValidator }),
  v.object({ outcome: v.literal("cancelled"), task: taskDescriptorValidator }),
  v.object({ outcome: v.literal("not_found") }),
  v.object({ outcome: v.literal("conflict"), status: taskStatusValidator }),
  v.object({ outcome: v.literal("mismatch") }),
  v.object({ outcome: v.literal("too_large") }),
  // The submission answers a round other than the one currently
  // pending: a stale retry of an earlier round, or a client that lost
  // count. Rejected so a lost-response retry can never be mistaken for
  // the answer to a re-asked question.
  v.object({
    outcome: v.literal("stale_round"),
    expectedRound: v.number(),
  }),
);

/**
 * True when `value` is a non-empty response map whose every entry carries
 * `action: "cancel"` — the shape that cancels a task instead of resuming
 * it, and therefore the only shape whose replay is a cancel replay.
 */
function isAllCancel(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const responses = Object.values(value);
  return (
    responses.length > 0 &&
    responses.every(
      (response) =>
        isPlainRecord(response) && response.action === "cancel",
    )
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Owner submission of MRTR-shaped `inputResponses` for an
 * `input_required` task (`tasks/update`). Idempotent: re-sending the
 * responses that were already accepted returns `"duplicate"` without a
 * state change or audit row. Every response whose `action` is `"cancel"`
 * cancels the task instead of resuming it.
 */
export const submitInputResponsesForOwner = mutation({
  args: {
    taskId: v.string(),
    ownerSubject: v.string(),
    scope: v.optional(v.string()),
    inputResponses: v.any(),
    /**
     * The round this submission answers, echoed from the task descriptor
     * the client polled. Validator-optional only for rows written before
     * `inputRound` existed: `requireTaskInput` always sets a round, so
     * every row this code can put into `input_required` carries one and a
     * submission that omits the field is rejected as `stale_round`.
     */
    inputRound: v.optional(v.number()),
  },
  returns: submitInputResultValidator,
  handler: async (ctx, args) => {
    const row = await getRow(ctx, args.taskId);
    const now = Date.now();
    if (
      !row ||
      !isOwnedBy(row, args.ownerSubject, args.scope) ||
      isExpired(row, now)
    ) {
      return { outcome: "not_found" as const };
    }
    if (!isPlainRecord(args.inputResponses)) {
      return { outcome: "mismatch" as const };
    }
    const currentRound = row.inputRound ?? 0;
    // Round binding: a submission that names a round other than the one
    // currently pending is a stale retry (e.g. round-1 answers arriving
    // after the host re-asked as round 2 with the same keys). Reject it
    // so it cannot be mistaken for the answer to the re-asked question.
    // The idempotent-duplicate check below still lets a genuine retry of
    // the CURRENT round through.
    //
    // Omitting the field is only tolerated before the first round has been
    // recorded (a client that predates `inputRound`, answering a task the
    // host asked without one). Once the row carries a round, the
    // submission must name it: otherwise a round-1 retry that simply
    // dropped the field would sail past this check into round 2.
    if (args.inputRound === undefined) {
      if (row.inputRound !== undefined) {
        return { outcome: "stale_round" as const, expectedRound: currentRound };
      }
    } else if (args.inputRound !== currentRound) {
      return { outcome: "stale_round" as const, expectedRound: currentRound };
    }
    // An all-cancel submission re-sent against the row it itself
    // cancelled is the cancel path's idempotent replay, mirroring
    // `already_cancelled` on `cancelTaskForOwner`: it re-fires the host's
    // `onCancel` so a notification that failed once is recoverable from
    // the wire. No state change, no new audit row.
    //
    // Narrow on purpose: the stored responses must be the all-cancel ones
    // that caused the cancellation. A row that was cancelled some OTHER
    // way (an explicit `tasks/update` cancel after its input was accepted)
    // must still answer `conflict` to a replayed accept, or the client
    // would read "cancelled" as the outcome of the answers it re-sent.
    if (
      row.status === "cancelled" &&
      isAllCancel(row.inputResponses) &&
      safeStableStringify(row.inputResponses) !== null &&
      safeStableStringify(row.inputResponses) ===
        safeStableStringify(args.inputResponses)
    ) {
      return { outcome: "cancelled" as const, task: descriptor(row) };
    }
    // Idempotent duplicate: the same responses for the round still pending
    // were already applied, so the status has moved on to `working`. Any
    // other TERMINAL row is deliberately not treated as a duplicate —
    // "your answers were accepted" would paper over the fact that the
    // task has already produced an outcome, which the client must see as
    // a conflict.
    if (
      !TERMINAL_STATUSES.has(row.status) &&
      row.inputResponses !== undefined &&
      safeStableStringify(row.inputResponses) !== null &&
      safeStableStringify(row.inputResponses) ===
        safeStableStringify(args.inputResponses)
    ) {
      return { outcome: "duplicate" as const, task: descriptor(row) };
    }
    if (row.status !== "input_required") {
      return { outcome: "conflict" as const, status: row.status };
    }
    if (exceeds(args.inputResponses, TASK_MAX_INPUT_BYTES)) {
      return { outcome: "too_large" as const };
    }
    // MRTR-shaped validation: response keys must exactly match the
    // requested input keys, and each response must carry a recognised
    // action verb. Content stays opaque to the gateway.
    const requestKeys = isPlainRecord(row.inputRequests)
      ? Object.keys(row.inputRequests).sort()
      : [];
    const responseKeys = Object.keys(args.inputResponses).sort();
    if (
      requestKeys.length !== responseKeys.length ||
      requestKeys.some((key, index) => key !== responseKeys[index])
    ) {
      return { outcome: "mismatch" as const };
    }
    const responses = Object.values(args.inputResponses);
    if (
      responses.some(
        (response) =>
          !isPlainRecord(response) ||
          (response.action !== "accept" &&
            response.action !== "decline" &&
            response.action !== "cancel"),
      )
    ) {
      return { outcome: "mismatch" as const };
    }
    const cancelled = responses.every(
      (response) => (response as { action: string }).action === "cancel",
    );
    const nextStatus = cancelled ? ("cancelled" as const) : ("working" as const);
    await ctx.db.patch("tasks", row._id, {
      status: nextStatus,
      inputResponses: args.inputResponses,
      updatedAt: now,
    });
    const updated = {
      ...row,
      status: nextStatus,
      inputResponses: args.inputResponses,
      updatedAt: now,
    };
    await recordTaskAudit(
      ctx,
      row,
      cancelled ? "cancel" : "input",
      "allowed",
      now - row.createdAt,
    );
    return {
      outcome: cancelled ? ("cancelled" as const) : ("accepted" as const),
      task: descriptor(updated),
    };
  },
});

/**
 * Record that the host's `tasks.execute` returned for this task, so a
 * replayed request can tell "execution started" from "a row was left
 * behind by a start that failed". Idempotent and best-effort: it only
 * ever sets the marker, never clears it, and a missing row is not an
 * error (the task may have been cancelled or pruned meanwhile).
 */
export const markTaskStarted = mutation({
  args: { taskId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await getRow(ctx, args.taskId);
    if (!row || row.startedAt !== undefined) return null;
    await ctx.db.patch("tasks", row._id, { startedAt: Date.now() });
    return null;
  },
});

const finalizeResultValidator = v.union(
  v.literal("finalized"),
  v.literal("not_found"),
  v.literal("conflict"),
);

/**
 * `completeTask` additionally reports `result_too_large`: the task WAS
 * finalized, but as `failed`, because the result could not be stored.
 * Distinct from `finalized` so a caller (the built-in executor, or a
 * host workflow's final step) can tell "the client got your result" from
 * "the client got an error even though your work committed".
 */
const completeResultValidator = v.union(
  finalizeResultValidator,
  v.literal("result_too_large"),
);

/**
 * Trusted completion, called by the built-in executor or by the host's
 * workflow. Only non-terminal tasks can complete; a cancel that raced
 * ahead wins (`"conflict"`), so a cancelled task never flips back to a
 * success. An oversized result fails the task instead of storing a row
 * the client could never fetch within limits — reported as
 * `"result_too_large"`, NOT `"finalized"`, because the caller's work
 * succeeded while the client will be served an error.
 */
export const completeTask = mutation({
  args: { taskId: v.string(), result: v.any() },
  returns: completeResultValidator,
  handler: async (ctx, args) => {
    const row = await getRow(ctx, args.taskId);
    if (!row) return "not_found";
    const now = Date.now();
    // An expired-but-not-yet-pruned row is unobservable to its owner
    // (get/update answer not_found), so finalizing it would strand an
    // outcome no one can fetch. Treat expiry as gone.
    if (isExpired(row, now)) return "not_found";
    if (TERMINAL_STATUSES.has(row.status)) return "conflict";
    if (exceeds(args.result, TASK_MAX_RESULT_BYTES)) {
      const error = {
        code: -32000,
        message: `Task result exceeds ${TASK_MAX_RESULT_BYTES} serialized bytes`,
      };
      await ctx.db.patch("tasks", row._id, {
        status: "failed",
        error,
        updatedAt: now,
      });
      await recordTaskAudit(
        ctx,
        row,
        "fail",
        "error",
        now - row.createdAt,
        error,
      );
      return "result_too_large";
    }
    await ctx.db.patch("tasks", row._id, {
      status: "completed",
      result: args.result,
      updatedAt: now,
    });
    await recordTaskAudit(ctx, row, "complete", "allowed", now - row.createdAt);
    return "finalized";
  },
});

/**
 * Trusted failure, the error counterpart of `completeTask`. `error`
 * reaches the polling client verbatim, so callers sanitize it first;
 * `auditErrorMessage` (defaulting to the wire message) is what lands in
 * the audit row and may carry the full exception text.
 */
export const failTask = mutation({
  args: {
    taskId: v.string(),
    error: taskErrorValidator,
    auditErrorMessage: v.optional(v.string()),
  },
  returns: finalizeResultValidator,
  handler: async (ctx, args) => {
    const row = await getRow(ctx, args.taskId);
    if (!row) return "not_found";
    const now = Date.now();
    if (isExpired(row, now)) return "not_found";
    if (TERMINAL_STATUSES.has(row.status)) return "conflict";
    await ctx.db.patch("tasks", row._id, {
      status: "failed",
      error: args.error,
      updatedAt: now,
    });
    await recordTaskAudit(ctx, row, "fail", "error", now - row.createdAt, {
      code: args.error.code,
      message: args.auditErrorMessage ?? args.error.message,
    });
    return "finalized";
  },
});

const requireInputResultValidator = v.union(
  v.literal("updated"),
  v.literal("not_found"),
  // The task is not in a state that can ask for input (already terminal,
  // or already awaiting an answer). Distinct from `invalid_requests`,
  // which is a host-side programming error, because hosts are told to
  // treat `conflict` as "the owner got there first, abandon the run".
  v.literal("conflict"),
  v.literal("invalid_requests"),
  v.literal("too_large"),
  v.literal("unsupported_executor"),
);

/**
 * Trusted transition to `input_required`, called by the host's workflow
 * when it needs MRTR-shaped input before continuing. Prior responses are
 * cleared and `inputRound` is bumped so the next `tasks/update` answers
 * THIS request: the round is the anti-replay mechanism that makes the
 * client's echo mandatory, so do not "simplify" the bump away. Resumption is host-owned: the gateway surfaces accepted responses
 * through the `onInputResponses` handler option.
 */
export const requireTaskInput = mutation({
  args: { taskId: v.string(), inputRequests: v.any() },
  returns: requireInputResultValidator,
  handler: async (ctx, args) => {
    const row = await getRow(ctx, args.taskId);
    if (!row) return "not_found";
    const now = Date.now();
    // Expired rows are unobservable to their owner, so a workflow that
    // paused one for input would wait forever for an answer that can
    // never arrive; report gone instead of a phantom success.
    if (isExpired(row, now)) return "not_found";
    // The built-in executor runs once and has already finished or is
    // about to; nothing would ever resume an input_required transition,
    // so the accepted responses would create an unexecutable state.
    // Only host-executed tasks may pause for input.
    if (row.executor !== "host") return "unsupported_executor";
    if (row.status !== "working") return "conflict";
    if (!isPlainRecord(args.inputRequests)) return "invalid_requests";
    if (exceeds(args.inputRequests, TASK_MAX_INPUT_BYTES)) return "too_large";
    await ctx.db.patch("tasks", row._id, {
      status: "input_required",
      inputRequests: args.inputRequests,
      inputResponses: undefined,
      // Bump the round so a response must name this round; a stale retry
      // of an earlier round is rejected as `stale_round`.
      inputRound: (row.inputRound ?? 0) + 1,
      updatedAt: now,
    });
    await recordTaskAudit(ctx, row, "input", "allowed", now - row.createdAt);
    return "updated";
  },
});

/**
 * Fail a scheduled task, reporting every way that can itself fail.
 * Scheduled actions are at-most-once, so a lost failure is permanent:
 * a non-`finalized` outcome means the client will see something else
 * (a cancel that won, an expiry, a vanished row) and a thrown mutation
 * means the row stays `working` until its TTL. Both get a log line
 * naming the task, because neither is visible anywhere else.
 */
async function failScheduledTask(
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  taskId: string,
  toolName: string,
  error: { code: number; message: string },
  auditErrorMessage?: string,
): Promise<void> {
  try {
    const outcome = await ctx.runMutation(api.tasks.failTask, {
      taskId,
      error,
      ...(auditErrorMessage !== undefined ? { auditErrorMessage } : {}),
    });
    if (outcome !== "finalized") {
      console.warn(
        "[mcp-gateway] scheduled task failure not recorded",
        outcome,
        taskId,
        toolName,
      );
    }
  } catch (err) {
    console.error(
      "[mcp-gateway] failed to mark scheduled task as failed; the task " +
        "will stay working until its TTL expires",
      taskId,
      err,
    );
  }
}

/**
 * Built-in executor: runs the registered tool function once and
 * finalizes the task. Scheduled by `createTask` when the host did not
 * configure its own executor; Convex scheduled functions are durable, so
 * a deploy or restart between creation and execution does not lose the
 * task. The invocation itself goes through `dispatch.runTool`, so a
 * task-run tool is identical to a synchronous one in identity injection
 * and error sanitization, and — importantly — produces the same
 * `entryType: "tool"` audit row. (Redaction is moot here: `taskSupport`
 * is incompatible with `metadata.auditArgs`, so a task-run tool always
 * audits its arguments verbatim.) The task lifecycle
 * rows (`entryType: "task"`) are bookkeeping *around* that call, not a
 * replacement for it. A cancellation that lands before execution wins:
 * the task is left untouched.
 */
export const executeScheduledTask = action({
  args: { taskId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // A scheduled action is at-most-once: nothing retries it, so an
    // unhandled rejection anywhere in here is permanent for this task.
    // The row read is therefore guarded too, even though it is the first
    // thing that happens.
    let task: TaskRow | null;
    try {
      task = (await ctx.runQuery(api.tasks.getTaskInternal, {
        taskId: args.taskId,
      })) as TaskRow | null;
    } catch (err) {
      console.error(
        "[mcp-gateway] scheduled task could not be read; it will stay " +
          "working until its TTL expires",
        args.taskId,
        err,
      );
      return null;
    }
    if (!task) {
      // Distinct from the cancel-wins silence below: the row was inserted
      // in the very transaction that scheduled this action, so its
      // absence means it was pruned or lost, not that it finished.
      console.warn(
        "[mcp-gateway] scheduled task row missing at execution",
        args.taskId,
      );
      return null;
    }
    if (task.status !== "working") return null;
    if (isExpired(task, Date.now())) return null;

    let tool:
      | {
          kind: "query" | "mutation" | "action";
          identityArg?: string;
          mrtrArgs?: { idempotencyKey: string };
          mrtrGated?: boolean;
          taskSupport?: boolean;
        }
      | null;
    try {
      tool = (await ctx.runQuery(api.registry.getTool, {
        name: task.toolName,
      })) as typeof tool;
    } catch (err) {
      // Nothing has run yet, so failing the task is unambiguous.
      console.error(
        "[mcp-gateway] scheduled task could not read the registry",
        args.taskId,
        err,
      );
      await failScheduledTask(ctx, args.taskId, task.toolName, {
        code: -32000,
        message: "Task execution failed",
      });
      return null;
    }

    const fail = (error: { code: number; message: string }, audit?: string) =>
      failScheduledTask(ctx, args.taskId, task!.toolName, error, audit);

    if (!tool) {
      await fail({
        code: -32602,
        message: `Unknown tool: ${task.toolName}`,
      });
      return null;
    }
    if (tool.identityArg !== undefined && !task.caller) {
      await fail({
        code: -32001,
        message: "Unauthorized: tool requires an authenticated caller",
      });
      return null;
    }

    // The snapshotted kind must still match the registry: a tool whose
    // kind changed between create and run would otherwise be dispatched
    // under the wrong verb. Fail loudly instead of silently mis-running.
    if (tool.kind !== task.toolKind) {
      await fail({
        code: -32000,
        message: `Tool "${task.toolName}" kind changed since the task was created`,
      });
      return null;
    }
    // Re-check eligibility against the CURRENT row, not the snapshot. A
    // task can outlive a registry change by up to its TTL, and two of
    // those changes must not be bypassed by an already-queued run:
    //   - `mrtrGated`: the row now promises a host-side confirmation hook.
    //     The synchronous path fails closed without one; a queued task
    //     must too, or the destructive call the hook was added to guard
    //     runs unconfirmed. A task whose creation the hook DID approve
    //     carries `mrtrApproved` and is unaffected.
    //   - `taskSupport`: the tool was withdrawn from task execution (e.g.
    //     re-registered with `metadata.auditArgs`, which is incompatible
    //     with it), so it must not keep executing as a task.
    if (
      (tool.mrtrGated === true && task.mrtrApproved !== true) ||
      tool.taskSupport !== true
    ) {
      await fail({
        code: -32000,
        message: `Tool "${task.toolName}" is no longer eligible for task execution`,
      });
      return null;
    }

    // A tool that reserves `mrtrArgs` receives the task row's own
    // idempotency key, which is stable across the whole task (including
    // an input_required round trip) so the tool can dedupe its side
    // effect exactly as it does on the synchronous MRTR path.
    const callArgs =
      tool.mrtrArgs !== undefined
        ? {
            ...(task.args as Record<string, unknown>),
            [tool.mrtrArgs.idempotencyKey]: task.idempotencyKey,
          }
        : task.args;

    // The tool invocation and the finalization live in SEPARATE try
    // scopes: a completion failure after a mutation tool committed its
    // side effects must not be misreported as "the tool failed".
    //
    // `runTool` turns every *tool* error into a result union, so a tool
    // failure needs no catch here. The `runAction` boundary itself can
    // still reject (registry read, size limits, timeout, transient
    // infrastructure), and that rejection can land after a mutation tool
    // committed — hence the deliberately ambiguous audit text.
    let dispatched: Awaited<ReturnType<typeof ctx.runAction>>;
    try {
      dispatched = await ctx.runAction(api.dispatch.runTool, {
        name: task.toolName,
        args: callArgs,
        auditIdentitySubject: task.caller?.subject ?? null,
        identity: task.caller ?? null,
      });
    } catch (err) {
      console.error(
        "[mcp-gateway] scheduled task dispatch threw at the component " +
          "boundary; the tool's side effects may or may not have committed",
        args.taskId,
        task.toolName,
        err,
      );
      await fail(
        { code: -32000, message: "Task execution failed" },
        `dispatch boundary threw (effect may have committed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
    if (!dispatched.ok) {
      // runTool already wrote the `entryType: "tool"` audit row, honouring
      // the tool's `metadata.auditErrorMessage` setting. The task
      // lifecycle row keeps its no-payload contract and records only the
      // error code, so an opted-out message can't leak through it.
      await fail(dispatched.error);
      return null;
    }
    const data = dispatched.data;
    try {
      const outcome = await ctx.runMutation(api.tasks.completeTask, {
        taskId: args.taskId,
        result: data ?? null,
      });
      if (outcome === "conflict") {
        // The owner cancelled while the tool was executing; cancel wins,
        // but a mutation tool's side effects have already committed.
        // Leave the operator a trace of the discarded result.
        console.warn(
          "[mcp-gateway] scheduled task finished after cancellation; the " +
            "tool's committed side effects are not rolled back and its " +
            "result was discarded",
          args.taskId,
          task.toolName,
        );
      } else if (outcome === "result_too_large") {
        // The tool succeeded; the task was failed because its result
        // could not be stored. The client sees an error, so make the
        // discrepancy visible to whoever has to explain it.
        console.error(
          "[mcp-gateway] scheduled task succeeded but its result exceeded " +
            "the storable size; the task was failed and the result discarded",
          args.taskId,
          task.toolName,
        );
      } else if (outcome === "not_found") {
        console.error(
          "[mcp-gateway] scheduled task row disappeared before completion; " +
            "the tool result was discarded",
          args.taskId,
          task.toolName,
        );
      }
    } catch (err) {
      // The tool succeeded but completion could not be recorded. Do NOT
      // mark the task failed (that would misreport committed work); the
      // row is bounded by its TTL.
      console.error(
        "[mcp-gateway] failed to record scheduled task completion; the " +
          "task will stay working until its TTL expires",
        args.taskId,
        err,
      );
    }
    return null;
  },
});

/**
 * Drop expired task rows. Bounded per call like every other prune in
 * this component; hosts drain from a cron via `gateway.pruneTasks`,
 * looping until the return value is `0`.
 *
 * Non-terminal rows are pruned too, deliberately: the TTL is the task's
 * execution deadline, not just its retention window. An expired `working`
 * or `input_required` row is already unobservable to its owner (every
 * owner-facing function answers `not_found` past `expiresAt`) and its
 * trusted finalizers refuse to write to it, so keeping the row would only
 * accumulate storage. A long-running tool therefore needs a `ttlMs` that
 * covers its worst-case runtime; a host executor that outlives the TTL
 * finds its `completeTask` / `failTask` answered `not_found`. Pruning a
 * non-terminal row writes the `fail` audit row it never got, so the
 * lifecycle trail (not pruned here) always shows how a task ended.
 */
export const pruneTasks = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("tasks")
      // `isExpired` treats `expiresAt <= now` as gone, so prune must use
      // the same boundary or a row landing exactly on it would be
      // unobservable yet survive this pass.
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(PRUNE_BATCH);
    let deleted = 0;
    let abandoned = 0;
    const abandonedIds: string[] = [];
    for (const row of rows) {
      const task = row as TaskRow;
      if (!TERMINAL_STATUSES.has(task.status)) {
        abandonedIds.push(task.taskId);
        // The task never reached a terminal state: it crashed, its
        // executor never started, or the client never answered an input
        // round. Write the `fail` row it never got, so the audit trail
        // shows how the task ended instead of stopping at `create` and
        // leaving "still running", "crashed", and "never existed"
        // indistinguishable forever.
        await recordTaskAudit(
          ctx,
          task,
          "fail",
          "error",
          now - task.createdAt,
          {
            code: -32000,
            message: `task expired in status "${task.status}" before finalization`,
          },
        );
        abandoned++;
      }
      await ctx.db.delete("tasks", row._id);
      deleted++;
    }
    if (abandoned > 0) {
      // Named, not just counted: this warn is sometimes the only trace
      // that a task existed at all, so an operator must be able to grep
      // for the id the client was polling.
      console.warn(
        "[mcp-gateway] pruned task rows that never finalized",
        abandoned,
        abandonedIds.join(","),
      );
    }
    return deleted;
  },
});

/**
 * Cancel every live (non-terminal) task owned by `ownerSubject`, for the
 * revocation case: an operator learns a subject's access was revoked and
 * wants its pending tasks stopped before they execute with the (still
 * valid until TTL) stored identity snapshot. Bounded per call via the
 * `by_ownerSubject` index; the host re-invokes with
 * `cursorCreationTime = cursor` until `cursor` is `null`. `cancelled` may
 * legitimately be `0` for a page whose rows were all terminal while later
 * pages still hold live tasks, which is why the cursor — not the count —
 * terminates the loop. Returns what was cancelled this batch. Terminal tasks are left as-is
 * so their outcome stays observable. The host still cancels any durable
 * execution (workflow run) itself.
 *
 * `scope` behaves DIFFERENTLY here than on the owner-facing functions, on
 * purpose. There, an omitted scope means "unscoped rows only", because a
 * mount must not reach another mount's tasks. Revocation is about the
 * SUBJECT, not the mount: omitting `scope` cancels every task that
 * subject owns across all mounts, which is what an operator processing a
 * revocation wants. Pass a `scope` only to narrow the sweep to one mount.
 */
export const cancelPendingTasksForOwner = mutation({
  args: {
    ownerSubject: v.string(),
    /** Narrow the sweep to one mount's tasks; omit to cancel all of them. */
    scope: v.optional(v.string()),
    cursorCreationTime: v.optional(v.number()),
  },
  returns: v.object({
    cancelled: v.number(),
    taskIds: v.array(v.string()),
    /**
     * Rows examined this page, whatever their status or scope. Lets the
     * caller tell "this subject had nothing pending" from "a `scope`
     * argument matched nothing", which are otherwise the same
     * `cancelled: 0` — and the second one means a revoked subject's tasks
     * are still armed.
     */
    scanned: v.number(),
    /**
     * Live rows this page skipped ONLY because their scope did not match.
     * Non-zero with `cancelled: 0` is the wrong-scope signal; a sweep over
     * a subject whose tasks have all settled reports zero for both.
     */
    outOfScope: v.number(),
    cursor: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    // Page by the compound (ownerSubject, _creationTime) order so the
    // cursor advances regardless of how many rows we actually cancel:
    // live tasks are a sparse predicate here (terminal rows sit
    // interleaved), so a plain repeated `.take()` from the front could
    // stall behind a window full of terminal rows.
    const rows = await ctx.db
      .query("tasks")
      .withIndex("by_ownerSubject", (q) =>
        args.cursorCreationTime !== undefined
          ? q
              .eq("ownerSubject", args.ownerSubject)
              .gt("_creationTime", args.cursorCreationTime)
          : q.eq("ownerSubject", args.ownerSubject),
      )
      .take(PRUNE_BATCH);
    const taskIds: string[] = [];
    let outOfScope = 0;
    for (const row of rows) {
      const task = row as TaskRow;
      if (TERMINAL_STATUSES.has(task.status)) continue;
      if (args.scope !== undefined && task.scope !== args.scope) {
        outOfScope++;
        continue;
      }
      await ctx.db.patch("tasks", task._id, {
        status: "cancelled",
        updatedAt: now,
      });
      await recordTaskAudit(ctx, task, "cancel", "allowed", now - task.createdAt);
      taskIds.push(task.taskId);
    }
    const last = rows[rows.length - 1] as { _creationTime: number } | undefined;
    const cursor =
      rows.length === PRUNE_BATCH && last ? last._creationTime : null;
    if (outOfScope > 0 && taskIds.length === 0) {
      // Every live task this page held belongs to a different mount. With
      // a stale or mistyped `scope` that is the whole sweep, and the
      // operator would read `cancelled: 0` as "nothing was pending" while
      // the revoked subject's tasks stay armed until their TTL.
      console.warn(
        "[mcp-gateway] revocation sweep skipped live tasks that are out of " +
          "scope; is the scope argument correct?",
        args.scope,
        outOfScope,
      );
    }
    return {
      cancelled: taskIds.length,
      taskIds,
      scanned: rows.length,
      outOfScope,
      cursor,
    };
  },
});
