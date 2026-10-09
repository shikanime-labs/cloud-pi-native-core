<!-- owner: automata | zone: internal | purpose: developer setup, commands, conventions -->

# Development

## Setup

```sh
pnpm install          # pnpm 12.x; workspace: packages/* and apps/*
```

## Commands

```sh
pnpm --filter @cpn/api build    # tsc, per-package build
pnpm --filter @cpn/api test     # vitest run
pnpm --filter @cpn/api dev      # tsx src/server.ts, PORT env (default 8080)
pnpm --filter @cpn/core test    # library tests
```

Formatting is biome. NEVER run the root `pnpm format` — it rewrites the whole
tree. Scope it to touched files:

```sh
./node_modules/.bin/biome check <files>
```

## Conventions

- Resource type strings: `Cpn.<Service>.<Resource>`, globally unique.
- TypeScript `module: NodeNext`: specifiers carry the `.js` extension.
- Commits: plain capitalized title (no conventional prefix), body labels
  `Design:` / `Related:` / `Closes #`, trailers
  `Co-authored-by: Automata <automata@shikanime.studio>` and
  `Signed-off-by: Shikanime Deva <william.phetsinorath@shikanime.studio>`
  (gitlint CC1 rejects its absence).
- Branches must match
  `^(main|(feat|fix|chore|docs|refactor|test|ci|build|perf|renovate)/[a-z0-9][a-z0-9._/-]*|release-x.y.z)$`.
- Edit in jj workspaces pinned to `main@origin`, never the cloned checkout.

## Test loop

Per-package vitest suites. `apps/api` pins three tiers — conformance, router,
alchemy-mapping — run with `pnpm --filter @cpn/api test`. Behavioral contracts
for reconcilers live in [`docs/audit/`](./audit/README.md); a reconciler
change updates its audit page in the same PR.

## CI

`javascript` (build) and `nix` (flake checks) gates run on every PR; both
architectures. Renovate keeps dependencies current via the Dependency
Dashboard issue.
