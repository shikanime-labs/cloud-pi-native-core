import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as argocd from "../argocd/index.ts";
import * as gitlab from "../gitlab/index.ts";
import * as harbor from "../harbor/index.ts";
import * as keycloak from "../keycloak/index.ts";
import * as nexus from "../nexus/index.ts";
import * as sonarqube from "../sonarqube/index.ts";
import type { ClusterPrivacy } from "../sonarqube/paths.ts";
import * as vault from "../vault/index.ts";
import { deriveProjectChildProps, type ProjectProps } from "./derive.ts";

// ---------------------------------------------------------------------------
// Cpn.Project — one console project composed from the existing per-service
// resources. Zero new HTTP calls, zero new clients: reconcile drives the
// child provider services in dependency order (threading outputs), delete
// drives them in exact reverse. Child services come from the child provider
// layers provided below; wire everything with CpnProvider (./provider.ts).
// ---------------------------------------------------------------------------

/** Cross-cutting child outputs the composite exposes. */
export interface ProjectAttrs {
	readonly keycloakGroupPath: string;
	readonly gitlabGroupId: number;
	readonly gitlabGroupFullPath: string;
	/** Repository path — the SonarQube `repository` input. */
	readonly gitlabRepoPath: string;
	readonly gitlabRepoPathWithNamespace: string;
	readonly mirrorRobotTokenId: number;
	readonly sonarKey: string;
	readonly sonarSecretPath: string;
	readonly harborProjectId: number;
	readonly harborRetentionId: number | null;
	readonly harborRobotIds: Readonly<Record<"ro" | "rw", number>>;
	readonly harborRobotNames: Readonly<Record<"ro" | "rw", string>>;
	readonly vaultMountName: string;
	readonly vaultPolicyNames: readonly string[];
	readonly vaultAppRoleName: string;
	readonly argocdFilePaths: readonly string[];
}

export interface Project
	extends Resource<"Cpn.Project", ProjectProps, ProjectAttrs> {}

export const Project = Resource<Project>("Cpn.Project");

// ---------------------------------------------------------------------------
// Child-service plumbing
// ---------------------------------------------------------------------------

interface ChildScope {
	readonly id: string;
	readonly fqn: string;
	readonly instanceId: string;
	readonly session: ScopedPlanStatusSession;
}

const childReconcileCall = <News>(
	scope: ChildScope,
	kind: string,
	news: News,
) => ({
	id: `${scope.id}/${kind}`,
	fqn: `${scope.fqn}/${kind}`,
	instanceId: scope.instanceId,
	news,
	olds: undefined,
	output: undefined,
	session: scope.session,
	bindings: [],
});

const childDeleteCall = <Olds, Out>(
	scope: ChildScope,
	kind: string,
	olds: Olds,
	output: Out,
) => ({
	id: `${scope.id}/${kind}`,
	fqn: `${scope.fqn}/${kind}`,
	instanceId: scope.instanceId,
	olds,
	output,
	session: scope.session,
	bindings: [],
});

const ROBOT_KINDS: readonly ("ro" | "rw")[] = ["ro", "rw"];

/** SonarQube visibility derived from cluster privacy (see its provider). */
const sonarVisibility = (
	privacy: ClusterPrivacy | undefined,
): "public" | "private" => (privacy === "public" ? "public" : "private");

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const ProjectProvider = () =>
	Provider.effect(
		Project,
		Effect.gen(function* () {
			const services = {
				keycloakGroups: yield* keycloak.ProjectGroups.Provider,
				gitlabProjectGroup: yield* gitlab.ProjectGroup.Provider,
				gitlabUsers: yield* gitlab.User.Provider,
				gitlabRepository: yield* gitlab.Repository.Provider,
				gitlabMirrorRobot: yield* gitlab.MirrorRobot.Provider,
				gitlabGroupMembers: yield* gitlab.GroupMembers.Provider,
				sonarProject: yield* sonarqube.Project.Provider,
				sonarPermissions:
					yield* sonarqube.ProjectPermissions.Provider,
				sonarTemplate: yield* sonarqube.PermissionTemplate.Provider,
				harborProject: yield* harbor.Project.Provider,
				harborRobots: yield* harbor.Robot.Provider,
				harborRetention: yield* harbor.Retention.Provider,
				harborGroupMembers: yield* harbor.GroupMembers.Provider,
				nexusMavenRepos: yield* nexus.MavenRepos.Provider,
				nexusGroupRepo: yield* nexus.GroupRepo.Provider,
				nexusProjectRoles: yield* nexus.ProjectRoles.Provider,
				vaultMount: yield* vault.ProjectMount.Provider,
				vaultPolicies: yield* vault.ProjectPolicies.Provider,
				vaultAppRole: yield* vault.ProjectAppRole.Provider,
				vaultSecrets: yield* vault.Secret.Provider,
				vaultIdentityGroups: yield* vault.IdentityGroup.Provider,
				argocdEnvironments:
					yield* argocd.ProjectEnvironments.Provider,
			};
			return Project.Provider.of({
				list: () => Effect.succeed([]),
				reconcile: Effect.fn("Cpn.Project/reconcile")(function* ({
					id,
					fqn,
					instanceId,
					news,
					session,
				}) {
					const child = deriveProjectChildProps(news);
					const scope: ChildScope = { id, fqn, instanceId, session };

					const groups = yield* services.keycloakGroups.reconcile(
						childReconcileCall(scope, "keycloak-groups", child.keycloakGroups),
					);
					yield* services.gitlabProjectGroup.reconcile(
						childReconcileCall(scope, "gitlab-root", child.gitlabRootGroup),
					);
					const projectGroup = yield* services.gitlabProjectGroup.reconcile(
						childReconcileCall(
							scope,
							"gitlab-project",
							child.gitlabProjectGroup,
						),
					);
					const gitlabUserIds: Record<string, number> = {};
					for (const user of child.gitlabUsers) {
						const out = yield* services.gitlabUsers.reconcile(
							childReconcileCall(scope, `gitlab-user-${user.email}`, user),
						);
						gitlabUserIds[user.email] = out.userId;
					}
					const repo = yield* services.gitlabRepository.reconcile(
						childReconcileCall(scope, "gitlab-repository", {
							...child.gitlabRepository,
							groupId: projectGroup.groupId,
							groupFullPath: projectGroup.fullPath,
						}),
					);
					const robot = yield* services.gitlabMirrorRobot.reconcile(
						childReconcileCall(scope, "gitlab-mirror-robot", {
							...child.gitlabMirrorRobot,
							groupId: projectGroup.groupId,
						}),
					);
					yield* services.gitlabGroupMembers.reconcile(
						childReconcileCall(scope, "gitlab-members", {
							...child.gitlabGroupMembers,
							groupId: projectGroup.groupId,
							gitlabUserIds,
							ownerGitlabUserId: gitlabUserIds[news.owner] ?? -1,
						}),
					);

					const sonarProject = yield* services.sonarProject.reconcile(
						childReconcileCall(scope, "sonar-project", {
							...child.sonarProject,
							repository: repo.path,
						}),
					);
					const sonarPerms = yield* services.sonarPermissions.reconcile(
						childReconcileCall(scope, "sonar-permissions", {
							...child.sonarPermissions,
							repository: repo.path,
						}),
					);
					yield* services.sonarTemplate.reconcile(
						childReconcileCall(scope, "sonar-template", child.sonarTemplate),
					);

					const harborProject = yield* services.harborProject.reconcile(
						childReconcileCall(scope, "harbor-project", child.harborProject),
					);
					const robotIds: Record<"ro" | "rw", number> = { ro: -1, rw: -1 };
					const robotNames: Record<"ro" | "rw", string> = { ro: "", rw: "" };
					for (const kind of ROBOT_KINDS) {
						const out = yield* services.harborRobots.reconcile(
							childReconcileCall(scope, `harbor-robot-${kind}`, {
								...child.harborRobots[kind],
								projectId: harborProject.projectId,
							}),
						);
						robotIds[kind] = out.robotId;
						robotNames[kind] = out.name;
					}
					const retention = yield* services.harborRetention.reconcile(
						childReconcileCall(scope, "harbor-retention", {
							...child.harborRetention,
							projectId: harborProject.projectId,
						}),
					);
					yield* services.harborGroupMembers.reconcile(
						childReconcileCall(
							scope,
							"harbor-members",
							child.harborGroupMembers,
						),
					);

					yield* services.nexusMavenRepos.reconcile(
						childReconcileCall(scope, "nexus-maven", child.nexusMavenRepos),
					);
					yield* services.nexusGroupRepo.reconcile(
						childReconcileCall(scope, "nexus-group", child.nexusGroupRepo),
					);
					yield* services.nexusProjectRoles.reconcile(
						childReconcileCall(scope, "nexus-roles", child.nexusProjectRoles),
					);

					const mount = yield* services.vaultMount.reconcile(
						childReconcileCall(scope, "vault-mount", child.vaultMount),
					);
					const policies = yield* services.vaultPolicies.reconcile(
						childReconcileCall(scope, "vault-policies", child.vaultPolicies),
					);
					const appRole = yield* services.vaultAppRole.reconcile(
						childReconcileCall(scope, "vault-approle", child.vaultAppRole),
					);
					const secretDatas: readonly Readonly<Record<string, string>>[] = [
						{ token: robot.secretRef },
						{
							SONAR_USERNAME: sonarPerms.secret.SONAR_USERNAME,
							SONAR_PASSWORD: sonarPerms.secret.SONAR_PASSWORD,
							SONAR_TOKEN: sonarPerms.secret.SONAR_TOKEN,
						},
						{ note: "robot secret refs live in the secret store" },
					];
					let secretIndex = 0;
					for (const base of child.vaultSecrets) {
						yield* services.vaultSecrets.reconcile(
							childReconcileCall(scope, `vault-secret-${secretIndex}`, {
								...base,
								data: secretDatas[secretIndex] ?? {},
							}),
						);
						secretIndex += 1;
					}
					for (const group of child.vaultIdentityGroups) {
						yield* services.vaultIdentityGroups.reconcile(
							childReconcileCall(scope, `vault-identity-${group.scope}`, group),
						);
					}

					const argocd = yield* services.argocdEnvironments.reconcile(
						childReconcileCall(
							scope,
							"argocd-environments",
							child.argocdEnvironments,
						),
					);

					return {
						keycloakGroupPath: groups.groupPath,
						gitlabGroupId: projectGroup.groupId,
						gitlabGroupFullPath: projectGroup.fullPath,
						gitlabRepoPath: repo.path,
						gitlabRepoPathWithNamespace: repo.pathWithNamespace,
						mirrorRobotTokenId: robot.tokenId,
						sonarKey: sonarProject.key,
						sonarSecretPath: child.sonarPermissions.vaultSecretPath,
						harborProjectId: harborProject.projectId,
						harborRetentionId: retention.retentionId,
						harborRobotIds: { ...robotIds },
						harborRobotNames: { ...robotNames },
						vaultMountName: mount.mountName,
						vaultPolicyNames: policies.policyNames,
						vaultAppRoleName: appRole.roleName,
						argocdFilePaths: argocd.filePaths,
					};
				}),
				delete: Effect.fn("Cpn.Project/delete")(function* ({
					id,
					fqn,
					instanceId,
					olds,
					output,
					session,
				}) {
					const child = deriveProjectChildProps(olds);
					const scope: ChildScope = { id, fqn, instanceId, session };

					// argocd → vault identity/secrets/approle/policies/mount →
					// nexus → harbor → sonar → gitlab → keycloak (exact reverse).
					yield* services.argocdEnvironments.delete(
						childDeleteCall(
							scope,
							"argocd-environments",
							child.argocdEnvironments,
							{
								filePaths: [...output.argocdFilePaths],
								committed: false,
							},
						),
					);
					for (const group of [...child.vaultIdentityGroups].reverse()) {
						yield* services.vaultIdentityGroups.delete(
							childDeleteCall(scope, `vault-identity-${group.scope}`, group, {
								groupName: "",
								aliasPaths: [],
							}),
						);
					}
					let secretIndex = child.vaultSecrets.length - 1;
					for (const base of [...child.vaultSecrets].reverse()) {
						yield* services.vaultSecrets.delete(
							childDeleteCall(
								scope,
								`vault-secret-${secretIndex}`,
								{ ...base, data: {} },
								{ path: base.path },
							),
						);
						secretIndex -= 1;
					}
					yield* services.vaultAppRole.delete(
						childDeleteCall(scope, "vault-approle", child.vaultAppRole, {
							roleName: output.vaultAppRoleName,
						}),
					);
					yield* services.vaultPolicies.delete(
						childDeleteCall(scope, "vault-policies", child.vaultPolicies, {
							policyNames: [],
						}),
					);
					yield* services.vaultMount.delete(
						childDeleteCall(scope, "vault-mount", child.vaultMount, {
							mountName: output.vaultMountName,
						}),
					);
					yield* services.nexusProjectRoles.delete(
						childDeleteCall(scope, "nexus-roles", child.nexusProjectRoles, {
							roleIds: [],
						}),
					);
					yield* services.nexusGroupRepo.delete(
						childDeleteCall(scope, "nexus-group", child.nexusGroupRepo, {
							groupRepoName: "",
							members: [],
						}),
					);
					yield* services.nexusMavenRepos.delete(
						childDeleteCall(scope, "nexus-maven", child.nexusMavenRepos, {
							releaseRepoName: "",
							snapshotRepoName: "",
						}),
					);
					yield* services.harborGroupMembers.delete(
						childDeleteCall(scope, "harbor-members", child.harborGroupMembers, {
							groups: [],
						}),
					);
					yield* services.harborRetention.delete(
						childDeleteCall(
							scope,
							"harbor-retention",
							{ ...child.harborRetention, projectId: output.harborProjectId },
							{ retentionId: output.harborRetentionId },
						),
					);
					for (const kind of [...ROBOT_KINDS].reverse()) {
						const robotId = output.harborRobotIds[kind] ?? -1;
						if (robotId < 0) continue;
						const name = harbor.kindName(kind);
						yield* services.harborRobots.delete(
							childDeleteCall(
								scope,
								`harbor-robot-${kind}`,
								{
									...child.harborRobots[kind],
									projectId: output.harborProjectId,
								},
								{
									robotId,
									name,
									fullName: harbor.robotFullName(olds.slug, name),
									secretRef: "",
								},
							),
						);
					}
					yield* services.harborProject.delete(
						childDeleteCall(scope, "harbor-project", child.harborProject, {
							projectId: output.harborProjectId,
							name: child.harborProject.name,
							storageLimit: child.harborProject.storageLimit,
							retentionId: output.harborRetentionId,
						}),
					);
					yield* services.sonarTemplate.delete(
						childDeleteCall(scope, "sonar-template", child.sonarTemplate, {
							name: olds.slug,
							id: undefined,
						}),
					);
					yield* services.sonarPermissions.delete(
						childDeleteCall(
							scope,
							"sonar-permissions",
							{ ...child.sonarPermissions, repository: output.gitlabRepoPath },
							{
								secret: {
									SONAR_USERNAME: "",
									SONAR_PASSWORD: "",
									SONAR_TOKEN: "",
								},
							},
						),
					);
					yield* services.sonarProject.delete(
						childDeleteCall(
							scope,
							"sonar-project",
							{ ...child.sonarProject, repository: output.gitlabRepoPath },
							{
								key: output.sonarKey,
								name: "",
								visibility: sonarVisibility(child.sonarProject.clusterPrivacy),
							},
						),
					);
					yield* services.gitlabGroupMembers.delete(
						childDeleteCall(
							scope,
							"gitlab-members",
							{
								...child.gitlabGroupMembers,
								groupId: output.gitlabGroupId,
								gitlabUserIds: {},
								ownerGitlabUserId: -1,
							},
							{ members: [] },
						),
					);
					yield* services.gitlabMirrorRobot.delete(
						childDeleteCall(
							scope,
							"gitlab-mirror-robot",
							{ ...child.gitlabMirrorRobot, groupId: output.gitlabGroupId },
							{
								tokenId: output.mirrorRobotTokenId,
								name: "",
								expiresAt: undefined,
								secretRef: "",
							},
						),
					);
					yield* services.gitlabRepository.delete(
						childDeleteCall(
							scope,
							"gitlab-repository",
							{
								...child.gitlabRepository,
								groupId: output.gitlabGroupId,
								groupFullPath: output.gitlabGroupFullPath,
							},
							{
								projectId: -1,
								path: output.gitlabRepoPath,
								pathWithNamespace: output.gitlabRepoPathWithNamespace,
								topics: [],
							},
						),
					);
					for (const user of [...child.gitlabUsers].reverse()) {
						yield* services.gitlabUsers.delete(
							childDeleteCall(scope, `gitlab-user-${user.email}`, user, {
								userId: -1,
								username: "",
								name: user.name,
								email: user.email,
							}),
						);
					}
					yield* services.gitlabProjectGroup.delete(
						childDeleteCall(scope, "gitlab-project", child.gitlabProjectGroup, {
							groupId: output.gitlabGroupId,
							fullPath: output.gitlabGroupFullPath,
							isRoot: false,
						}),
					);
					yield* services.gitlabProjectGroup.delete(
						childDeleteCall(scope, "gitlab-root", child.gitlabRootGroup, {
							groupId: -1,
							fullPath: child.gitlabRootGroup.rootGroupPath,
							isRoot: true,
						}),
					);
					yield* services.keycloakGroups.delete(
						childDeleteCall(scope, "keycloak-groups", child.keycloakGroups, {
							groupPath: output.keycloakGroupPath,
							consoleGroupPath: "",
							roleGroupPaths: [],
							environmentGroupPaths: [],
						}),
					);
				}),
			});
		}),
	).pipe(
		Layer.provide(
			Layer.mergeAll(
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
			),
		),
		// nexus providers are NOT provided here: they need a NexusConfig, so
		// the layer keeps those tags as requirements — CpnProvider (or a
		// hand-wired stack) provides nexus.providers(config) from the outside.
	);
