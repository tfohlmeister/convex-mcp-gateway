# AGENTS.md

How to verify a change in this repo. Read this before you report a
change as verified.

## Run the full check

```sh
pnpm install
pnpm build       # required before pnpm test
pnpm typecheck
pnpm test
pnpm lint
```

These are the same steps CI runs, in the same order. Run all five.

`pnpm build` is not optional. The example suite imports
`convex-mcp-gateway` by package name, which resolves to `dist/`. Without
a build, that suite fails to import and its results are meaningless.

Do not report a subset of `pnpm test` as verification. A focused
`vitest run <file>` is a debugging aid, not a result.

## Know which layer catches what

The unit tests in `src/client/*.test.ts` run against a **mock**
component. Mocks do not enforce Convex validators, so a wrong validator
passes there.

`example/convex/mcp.test.ts` registers the real component schema and the
real component modules through `convex-test`. Convex argument and return
validators are enforced there. Convex `v.object` rejects unknown fields,
so a field that the client writes but the mutation does not declare
fails here and only here.

If you change what the component stores or accepts, add coverage to
`example/convex/mcp.test.ts`. Then prove the new test is not vacuous:
revert your source change, confirm the test fails, restore the change,
confirm it passes.

## Never hand-edit generated code

`_generated/` directories are output. Editing them makes a broken change
look green, because the hand-written types no longer describe the real
validators.

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

## Before you report the result

- State the exact commands you ran and their outcome.
- Check the CI status on the pull request. A red check is a result, not
  noise.
- If you skipped a step, say which one and why.
