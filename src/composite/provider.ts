import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as argocd from "../argocd/index.ts";
import * as gitlab from "../gitlab/index.ts";
import * as harbor from "../harbor/index.ts";
import * as keycloak from "../keycloak/index.ts";
import * as nexus from "../nexus/index.ts";
import * as sonarqube from "../sonarqube/index.ts";
import * as vault from "../vault/index.ts";
import { AdminRoleProvider } from "./admin-role.ts";
import { ClusterProvider } from "./cluster.ts";
import type { CpnProviderConfig } from "./derive.ts";
import { ProjectProvider } from "./project.ts";
import { ZoneProvider } from "./zone.ts";

// ---------------------------------------------------------------------------
// CpnProvider(config) — every per-service provider + the two composites
// behind ONE layer, fed by ONE config object with a field per service (each
// field the exact client config that service already takes). Factory
// function over Layer.mergeAll — no new abstraction. The config shape
// lives in derive.ts (alchemy-free) so tests can use it standalone.
// ---------------------------------------------------------------------------

export type { CpnProviderConfig } from "./derive.ts";

export const CpnProvider = (config: CpnProviderConfig) =>
	Layer.mergeAll(
		keycloak.ProjectGroupsProvider(),
		keycloak.RoleGroupMembersProvider(),
		keycloak.AdminRoleGroupProvider(),
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
		vault.ZoneMountProvider(),
		vault.ProjectPoliciesProvider(),
		vault.ZonePolicyProvider(),
		vault.ProjectAppRoleProvider(),
		vault.ZoneAppRoleProvider(),
		vault.SecretProvider(),
		vault.IdentityGroupProvider(),
		vault.KubeconfigSecretProvider(),
		argocd.ProjectEnvironmentsProvider,
		ProjectProvider(),
		AdminRoleProvider(),
		ZoneProvider(),
		ClusterProvider(),
	).pipe(
		// nexus first: the config-resolved client feeds both the standalone
		// nexus providers and the nexus children driven by Cpn.Project.
		Layer.provide(
			nexus.providers(() => {
				const c = config.nexus;
				if (c === undefined) {
					return Effect.die("CpnProvider: config.nexus is not configured");
				}
				return Effect.succeed(c);
			}),
		),
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
				keycloak.credentialsLayer(
					Effect.sync((): keycloak.KeycloakConnection => {
						if (config.keycloak === undefined) {
							throw new Error("CpnProvider: config.keycloak is not configured");
						}
						return config.keycloak;
					}),
				),
				gitlab.credentialsLayer(
					Effect.sync((): gitlab.GitlabConnection => {
						if (config.gitlab === undefined) {
							throw new Error("CpnProvider: config.gitlab is not configured");
						}
						return config.gitlab;
					}),
				),
				sonarqube.credentialsLayer(
					Effect.sync((): sonarqube.SonarqubeConnection => {
						if (config.sonarqube === undefined) {
							throw new Error(
								"CpnProvider: config.sonarqube is not configured",
							);
						}
						return config.sonarqube;
					}),
				),
				vault.credentialsLayer(
					Effect.sync((): vault.VaultConnection => {
						if (config.vault === undefined) {
							throw new Error("CpnProvider: config.vault is not configured");
						}
						return config.vault;
					}),
				),
			),
		),
		Layer.provide(
			Layer.effect(
				harbor.HarborClient,
				Effect.sync(() => {
					const h = config.harbor;
					return harbor.makeHarborClient({
						url: () => {
							if (h === undefined) {
								throw new Error("CpnProvider: config.harbor is not configured");
							}
							return h.url;
						},
						credentials: () => {
							if (h === undefined) {
								return Effect.die(
									"CpnProvider: config.harbor is not configured",
								);
							}
							return Effect.succeed({
								username: h.username,
								password: h.password,
							});
						},
					});
				}),
			),
		),
		Layer.provide(
			Layer.effect(
				argocd.ArgocdGitClient,
				Effect.sync(() => {
					if (config.argocd === undefined) {
						throw new Error("CpnProvider: config.argocd is not configured");
					}
					return config.argocd;
				}),
			),
		),
	);
