<!-- owner: automata | zone: user | purpose: how to consume the resource library -->

# Usage

`cloud-pi-native-core` is an [Alchemy.run](https://alchemy.run) v2 resource
library that extracts the cloud-pi-native console's project provisioning as
Infrastructure-as-Effects. Each console reconciliation module (Keycloak
groups, GitLab mirroring, SonarQube projects, Harbor registry, Nexus repos,
Vault secrets, ArgoCD environments) becomes a standalone `Resource` whose
reconciler converges the real service API — a proof of concept that replaces
the console's reconciliation engine, not a wrapper around it.

The behavioral contract of every resource is documented per service in
[`docs/audit/`](./audit/README.md); this page covers how to consume the
library.

## Install

The package is not published to a registry — depend on the git checkout:

```sh
pnpm add cloud-pi-native-core@github:shikanime-labs/cloud-pi-native-core
```

Peer requirements: `alchemy@2.0.0-beta.81`, `effect@^3.19`, `zod@^4`.
There is no root barrel; import per service:

```ts
import { ProjectGroups } from "cloud-pi-native-core/src/keycloak/index.js";
```

(The repo builds with `tsc -p tsconfig.json`, `module: NodeNext` — the
`.js` extension in specifiers is required under NodeNext resolution.)

## The resource model

Every resource follows one pattern — a type triple, a constructor, and a
provider layer:

```ts
// src/keycloak/resources.ts (excerpt)
export interface ProjectGroupsProps {
  readonly slug: string;                 // desired-state inputs
  readonly ownerEmail: string;
  readonly memberEmails: readonly string[];
}

export interface ProjectGroups
  extends Resource<                       // type + props + attributes
    "Cpn.Keycloak.ProjectGroups",
    ProjectGroupsProps,
    { readonly groupPath: string; /* ...observed outputs */ }
  > {}

export const ProjectGroups = Resource<ProjectGroups>(
  "Cpn.Keycloak.ProjectGroups",
);                                        // constructor: ProjectGroups(id, props)

export const ProjectGroupsProvider = () =>
  Provider.effect(ProjectGroups, Effect.gen(function* () {
    const client = yield* KeycloakClient; // service dependency
    return ProjectGroups.Provider.of({
      list: () => Effect.succeed([]),
      reconcile: Effect.fn(".../reconcile")(function* ({ news }) {
        // observe → ensure → sync; one body converges from any state
      }),
      delete: Effect.fn(".../delete")(function* ({ olds }) { /* ... */ }),
    });
  }));
```

- **Type string** `Cpn.<Service>.<Resource>` is globally unique and stable —
  it is the state-store key.
- **Props** are plain inputs (what you want); **attributes** are what the
  remote API returns (what exists).
- **`reconcile`** replaces create/update: it observes live state, ensures the
  desired shape, and syncs the difference. Rerunning is always safe.
- **Providers** are Effect layers requiring the service's client tag; wire
  them into your stack's `providers` layer.
- **`delete`** is implemented by every resource — often 404-tolerant.

## Auth

Each service exposes a `Credentials` Context.Tag holding a lazy
`Effect` — credentials resolve on first API call, so building layers never
requires a configured environment. Three constructors exist per service:
`credentialsStatic(connection)`, `credentialsLayer(resolveEffect)`, and
`credentialsUnavailable` (fails on use).

| Service | Client tag | Connection shape | Live layer |
|---|---|---|---|
| Keycloak | `KeycloakClient` | `KeycloakConnection { baseUrl, realm, adminClientId, adminUser, adminPassword }` | `KeycloakClientLive` (password grant vs master realm) |
| GitLab | `GitlabClient` | `GitlabConnection { url, token }` | `GitlabClientLive` |
| SonarQube | `SonarqubeClient` | `SonarqubeConnection { url, token }` | `SonarqubeClientLive` |
| Vault | `VaultClient` | `VaultConnection { url, token }` | `VaultClientLive` |
| Nexus | `NexusClient` (service is the request fn) | `NexusConfig { url, token }` | `NexusClientLive(config)` + `nexus.providers(config)` bundle |
| Harbor | `HarborClient` | `HarborCredentials { username, password }` + lazy `url` | `makeHarborClient({ url, credentials })` |
| ArgoCD | `ArgocdGitClient` | `GitClient { listTree, readFile, commit }` | implement the interface per zone |

Nexus bundles its four providers behind `providers(config)`
(`Layer.mergeAll(GroupRepoProvider(), MavenReposProvider(),
PlatformRolesProvider(), ProjectRolesProvider())`)
with the client provided. Harbor providers yield `HarborClient` from context,
so provide `Layer.effect(HarborClient, Effect.succeed(makeHarborClient(...)))`.

## Resource catalog

### Keycloak (`src/keycloak`)

| Type | Purpose | Key props |
|---|---|---|
| `Cpn.Keycloak.ProjectGroups` | Whole per-project group tree: `/{slug}`, `/{slug}/console`, role groups, per-env RO/RW groups | `slug`, `ownerEmail`, `memberEmails`, `roleSuffixes?`, `environments?` |
| `Cpn.Keycloak.RoleGroupMembers` | Membership of one role group | `slug`, `suffix`, `userEmails`, `projectUserEmails` |
| `Cpn.Keycloak.AdminRoleGroup` | Platform-level admin group + members | `groupPath`, `userEmails` |

Free function `purgeOrphanGroups(client, currentSlugs)` implements the
console's cron sweep.

### GitLab (`src/gitlab`)

| Type | Purpose | Key props |
|---|---|---|
| `Cpn.Gitlab.ProjectGroup` | Root group or `projects/{slug}` subgroup, tagged with console custom attributes | `rootGroupPath`, `slug?` |
| `Cpn.Gitlab.Repository` | Project repository, mirrored when `externalRepoUrl` set | `groupId`, `groupFullPath`, `name`, `kind`, `externalRepoUrl?` |
| `Cpn.Gitlab.MirrorRobot` | `<slug>-bot` group token, age-based rotation; secret surfaced as `secretRef` only | `groupId`, `slug`, `expirationDays`, `rotationThresholdDays` |
| `Cpn.Gitlab.GroupMembers` | OIDC-group → access-level mapping for the subgroup | `groupId`, `slug`, `roles`, `memberships`, `gitlabUserIds`, `ownerGitlabUserId` |
| `Cpn.Gitlab.User` | Mirror one console user (never deleted) | `email`, `name`, `cpnUserId`, `admin?`, `auditor?` |

Access-level constants (`ACCESS_LEVEL_OWNER`, ...) and
`ConsoleRole`/`ConsoleMembership` shapes live in `src/gitlab/utils.ts`.

### SonarQube (`src/sonarqube`)

| Type | Purpose | Key props |
|---|---|---|
| `Cpn.Sonarqube.Project` | Project + main branch; visibility from cluster privacy | `slug`, `repository`, `clusterPrivacy?` |
| `Cpn.Sonarqube.ProjectPermissions` | CI robot user, token rotation, group grants; returns the secret for the caller to write to Vault | `slug`, `repository`, `vaultSecretPath`, `existingSecret?` |
| `Cpn.Sonarqube.PermissionTemplate` | Per-project permission template | `slug`, `adminGroup?` |

### Harbor (`src/harbor`)

| Type | Purpose | Key props |
|---|---|---|
| `Cpn.Harbor.Project` | Project + storage quota (create-409 converges by reload) | `name`, `storageLimit` |
| `Cpn.Harbor.Robot` | `ro`/`rw`/`project` robot; rotates only on `secretVersion` bump | `slug`, `kind`, `projectId`, `durationDays`, `secretVersion?` |
| `Cpn.Harbor.Retention` | The single retention policy per project | `slug`, `projectId`, `template`, `count`, `cron` |
| `Cpn.Harbor.GroupMembers` | OIDC groups → Harbor roles, incl. the project-admin→DEVELOPER quirk | `slug`, `adminGroups?`, ... |

### Nexus (`src/nexus`)

| Type | Purpose | Key props |
|---|---|---|
| `Cpn.Nexus.MavenRepos` | `<slug>-maven-release` + `-snapshot` hosted repos | `slug` |
| `Cpn.Nexus.GroupRepo` | `<slug>-repository-group` aggregating members | `slug`, `members` |
| `Cpn.Nexus.ProjectRoles` | Project-scoped privileges per role tier | `slug`, `npm`, `writeSuffixes?`, `readSuffixes?` |
| `Cpn.Nexus.PlatformRoles` | Platform roles aggregating every project | `projects`, `writeGroupPaths?`, `readGroupPaths?` |

### Vault (`src/vault`)

| Type | Purpose | Key props |
|---|---|---|
| `Cpn.Vault.ProjectMount` | KV-v2 mount named `<slug>` | `slug` |
| `Cpn.Vault.ZoneMount` | KV-v2 mount named `zone-<zone>` | `zone` |
| `Cpn.Vault.ProjectPolicies` | Six project ACL policies (`app--{slug}--admin`, `tech--{slug}--ro`, `project--{slug}--{scope}`) | `slug`, `kvName?`, `robotSecretPath?` |
| `Cpn.Vault.ZonePolicy` | `tech--zone-<zone>--ro` policy | `zone` |
| `Cpn.Vault.ProjectAppRole` | AppRole with batch tokens, default policies | `slug`, `policies?` |
| `Cpn.Vault.ZoneAppRole` | Zone AppRole | `zone`, `policies?` |
| `Cpn.Vault.Secret` | KV-v2 write (mirror creds, tech creds, group secrets) | `mount`, `projectRootDir`, `slug`, `path`, `data` |
| `Cpn.Vault.IdentityGroup` | External identity group + OIDC alias per scope | `slug`, `scope`, `policies`, `groupPathSuffix?` |

`scope` is one of `PROJECT_SCOPES` (`admin|devops|developer|readonly|security`).
Path helpers (`sonarqubeCredPath`, `gitlabMirrorCredPath`,
`registryGroupSecretPath`, ...) live in `src/vault/paths.ts`.

### ArgoCD (`src/argocd`)

| Type | Purpose | Key props |
|---|---|---|
| `Cpn.Argocd.ProjectEnvironments` | Values files per environment across zones, committed via git | `projectName`, `projectSlug`, `zoneSlugs`, `environments` |
| `Cpn.Argocd.EnvironmentValues` | One environment's values file | `projectName`, `projectSlug`, `zoneSlug`, `clusterLabel`, `environmentName` |

Both require an `ArgocdGitClient` implementation (list/read/commit against
each zone's platform-apps repo).

## Composing a full project

[`examples/full.ts`](../examples/full.ts) is the whole deployment: one
`CpnProvider` block (one field per service), then resources in dependency
order — `Zone`, `Cluster`, `AdminRole`, and one `Project` that fans out to
every service. Later resources reference earlier ones by key (zone slug,
cluster label), Terraform-style.

Drive it with the alchemy CLI: `alchemy deploy --config examples/full.ts`
(the default-exported `Stack` is the entrypoint). Attributes are lazy
`Output` references — valid `Input`s for downstream props without
unwrapping. For programmatic use: `deploy({ stack, stage })` /
`destroy({ stack, stage })` from `alchemy/Deploy` / `alchemy/Destroy`
(alchemy 2.0.0-beta.81 exports no `run()`).

### Composites (`src/composite`)

| Type | Purpose | Key props |
|---|---|---|
| `Cpn.Project` | One console project across every service, as one resource | `slug`, `name`, `owner`, `roles`, `members`, `environments` |
| `Cpn.AdminRole` | One platform admin role (Keycloak group + members) | `role`, `userEmails` |
| `Cpn.Zone` | One zone's Vault footprint: mount, policy, AppRole | `slug` |

Single-child domain types are aliased from the same barrel: `CpnEnvironment`
(ArgoCD values file), `CpnRepository` (GitLab repository), `CpnProjectRole`
(Keycloak role-group members). The full classification — including named
gaps (Stage, ProjectMember) — is
[`docs/audit/domain-remap.md`](./audit/domain-remap.md).

`Cpn.Project` drives the existing per-service providers as children in
dependency order (Keycloak tree, GitLab, SonarQube, Harbor, Nexus,
Vault, ArgoCD), threading child outputs (`groupId`, `projectId`, repo
path) into downstream props; delete walks the same children in exact
reverse. Child prop derivation is pure and lives in `src/composite/
derive.ts`, which imports alchemy types only — tests load it without
any alchemy runtime dependency.

Wire everything with `CpnProvider(config)` (`src/composite/provider.ts`)
— one layer bundling every per-service provider plus the two composites,
fed by one config object with a field per service:

```ts
import { AdminRole, CpnProvider, Project } from
  "cloud-pi-native-core/src/composite/index.js";

const providers = CpnProvider({
  keycloak: { baseUrl, realm, /* ... */ },
  gitlab: { url, token },
  sonarqube: { url, token },
  vault: { url, token },
  nexus: { url, token },
  harbor: { url, username, password },
  argocd: gitClient,
});

const project = yield* Project("project", {
  slug: "dso",
  name: "Cloud Pi Native",
  description: "console extraction",
  owner: "owner@example.fr",
  roles: [{ name: "devops", oidcGroup: "devops", /* ... */ }],
  members: [{ email: "owner@example.fr", roleIds: ["devops"] }],
  environments: [
    { name: "dev", zoneSlug: "scw1", clusterLabel: "c1", /* ... */ },
  ],
});
// project.gitlabGroupFullPath, project.harborProjectId, ...
```

Gaps: members keyed by `userId` (no email) keep their id for GitLab
memberships but cannot be mirrored to Keycloak/GitLab users; Nexus
platform roles stay stack-level (`Cpn.Nexus.PlatformRoles`) because
they aggregate all projects.

## Related

- [`docs/audit/`](./audit/README.md) — per-service behavioral source of truth
- [`AGENTS.md`](../AGENTS.md) — library conventions
