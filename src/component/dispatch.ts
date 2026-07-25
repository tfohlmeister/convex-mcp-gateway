import { ConvexError, v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { action, mutation } from "./_generated/server.js";
import { api, internal } from "./_generated/api.js";
import { mcpCallerValidator } from "../shared.js";

const dispatchResultValidator = v.union(
  v.object({ ok: v.literal(true), data: v.any() }),
  v.object({
    ok: v.literal(false),
    error: v.object({ code: v.number(), message: v.string() }),
  }),
);

type RegisteredTool = {
  name: string;
  description: string;
  kind: "query" | "mutation" | "action";
  functionHandle: string;
  inputSchema: unknown;
  identityArg?: string;
  metadata?: unknown;
};

/**
 * Run a registered tool by name. Looks up the function handle from the
 * registry, invokes it with the caller-supplied args, and writes one
 * audit row per call.
 *
 * The component intentionally does **not** authorize. Authorization
 * lives entirely host-side in `gateway.handleMcpRequest({ authorize })`,
 * because Convex does not propagate `ctx.auth` into component code (see
 * the Convex authoring docs). The host calls the host-side authorize
 * function before delegating to this action; by the time the call
 * arrives here, the request is already approved.
 *
 * `auditIdentitySubject` is the only piece of identity the host
 * forwards: a string subject for audit attribution, or null for
 * anonymous calls. Nothing about the policy decision crosses the
 * component boundary.
 */
export const runTool = action({
  args: {
    name: v.string(),
    args: v.any(),
    auditIdentitySubject: v.union(v.string(), v.null()),
    /**
     * Caller identity to inject into the tool's `identityArg` argument.
     * Resolved host-side at the gateway boundary. Only used when the
     * registered tool declares an `identityArg`; ignored otherwise.
     * Optional so direct (test) callers and identity-less tools can omit it.
     */
    identity: v.optional(v.union(mcpCallerValidator, v.null())),
  },
  returns: dispatchResultValidator,
  handler: async (ctx, request) => {
    const start = Date.now();

    const tool = (await ctx.runQuery(api.registry.getTool, {
      name: request.name,
    })) as RegisteredTool | null;
    if (!tool) {
      // Intentionally not audited: an unauthenticated caller can spam
      // arbitrary tool names with arbitrary args, and this would let
      // them grow the audit table without bound.
      return {
        ok: false as const,
        error: { code: -32602, message: `Unknown tool: ${request.name}` },
      };
    }

    // A tool that declares `identityArg` needs a resolved caller. Deny
    // here too (not only in the host handler) so a direct `runTool` call
    // can't inject `null` and crash the function's arg validator. The
    // component stays self-defending regardless of how it was reached.
    if (tool.identityArg !== undefined && !request.identity) {
      return {
        ok: false as const,
        error: {
          code: -32001,
          message: "Unauthorized: tool requires an authenticated caller",
        },
      };
    }

    // The audit records only what the caller actually sent: strip the
    // identity arg before auditing (defense in depth, since the host also
    // strips it on the HTTP path) so the injected caller / claims never
    // reach the audit log. Inject the resolved caller only into callArgs.
    const callerArgs =
      tool.identityArg !== undefined
        ? omitKey(request.args, tool.identityArg)
        : request.args;
    const auditArgs = redactArgsForAudit(tool, callerArgs);
    const callArgs =
      tool.identityArg !== undefined
        ? {
            ...(callerArgs as Record<string, unknown>),
            [tool.identityArg]: request.identity,
          }
        : request.args;
    let data: unknown;
    // Errors come in two flavours:
    //   - `wire`: what the MCP caller sees in `result.isError` /
    //     JSON-RPC error envelope. Generic for any error that isn't a
    //     deliberate ConvexError, because tool authors can't be
    //     trusted to omit secrets from arbitrary thrown messages
    //     (e.g. fetch errors that quote URLs containing credentials).
    //   - `audit`: what lands in the audit table. Verbose by default,
    //     but tools that can quote credentials or other sensitive values
    //     may opt out of persisted error text with metadata.auditErrorMessage.
    let wireError: { code: number; message: string } | null = null;
    let auditError: { code: number; message?: string } | null = null;
    try {
      const handle = tool.functionHandle as FunctionHandle<
        "query" | "mutation" | "action"
      >;
      switch (tool.kind) {
        case "query":
          data = await ctx.runQuery(
            handle as FunctionHandle<"query">,
            callArgs,
          );
          break;
        case "mutation":
          data = await ctx.runMutation(
            handle as FunctionHandle<"mutation">,
            callArgs,
          );
          break;
        case "action":
          data = await ctx.runAction(
            handle as FunctionHandle<"action">,
            callArgs,
          );
          break;
      }
    } catch (err) {
      const fullMessage = err instanceof Error ? err.message : String(err);
      // ConvexError is the deliberate user-facing channel: hosts
      // throw it when they want a specific message to reach the LLM
      // (e.g. "Invoice not found"). Anything else is treated as an
      // unexpected internal error and the wire gets a generic
      // message; the audit row still records the full text.
      //
      // The instanceof check covers the in-process case; the
      // `name === "ConvexError"` fallback catches the case where the
      // error crossed a Convex function boundary (ctx.runQuery /
      // runMutation / runAction reconstruct the error with the
      // proper `name` but the class identity can differ across
      // module resolution boundaries inside convex-test).
      const isConvexError =
        err instanceof ConvexError ||
        (err instanceof Error && err.name === "ConvexError");
      const wireMessage = isConvexError ? fullMessage : "Tool execution failed";
      wireError = { code: -32000, message: wireMessage };
      auditError = {
        code: -32000,
        ...(shouldAuditErrorMessage(tool) ? { message: fullMessage } : {}),
      };
    }

    // Audit happens AFTER the handler resolves and OUTSIDE the tool's
    // try/catch, so an audit-write failure can never invert a
    // successful tool result into an error response (and vice versa).
    // `safeRecordAudit` additionally swallows its own errors; loss of
    // an audit row is the accepted failure mode here.
    await safeRecordAudit(ctx, {
      toolName: tool.name,
      toolKind: tool.kind,
      args: auditArgs,
      outcome: auditError ? "error" : "allowed",
      identitySubject: request.auditIdentitySubject,
      durationMs: Date.now() - start,
      ...(auditError
        ? {
            errorCode: auditError.code,
            ...(auditError.message !== undefined
              ? { errorMessage: auditError.message }
              : {}),
          }
        : {}),
    });

    if (wireError) {
      return { ok: false as const, error: wireError };
    }
    return { ok: true as const, data };
  },
});

/**
 * Record a deny/error decision the host's authorizer made before
 * delegating. Hosts call this when their authorize callback returns
 * `allowed: false` so the audit log captures the rejection (not just
 * the allowed dispatches).
 *
 * Mutation (not action) because the handler only reads the registry
 * and writes one audit row, no external IO, no non-transactional
 * work. Hosts invoke via `ctx.runMutation`, one round-trip instead
 * of the previous action-wrapping-mutation pattern.
 */
export const recordAuthDenial = mutation({
  args: {
    name: v.string(),
    args: v.any(),
    auditIdentitySubject: v.union(v.string(), v.null()),
    outcome: v.union(v.literal("denied"), v.literal("error")),
    errorCode: v.number(),
    errorMessage: v.string(),
    durationMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, request) => {
    const row = await ctx.db
      .query("tools")
      .withIndex("by_name", (q) => q.eq("name", request.name))
      .unique();
    // If the tool doesn't exist we still record an audit entry: this is
    // a denied call to a known-by-the-caller name, not the anonymous
    // unknown-tool spam path we skip elsewhere.
    const tool = row as RegisteredTool | null;
    const toolKind = tool?.kind ?? "query";
    const auditArgs = tool ? redactArgsForAudit(tool, request.args) : null;
    await ctx.db.insert("audit", {
      entryType: "tool",
      toolName: request.name,
      toolKind,
      args: auditArgs,
      outcome: request.outcome,
      identitySubject: request.auditIdentitySubject,
      durationMs: request.durationMs,
      errorCode: request.errorCode,
      ...(request.outcome !== "error" ||
      tool === null ||
      shouldAuditErrorMessage(tool)
        ? { errorMessage: request.errorMessage }
        : {}),
    });
    return null;
  },
});

/**
 * Hosts shape what gets stored in the audit log via `metadata.auditArgs`:
 *
 *   - `auditArgs: true`              (or omitted) → store args verbatim
 *   - `auditArgs: false`                          → store `null`
 *   - `auditArgs: { redact: [...] }`              → store args with the
 *     listed paths replaced by the string `"[redacted]"`
 *
 * Each entry in `redact` is a dotted path: `"token"` redacts a
 * top-level key, `"credentials.token"` redacts a nested key inside
 * `credentials`. Arrays and missing intermediate keys are passed
 * through unchanged (no insertion). Returned objects are fresh
 * shallow clones at each touched level, so the caller's args object
 * is never mutated.
 */
function redactArgsForAudit(tool: RegisteredTool, args: unknown): unknown {
  const meta = tool.metadata as
    | { auditArgs?: false | true | { redact?: string[] } }
    | null
    | undefined;
  const setting = meta?.auditArgs;

  if (setting === false) return null;
  if (setting === undefined || setting === true) return args;

  const redactList = setting.redact ?? [];
  if (redactList.length === 0) return args;

  let out = args;
  for (const field of redactList) {
    out = applyRedactionPath(out, field.split("."));
  }
  return out;
}

function omitKey(obj: unknown, key: string): unknown {
  // `args` is `v.any()`, so a caller can send a non-object (string,
  // number, array). The `in` operator throws on primitives, so guard
  // before touching it; non-objects are passed through unchanged and
  // the dispatched function's validator rejects them gracefully inside
  // the try/catch (a clean -32000, not an uncaught 500).
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return obj;
  const record = obj as Record<string, unknown>;
  if (!(key in record)) return record;
  const clone = { ...record };
  delete clone[key];
  return clone;
}

function applyRedactionPath(value: unknown, path: string[]): unknown {
  if (path.length === 0) return "[redacted]";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const [head, ...rest] = path;
  const obj = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(obj, head)) return value;
  return { ...obj, [head]: applyRedactionPath(obj[head], rest) };
}

async function safeRecordAudit(
  ctx: { runMutation: (...args: any[]) => Promise<unknown> },
  entry: {
    toolName: string;
    toolKind: "query" | "mutation" | "action";
    args: unknown;
    outcome: "allowed" | "denied" | "error";
    identitySubject: string | null;
    durationMs: number;
    errorCode?: number;
    errorMessage?: string;
  },
): Promise<void> {
  try {
    await ctx.runMutation(internal.audit.recordEntry, entry);
  } catch (err) {
    // Audit must never alter the dispatch outcome. Surface the failure
    // to the deployment log so operators can investigate, then swallow.
    console.error(
      "[mcp-gateway] failed to record audit entry",
      entry.toolName,
      entry.outcome,
      err,
    );
  }
}

// Single source of truth lives in `src/shared.ts` so both the host's
// `mcp-handler` and this component module can defend against malformed
// authorize-callback return values without keeping two copies in sync.
// Re-export keeps `dispatch.test.ts` and any host that imports it stable.
export { parseAuthorizerDecision } from "../shared.js";

/**
 * Error text is persisted by default for backward compatibility. Sensitive
 * tools can set `metadata.auditErrorMessage: false` to retain the outcome and
 * error code without storing an exception message that may quote credentials.
 */
function shouldAuditErrorMessage(tool: RegisteredTool): boolean {
  const meta = tool.metadata as
    | { auditErrorMessage?: false | true }
    | null
    | undefined;
  return meta?.auditErrorMessage !== false;
}
