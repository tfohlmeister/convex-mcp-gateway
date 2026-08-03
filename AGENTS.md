# AGENTS.md

## Verifying changes

```sh
pnpm install
pnpm build       # required before pnpm test
pnpm typecheck
pnpm test
pnpm lint
```

## Never hand-edit generated code

`_generated/` directories are generated and must never be hand edited.

Regenerate them against a live backend:

```sh
pnpm local:start        # terminal 1: local Convex backend on :3310 / :3311
pnpm run build:codegen  # terminal 2: convex codegen + build
```

Commit the regenerated files. Then run the full check again.

## Optional: smoke test a real client

For protocol-surface changes, drive the gateway with the MCP Inspector
against the local backend. See
[docs/testing.md](./docs/testing.md#real-client-smoke-test-mcp-inspector).
