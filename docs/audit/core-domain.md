# Core domain audit — console entities

Source: `cloud-pi-native/console` @ `eb3f6a99`, `apps/server/src/prisma/schema/{project,topography,admin}.prisma`
and `packages/shared/src/contracts/{project,zone,stage,cluster,project-role,admin-role,project-member}.ts`.
These are console-owned database entities, not external-service artifacts — in the
Alchemy extraction they become the typed inputs that parameterize service
resources.

## Topology: Zone → Cluster → Stage → Environment

- `Zone`: `slug` (unique, ≤10 chars), `label`, `description`, `argocdUrl`.
  Owns clusters. In Vault a zone additionally owns a KV mount (`zone-<slug>`)
  and an AppRole — see `vault.md`.
- `Cluster`: `label` (unique), `privacy` (`public` | `dedicated`),
  `secretName`, `clusterResources`, `infos`, capacity (`memory`, `cpu`, `gpu`),
  FK `zoneId`, and a `Kubeconfig` row. Join tables: `Cluster↔Project`,
  `Cluster↔Stage`.
- `Stage`: `name` (unique) — the deployment stage dimension (dev, staging,
  prod). Related to clusters many-to-many.
- `Environment`: `name` (≤11 chars, unique per project), `projectId`,
  `clusterId`, `stageId`, quota (`memory`, `cpu`, `gpu`), `autosync`,
  `@@unique([projectId, name])`. The unit ArgoCD renders per
  cluster+stage.

## Project

- Fields: `name`, `slug` (unique — THE join key every service module uses),
  `description`, `status` (`initializing|created|failed|archived|warning`),
  `locked`, `ownerId`, `everyonePerms` (BigInt bitmask, default 896),
  `limitless`, hprod/prod quota floats, `lastSuccessProvisionningVersion`.
- `ownerId` is exclusive of membership: owner is never a `ProjectMembers` row
  (console enforces mutual exclusion; ownership transfer swaps the rows).
- Event verbs emitted: `project.upsert`, `project.delete` — the two triggers
  every service module consumes.

## Roles

- `ProjectRole`: per-project, `name`, `permissions` (BigInt bitmask),
  `position` (SmallInt ordering), `oidcGroup` (relative path under
  `/<slug>/console/`), `type` (`managed` | custom). Four system roles seeded
  at creation: admin, devops, developer, readonly; security exists only as a
  plugin suffix.
- `AdminRole`: platform tier, same shape minus project FK. `oidcGroup`
  maps to platform groups (`/admin` bootstrap, `/console/security`,
  `/console/reader|readonly`).
- `ProjectMembers`: join with `roleIds: String[]` — a member holds a set of
  role uuids.

## Members

- `addMember` accepts `{email} | {userId}`; owner rejected as member.
- Desired-group-state derivation (Keycloak): `desiredUserIds =
  Set([ownerId, ...members])` for the top group; per role-group, members whose
  `roleIds` include that role.

## Alchemy mapping (candidate resources)

| Console entity | Candidate resource | Notes |
| --- | --- | --- |
| Project | `Cpn.Project` (spec/props only) | slug as physical key; no cloud side |
| Zone | `Cpn.Zone` | composes `Vault.ZoneMount`, `Vault.ZoneAppRole` |
| Cluster | `Cpn.Cluster` | kubeconfig secret reference, privacy, quota |
| Stage | `Cpn.Stage` | joins clusters |
| Environment | `Cpn.Environment` | per project+cluster+stage; feeds ArgoCD rendering |
| ProjectRole | `Cpn.ProjectRole` | oidcGroup suffix drives every service group path |
| AdminRole | `Cpn.AdminRole` | platform tier; drives GitLab admin/auditor flags |
| ProjectMember | `Cpn.ProjectMember` | feeds Keycloak/GitLab/Harbor membership sync |

Cross-cutting: every service resource keys on `project.slug`; role group
paths derive as `/<slug>/console/<suffix>` with suffixes overridable via
plugin config (admin > project precedence, comma-separated multi-paths).
