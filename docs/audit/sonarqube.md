# SonarQube audit

Source: `console/apps/server-nestjs/src/modules/sonarqube/`.

## Artifacts

| Artifact | Notes |
| --- | --- |
| Project | key = slug, name = project name, visibility private |
| Robot account | login = slug, `local: true`, email `{slug}@cloud-pi-native.fr` (fake per-project; legacy robots carrying the owner's real email are rewritten every reconcile — #2510 SSO collision), random 30-char password |
| Robot token | `Sonar Token for {slug}`; rotation = revoke (best-effort) + generate |
| Role groups | `/{slug}{suffix}` per suffix (admin/devops/developer/readonly/security; comma-separated multi-path; admin > project precedence); groups carry no members — membership flows through OIDC sync |
| Permission sets | admin → [admin, scan, user, codeviewer, issueadmin, securityhotspotadmin]; devops/developer/security → [scan, user, codeviewer]; readonly → [user, codeviewer] |
| Platform groups | security + readonly groups granted security/readonly sets on EVERY project |
| CI variables | Sonar token → GitLab group/project variables (cross-module side effect) |
| Properties file | `sonar.projectKey={key}`, `sonar.qualitygate.wait=true` |

Permission grants are idempotent (re-grant no-op); conflict signal for
already-existing entities: 409 or message-matched races.

## Candidate resources

- `Cpn.Sonarqube.Project`, `Cpn.Sonarqube.RobotAccount`,
  `Cpn.Sonarqube.RoleGroups`, `Cpn.Sonarqube.ProjectPermissions`
