import { describe, expect, test } from "vitest";
import type { ComponentApi } from "../component/_generated/component.js";
import { McpGateway } from "./index.js";

function gateway() {
  return new McpGateway({} as ComponentApi);
}

function upstreamMetadata(issuer: string, extra: Record<string, unknown> = {}) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    ...extra,
  };
}

async function withFetch(
  body: Record<string, unknown>,
  run: () => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("OAuth bridge CIMD and issuer hardening", () => {
  test("advertises CIMD only when explicitly enabled and supported upstream", async () => {
    const issuer = "https://issuer-cimd.example";
    await withFetch(
      upstreamMetadata(issuer, {
        client_id_metadata_document_supported: true,
      }),
      async () => {
        const response = await gateway().serveAuthorizationServerMetadata(
          null,
          new Request(
            "https://gateway.example/.well-known/oauth-authorization-server",
          ),
          { upstreamIssuer: issuer, clientIdMetadataDocuments: true },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          client_id_metadata_document_supported: true,
          registration_endpoint: "https://gateway.example/oauth/register",
        });
      },
    );
  });

  test("does not advertise CIMD merely because the upstream supports it", async () => {
    const issuer = "https://issuer-dcr.example";
    await withFetch(
      upstreamMetadata(issuer, {
        client_id_metadata_document_supported: true,
      }),
      async () => {
        const response = await gateway().serveAuthorizationServerMetadata(
          null,
          new Request(
            "https://gateway.example/.well-known/oauth-authorization-server",
          ),
          { upstreamIssuer: issuer },
        );

        const body = (await response.json()) as Record<string, unknown>;
        expect(body.client_id_metadata_document_supported).toBeUndefined();
        expect(body.registration_endpoint).toBe(
          "https://gateway.example/oauth/register",
        );
      },
    );
  });

  test("does not advertise CIMD when an enabled bridge has no upstream support", async () => {
    const issuer = "https://issuer-no-cimd.example";
    await withFetch(upstreamMetadata(issuer), async () => {
      const response = await gateway().serveAuthorizationServerMetadata(
        null,
        new Request(
          "https://gateway.example/.well-known/oauth-authorization-server",
        ),
        { upstreamIssuer: issuer, clientIdMetadataDocuments: true },
      );

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.client_id_metadata_document_supported).toBeUndefined();
      expect(body.registration_endpoint).toBe(
        "https://gateway.example/oauth/register",
      );
    });
  });

  test("rejects a discovery document for another issuer", async () => {
    await withFetch(
      upstreamMetadata("https://different-issuer.example"),
      async () => {
        const response = await gateway().serveAuthorizationServerMetadata(
          null,
          new Request(
            "https://gateway.example/.well-known/oauth-authorization-server",
          ),
          { upstreamIssuer: "https://issuer-mismatch.example" },
        );

        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toMatchObject({
          error: "upstream_metadata_unreachable",
        });
      },
    );
  });

  test("caches the discovery document under the normalized issuer", async () => {
    // A trailing slash used to produce a second cache entry, so the same
    // upstream was fetched twice and the two entries could drift apart.
    const issuer = "https://issuer-cache.example";
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify(upstreamMetadata(issuer)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const request = new Request(
        "https://gateway.example/.well-known/oauth-authorization-server",
      );
      for (const configured of [issuer, `${issuer}/`]) {
        const response = await gateway().serveAuthorizationServerMetadata(
          null,
          request,
          { upstreamIssuer: configured },
        );
        expect(response.status).toBe(200);
      }
      expect(fetches).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    "ftp://issuer.example",
    "https://user:pass@issuer.example",
    "https://issuer.example?tenant=one",
    "https://issuer.example#fragment",
  ])("rejects an invalid configured issuer: %s", async (upstreamIssuer) => {
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      throw new Error("should not fetch");
    };
    try {
      const response = await gateway().serveAuthorizationServerMetadata(
        null,
        new Request(
          "https://gateway.example/.well-known/oauth-authorization-server",
        ),
        { upstreamIssuer },
      );

      expect(response.status).toBe(502);
      expect(fetched).toBe(false);
      await expect(response.json()).resolves.toMatchObject({
        error: "upstream_metadata_unreachable",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
