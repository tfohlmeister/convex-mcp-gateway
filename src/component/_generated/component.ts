/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    audit: {
      listEntries: FunctionReference<
        "query",
        "internal",
        {
          entryType?: "tool" | "resource" | "task";
          limit?: number;
          outcome?: "allowed" | "denied" | "error";
          resourceUri?: string;
          taskId?: string;
          toolName?: string;
        },
        Array<{
          _creationTime: number;
          _id: string;
          args: any;
          durationMs: number;
          entryType?: "tool" | "resource" | "task";
          errorCode?: number;
          errorMessage?: string;
          identitySubject: string | null;
          outcome: "allowed" | "denied" | "error";
          resourceOperation?: "list" | "read" | "templates_list";
          resourceUri?: string;
          taskId?: string;
          taskOperation?: "create" | "input" | "cancel" | "complete" | "fail";
          toolKind?: "query" | "mutation" | "action";
          toolName?: string;
        }>,
        Name
      >;
      pruneOlderThan: FunctionReference<
        "mutation",
        "internal",
        { cutoffMs: number },
        number,
        Name
      >;
      recordResourceEntry: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          durationMs: number;
          errorCode?: number;
          errorMessage?: string;
          identitySubject: string | null;
          outcome: "allowed" | "denied" | "error";
          resourceOperation: "list" | "read" | "templates_list";
          resourceUri?: string;
        },
        string,
        Name
      >;
    };
    dispatch: {
      recordAuthDenial: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          auditIdentitySubject: string | null;
          durationMs: number;
          errorCode: number;
          errorMessage: string;
          name: string;
          outcome: "denied" | "error";
        },
        null,
        Name
      >;
      runTool: FunctionReference<
        "action",
        "internal",
        {
          args: any;
          auditIdentitySubject: string | null;
          identity?: { claims?: any; subject: string } | null;
          name: string;
        },
        | { data: any; ok: true }
        | { error: { code: number; message: string }; ok: false },
        Name
      >;
    };
    mrtr: {
      claimChain: FunctionReference<
        "mutation",
        "internal",
        {
          chainKey: string;
          expiresAt: number;
          jti: string;
          resolution: "dispatched" | "completed";
          responsesDigest?: string;
        },
        | "claimed"
        | {
            resolution: "dispatched" | "completed";
            resolvedByDigest?: string;
            resolvedByJti: string;
          },
        Name
      >;
      getChainResolution: FunctionReference<
        "query",
        "internal",
        { chainKey: string },
        null | {
          resolution: "dispatched" | "completed";
          resolvedByDigest?: string;
          resolvedByJti: string;
        },
        Name
      >;
      pruneMrtrRedemptions: FunctionReference<
        "mutation",
        "internal",
        {},
        number,
        Name
      >;
      redeemContinuation: FunctionReference<
        "mutation",
        "internal",
        { expiresAt: number; jti: string; responsesDigest?: string },
        "fresh" | "replay" | "conflict",
        Name
      >;
    };
    registry: {
      clearAllResources: FunctionReference<
        "mutation",
        "internal",
        {},
        null,
        Name
      >;
      clearAllResourceTemplates: FunctionReference<
        "mutation",
        "internal",
        {},
        null,
        Name
      >;
      clearAllTools: FunctionReference<"mutation", "internal", {}, null, Name>;
      getOAuthConfig: FunctionReference<
        "query",
        "internal",
        {},
        { authServerUrl: string; resourceUrl: string | null } | null,
        Name
      >;
      getResource: FunctionReference<
        "query",
        "internal",
        { uri: string },
        {
          _creationTime: number;
          _id: string;
          description?: string;
          metadata?: any;
          mimeType?: string;
          name: string;
          uri: string;
        } | null,
        Name
      >;
      getResourcesFingerprint: FunctionReference<
        "query",
        "internal",
        {},
        string | null,
        Name
      >;
      getResourceTemplatesFingerprint: FunctionReference<
        "query",
        "internal",
        {},
        string | null,
        Name
      >;
      getTool: FunctionReference<
        "query",
        "internal",
        { name: string },
        {
          _creationTime: number;
          _id: string;
          authoredInputSchemaJson?: string;
          authoredOutputSchemaJson?: string;
          description: string;
          functionHandle: string;
          identityArg?: string;
          inputSchema: any;
          kind: "query" | "mutation" | "action";
          metadata?: any;
          mrtrArgs?: { idempotencyKey: string };
          mrtrGated?: boolean;
          name: string;
          outputSchema?: any;
          protocolMetadata?: any;
          taskSupport?: boolean;
        } | null,
        Name
      >;
      getToolsFingerprint: FunctionReference<
        "query",
        "internal",
        {},
        string | null,
        Name
      >;
      listResources: FunctionReference<
        "query",
        "internal",
        {},
        Array<{
          _creationTime: number;
          _id: string;
          description?: string;
          metadata?: any;
          mimeType?: string;
          name: string;
          uri: string;
        }>,
        Name
      >;
      listResourceTemplates: FunctionReference<
        "query",
        "internal",
        {},
        Array<{
          _creationTime: number;
          _id: string;
          annotations?: any;
          description?: string;
          icons?: any;
          mimeType?: string;
          name: string;
          title?: string;
          uriTemplate: string;
        }>,
        Name
      >;
      listTools: FunctionReference<
        "query",
        "internal",
        {},
        Array<{
          _creationTime: number;
          _id: string;
          authoredInputSchemaJson?: string;
          authoredOutputSchemaJson?: string;
          description: string;
          functionHandle: string;
          identityArg?: string;
          inputSchema: any;
          kind: "query" | "mutation" | "action";
          metadata?: any;
          mrtrArgs?: { idempotencyKey: string };
          mrtrGated?: boolean;
          name: string;
          outputSchema?: any;
          protocolMetadata?: any;
          taskSupport?: boolean;
        }>,
        Name
      >;
      registerResource: FunctionReference<
        "mutation",
        "internal",
        {
          description?: string;
          metadata?: any;
          mimeType?: string;
          name: string;
          uri: string;
        },
        string,
        Name
      >;
      registerResourceTemplate: FunctionReference<
        "mutation",
        "internal",
        {
          annotations?: any;
          description?: string;
          icons?: any;
          mimeType?: string;
          name: string;
          title?: string;
          uriTemplate: string;
        },
        string,
        Name
      >;
      registerTool: FunctionReference<
        "mutation",
        "internal",
        {
          authoredInputSchemaJson?: string;
          authoredOutputSchemaJson?: string;
          description: string;
          functionHandle: string;
          identityArg?: string;
          inputSchema: any;
          kind: "query" | "mutation" | "action";
          metadata?: any;
          mrtrArgs?: { idempotencyKey: string };
          mrtrGated?: boolean;
          name: string;
          outputSchema?: any;
          protocolMetadata?: any;
          taskSupport?: boolean;
        },
        string,
        Name
      >;
      replaceResources: FunctionReference<
        "mutation",
        "internal",
        {
          fingerprint?: string;
          resources: Array<{
            description?: string;
            metadata?: any;
            mimeType?: string;
            name: string;
            uri: string;
          }>;
        },
        null,
        Name
      >;
      replaceResourceTemplates: FunctionReference<
        "mutation",
        "internal",
        {
          fingerprint?: string;
          templates: Array<{
            annotations?: any;
            description?: string;
            icons?: any;
            mimeType?: string;
            name: string;
            title?: string;
            uriTemplate: string;
          }>;
        },
        null,
        Name
      >;
      replaceTools: FunctionReference<
        "mutation",
        "internal",
        {
          fingerprint?: string;
          tools: Array<{
            authoredInputSchemaJson?: string;
            authoredOutputSchemaJson?: string;
            description: string;
            functionHandle: string;
            identityArg?: string;
            inputSchema: any;
            kind: "query" | "mutation" | "action";
            metadata?: any;
            mrtrArgs?: { idempotencyKey: string };
            mrtrGated?: boolean;
            name: string;
            outputSchema?: any;
            protocolMetadata?: any;
            taskSupport?: boolean;
          }>;
        },
        null,
        Name
      >;
      setOAuthConfig: FunctionReference<
        "mutation",
        "internal",
        { authServerUrl: string | null; resourceUrl?: string | null },
        null,
        Name
      >;
      unregisterResource: FunctionReference<
        "mutation",
        "internal",
        { uri: string },
        boolean,
        Name
      >;
      unregisterResourceTemplate: FunctionReference<
        "mutation",
        "internal",
        { uriTemplate: string },
        boolean,
        Name
      >;
      unregisterTool: FunctionReference<
        "mutation",
        "internal",
        { name: string },
        boolean,
        Name
      >;
    };
    sessions: {
      createSession: FunctionReference<
        "mutation",
        "internal",
        {
          identitySubject: string | null;
          protocolVersion: string;
          sessionId: string;
        },
        string,
        Name
      >;
      deleteSession: FunctionReference<
        "mutation",
        "internal",
        { callerIdentitySubject: string | null; sessionId: string },
        "deleted" | "not_found" | "forbidden",
        Name
      >;
      getSession: FunctionReference<
        "query",
        "internal",
        { sessionId: string },
        {
          _creationTime: number;
          _id: string;
          createdAt: number;
          identitySubject?: string | null;
          lastSeenAt: number;
          protocolVersion: string;
          sessionId: string;
        } | null,
        Name
      >;
      listResourceSubscribers: FunctionReference<
        "query",
        "internal",
        { uri: string },
        Array<string>,
        Name
      >;
      pruneOrphanResourceSubscriptions: FunctionReference<
        "mutation",
        "internal",
        { cursorCreationTime?: number },
        { cursor: number | null; deleted: number },
        Name
      >;
      pruneSessions: FunctionReference<
        "mutation",
        "internal",
        { olderThanMs: number },
        number,
        Name
      >;
      subscribeResource: FunctionReference<
        "mutation",
        "internal",
        { sessionId: string; uri: string },
        "subscribed" | "exists" | "limit_exceeded",
        Name
      >;
      touchSession: FunctionReference<
        "mutation",
        "internal",
        { sessionId: string },
        boolean,
        Name
      >;
      unsubscribeResource: FunctionReference<
        "mutation",
        "internal",
        { sessionId: string; uri: string },
        boolean,
        Name
      >;
    };
    tasks: {
      cancelPendingTasksForOwner: FunctionReference<
        "mutation",
        "internal",
        { cursorCreationTime?: number; ownerSubject: string; scope?: string },
        {
          cancelled: number;
          cursor: number | null;
          outOfScope: number;
          scanned: number;
          taskIds: Array<string>;
        },
        Name
      >;
      cancelTaskForOwner: FunctionReference<
        "mutation",
        "internal",
        { ownerSubject: string; scope?: string; taskId: string },
        | {
            executor: "component" | "host";
            outcome: "cancelled";
            task: {
              createdAt: number;
              error?: { code: number; message: string };
              expiresAt: number;
              inputRequests?: any;
              inputRound?: number;
              result?: any;
              status:
                | "working"
                | "input_required"
                | "completed"
                | "failed"
                | "cancelled";
              taskId: string;
              toolName: string;
              updatedAt: number;
            };
          }
        | {
            executor: "component" | "host";
            outcome: "already_cancelled";
            task: {
              createdAt: number;
              error?: { code: number; message: string };
              expiresAt: number;
              inputRequests?: any;
              inputRound?: number;
              result?: any;
              status:
                | "working"
                | "input_required"
                | "completed"
                | "failed"
                | "cancelled";
              taskId: string;
              toolName: string;
              updatedAt: number;
            };
          }
        | { outcome: "not_found" }
        | {
            outcome: "conflict";
            status:
              | "working"
              | "input_required"
              | "completed"
              | "failed"
              | "cancelled";
          },
        Name
      >;
      completeTask: FunctionReference<
        "mutation",
        "internal",
        { isError?: boolean; result: any; taskId: string },
        "finalized" | "not_found" | "conflict" | "result_too_large",
        Name
      >;
      createTask: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          caller?: { claims?: any; subject: string };
          executor: "component" | "host";
          idempotencyKey: string;
          mrtrApproved?: boolean;
          ownerSubject: string;
          scope?: string;
          taskId: string;
          toolKind: "query" | "mutation" | "action";
          toolName: string;
          ttlMs?: number;
        },
        | {
            created: true;
            reused?: true;
            startPending?: true;
            task: {
              createdAt: number;
              error?: { code: number; message: string };
              expiresAt: number;
              inputRequests?: any;
              inputRound?: number;
              result?: any;
              status:
                | "working"
                | "input_required"
                | "completed"
                | "failed"
                | "cancelled";
              taskId: string;
              toolName: string;
              updatedAt: number;
            };
          }
        | {
            created: false;
            reason:
              | "duplicate_id"
              | "args_too_large"
              | "caller_too_large"
              | "limit_exceeded";
          },
        Name
      >;
      executeScheduledTask: FunctionReference<
        "action",
        "internal",
        { taskId: string },
        null,
        Name
      >;
      failTask: FunctionReference<
        "mutation",
        "internal",
        {
          auditErrorMessage?: string;
          error: { code: number; message: string };
          taskId: string;
        },
        "finalized" | "not_found" | "conflict",
        Name
      >;
      getTaskForOwner: FunctionReference<
        "query",
        "internal",
        { ownerSubject: string; scope?: string; taskId: string },
        {
          createdAt: number;
          error?: { code: number; message: string };
          expiresAt: number;
          inputRequests?: any;
          inputRound?: number;
          result?: any;
          status:
            | "working"
            | "input_required"
            | "completed"
            | "failed"
            | "cancelled";
          taskId: string;
          toolName: string;
          updatedAt: number;
        } | null,
        Name
      >;
      getTaskInternal: FunctionReference<
        "query",
        "internal",
        { taskId: string },
        any | null,
        Name
      >;
      markTaskStarted: FunctionReference<
        "mutation",
        "internal",
        { taskId: string },
        null,
        Name
      >;
      pruneTasks: FunctionReference<"mutation", "internal", {}, number, Name>;
      requireTaskInput: FunctionReference<
        "mutation",
        "internal",
        { inputRequests: any; taskId: string },
        | "updated"
        | "not_found"
        | "conflict"
        | "invalid_requests"
        | "too_large"
        | "unsupported_executor",
        Name
      >;
      submitInputResponsesForOwner: FunctionReference<
        "mutation",
        "internal",
        {
          inputResponses: any;
          inputRound?: number;
          ownerSubject: string;
          scope?: string;
          taskId: string;
        },
        | {
            executor: "component" | "host";
            outcome: "accepted";
            task: {
              createdAt: number;
              error?: { code: number; message: string };
              expiresAt: number;
              inputRequests?: any;
              inputRound?: number;
              result?: any;
              status:
                | "working"
                | "input_required"
                | "completed"
                | "failed"
                | "cancelled";
              taskId: string;
              toolName: string;
              updatedAt: number;
            };
          }
        | {
            executor: "component" | "host";
            outcome: "duplicate";
            task: {
              createdAt: number;
              error?: { code: number; message: string };
              expiresAt: number;
              inputRequests?: any;
              inputRound?: number;
              result?: any;
              status:
                | "working"
                | "input_required"
                | "completed"
                | "failed"
                | "cancelled";
              taskId: string;
              toolName: string;
              updatedAt: number;
            };
          }
        | {
            executor: "component" | "host";
            outcome: "cancelled";
            task: {
              createdAt: number;
              error?: { code: number; message: string };
              expiresAt: number;
              inputRequests?: any;
              inputRound?: number;
              result?: any;
              status:
                | "working"
                | "input_required"
                | "completed"
                | "failed"
                | "cancelled";
              taskId: string;
              toolName: string;
              updatedAt: number;
            };
          }
        | { outcome: "not_found" }
        | {
            outcome: "conflict";
            status:
              | "working"
              | "input_required"
              | "completed"
              | "failed"
              | "cancelled";
          }
        | { outcome: "mismatch" }
        | { outcome: "too_large" }
        | { expectedRound: number; outcome: "stale_round" },
        Name
      >;
    };
  };
