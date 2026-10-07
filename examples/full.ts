/**
 * One console project provisioned across every service. Env-var credentials.
 * Compile-check: pnpm exec tsc -p tsconfig.examples.json
 * Run: alchemy deploy --config examples/full.ts
 */

import { localState, Stack } from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as argocd from "../src/argocd/index.js";
import * as gitlab from "../src/gitlab/index.js";
import * as harbor from "../src/harbor/index.js";
import * as keycloak from "../src/keycloak/index.js";
import * as nexus from "../src/nexus/index.js";
import * as sonarqube from "../src/sonarqube/index.js";
import * as vault from "../src/vault/index.js";

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Missing required env var ${name}`);
  return value;
};

const slug = "demo";
const ownerEmail = "owner@example.com";
const repoName = `${slug}-app`;
const projectRootDir = "projects";

// --- 1. Credentials: lazy Effects — env is read on first API call only. ---

const keycloakCredentials = keycloak.credentialsLayer(
  Effect.sync((): keycloak.KeycloakConnection => ({
    baseUrl: env("KEYCLOAK_BASE_URL"),
    realm: env("KEYCLOAK_REALM"),
    adminClientId: env("KEYCLOAK_ADMIN_CLIENT_ID"),
    adminUser: env("KEYCLOAK_ADMIN_USER"),
    adminPassword: env("KEYCLOAK_ADMIN_PASSWORD"),
  })),
);
const gitlabCredentials = gitlab.credentialsLayer(
  Effect.sync((): gitlab.GitlabConnection => ({
    url: env("GITLAB_URL"),
    token: env("GITLAB_TOKEN"),
  })),
);
const sonarqubeCredentials = sonarqube.credentialsLayer(
  Effect.sync((): sonarqube.SonarqubeConnection => ({
    url: env("SONARQUBE_URL"),
    token: env("SONARQUBE_TOKEN"),
  })),
);
const vaultCredentials = vault.credentialsLayer(
  Effect.sync((): vault.VaultConnection => ({
    url: env("VAULT_URL"),
    token: env("VAULT_TOKEN"),
  })),
);

// --- 2. Providers: every resource + its client layer.
// Most services export `XProvider()` factories; argocd's
// ProjectEnvironmentsProvider is a ready Layer; nexus bundles all four
// resources behind `nexus.providers(config)`.
// ponytail: keycloak RoleGroupMembers/AdminRoleGroup and the zone-scoped
// vault resources stay out until a stack uses them — add to the merge then.

const providers = Layer.mergeAll(
  keycloak.ProjectGroupsProvider(),
  gitlab.ProjectGroupProvider(),
  gitlab.RepositoryProvider(),
  gitlab.MirrorRobotProvider(),
  gitlab.GroupMembersProvider(),
  gitlab.UserProvider(),
  sonarqube.ProjectProvider(),
  sonarqube.ProjectPermissionsProvider(),
  sonarqube.PermissionTemplateProvider(),
  harbor.ProjectProvider(),
  harbor.RobotProvider(),
  harbor.RetentionProvider(),
  harbor.GroupMembersProvider(),
  vault.ProjectMountProvider(),
  vault.ProjectPoliciesProvider(),
  vault.ProjectAppRoleProvider(),
  vault.SecretProvider(),
  vault.IdentityGroupProvider(),
  argocd.ProjectEnvironmentsProvider,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      keycloak.KeycloakClientLive,
      gitlab.GitlabClientLive,
      sonarqube.SonarqubeClientLive,
      vault.VaultClientLive,
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      keycloakCredentials,
      gitlabCredentials,
      sonarqubeCredentials,
      vaultCredentials,
    ),
  ),
  Layer.provide(
    nexus.providers(() =>
      Effect.sync(() => ({ url: env("NEXUS_URL"), token: env("NEXUS_TOKEN") })),
    ),
  ),
  Layer.provide(
    Layer.effect(
      harbor.HarborClient,
      Effect.succeed(
        harbor.makeHarborClient({
          url: () => env("HARBOR_URL"),
          credentials: () =>
            Effect.sync(() => ({
              username: env("HARBOR_USERNAME"),
              password: env("HARBOR_PASSWORD"),
            })),
        }),
      ),
    ),
  ),
);

// --- 3. The stack: resources in dependency order. ---

const stack = Stack(
  "cpn-full-demo",
  { providers, state: localState() },
  Effect.gen(function* () {
    // Keycloak: the OIDC group tree every other service references.
    yield* keycloak.ProjectGroups("groups", {
      slug,
      ownerEmail,
      memberEmails: [ownerEmail],
      environments: [
        { name: "dev", roUserEmails: [], rwUserEmails: [ownerEmail] },
      ],
    });

    // GitLab: root group once, then project subgroup, repo, mirror robot.
    yield* gitlab.ProjectGroup("gitlab-root", {
      rootGroupPath: projectRootDir,
    });
    const projectGroup = yield* gitlab.ProjectGroup("gitlab-project", {
      rootGroupPath: projectRootDir,
      slug,
    });
    const repo = yield* gitlab.Repository("app-repo", {
      groupId: projectGroup.groupId,
      groupFullPath: projectGroup.fullPath,
      name: repoName,
      kind: "user",
      externalRepoUrl: env("CPN_EXTERNAL_REPO_URL"),
    });
    const robot = yield* gitlab.MirrorRobot("mirror-robot", {
      groupId: projectGroup.groupId,
      slug,
      expirationDays: 90,
      rotationThresholdDays: 70,
    });
    const owner = yield* gitlab.User("owner", {
      email: ownerEmail,
      name: "Demo Owner",
      cpnUserId: ownerEmail,
    });
    const roles = [
      { id: "devops", oidcGroup: `/${slug}/console/devops` },
      { id: "developer", oidcGroup: `/${slug}/console/developer` },
    ] satisfies readonly gitlab.ConsoleRole[];
    const memberships = [
      { userId: ownerEmail, roleIds: ["devops"] },
    ] satisfies readonly gitlab.ConsoleMembership[];
    yield* gitlab.GroupMembers("members", {
      groupId: projectGroup.groupId,
      slug,
      roles,
      memberships,
      gitlabUserIds: { [ownerEmail]: owner.userId },
      ownerGitlabUserId: owner.userId,
    });

    // SonarQube: project + permissions (returns the CI secret payload).
    yield* sonarqube.Project("sonar", {
      slug,
      repository: repo.path,
      clusterPrivacy: "dedicated",
    });
    const sonarSecretPath = vault.sonarqubeCredPath(projectRootDir, slug);
    const sonarPerms = yield* sonarqube.ProjectPermissions("sonar-perms", {
      slug,
      repository: repo.path,
      vaultSecretPath: sonarSecretPath,
    });

    // Harbor: project, robots, retention, group mapping.
    const harborProject = yield* harbor.Project("registry", {
      name: slug,
      storageLimit: 10 * 1024 * 1024 * 1024,
    });
    for (const kind of ["ro", "rw"] as const) {
      yield* harbor.Robot(`robot-${kind}`, {
        slug,
        kind,
        projectId: harborProject.projectId,
        durationDays: 30,
      });
    }
    yield* harbor.Retention("retention", {
      slug,
      projectId: harborProject.projectId,
      template: "nDaysSinceLastPush",
      count: 10,
      cron: "0 0 0 * * 0",
    });
    yield* harbor.GroupMembers("harbor-groups", { slug });

    // Nexus: maven repos, group repo, project + platform roles.
    yield* nexus.MavenRepos("maven", { slug });
    yield* nexus.GroupRepo("group", {
      slug,
      members: [`${slug}-maven-release`, `${slug}-maven-snapshot`],
    });
    yield* nexus.ProjectRoles("project-roles", { slug, npm: false });
    yield* nexus.PlatformRoles("platform-roles", {
      projects: [{ slug, npm: false }],
    });

    // Vault: mount, policies, approle, secrets, identity groups.
    yield* vault.ProjectMount("mount", { slug });
    yield* vault.ProjectAppRole("approle", { slug });
    const policies = yield* vault.ProjectPolicies("policies", { slug });
    yield* vault.Secret("mirror-secret", {
      mount: slug,
      projectRootDir,
      slug,
      path: vault.gitlabMirrorCredPath(projectRootDir, slug, repoName),
      data: { token: robot.secretRef },
    });
    // Attributes are lazy Outputs — valid Inputs for downstream props.
    yield* vault.Secret("sonar-secret", {
      mount: slug,
      projectRootDir,
      slug,
      path: sonarSecretPath,
      data: {
        SONAR_USERNAME: sonarPerms.secret.SONAR_USERNAME,
        SONAR_PASSWORD: sonarPerms.secret.SONAR_PASSWORD,
        SONAR_TOKEN: sonarPerms.secret.SONAR_TOKEN,
      },
    });
    yield* vault.Secret("registry-secret", {
      mount: slug,
      projectRootDir,
      slug,
      path: vault.registryGroupSecretPath(projectRootDir, slug),
      data: { note: "robot secret refs live in the secret store" },
    });
    for (const scope of vault.PROJECT_SCOPES) {
      yield* vault.IdentityGroup(`identity-${scope}`, {
        slug,
        scope,
        policies: [`project--${slug}--${scope}`],
      });
    }

    // ArgoCD: per-zone, per-environment values files.
    yield* argocd.ProjectEnvironments("argocd", {
      projectName: "Demo",
      projectSlug: slug,
      zoneSlugs: ["scw1"],
      environments: [
        { zoneSlug: "scw1", clusterLabel: "cluster-1", environmentName: "dev" },
      ],
    });

    return {
      slug,
      repoPath: repo.pathWithNamespace,
      policyNames: policies.policyNames,
    };
  }),
);

// --- 4. alchemy 2.0.0-beta.81 exports no run(): the default-exported
// Stack IS the entrypoint the alchemy CLI drives. ---
export default stack;
