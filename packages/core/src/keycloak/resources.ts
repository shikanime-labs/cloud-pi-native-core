import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
	isKeycloakConflict,
	isKeycloakNotFound,
	KeycloakClient,
	type KeycloakClientService,
	type KeycloakError,
} from "./client.ts";
import {
	additionSet,
	consoleGroupPath,
	desiredEnvGroupMembers,
	desiredProjectMembers,
	envGroupPaths,
	evictionSet,
	findOrphanEnvGroups,
	findOrphanTopGroups,
	type GroupSummary,
	projectGroupPath,
	roleGroupPath,
} from "./paths.ts";

// ---------------------------------------------------------------------------
// Membership primitives — the console's maybeAddUserToGroup / maybeRemove:
// 404 user-gone → skip (log), 409 already-member → log, else throw.
// ---------------------------------------------------------------------------

const maybeAddUser = (
	client: KeycloakClientService,
	email: string,
	groupId: string,
	label: string,
): Effect.Effect<void, KeycloakError> =>
	Effect.gen(function* () {
		const user = yield* client.getUserByEmail(email);
		if (user === undefined) {
			yield* Effect.logWarning(
				`User '${email}' not found in Keycloak, skipping addition to ${label}`,
			);
			return;
		}
		yield* client.addUserToGroup(user.id, groupId).pipe(
			Effect.catchAll((error) => {
				if (isKeycloakNotFound(error)) {
					return Effect.logWarning(
						`User '${email}' gone from Keycloak, skipping addition to ${label}`,
					);
				}
				if (isKeycloakConflict(error)) {
					return Effect.logDebug(
						`User '${email}' already a member of ${label}`,
					);
				}
				return Effect.fail(error);
			}),
		);
	});

const maybeRemoveUser = (
	client: KeycloakClientService,
	email: string,
	groupId: string,
	label: string,
): Effect.Effect<void, KeycloakError> =>
	Effect.gen(function* () {
		const user = yield* client.getUserByEmail(email);
		if (user === undefined) {
			yield* Effect.logWarning(
				`User '${email}' not found in Keycloak, skipping removal from ${label}`,
			);
			return;
		}
		yield* client.removeUserFromGroup(user.id, groupId).pipe(
			Effect.catchAll((error) => {
				if (isKeycloakNotFound(error)) {
					return Effect.logWarning(
						`User '${email}' gone from Keycloak, skipping removal from ${label}`,
					);
				}
				return Effect.fail(error);
			}),
		);
	});

const currentMemberEmails = (
	client: KeycloakClientService,
	groupId: string,
): Effect.Effect<ReadonlySet<string>, KeycloakError> =>
	Effect.map(
		client.getGroupMembers(groupId),
		(members) =>
			new Set(
				members.flatMap((member) =>
					member.email === undefined ? [] : [member.email],
				),
			),
	);

/**
 * Converge one group's membership: add every desired email missing from the
 * group, then evict every current email absent from `keep` (for most groups
 * `keep` is the desired set; role groups keep the whole project user set).
 */
const syncGroupMembers = (
	client: KeycloakClientService,
	options: {
		readonly groupId: string;
		readonly label: string;
		readonly desired: ReadonlySet<string>;
		readonly keep: ReadonlySet<string>;
	},
): Effect.Effect<void, KeycloakError> =>
	Effect.gen(function* () {
		const current = yield* currentMemberEmails(client, options.groupId);
		for (const email of additionSet(current, options.desired)) {
			yield* maybeAddUser(client, email, options.groupId, options.label);
		}
		for (const email of evictionSet(current, options.keep)) {
			yield* maybeRemoveUser(client, email, options.groupId, options.label);
		}
	});

// ---------------------------------------------------------------------------
// Cpn.Keycloak.ProjectGroups — the whole per-project tree: top /{slug} group
// (members = owner + project members), the fixed /{slug}/console subgroup,
// role groups at role-relative oidcGroup paths, and per-environment
// /{slug}/console/{env}/RO|RW groups.
// ---------------------------------------------------------------------------

export interface EnvironmentProps {
	readonly name: string;
	readonly roUserEmails: readonly string[];
	readonly rwUserEmails: readonly string[];
}

export interface ProjectGroupsProps {
	/** Console project slug — names the top group /{slug}. */
	readonly slug: string;
	readonly ownerEmail: string;
	readonly memberEmails: readonly string[];
	/**
	 * Role-group suffixes created under /{slug}/console. Defaults to the
	 * console's seeded roles (admin, devops, developer, readonly) plus the
	 * security plugin's suffix.
	 */
	readonly roleSuffixes?: readonly string[];
	readonly environments?: readonly EnvironmentProps[];
}

export interface ProjectGroups
	extends Resource<
		"Cpn.Keycloak.ProjectGroups",
		ProjectGroupsProps,
		{
			readonly groupPath: string;
			readonly consoleGroupPath: string;
			readonly roleGroupPaths: readonly string[];
			readonly environmentGroupPaths: readonly {
				readonly name: string;
				readonly ro: string;
				readonly rw: string;
			}[];
		}
	> {}

export const ProjectGroups = Resource<ProjectGroups>(
	"Cpn.Keycloak.ProjectGroups",
);

const DEFAULT_ROLE_SUFFIXES = [
	"admin",
	"devops",
	"developer",
	"readonly",
	"security",
];

export const ProjectGroupsProvider = () =>
	Provider.effect(
		ProjectGroups,
		Effect.gen(function* () {
			const client = yield* KeycloakClient;
			return ProjectGroups.Provider.of({
				list: () => Effect.succeed([]),
				reconcile: Effect.fn("Cpn.Keycloak.ProjectGroups/reconcile")(
					function* ({ news }) {
						const slug = news.slug;
						const roleSuffixes = news.roleSuffixes ?? DEFAULT_ROLE_SUFFIXES;
						const environments = news.environments ?? [];

						const top = yield* client.getOrCreateGroupByPath(
							projectGroupPath(slug),
						);
						const consoleGroup = yield* client.getOrCreateGroupByPath(
							consoleGroupPath(slug),
						);

						for (const suffix of roleSuffixes) {
							yield* client.getOrCreateGroupByPath(roleGroupPath(slug, suffix));
						}

						const desiredTop = desiredProjectMembers(
							news.ownerEmail,
							news.memberEmails,
						);
						yield* syncGroupMembers(client, {
							groupId: top.id,
							label: top.path,
							desired: desiredTop,
							keep: desiredTop,
						});

						const environmentGroupPaths: {
							readonly name: string;
							readonly ro: string;
							readonly rw: string;
						}[] = [];
						for (const environment of environments) {
							const paths = envGroupPaths(slug, environment.name);
							const roGroup = yield* client.getOrCreateGroupByPath(paths.ro);
							const rwGroup = yield* client.getOrCreateGroupByPath(paths.rw);
							environmentGroupPaths.push({
								name: environment.name,
								ro: roGroup.path,
								rw: rwGroup.path,
							});
							const desiredEnv = desiredEnvGroupMembers(
								news.ownerEmail,
								environment,
							);
							yield* syncGroupMembers(client, {
								groupId: roGroup.id,
								label: roGroup.path,
								desired: desiredEnv.ro,
								keep: desiredEnv.ro,
							});
							yield* syncGroupMembers(client, {
								groupId: rwGroup.id,
								label: rwGroup.path,
								desired: desiredEnv.rw,
								keep: desiredEnv.rw,
							});
						}

						// Orphan env groups: console-subgroup children shaped like env
						// groups (RO/RW subgroups) whose name matches no current env.
						const consoleChildren = yield* client.getSubGroups(consoleGroup.id);
						const envNames = new Set(
							environments.map((environment) => environment.name),
						);
						for (const child of consoleChildren) {
							const grandChildren = yield* client.getSubGroups(child.id);
							const summary: GroupSummary = {
								id: child.id,
								name: child.name,
								subGroups: grandChildren.map((sub) => ({ name: sub.name })),
							};
							for (const orphan of findOrphanEnvGroups([summary], envNames)) {
								yield* Effect.log(
									`Deleting orphan Keycloak env group ${orphan.name} (${slug})`,
								);
								yield* client
									.deleteGroupTree(orphan.id)
									.pipe(
										Effect.catchAll((error) =>
											Effect.logWarning(
												`Failed to delete orphan env group ${orphan.name}: ${error.message}`,
											),
										),
									);
							}
						}

						return {
							groupPath: top.path,
							consoleGroupPath: consoleGroup.path,
							roleGroupPaths: roleSuffixes.map((suffix) =>
								roleGroupPath(slug, suffix),
							),
							environmentGroupPaths,
						};
					},
				),
				// project.delete = recursive tree delete, children first (client-side).
				delete: Effect.fn("Cpn.Keycloak.ProjectGroups/delete")(function* ({
					olds,
				}) {
					const top = yield* client.getGroupByPath(projectGroupPath(olds.slug));
					if (top === undefined) return;
					yield* client.deleteGroupTree(top.id);
				}),
			});
		}),
	);

// ---------------------------------------------------------------------------
// Cpn.Keycloak.RoleGroupMembers — membership for one role group at
// /{slug}/console/<suffix>: add desired members (add-only sync), evict
// members outside the project user set (managed-role orphan purge).
// ---------------------------------------------------------------------------

export interface RoleGroupMembersProps {
	readonly slug: string;
	/** Role-group suffix under /{slug}/console (e.g. `admin`, `devops`). */
	readonly suffix: string;
	/** Emails that must hold the role. */
	readonly userEmails: readonly string[];
	/** Every user of the project — members outside this set are evicted. */
	readonly projectUserEmails: readonly string[];
}

export interface RoleGroupMembers
	extends Resource<
		"Cpn.Keycloak.RoleGroupMembers",
		RoleGroupMembersProps,
		{ readonly groupPath: string; readonly memberEmails: readonly string[] }
	> {}

export const RoleGroupMembers = Resource<RoleGroupMembers>(
	"Cpn.Keycloak.RoleGroupMembers",
);

export const RoleGroupMembersProvider = () =>
	Provider.effect(
		RoleGroupMembers,
		Effect.gen(function* () {
			const client = yield* KeycloakClient;
			return RoleGroupMembers.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Keycloak.RoleGroupMembers/read")(function* ({
					olds,
				}) {
					const group = yield* client.getGroupByPath(
						roleGroupPath(olds.slug, olds.suffix),
					);
					if (group === undefined) return undefined;
					const current = yield* currentMemberEmails(client, group.id);
					return { groupPath: group.path, memberEmails: [...current] };
				}),
				reconcile: Effect.fn("Cpn.Keycloak.RoleGroupMembers/reconcile")(
					function* ({ news }) {
						const group = yield* client.getOrCreateGroupByPath(
							roleGroupPath(news.slug, news.suffix),
						);
						const desired = new Set(news.userEmails);
						const projectUsers = new Set(news.projectUserEmails);
						yield* syncGroupMembers(client, {
							groupId: group.id,
							label: group.path,
							desired,
							keep: projectUsers,
						});
						return {
							groupPath: group.path,
							memberEmails: [...additionSet(new Set(), desired)],
						};
					},
				),
				delete: Effect.fn("Cpn.Keycloak.RoleGroupMembers/delete")(
					// Membership-only resource: removal drops nothing the next
					// reconciler run would not rebuild; console parity.
					function* () {},
				),
			});
		}),
	);

// ---------------------------------------------------------------------------
// Cpn.Keycloak.AdminRoleGroup — group for a managed AdminRole with a
// non-empty oidcGroup (e.g. /admin, /console/reader), members synced to the
// role's user list (add missing, remove stale).
// ---------------------------------------------------------------------------

export interface AdminRoleGroupProps {
	/** Absolute OIDC group path, e.g. `/admin` or `/console/reader`. */
	readonly groupPath: string;
	/** Emails of users holding this admin role. */
	readonly userEmails: readonly string[];
}

export interface AdminRoleGroup
	extends Resource<
		"Cpn.Keycloak.AdminRoleGroup",
		AdminRoleGroupProps,
		{ readonly groupPath: string; readonly memberEmails: readonly string[] }
	> {}

export const AdminRoleGroup = Resource<AdminRoleGroup>(
	"Cpn.Keycloak.AdminRoleGroup",
);

export const AdminRoleGroupProvider = () =>
	Provider.effect(
		AdminRoleGroup,
		Effect.gen(function* () {
			const client = yield* KeycloakClient;
			return AdminRoleGroup.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Keycloak.AdminRoleGroup/read")(function* ({
					olds,
				}) {
					const group = yield* client.getGroupByPath(olds.groupPath);
					if (group === undefined) return undefined;
					const current = yield* currentMemberEmails(client, group.id);
					return { groupPath: group.path, memberEmails: [...current] };
				}),
				reconcile: Effect.fn("Cpn.Keycloak.AdminRoleGroup/reconcile")(
					function* ({ news }) {
						const group = yield* client.getOrCreateGroupByPath(news.groupPath);
						const desired = new Set(news.userEmails);
						yield* syncGroupMembers(client, {
							groupId: group.id,
							label: group.path,
							desired,
							keep: desired,
						});
						return { groupPath: group.path, memberEmails: [...desired] };
					},
				),
				delete: Effect.fn("Cpn.Keycloak.AdminRoleGroup/delete")(function* ({
					olds,
				}) {
					const group = yield* client.getGroupByPath(olds.groupPath);
					if (group === undefined) return;
					yield* client.deleteGroupTree(group.id);
				}),
			});
		}),
	);

// ---------------------------------------------------------------------------
// Orphan purge (the console's cron pass): top-level groups not matching a
// current slug AND containing a console subgroup → recursive delete.
// ---------------------------------------------------------------------------

export const purgeOrphanGroups = (
	client: KeycloakClientService,
	currentSlugs: ReadonlySet<string>,
): Effect.Effect<readonly string[], KeycloakError> =>
	Effect.gen(function* () {
		const topGroups = yield* client.getRootGroups();
		const summaries: GroupSummary[] = [];
		for (const group of topGroups) {
			const subGroups = yield* client.getSubGroups(group.id);
			summaries.push({
				id: group.id,
				name: group.name,
				subGroups: subGroups.map((sub) => ({ name: sub.name })),
			});
		}
		const purged: string[] = [];
		for (const orphan of findOrphanTopGroups(summaries, currentSlugs)) {
			yield* Effect.log(
				`Deleting orphan Keycloak group ${orphan.name} (${orphan.id})`,
			);
			yield* client.deleteGroupTree(orphan.id);
			purged.push(orphan.name);
		}
		return purged;
	});
