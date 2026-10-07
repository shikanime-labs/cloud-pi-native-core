# Nexus audit

Source: `console/apps/server-nestjs/src/modules/nexus/`.

## Artifacts

| Artifact | Notes |
| --- | --- |
| Maven hosted repos | `{slug}-maven-release` (release policy) + `{slug}-maven-snapshot` (snapshot); optional per config |
| npm repos | when specificallyEnabled |
| Group repo | `{slug}-repository-group` aggregating hosted repos; writePolicy ALLOW once, strict content-type validation, default blob store, ATTACHMENT disposition |
| Project security roles | from OIDC group-path suffixes; write defaults `/console/admin,/console/devops` (full privileges), read defaults `/console/developer,/console/readonly` (read); overridable `projectWriteGroupPathSuffixes` / `projectReadGroupPathSuffixes` (admin > project) |
| Platform roles | `console-admin`, `console-readonly`, `console-security` — RE-AGGREGATED after every project upsert/delete; they union privileges across ALL projects |

Duplicate signal: 409, or 4xx message matching `/already|exists/i` → ensure()
reload pattern; `isNexusNotFound` for 404-tolerant deletes. Cleanup deletes
roles before hosted repos, group repo first.

## Candidate resources

- `Cpn.Nexus.MavenRepos`, `Cpn.Nexus.GroupRepo`, `Cpn.Nexus.ProjectRoles`,
  `Cpn.Nexus.PlatformRoles` (platform roles are inherently cross-project —
  model as a stack-level composite, not per-project)
