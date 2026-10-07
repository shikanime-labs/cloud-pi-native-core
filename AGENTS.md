# cloud-pi-native-core

Alchemy.run resource library extracting the cloud-pi-native console's resource
provisioning as Infrastructure-as-Effects. TypeScript + Effect.

## Structure

- `src/` — resource types and provider layers, one directory per service
  (`keycloak/`, `vault/`, `gitlab/`, `sonarqube/`, `harbor/`, `nexus/`,
  `argocd/`) plus `core/` for the domain model (Project, Zone, Cluster, Stage,
  Environment, Repository, roles, members)
- `docs/audit/` — the console audit that grounds every resource; update when
  the console modules move
- `test/` — `alchemy/Test/Vitest` provider lifecycle tests

## Conventions

- Resource type strings are globally unique and stable:
  `Cpn.<Service>.<Resource>` (e.g. `Cpn.Keycloak.ProjectGroups`)
- Props are plain interfaces; attributes are what the remote API returns.
  Parse, don't validate: at the HTTP boundary, turn external data into the most
  precise type it allows — the returned type is the proof.
- No `as` casts in any form; narrow with `if` type guards naming the offending
  identifier in the error message.
- Reconcilers follow observe → ensure → sync; one body converges from any
  starting point. Trust observed state, never `olds`.
- Zod schemas shared between provider and call sites when a contract needs
  runtime parsing.
- Every resource implements delete; omission of delete semantics is an audit
  finding, not a shortcut.

## Main commands

- Install: `pnpm install` (or direnv + `use flake .`)
- Build gate: `pnpm build`
- Test gate: `pnpm test`
- Format: `pnpm format`

## Commit style

Plain capitalized title, no conventional-commit prefix. Body labels:
`Design:`, `Related:`, `Closes #`. Add the Automata co-author trailer on
agent-authored commits:

```
Co-authored-by: Automata <automata@shikanime.studio>
```

## Environment

`.envrc` with direnv loads the Nix flake dev shell (`use flake .
--accept-flake-config --no-pure-eval`). Node >= 24, pnpm >= 10 via corepack.

_Always work in jj workspaces, never the cloned checkout._
