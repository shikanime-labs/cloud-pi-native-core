# ArgoCD audit

Source: `console/apps/server-nestjs/src/modules/argocd/`.

Not an ArgoCD HTTP API integration — state is rendered into the infra Git
repo (GitLab) and converged by ArgoCD's Git sync.

## Artifacts

| Artifact | Notes |
| --- | --- |
| Environment values files | `{project.name}/clusters/{cluster.label}/envs/{stage}/{env.name}/values.yaml` |
| Commit batching | environment actions + purge actions (moved/deleted envs) in ONE commit, only when non-empty |
| Group path keys in values | nine keys: roGroup / rwGroup (`/{slug}/console/{env}/{RO|RW}`), consoleAdminGroup, platformAdminGroup (`/console/admin`), platformReadonlyGroup, platformSecurityGroup, projectAdminGroup, projectDevopsGroup, projectDevelopperGroup, projectSecurityGroup |
| AppProject name | `{slug}-{env}-{hmac4}` where hmac4 = HMAC-SHA256(key: `''`, msg: env).slice(0, 4) |
| Vault AppRole handoff | ArgoCD pulls secret-id via the vault module's approle |
| Project delete | for EVERY zone: list `{project.name}/` recursively, delete every values.yaml beneath, one commit per zone |

No owner handling by design — access is purely group-based through the
values file keys. Chart versions (`dso-env` / `dso-ns`) are plugin-config
keys with defaults.

## Candidate resources

- `Cpn.Argocd.EnvironmentValues` (render + idempotent commit — compare
  existing content, skip no-ops)
- `Cpn.Argocd.ProjectEnvironments` (per-project composite; delete sweeps all
  zones)
- GitClient seam for tree-list / read / commit against the infra repo
