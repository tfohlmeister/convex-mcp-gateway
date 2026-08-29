#!/usr/bin/env node
/* global console, process */

/**
 * Puts a Bearer token on every request the MCP conformance suite sends.
 *
 * The suite has no way to authenticate: `conformance server` takes a URL
 * and nothing else, and its scenarios send no `Authorization` header. The
 * gateway resolves an identity only from a Bearer. Everything that needs
 * an authenticated caller is therefore out of the suite's reach by
 * default, which is most of what this gateway does: MCP Tasks are
 * owner-bound, and a `beforeCall` hook (the only route to an MRTR round
 * or to non-text content) structurally requires a caller.
 *
 * This bridges the two. Point the suite at the proxy instead of at the
 * deployment and those scenarios run for real:
 *
 * ```sh
 * pnpm conformance:proxy                       # in one shell
 * npx @modelcontextprotocol/conformance@alpha server \
 *   --url http://127.0.0.1:3399/mcp --requirements 2026-07-28
 * ```
 *
 * The token defaults to the example app's `valid-admin-token` fixture,
 * which its `resolveIdentity` maps to a subject carrying the
 * `finance.admin` role, so both `authorize` and `authorizeResource`
 * admit it. Against another deployment, pass your own.
 *
 * It is a test shim, not a component of the gateway: it holds a token in
 * an environment variable and adds it to everything, which is exactly
 * what you do not want anywhere near a real deployment. It binds to
 * loopback only, and refuses a non-loopback target unless you say so.
 */

import http from "node:http";

const PORT = Number(process.env.MCP_PROXY_PORT || 3399);
const TARGET = process.env.MCP_PROXY_TARGET || "http://127.0.0.1:3311";
const TOKEN = process.env.MCP_PROXY_TOKEN || "valid-admin-token";
const ALLOW_REMOTE = process.env.MCP_PROXY_ALLOW_REMOTE === "1";

const target = new URL(TARGET);
const isLoopback =
  target.hostname === "127.0.0.1" ||
  target.hostname === "localhost" ||
  target.hostname === "[::1]";

if (!isLoopback && !ALLOW_REMOTE) {
  console.error(
    `[conformance-proxy] refusing to send a bearer token to ${target.origin}.\n` +
      `Set MCP_PROXY_ALLOW_REMOTE=1 if that is really what you want, and use a\n` +
      `token minted for testing.`,
  );
  process.exit(1);
}

const upstreamPort = target.port || (target.protocol === "https:" ? 443 : 80);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    // Replace rather than merge: the suite never sets one, and a stale
    // header would silently decide the identity instead of this token.
    const headers = { ...req.headers, authorization: `Bearer ${TOKEN}` };
    delete headers.host;
    if (body.length > 0) headers["content-length"] = String(body.length);

    const upstream = http.request(
      {
        hostname: target.hostname,
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      console.error("[conformance-proxy] upstream failed", err.message);
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`upstream failed: ${err.message}`);
    });
    if (body.length > 0) upstream.write(body);
    upstream.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[conformance-proxy] http://127.0.0.1:${PORT} -> ${target.origin}, ` +
      `bearer ${TOKEN.slice(0, 4)}...`,
  );
});
