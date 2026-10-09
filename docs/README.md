<!-- owner: automata | zone: internal | purpose: docs landing page, project presentation and index -->

# cloud-pi-native-core docs

Alchemy.run resource library that provisions the
[cloud-pi-native](https://github.com/cloud-pi-native) socle through
Infrastructure-as-Effects — a proof of concept for replacing the console's
reconciliation engine with a declarative dependency graph. Every artifact the
console's plugin system creates per project (Keycloak groups, Vault namespaces
and policies, GitLab groups and robots, SonarQube projects and tokens, Harbor
projects and retention, Nexus roles, ArgoCD wiring) is extracted here as a
typed Alchemy `Resource` with an explicit reconcile/delete lifecycle.

The library ships as `packages/core`; `apps/api` is the deployable console API
service built on it; `apps/example` demonstrates consumption.

## Index

| Page | Zone | Content |
| --- | --- | --- |
| [Usage](./usage.md) | user | install, resource model, consuming the library |
| [Service audit](./audit/README.md) | internal | per-service behavioral contracts grounding each reconciler |
| [Architecture](./Architecture.md) | internal | layout, resource model, composite layer, data flow |
| [Development](./Development.md) | internal | setup, commands, conventions, test loop |
