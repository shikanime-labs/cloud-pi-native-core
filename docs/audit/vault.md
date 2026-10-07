# Vault audit

Source: `console/apps/server-nestjs/src/modules/vault/` (vault.service.ts,
vault-client.service.ts, vault.utils.ts). Events: `project.upsert/delete`,
`zone.upsert/delete`.

## Artifacts

| Artifact | Name / path | Notes |
| --- | --- | --- |
| Project KV-v2 mount | `{slug}` | `POST /v1/sys/mounts/{slug}` type=kv options version:2; existing → `tune` (version only; `force_no_cache` is create-only, never reconciled); delete = unmount, destroys all secrets |
| Zone KV-v2 mount | `zone-{zone.slug}` | Same lifecycle, zone-scoped |
| ACL policies | `app--{slug}--admin`, `tech--{slug}--ro`, `project--{slug}--{devops,developer,readonly,security}` | `POST /v1/sys/policies/acl/{name}` is upsert/replace; delete 404-tolerant (allSettled) |
| Identity groups | `project-{slug}-{scope}` | External groups; policies = matching policy; OIDC group-alias per configured Keycloak path `/{slug}/console/{suffix}`; multi-path comma-separated; admin > project config precedence |
| AppRoles | `{slug}`, `zone-{zone}` | `token_type: batch`, all ttl/num_uses 0, `secret_id_num_uses: 0`; token_policies wired; delete 404-tolerant |
| KV secrets | `{projectRootDir}/{slug}/...` | sonarqube creds, gitlab mirror creds per repo, tech read-only creds, GITLAB/REGISTRY group secrets; POST upserts a new KV-v2 version; reads null on NotFound |

## Semantics

- Policy → identity-group binding: `project-{slug}-{scope}` carries the
  matching `project--{slug}--{scope}` policy; alias name = Keycloak group
  path, alias mount = realm's OIDC auth mount.
- AppRole handoff consumed by ArgoCD (`ensureAuthApproleRoleSecretId`).
- 400 on alias create treated as benign race; deletes tolerate 404.

## Candidate resources

- `Cpn.Vault.ProjectMount` / `Cpn.Vault.ZoneMount`
- `Cpn.Vault.ProjectPolicies` (policy set composite)
- `Cpn.Vault.IdentityGroup` (group + aliases)
- `Cpn.Vault.AppRole`
- Secret-path helpers (pure functions, not resources)
