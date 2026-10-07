# Harbor (registry) audit

Source: `console/apps/server-nestjs/src/modules/registry/`.

`project.upsert` → `ensureProject` = project + quota, then parallel: robot
secrets, group members, retention.

## Duplicate-signal matrix (empirically verified)

| Create target | Duplicate signal |
| --- | --- |
| Project (`POST /projects`) | real HTTP 409 (bare) |
| Group member | 409, body code `CONFLICT` |
| Robot | 400, body code `CONFLICT` |
| Retention | 400, body code `BAD_REQUEST`, message "...already has retention policy N" |

Shared gate `isRegistryConflict` accepts only real 409 OR 400+`CONFLICT`.
Retention's message-only signal is NOT gate-reconcilable → plain
read-then-create idempotent method, no `ensure()` wrapper.

## Artifacts

| Artifact | Notes |
| --- | --- |
| Project | + storage quota |
| Robots | `ro` / `rw` (+ `project-robot` roAccess when specificallyEnabled); full name `robot${slug}+{name}`; duration = robotExpirationDays (default 90); NEVER rotated client-side on create conflict — the racing run owns the robot; `rotateRobot` is the explicit path |
| Robot secrets | stored via Vault; rotation triggers on missing secret / HOST mismatch / age past robotRotationThresholdDays (default 60) |
| Retention | exactly one policy per project; every sync ends in a PUT of the desired policy; rules from ruleTemplate/ruleCount (default 10, or 1 for 'always'), `**` selectors, schedule cron default `0 22 2 * * *` |
| Group members | role mapping quirk: `/{slug}/console/admin` → `HARBOR_ROLE_DEVELOPER`(2) NOT PROJECT_ADMIN; guest+developer+maintainer+platform-guest → GUEST(3); only platform `/console/admin` → PROJECT_ADMIN |

## Candidate resources

- `Cpn.Harbor.Project`, `Cpn.Harbor.Robot`, `Cpn.Harbor.Retention`,
  `Cpn.Harbor.GroupMembers`
