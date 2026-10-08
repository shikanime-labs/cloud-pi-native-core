# Domain remap — every core-domain type addressed from src/composite

Classification of every core-domain type in `src/core/spec.ts` against the
extracted per-service resources, verified by fan-out in `src/` (not by the
audit docs alone). Three statuses:

- **composite** — a `Cpn.<X>` resource in `src/composite/` orchestrates
  one or more existing service children in dependency order.
- **alias** — exactly one service child; re-exported from
  `src/composite/index.ts` so the whole domain is one import. No new code.
- **gap** — zero dedicated children extracted; named here so nothing is
  silently missing. No stubs.

## Ledger

| Domain type | Status | Children (extracted resources) | Notes |
| --- | --- | --- | --- |
| Project | composite | 23 children: Keycloak.ProjectGroups, Gitlab.{ProjectGroup,User,Repository,MirrorRobot,GroupMembers}, Sonarqube.{Project,ProjectPermissions,PermissionTemplate}, Harbor.{Project,Robot,Retention,GroupMembers}, Nexus.{MavenRepos,GroupRepo,ProjectRoles}, Vault.{ProjectMount,ProjectPolicies,ProjectAppRole,Secret,IdentityGroup}, Argocd.ProjectEnvironments | `Cpn.Project` (src/composite/project.ts) |
| AdminRole | composite | Keycloak.AdminRoleGroup | `Cpn.AdminRole` (src/composite/admin-role.ts). Nexus platform roles stay stack-level (Cpn.Nexus.PlatformRoles) |
| Zone | composite | Vault.ZoneMount, Vault.ZonePolicy, Vault.ZoneAppRole | `Cpn.Zone` (src/composite/zone.ts); `label`/`argocdUrl` are console-DB metadata no service child consumes |
| Cluster | gap | none | Referenced only as string props (`clusterLabel`, `clusterPrivacy`) threaded into project-scoped resources; kubeconfig secret, quota, and privacy fields have no extracted resource |
| Stage | gap | none | Name-only spec; not even a path segment in the extracted `valuesFilePath` (audit path has `{stage}`, extraction dropped it) |
| Environment | alias | Argocd.EnvironmentValues | `CpnEnvironment`; the Keycloak RO/RW env groups ride inside Keycloak.ProjectGroups (a Project child), not standalone |
| Repository | alias | Gitlab.Repository | `CpnRepository` |
| ProjectRole | alias | Keycloak.RoleGroupMembers | `CpnProjectRole`; per-suffix membership keyed `slug`+`suffix`; GitLab/Nexus role mapping is a Project child, not per-role |
| ProjectMember | gap | none standalone | Membership state converges inside Project children (Keycloak.ProjectGroups sync, Gitlab.GroupMembers) from `ProjectProps.members`; no standalone resource |

## Alias surface

```ts
import {
  CpnEnvironment,
  CpnProjectRole,
  CpnRepository,
} from "cloud-pi-native-core/src/composite/index.js";
```

Each alias IS the underlying service resource — same constructor, provider,
and type string; the alias exists so the domain is addressable from one
barrel.

## Gap policy

Gaps are named, not stubbed. Closing one means extracting the missing
per-service resources first (e.g. a Vault kubeconfig secret for Cluster),
then reclassifying here by actual fan-out.
