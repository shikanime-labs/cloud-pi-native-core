import { Resource, type Resource as ResourceT } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { isNexusNotFound, NexusClient, type NexusRole } from "./client.js";
import {
	cleanupOrder,
	computeProjectRoles,
	groupPrivilegeName,
	groupRepoName,
	mavenHostedPrivilegeName,
	mavenHostedRepoName,
	NPM_WRITE_POLICY,
	npmGroupPrivilegeName,
	npmGroupRepoName,
	npmHostedPrivilegeName,
	npmHostedRepoName,
} from "./roles.js";

export interface ProjectRolesProps {
	readonly slug: string;
	/** npm repos provisioned (console: `specificallyEnabled`). */
	readonly npm: boolean;
	/** Project-level suffix overrides (comma-separated group-path suffixes). */
	readonly writeSuffixes?: string;
	readonly readSuffixes?: string;
	/** Admin-level overrides; win over project values. */
	readonly adminWriteSuffixes?: string;
	readonly adminReadSuffixes?: string;
}

export type ProjectRoles = ResourceT<
	"Cpn.Nexus.ProjectRoles",
	ProjectRolesProps,
	{
		readonly roleIds: ReadonlyArray<string>;
	}
>;

export const ProjectRoles = Resource<ProjectRoles>("Cpn.Nexus.ProjectRoles");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const parseRole = (data: unknown, roleId: string): NexusRole => {
	if (!isRecord(data)) {
		throw new Error(`nexus: role "${roleId}" response is not an object`);
	}
	const privileges = data.privileges;
	if (
		typeof data.id !== "string" ||
		typeof data.name !== "string" ||
		!Array.isArray(privileges)
	) {
		throw new Error(`nexus: role "${roleId}" is missing id/name/privileges`);
	}
	const parsed: string[] = [];
	for (const privilege of privileges) {
		if (typeof privilege !== "string") {
			throw new Error(
				`nexus: role "${roleId}" privileges contains a non-string`,
			);
		}
		parsed.push(privilege);
	}
	return { id: data.id, name: data.name, privileges: parsed };
};

const WRITE_ACTIONS = ["all"] as const;
const READ_ACTIONS = ["read", "browse"] as const;

interface PrivilegeSpec {
	readonly type: "maven" | "npm";
	readonly name: string;
	readonly actions: ReadonlyArray<string>;
	readonly format: string;
	readonly repository: string;
}

const mavenPrivileges = (slug: string): ReadonlyArray<PrivilegeSpec> => [
	{
		type: "maven",
		name: mavenHostedPrivilegeName(slug, "release"),
		actions: WRITE_ACTIONS,
		format: "maven2",
		repository: mavenHostedRepoName(slug, "release"),
	},
	{
		type: "maven",
		name: `${mavenHostedPrivilegeName(slug, "release")}-ro`,
		actions: READ_ACTIONS,
		format: "maven2",
		repository: mavenHostedRepoName(slug, "release"),
	},
	{
		type: "maven",
		name: mavenHostedPrivilegeName(slug, "snapshot"),
		actions: WRITE_ACTIONS,
		format: "maven2",
		repository: mavenHostedRepoName(slug, "snapshot"),
	},
	{
		type: "maven",
		name: `${mavenHostedPrivilegeName(slug, "snapshot")}-ro`,
		actions: READ_ACTIONS,
		format: "maven2",
		repository: mavenHostedRepoName(slug, "snapshot"),
	},
	{
		type: "maven",
		name: groupPrivilegeName(slug),
		actions: WRITE_ACTIONS,
		format: "maven2",
		repository: groupRepoName(slug),
	},
	{
		type: "maven",
		name: `${groupPrivilegeName(slug)}-ro`,
		actions: READ_ACTIONS,
		format: "maven2",
		repository: groupRepoName(slug),
	},
];

const npmPrivileges = (slug: string): ReadonlyArray<PrivilegeSpec> => [
	{
		type: "npm",
		name: npmHostedPrivilegeName(slug),
		actions: WRITE_ACTIONS,
		format: "npm",
		repository: npmHostedRepoName(slug),
	},
	{
		type: "npm",
		name: `${npmHostedPrivilegeName(slug)}-ro`,
		actions: READ_ACTIONS,
		format: "npm",
		repository: npmHostedRepoName(slug),
	},
	{
		type: "npm",
		name: npmGroupPrivilegeName(slug),
		actions: WRITE_ACTIONS,
		format: "npm",
		repository: npmGroupRepoName(slug),
	},
	{
		type: "npm",
		name: `${npmGroupPrivilegeName(slug)}-ro`,
		actions: READ_ACTIONS,
		format: "npm",
		repository: npmGroupRepoName(slug),
	},
];

export const ProjectRolesProvider = () =>
	Provider.effect(
		ProjectRoles,
		Effect.gen(function* () {
			const nexus = yield* NexusClient;

			const getPrivilege = (name: string) =>
				nexus(`security/privileges/${name}`).pipe(
					Effect.catchIf(isNexusNotFound, () => Effect.succeed(undefined)),
				);

			const upsertPrivilege = (spec: PrivilegeSpec, slug: string) =>
				Effect.gen(function* () {
					// Observe → ensure → sync for each repository-view privilege.
					const observed = yield* getPrivilege(spec.name);
					const body = {
						type: spec.type,
						name: spec.name,
						description: `Privilege for project ${slug} repo ${spec.repository}`,
						actions: [...spec.actions],
						format: spec.format,
						repository: spec.repository,
					};
					if (observed === undefined) {
						yield* nexus("security/privileges/repository-view", {
							method: "POST",
							body,
						});
					} else {
						yield* nexus(`security/privileges/repository-view/${spec.name}`, {
							method: "PUT",
							body,
						});
					}
				});

			const getRole = (id: string) =>
				nexus(`security/roles/${id}`).pipe(
					Effect.catchIf(isNexusNotFound, () => Effect.succeed(undefined)),
					Effect.map((data) =>
						data === undefined ? undefined : parseRole(data, id),
					),
				);

			const upsertRole = (id: string, privileges: ReadonlyArray<string>) =>
				Effect.gen(function* () {
					const observed = yield* getRole(id);
					const body = {
						id,
						name: id,
						description: `Role for OIDC group ${id}`,
						privileges: [...privileges],
					};
					if (observed === undefined) {
						yield* nexus("security/roles", { method: "POST", body });
					} else if (
						observed.privileges.length !== privileges.length ||
						observed.privileges.some((p) => !privileges.includes(p))
					) {
						yield* nexus(`security/roles/${id}`, { method: "PUT", body });
					}
				});

			const ensureNpmRepos = (slug: string) =>
				Effect.gen(function* () {
					// npm hosted + group repos — the audit assigns these to this
					// resource (created only when specificallyEnabled).
					const hostedName = npmHostedRepoName(slug);
					const groupName = npmGroupRepoName(slug);
					const observedHosted = yield* nexus(
						`repositories/npm/hosted/${hostedName}`,
					).pipe(
						Effect.catchIf(isNexusNotFound, () => Effect.succeed(undefined)),
					);
					if (observedHosted === undefined) {
						yield* nexus("repositories/npm/hosted", {
							method: "POST",
							body: {
								name: hostedName,
								online: true,
								storage: {
									blobStoreName: "default",
									strictContentTypeValidation: true,
									writePolicy: NPM_WRITE_POLICY,
								},
								component: { proprietaryComponents: true },
							},
						});
					}
					const observedGroup = yield* nexus(
						`repositories/npm/group/${groupName}`,
					).pipe(
						Effect.catchIf(isNexusNotFound, () => Effect.succeed(undefined)),
					);
					if (observedGroup === undefined) {
						yield* nexus("repositories/npm/group", {
							method: "POST",
							body: {
								name: groupName,
								online: true,
								storage: {
									blobStoreName: "default",
									strictContentTypeValidation: true,
								},
								group: { memberNames: [hostedName] },
							},
						});
					}
				});

			return {
				reconcile: Effect.fn("Cpn.Nexus.ProjectRoles/reconcile")(function* ({
					news,
				}: {
					news: ProjectRolesProps;
				}) {
					const slug = news.slug;

					// Privileges: Maven always, npm only when specificallyEnabled.
					const specs = news.npm
						? [...mavenPrivileges(slug), ...npmPrivileges(slug)]
						: mavenPrivileges(slug);
					for (const spec of specs) {
						yield* upsertPrivilege(spec, slug);
					}

					// Roles from OIDC group-path suffixes (admin > project > defaults).
					const { roles } = computeProjectRoles(news);
					for (const role of roles) {
						yield* upsertRole(role.id, role.privileges);
					}

					// npm repos when specificallyEnabled.
					if (news.npm) {
						yield* ensureNpmRepos(slug);
					}

					return { roleIds: roles.map((role) => role.id) };
				}),
				delete: Effect.fn("Cpn.Nexus.ProjectRoles/delete")(function* ({
					olds,
				}: {
					olds: ProjectRolesProps;
				}) {
					// Roles and privileges before repositories; group repo before the
					// hosted repos it aggregates. Repos owned by MavenRepos/GroupRepo
					// are deleted by their own resources in reverse-dependency order;
					// this resource only tears down what it owns: roles, privileges,
					// and the npm repos it created (group first).
					for (const step of cleanupOrder(olds.slug, olds.npm)) {
						if (step.kind !== "repository") {
							const path =
								step.kind === "role"
									? `security/roles/${step.name}`
									: `security/privileges/${step.name}`;
							yield* nexus(path, { method: "DELETE" }).pipe(
								Effect.catchIf(isNexusNotFound, () => Effect.void),
							);
						} else if (
							olds.npm &&
							(step.name === npmGroupRepoName(olds.slug) ||
								step.name === npmHostedRepoName(olds.slug))
						) {
							yield* nexus(`repositories/${step.name}`, {
								method: "DELETE",
							}).pipe(Effect.catchIf(isNexusNotFound, () => Effect.void));
						}
					}
				}),
			};
		}),
	);
