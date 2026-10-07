# Keycloak audit

Source: `console/apps/server-nestjs/src/modules/keycloak/` (keycloak.service.ts,
keycloak-client.service.ts). Event-driven reconciler over
`@keycloak/keycloak-admin-client`. No clients, no robot/service accounts, no
realm roles — everything is group-based.

## Artifacts per project

| Artifact | Path / name | Notes |
| --- | --- | --- |
| Top group | `/{slug}` | Members = `Set([ownerId, ...memberIds])`; connectivity anchor only — membership is inherited downward so the top group grants nothing by itself |
| Console subgroup | `/{slug}/console` | Fixed name; parent anchor for role groups; ownership marker for orphan purge |
| Role groups | `/{slug}/console/{role-relative path}` | Seeded roles: admin, devops, developer, readonly (+ security as plugin suffix); path from `role.oidcGroup` relative to console group |
| Admin-role groups | `AdminRole.oidcGroup` (`/admin`, `/console/reader`, …) | Managed roles only (`type: managed`) |

## Reconciliation semantics

- `project.upsert` → `ensureProjectGroups`: ensure tree, then membership sync.
- Membership ops are add-only-sync with conflict tolerance: 404 (user gone)
  → warn+skip; 409 (already member) → verbose log; else throw.
- Admin-role desired state from `UserWithAdminRoles`; managed roles absent
  from desired are purged (`purgeOrphanRoleGroupMembers` analog).
- Hourly cron (commented out in source) reconciles all projects + admin-role
  groups and purges orphan root groups: any top-level group whose name is not
  a current slug AND that has a `console` subgroup → recursive delete.
- `project.delete` → recursive group-tree delete, children first; 404 on
  already-gone tolerated.

## Auth

Admin client consumed, never created: password grant on `admin-cli` in the
MASTER realm at init; token refreshed every 45s (60s lifetime).

## Candidate resources

- `Cpn.Keycloak.ProjectGroups` — tree composite (top + console + role groups)
- `Cpn.Keycloak.RoleGroupMembers` — desired-set membership sync
- `Cpn.Keycloak.AdminRoleGroup` — platform role group + managed purge
- Orphan purge → drift detection (`alchemy drift`) rather than a resource
