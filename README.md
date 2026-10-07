# cloud-pi-native-core

Alchemy.run resource library that provisions the [cloud-pi-native](https://github.com/cloud-pi-native)
socle through Infrastructure-as-Effects — a proof of concept for replacing the
console's reconciliation engine.

Every artifact the console's plugin system creates per project — Keycloak
groups, Vault namespaces and policies, GitLab groups and robots, SonarQube
projects and tokens, Harbor projects, robots and retention, Nexus roles, ArgoCD
wiring — is extracted here as a typed Alchemy `Resource` with an explicit
lifecycle (reconcile / delete), replacing the event-bus reconciliation loop with
a declarative dependency graph.

## Status

Proof of concept. The audit that maps every console provisioning routine to a
candidate resource lives in [`docs/audit/`](docs/audit/).

## Usage

```ts
import * as Cpn from "cloud-pi-native-core";

const project = yield* Cpn.Project("my-project", {
  slug: "my-project",
  owner: { email: "owner@example.org" },
});

yield* Cpn.Keycloak.ProjectGroups("kc", { project: project.slug });
```

## Development

pnpm + Nix flake (direnv). `pnpm install`, `pnpm test`.

Apache-2.0.
