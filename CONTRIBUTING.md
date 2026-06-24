# Contributing

Thanks for your interest. This guide covers the dev loop, the test
patterns specific to this component, and the release flow.

If you're new to the project, [docs/getting-started.md](./docs/getting-started.md)
is a better entry point than this file.

## Local setup

This repo bundles its own pinned `convex-local-backend` binary so you can
deploy and exercise the gateway without a cloud Convex project. The
binary is downloaded into `.tools/` on first use.

```sh
pnpm install
pnpm local:start            # downloads the binary, writes .env.local,
                            # runs the backend on :3310 / :3311
```

## Day-to-day

In a second shell, with the backend from `pnpm local:start` running:

```sh
source .env.local
pnpm convex:codegen         # regenerate _generated/ for component + example
pnpm typecheck
pnpm test
pnpm lint
```

`pnpm check` runs all four (codegen + typecheck + test + lint) but the
codegen step requires a running local backend.

## Releasing

Releases are automated with
[release-please](https://github.com/googleapis/release-please). On every
push to `main` it reads the Conventional Commits since the last release
and maintains a "release PR" that bumps the version (`feat` minor, `fix`
patch, `feat!` or `BREAKING CHANGE` major) and updates `CHANGELOG.md`.

To cut a release, merge that PR. release-please then creates the
`v<x.y.z>` tag and the GitHub release, and the publish job in
`.github/workflows/release.yml` runs. That job is gated by the `release`
environment, so a required reviewer still approves the publish. No version
is hardcoded and there is no local release ceremony.

Publishing uses npm Trusted Publishing (OIDC), so no `NPM_TOKEN` secret is
needed. The Trusted Publisher is registered for workflow file
`release.yml`.

## Tests

Run with `pnpm test`. Patterns specific to this component (registering
the component schema, swapping authorizers per test, simulating
identities) are documented in [docs/testing.md](./docs/testing.md).

When you change behavior, update or add the matching test before sending
the PR. The fleet code review run on the last batch flagged a few
"feature shipped without test" gaps; please don't repeat them.

## Documentation

User-facing changes need a docs update. The relevant files live in
`docs/`:

- New top-level concept → new `docs/<concept>.md` plus a link from
  `README.md`
- Authorizer / `defineMcp*` API change → `docs/authorization.md` and
  the JSDoc on the helper itself
- HTTP / OAuth / `WWW-Authenticate` change → `docs/oauth.md` and
  `docs/architecture.md`
- Audit-log shape change → `docs/audit-log.md`

Diagrams live as editorial-styled SVGs in `docs/diagrams/`, referenced
from the markdown via `![alt](./diagrams/foo.svg)`. The standalone
HTML wrappers (`docs/diagrams/*.html`) provide a print-friendly view.
SVGs are hand-authored; keep them small (no embedded fonts, no
gradients beyond what's already in use) and check both the inline-in-
markdown render and the HTML wrapper before pushing.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org): the
prefix now drives the next version. `fix:` triggers a patch, `feat:` a
minor, and `feat!:` or a `BREAKING CHANGE:` footer a major bump. Other
types (`chore:`, `docs:`, `ci:`, `refactor:`) do not bump the version and
are hidden from the changelog by default. Keep the subject readable;
reviewers read it too.

## Pull requests

CI (`.github/workflows/test.yml`) runs `pnpm install`, `pnpm build`,
`pnpm typecheck`, `pnpm test`, and `pnpm lint` on every PR. Keep
`_generated/` directories committed so CI does not need a live backend.

A PR template will prompt for the things reviewers want: summary, test
plan, docs check, breaking-change note. Filling it out keeps the loop
short.
