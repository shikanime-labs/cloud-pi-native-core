<!-- owner: automata | zone: internal | purpose: architecture intent, components, data flow -->

# Architecture

## Layout

```text
packages/core/     the resource library (published unit)
  src/<service>/   per-service resources: argocd, gitlab, harbor, keycloak,
                   nexus, sonarqube, vault
  src/composite/   orchestration resources: Project, Zone, Cluster, AdminRole
apps/api/          deployable console API service (HTTP surface over the library)
apps/example/      consumption example
docs/audit/        per-service audit mapping console routines to resources
```

## Resource model

Every resource is a type triple, a constructor, and a provider layer. The
provider's `reconcile` receives `{ id, fqn, instanceId, news, olds, output,
session, bindings }` and converges the real service API: observe current
state, ensure the desired state, sync children. Delete runs children in
reverse order. Resource type strings are globally unique and follow
`Cpn.<Service>.<Resource>`.

Reconcilers trust observed state, never cached olds — one body converges from
any starting point. Where child names derive from a prop (e.g. a slug), a prop
change is rejected rather than mutated, because delete only knows the latest
name.

## Composite layer

`src/composite/` orchestrates per-service resources into console-level
objects: `Project`, `Zone`, `Cluster`, `AdminRole`. A composite provider
drives its children exactly as a consumer would — `Project` constructs the
Keycloak groups, GitLab group, SonarQube project, Harbor project, Nexus roles,
Vault namespace and ArgoCD wiring for one project. `derive.ts` derives child
specs from composite specs; the audit documents under `docs/audit/` are the
behavioral contract each child implements.

## The API service (`apps/api`)

`apps/api` wraps the composite providers behind an HTTP surface:
`contract.ts` defines the API shape, `router.ts` maps routes to `handlers.ts`,
which calls `deployer.ts` to drive the composite providers programmatically.
`server.ts` boots the service (`@effect/platform-node`, `PORT` env, default
8080). Conformance is pinned by three test tiers under `apps/api/test/`:
conformance, router, and alchemy-mapping. See [Usage](./usage.md) for running
it.

## Boundaries

- The library is headless: no API tier, no cluster dependency. `apps/api` is
  the only HTTP surface.
- A Kubernetes operator watching CRDs and invoking the composite providers
  (issue #28) is in development; it will reuse the library unchanged.
- The console remains the source of truth for anything not yet extracted; the
  audit tracks coverage.
