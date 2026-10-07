# GitLab audit

Source: `console/apps/server-nestjs/src/modules/gitlab/`. gitbeaker REST
client at `GITLAB_URL` / `GITLAB_INTERNAL_URL` with admin PAT.

## Structure

One root group (`PROJECTS_ROOT_DIR`), one subgroup per project at
`{root}/{slug}` — no per-role subgroups. Ownership via custom attributes:
`cpn_managed_by_console` + `cpn_projects_root_dir` on root, `cpn_project_slug`
on project groups/repos, `cpn_user_id` on users. Repo topics:
`plugin-managed`; `system-managed` for console plumbing repos.

## Artifacts

| Artifact | Notes |
| --- | --- |
| Project subgroup | get-or-create with collision reload |
| Group members | role→AccessLevel via config-driven OIDC group paths (defaults admin→50, devops→40, developer→30, readonly→10; overridable) |
| Mirrored users | search-by-email → create: username = email local-part stripped of non-`\w-`, externUid=email, provider=openid_connect, forceRandomPassword, skipConfirmation, projectsLimit=0, canCreateGroup=false |
| Instance flags | admin/auditor authoritative-mapped from admin-role group paths (member→true, non-member→false, empty mapping→undefined no-op) |
| Repositories | per project; system repos `infra-apps` + `mirror` (system-managed topic; rejected as mirror targets) |
| Mirror bootstrap | commit into empty `mirror` repo (pipeline definition) |
| Mirror robot | age-based token rotation (threshold < expiry, config-enforced) |
| Mirror trigger | pipeline on `mirror` repo, variables SYNC_ALL / GIT_BRANCH_DEPLOY / PROJECT_NAME |

## Semantics

- The OIDC auto-provision 409 "Username has already been taken" is NORMAL —
  tolerate, never build a handler.
- `repository.sync` pulls external → internal by triggering the mirror
  pipeline; creds from Vault `{repo}-mirror` secret.
- Delete: group removal cascades repos; users are demoted (flags), not
  deleted.

## Candidate resources

- `Cpn.Gitlab.ProjectGroup`, `Cpn.Gitlab.GroupMembers`, `Cpn.Gitlab.Repository`,
  `Cpn.Gitlab.MirrorRobot`, `Cpn.Gitlab.User`
