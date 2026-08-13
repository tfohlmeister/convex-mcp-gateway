import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { api } from "./_generated/api.js";

describe("registry", () => {
  test("an ungated row cannot join a gated one on the same function", async () => {
    // The confirmation is worth only as much as the least guarded route
    // to the same function. The client checks this across a declarative
    // catalog; the registry is the only place that sees a later
    // imperative row added beside an earlier gated one.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerTool, {
        name: "invoices_archiveAfterConfirmation",
        description: "Confirmed",
        kind: "mutation",
        functionHandle: "handle-archive",
        inputSchema: { type: "object" },
        mrtrArgs: { idempotencyKey: "continuationKey" },
        mrtrGated: true,
      });

      await expect(
        ctx.runMutation(api.registry.registerTool, {
          name: "invoices_archive_raw",
          description: "Not confirmed",
          kind: "mutation",
          functionHandle: "handle-archive",
          inputSchema: { type: "object" },
        }),
      ).rejects.toThrow(/different MRTR gate/);

      // Only the gated row survives.
      const names = (await ctx.runQuery(api.registry.listTools, {})).map(
        (tool: { name: string }) => tool.name,
      );
      expect(names).toEqual(["invoices_archiveAfterConfirmation"]);
    });
  });

  test("replaceTools rejects a catalog carrying both a gated and an ungated alias", async () => {
    // Most rows reach the registry this way, so the component has to
    // refuse it here too rather than trusting the client's own check.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await expect(
        ctx.runMutation(api.registry.replaceTools, {
          tools: [
            {
              name: "invoices_archiveAfterConfirmation",
              description: "Confirmed",
              kind: "mutation",
              functionHandle: "handle-archive",
              inputSchema: { type: "object" },
              mrtrGated: true,
            },
            {
              name: "invoices_archive_raw",
              description: "Not confirmed",
              kind: "mutation",
              functionHandle: "handle-archive",
              inputSchema: { type: "object" },
            },
          ],
          fingerprint: "fp-1",
        }),
      ).rejects.toThrow(/both a gated and an ungated tool/);
      expect((await ctx.runQuery(api.registry.listTools, {})).length).toBe(0);
    });
  });

  test("mrtrArgs alone counts as gated, in both directions", async () => {
    // The handler gates on `mrtrGated === true || mrtrArgs !== undefined`,
    // and a host registering straight against the component marks the
    // gate with `mrtrArgs` only. A check reading just `mrtrGated` would
    // both miss that gate and reject a legitimate pair.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerTool, {
        name: "archive_confirmed",
        description: "Confirmed the documented direct way",
        kind: "mutation",
        functionHandle: "handle-archive",
        inputSchema: { type: "object" },
        mrtrArgs: { idempotencyKey: "continuationKey" },
      });

      // Missed gate: the ungated alias must still be refused.
      await expect(
        ctx.runMutation(api.registry.registerTool, {
          name: "archive_raw",
          description: "Not confirmed",
          kind: "mutation",
          functionHandle: "handle-archive",
          inputSchema: { type: "object" },
        }),
      ).rejects.toThrow(/different MRTR gate/);

      // False positive: a client-registered row sets BOTH fields, and
      // pairing it with the mrtrArgs-only row above is legitimate.
      await ctx.runMutation(api.registry.registerTool, {
        name: "archive_confirmed_alias",
        description: "Also confirmed, via the client wrapper",
        kind: "mutation",
        functionHandle: "handle-archive",
        inputSchema: { type: "object" },
        mrtrArgs: { idempotencyKey: "continuationKey" },
        mrtrGated: true,
      });
      expect((await ctx.runQuery(api.registry.listTools, {})).length).toBe(2);
    });
  });

  test("re-registering a name cannot strip its gate", async () => {
    // The declarative catalog still supplies the hook, so the handler
    // would keep confirming while dispatching without the idempotency
    // key, and a replayed continuation would double-apply.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerTool, {
        name: "archive",
        description: "Gated",
        kind: "mutation",
        functionHandle: "handle-archive",
        inputSchema: { type: "object" },
        mrtrArgs: { idempotencyKey: "continuationKey" },
        mrtrGated: true,
      });
      await expect(
        ctx.runMutation(api.registry.registerTool, {
          name: "archive",
          description: "Same name, gate dropped",
          kind: "mutation",
          functionHandle: "handle-archive",
          inputSchema: { type: "object" },
        }),
      ).rejects.toThrow(/removes it/);
    });
  });

  test("an upsert cannot shed its gate by changing handle or kind", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerTool, {
        name: "archive",
        description: "Gated",
        kind: "mutation",
        functionHandle: "handle-A",
        inputSchema: { type: "object" },
        mrtrArgs: { idempotencyKey: "continuationKey" },
        mrtrGated: true,
      });

      // Pointing the same name at another function must not launder the
      // gate away: the row is found by NAME, not by handle.
      await expect(
        ctx.runMutation(api.registry.registerTool, {
          name: "archive",
          description: "Same name, different function, no gate",
          kind: "mutation",
          functionHandle: "handle-B",
          inputSchema: { type: "object" },
        }),
      ).rejects.toThrow(/removes it/);

      // Nor may switching the kind skip the check entirely.
      await expect(
        ctx.runMutation(api.registry.registerTool, {
          name: "archive",
          description: "Same name, now a query",
          kind: "query",
          functionHandle: "handle-A",
          inputSchema: { type: "object" },
        }),
      ).rejects.toThrow(/removes it/);
    });
  });

  test("replaceTools reads mrtrArgs as a gate too", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await expect(
        ctx.runMutation(api.registry.replaceTools, {
          tools: [
            {
              name: "archive_confirmed",
              description: "Gated via mrtrArgs only",
              kind: "mutation",
              functionHandle: "handle-archive",
              inputSchema: { type: "object" },
              mrtrArgs: { idempotencyKey: "continuationKey" },
            },
            {
              name: "archive_raw",
              description: "Not confirmed",
              kind: "mutation",
              functionHandle: "handle-archive",
              inputSchema: { type: "object" },
            },
          ],
          fingerprint: "fp-2",
        }),
      ).rejects.toThrow(/both a gated and an ungated tool/);
    });
  });

  test("queries and unrelated functions are unaffected by the gate check", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // A read has nothing destructive to confirm, so aliasing is fine.
      await ctx.runMutation(api.registry.registerTool, {
        name: "search",
        description: "Read",
        kind: "query",
        functionHandle: "handle-search",
        inputSchema: { type: "object" },
        mrtrGated: true,
      });
      await ctx.runMutation(api.registry.registerTool, {
        name: "search_alias",
        description: "Read alias",
        kind: "query",
        functionHandle: "handle-search",
        inputSchema: { type: "object" },
      });
      // A different function is a different question entirely.
      await ctx.runMutation(api.registry.registerTool, {
        name: "invoices_markPaid",
        description: "Other function",
        kind: "mutation",
        functionHandle: "handle-markPaid",
        inputSchema: { type: "object" },
      });
      expect(
        (await ctx.runQuery(api.registry.listTools, {})).length,
      ).toBe(3);
    });
  });

  test("registerTool inserts and is idempotent on name", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerTool, {
        name: "invoices_list",
        description: "first",
        kind: "query",
        functionHandle: "fakehandle-1",
        inputSchema: { type: "object" },
      });

      let tools = await ctx.runQuery(api.registry.listTools, {});
      expect(tools).toHaveLength(1);
      expect(tools[0]!.description).toBe("first");

      await ctx.runMutation(api.registry.registerTool, {
        name: "invoices_list",
        description: "second",
        kind: "query",
        functionHandle: "fakehandle-2",
        inputSchema: { type: "object" },
      });

      tools = await ctx.runQuery(api.registry.listTools, {});
      expect(tools).toHaveLength(1);
      expect(tools[0]!.description).toBe("second");
      expect(tools[0]!.functionHandle).toBe("fakehandle-2");
    });
  });

  test("getTool returns null for unknown names", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const tool = await ctx.runQuery(api.registry.getTool, {
        name: "does-not-exist",
      });
      expect(tool).toBeNull();
    });
  });

  test("unregisterTool removes the row and reports whether it existed", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerTool, {
        name: "tmp_tool",
        description: "tmp",
        kind: "mutation",
        functionHandle: "fakehandle",
        inputSchema: { type: "object" },
      });

      const removedExisting = await ctx.runMutation(
        api.registry.unregisterTool,
        { name: "tmp_tool" },
      );
      expect(removedExisting).toBe(true);

      const removedMissing = await ctx.runMutation(
        api.registry.unregisterTool,
        { name: "tmp_tool" },
      );
      expect(removedMissing).toBe(false);

      const tools = await ctx.runQuery(api.registry.listTools, {});
      expect(tools).toHaveLength(0);
    });
  });

  test("internalListTools is callable via internal", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerTool, {
        name: "a",
        description: "a",
        kind: "query",
        functionHandle: "fakehandle",
        inputSchema: { type: "object" },
      });
      const tools = await ctx.runQuery(api.registry.listTools, {});
      expect(tools).toHaveLength(1);
    });
  });

  test("replaceTools rejects duplicate names in the input array", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await expect(
        ctx.runMutation(api.registry.replaceTools, {
          tools: [
            {
              name: "dup",
              description: "first",
              kind: "query",
              functionHandle: "handle-a",
              inputSchema: { type: "object" },
            },
            {
              name: "dup",
              description: "second",
              kind: "mutation",
              functionHandle: "handle-b",
              inputSchema: { type: "object" },
            },
          ],
        }),
      ).rejects.toThrow(/duplicate tool names/);
    });
  });

  test("clearAllTools removes all tools", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const name of ["one", "two", "three"]) {
        await ctx.runMutation(api.registry.registerTool, {
          name,
          description: name,
          kind: "query",
          functionHandle: "fakehandle",
          inputSchema: { type: "object" },
        });
      }
      expect(await ctx.runQuery(api.registry.listTools, {})).toHaveLength(3);
      await ctx.runMutation(api.registry.clearAllTools, {});
      expect(await ctx.runQuery(api.registry.listTools, {})).toHaveLength(0);
    });
  });

  test("registerTool clears metadata when the upsert omits it (db.replace, not patch)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerTool, {
        name: "scoped",
        description: "with scopes",
        kind: "query",
        functionHandle: "h",
        inputSchema: { type: "object" },
        metadata: { scopes: ["finance:read"] },
      });
      let tool = await ctx.runQuery(api.registry.getTool, { name: "scoped" });
      expect(tool?.metadata).toEqual({ scopes: ["finance:read"] });

      // Re-register the same name without metadata: the prior scopes must
      // not silently survive (regression for db.patch ignoring missing fields).
      await ctx.runMutation(api.registry.registerTool, {
        name: "scoped",
        description: "no longer scoped",
        kind: "query",
        functionHandle: "h",
        inputSchema: { type: "object" },
      });
      tool = await ctx.runQuery(api.registry.getTool, { name: "scoped" });
      expect(tool?.description).toBe("no longer scoped");
      expect(tool?.metadata).toBeUndefined();
    });
  });

  test("replaceTools round-trips metadata and clears it when omitted", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.replaceTools, {
        tools: [
          {
            name: "x",
            description: "v1",
            kind: "query",
            functionHandle: "h",
            inputSchema: { type: "object" },
            metadata: { scopes: ["s"], roles: ["r"] },
          },
        ],
      });
      let row = await ctx.runQuery(api.registry.getTool, { name: "x" });
      expect(row?.metadata).toEqual({ scopes: ["s"], roles: ["r"] });

      // Re-register x without metadata: db.replace must clear it.
      await ctx.runMutation(api.registry.replaceTools, {
        tools: [
          {
            name: "x",
            description: "v2",
            kind: "query",
            functionHandle: "h",
            inputSchema: { type: "object" },
          },
        ],
      });
      row = await ctx.runQuery(api.registry.getTool, { name: "x" });
      expect(row?.description).toBe("v2");
      expect(row?.metadata).toBeUndefined();
    });
  });

  test("replaceTools deletes tools not in the incoming set and upserts the rest", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const name of ["alpha", "beta", "gamma"]) {
        await ctx.runMutation(api.registry.registerTool, {
          name,
          description: "stale",
          kind: "query",
          functionHandle: "stale-handle",
          inputSchema: { type: "object" },
        });
      }
      expect(await ctx.runQuery(api.registry.listTools, {})).toHaveLength(3);

      await ctx.runMutation(api.registry.replaceTools, {
        tools: [
          {
            name: "beta",
            description: "fresh-beta",
            kind: "mutation",
            functionHandle: "fresh-handle",
            inputSchema: { type: "object" },
          },
          {
            name: "delta",
            description: "fresh-delta",
            kind: "query",
            functionHandle: "fresh-handle-2",
            inputSchema: { type: "object" },
          },
        ],
      });

      const after = await ctx.runQuery(api.registry.listTools, {});
      const names = after.map((t) => t.name).sort();
      expect(names).toEqual(["beta", "delta"]);
      const beta = after.find((t) => t.name === "beta")!;
      expect(beta.description).toBe("fresh-beta");
      expect(beta.kind).toBe("mutation");
      expect(beta.functionHandle).toBe("fresh-handle");
    });
  });

  test("registerResource inserts and is idempotent on URI", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerResource, {
        uri: "docs://intro",
        name: "Intro",
        description: "first",
        mimeType: "text/markdown",
      });

      let resources = await ctx.runQuery(api.registry.listResources, {});
      expect(resources).toHaveLength(1);
      expect(resources[0]!.description).toBe("first");

      await ctx.runMutation(api.registry.registerResource, {
        uri: "docs://intro",
        name: "Intro v2",
        description: "second",
      });

      resources = await ctx.runQuery(api.registry.listResources, {});
      expect(resources).toHaveLength(1);
      expect(resources[0]!.name).toBe("Intro v2");
      expect(resources[0]!.description).toBe("second");
      expect(resources[0]!.mimeType).toBeUndefined();
    });
  });

  test("getResource returns null for unknown URIs", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const resource = await ctx.runQuery(api.registry.getResource, {
        uri: "docs://missing",
      });
      expect(resource).toBeNull();
    });
  });

  test("replaceResources rejects duplicate URIs in the input array", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await expect(
        ctx.runMutation(api.registry.replaceResources, {
          resources: [
            {
              uri: "docs://dup",
              name: "first",
            },
            {
              uri: "docs://dup",
              name: "second",
            },
          ],
        }),
      ).rejects.toThrow(/duplicate resource URIs/);
    });
  });

  test("replaceResources deletes resources not in the incoming set and upserts the rest", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const uri of ["docs://alpha", "docs://beta", "docs://gamma"]) {
        await ctx.runMutation(api.registry.registerResource, {
          uri,
          name: uri,
        });
      }
      expect(await ctx.runQuery(api.registry.listResources, {})).toHaveLength(
        3,
      );

      await ctx.runMutation(api.registry.replaceResources, {
        resources: [
          {
            uri: "docs://beta",
            name: "Fresh Beta",
            mimeType: "text/plain",
          },
          {
            uri: "docs://delta",
            name: "Fresh Delta",
            metadata: { audience: "operators" },
          },
        ],
        fingerprint: "fingerprint-v1",
      });

      const after = await ctx.runQuery(api.registry.listResources, {});
      const uris = after.map((r) => r.uri).sort();
      expect(uris).toEqual(["docs://beta", "docs://delta"]);
      const beta = after.find((r) => r.uri === "docs://beta")!;
      expect(beta.name).toBe("Fresh Beta");
      expect(beta.mimeType).toBe("text/plain");
      const delta = after.find((r) => r.uri === "docs://delta")!;
      expect(delta.metadata).toEqual({ audience: "operators" });
      expect(await ctx.runQuery(api.registry.getResourcesFingerprint, {})).toBe(
        "fingerprint-v1",
      );
    });
  });

  test("unregisterResource removes the row and reports whether it existed", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerResource, {
        uri: "docs://tmp",
        name: "Temporary",
      });

      const removedExisting = await ctx.runMutation(
        api.registry.unregisterResource,
        { uri: "docs://tmp" },
      );
      expect(removedExisting).toBe(true);

      const removedMissing = await ctx.runMutation(
        api.registry.unregisterResource,
        { uri: "docs://tmp" },
      );
      expect(removedMissing).toBe(false);

      const resources = await ctx.runQuery(api.registry.listResources, {});
      expect(resources).toHaveLength(0);
    });
  });

  test("clearAllResources removes all resources and clears the resource fingerprint", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.replaceResources, {
        resources: [
          { uri: "docs://one", name: "One" },
          { uri: "docs://two", name: "Two" },
        ],
        fingerprint: "fingerprint-v2",
      });
      expect(await ctx.runQuery(api.registry.getResourcesFingerprint, {})).toBe(
        "fingerprint-v2",
      );

      await ctx.runMutation(api.registry.clearAllResources, {});

      expect(await ctx.runQuery(api.registry.listResources, {})).toHaveLength(
        0,
      );
      expect(
        await ctx.runQuery(api.registry.getResourcesFingerprint, {}),
      ).toBeNull();
    });
  });

  test("setOAuthConfig writes the issuer + optional resource into config", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      expect(await ctx.runQuery(api.registry.getOAuthConfig, {})).toBeNull();

      await ctx.runMutation(api.registry.setOAuthConfig, {
        authServerUrl: "https://idp.example.com/",
      });
      const justAS = await ctx.runQuery(api.registry.getOAuthConfig, {});
      expect(justAS).toEqual({
        authServerUrl: "https://idp.example.com/",
        resourceUrl: null,
      });

      await ctx.runMutation(api.registry.setOAuthConfig, {
        authServerUrl: "https://idp.example.com/",
        resourceUrl: "https://app.example.com/mcp/",
      });
      const both = await ctx.runQuery(api.registry.getOAuthConfig, {});
      expect(both).toEqual({
        authServerUrl: "https://idp.example.com/",
        resourceUrl: "https://app.example.com/mcp/",
      });

      // Disable discovery again.
      await ctx.runMutation(api.registry.setOAuthConfig, {
        authServerUrl: null,
      });
      expect(await ctx.runQuery(api.registry.getOAuthConfig, {})).toBeNull();

      // Re-enabling without resourceUrl must NOT resurrect the previously
      // set resourceUrl (regression for db.patch ignoring undefined).
      await ctx.runMutation(api.registry.setOAuthConfig, {
        authServerUrl: "https://idp2.example.com/",
      });
      const reEnabled = await ctx.runQuery(api.registry.getOAuthConfig, {});
      expect(reEnabled).toEqual({
        authServerUrl: "https://idp2.example.com/",
        resourceUrl: null,
      });
    });
  });

  test("setOAuthConfig rejects non-URL strings instead of failing later", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await expect(
        ctx.runMutation(api.registry.setOAuthConfig, {
          authServerUrl: "not-a-url",
        }),
      ).rejects.toThrow(/authServerUrl/);

      await expect(
        ctx.runMutation(api.registry.setOAuthConfig, {
          authServerUrl: "https://idp.example.com/",
          resourceUrl: "also-bad",
        }),
      ).rejects.toThrow(/resourceUrl/);

      // Non-http schemes are also rejected.
      await expect(
        ctx.runMutation(api.registry.setOAuthConfig, {
          authServerUrl: "javascript:alert(1)",
        }),
      ).rejects.toThrow(/http or https/);
    });
  });

  test("registerResourceTemplate inserts and is idempotent on uriTemplate", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerResourceTemplate, {
        uriTemplate: "db://{table}/{id}",
        name: "first",
      });
      let templates = await ctx.runQuery(
        api.registry.listResourceTemplates,
        {},
      );
      expect(templates).toHaveLength(1);
      expect(templates[0]!.name).toBe("first");

      await ctx.runMutation(api.registry.registerResourceTemplate, {
        uriTemplate: "db://{table}/{id}",
        name: "second",
        title: "Row",
        annotations: { priority: 0.5 },
      });
      templates = await ctx.runQuery(api.registry.listResourceTemplates, {});
      expect(templates).toHaveLength(1);
      expect(templates[0]!.name).toBe("second");
      expect(templates[0]!.title).toBe("Row");
      expect(templates[0]!.annotations).toEqual({ priority: 0.5 });
    });
  });

  test("replaceResourceTemplates rejects duplicate uriTemplates", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await expect(
        ctx.runMutation(api.registry.replaceResourceTemplates, {
          templates: [
            { uriTemplate: "x://{a}", name: "first" },
            { uriTemplate: "x://{a}", name: "second" },
          ],
        }),
      ).rejects.toThrow(/duplicate uriTemplates/);
    });
  });

  test("replaceResourceTemplates deletes non-incoming, upserts the rest, persists title/annotations", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const uriTemplate of ["a://{x}", "b://{x}", "c://{x}"]) {
        await ctx.runMutation(api.registry.registerResourceTemplate, {
          uriTemplate,
          name: uriTemplate,
        });
      }
      expect(
        await ctx.runQuery(api.registry.listResourceTemplates, {}),
      ).toHaveLength(3);

      await ctx.runMutation(api.registry.replaceResourceTemplates, {
        templates: [
          { uriTemplate: "b://{x}", name: "Fresh B", mimeType: "text/plain" },
          {
            uriTemplate: "d://{x}",
            name: "Fresh D",
            title: "D",
            annotations: { audience: ["assistant"] },
          },
        ],
        fingerprint: "tpl-v1",
      });

      const after = await ctx.runQuery(api.registry.listResourceTemplates, {});
      expect(after.map((t) => t.uriTemplate).sort()).toEqual([
        "b://{x}",
        "d://{x}",
      ]);
      const d = after.find((t) => t.uriTemplate === "d://{x}")!;
      expect(d.title).toBe("D");
      expect(d.annotations).toEqual({ audience: ["assistant"] });
      expect(
        await ctx.runQuery(api.registry.getResourceTemplatesFingerprint, {}),
      ).toBe("tpl-v1");
    });
  });

  test("unregisterResourceTemplate removes the row and reports whether it existed", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerResourceTemplate, {
        uriTemplate: "tmp://{x}",
        name: "Temporary",
      });
      expect(
        await ctx.runMutation(api.registry.unregisterResourceTemplate, {
          uriTemplate: "tmp://{x}",
        }),
      ).toBe(true);
      expect(
        await ctx.runMutation(api.registry.unregisterResourceTemplate, {
          uriTemplate: "tmp://{x}",
        }),
      ).toBe(false);
      expect(
        await ctx.runQuery(api.registry.listResourceTemplates, {}),
      ).toHaveLength(0);
    });
  });

  test("clearAllResourceTemplates removes all templates and clears the fingerprint", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.replaceResourceTemplates, {
        templates: [
          { uriTemplate: "one://{x}", name: "One" },
          { uriTemplate: "two://{x}", name: "Two" },
        ],
        fingerprint: "tpl-v2",
      });
      expect(
        await ctx.runQuery(api.registry.getResourceTemplatesFingerprint, {}),
      ).toBe("tpl-v2");

      await ctx.runMutation(api.registry.clearAllResourceTemplates, {});

      expect(
        await ctx.runQuery(api.registry.listResourceTemplates, {}),
      ).toHaveLength(0);
      expect(
        await ctx.runQuery(api.registry.getResourceTemplatesFingerprint, {}),
      ).toBeNull();
    });
  });

  test("the three declarative fingerprints are independent in config", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.replaceResourceTemplates, {
        templates: [{ uriTemplate: "x://{a}", name: "X" }],
        fingerprint: "tpl-fp",
      });
      await ctx.runMutation(api.registry.replaceResources, {
        resources: [{ uri: "docs://x", name: "X" }],
        fingerprint: "res-fp",
      });

      // Writing the resources fingerprint must not clobber the templates one.
      expect(
        await ctx.runQuery(api.registry.getResourceTemplatesFingerprint, {}),
      ).toBe("tpl-fp");
      expect(await ctx.runQuery(api.registry.getResourcesFingerprint, {})).toBe(
        "res-fp",
      );

      // And clearing templates leaves the resources fingerprint intact.
      await ctx.runMutation(api.registry.clearAllResourceTemplates, {});
      expect(
        await ctx.runQuery(api.registry.getResourceTemplatesFingerprint, {}),
      ).toBeNull();
      expect(await ctx.runQuery(api.registry.getResourcesFingerprint, {})).toBe(
        "res-fp",
      );
    });
  });
});
