import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { GitlabClient } from "./client.ts";
import {
	ACCESS_LEVEL_GUEST,
	ACCESS_LEVEL_OWNER,
	type ConsoleMembership,
	type ConsoleRole,
	defaultRoleGroupPaths,
	generateAccessLevelMapping,
	generateProjectRoleGroupPaths,
	type RoleGroupPaths,
	shouldRemoveMember,
} from "./utils.ts";

/**
 * Cpn.Gitlab.GroupMembers — desired-state membership of ONE project
 * subgroup `{root}/{slug}` (no role subgroups).
 *
 * Console semantics:
 * - a member's access level is the HIGHEST across their roleIds, each
 *   role's level derived from its oidcGroup against the tier path sets:
 *   maintainer `/console/admin,/console/devops` → MAINTAINER(40),
 *   developer `/console/developer` → DEVELOPER(30), reporter
 *   `/console/readonly,/console/security` → REPORTER(20);
 * - no matching role → GUEST(10) fallback;
 * - the project owner is ALWAYS OWNER(50), reconciled last so it wins;
 * - NO_ACCESS(0) means remove the member;
 * - tier suffix sets are overridable (admin plugin value > project plugin
 *   value > default; comma-separated multi-path).
 */
export interface GroupMembersProps {
	/** Project subgroup id (Cpn.Gitlab.ProjectGroup output). */
	readonly groupId: number;
	/** Console project slug — defaults the role group paths. */
	readonly slug: string;
	/**
	 * Raw suffix lists per tier (comma-separated multi-path), overridable
	 * admin>project; omitted falls back to the console defaults.
	 */
	readonly reporterGroupPathSuffix?: string | undefined;
	readonly developerGroupPathSuffix?: string | undefined;
	readonly maintainerGroupPathSuffix?: string | undefined;
	/** Console roles: id → oidcGroup binding. */
	readonly roles: readonly ConsoleRole[];
	/** Console memberships: userId → roleIds. */
	readonly memberships: readonly ConsoleMembership[];
	/**
	 * Console user id → already-mirrored GitLab user id (from
	 * Cpn.Gitlab.User outputs).
	 */
	readonly gitlabUserIds: Readonly<Record<string, number>>;
	/** The project owner's GitLab user id — ALWAYS OWNER(50). */
	readonly ownerGitlabUserId: number;
}

export interface GroupMembersAttrs {
	readonly members: readonly {
		readonly gitlabUserId: number;
		readonly accessLevel: number;
	}[];
}

export interface GroupMembers
	extends Resource<
		"Cpn.Gitlab.GroupMembers",
		GroupMembersProps,
		GroupMembersAttrs
	> {}

export const GroupMembers = Resource<GroupMembers>("Cpn.Gitlab.GroupMembers");

const tierPaths = (
	slug: string,
	news: {
		reporterGroupPathSuffix?: string | undefined;
		developerGroupPathSuffix?: string | undefined;
		maintainerGroupPathSuffix?: string | undefined;
	},
): RoleGroupPaths => {
	const defaults = defaultRoleGroupPaths(slug);
	return {
		reporter:
			news.reporterGroupPathSuffix === undefined
				? defaults.reporter
				: generateProjectRoleGroupPaths(slug, news.reporterGroupPathSuffix),
		developer:
			news.developerGroupPathSuffix === undefined
				? defaults.developer
				: generateProjectRoleGroupPaths(slug, news.developerGroupPathSuffix),
		maintainer:
			news.maintainerGroupPathSuffix === undefined
				? defaults.maintainer
				: generateProjectRoleGroupPaths(slug, news.maintainerGroupPathSuffix),
	};
};

export const GroupMembersProvider = () =>
	Provider.effect(
		GroupMembers,
		Effect.gen(function* () {
			return GroupMembers.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Gitlab.GroupMembers/read")(function* ({ olds }) {
					const client = yield* GitlabClient;
					const observed = yield* client.listGroupMembers(olds.groupId);
					return {
						members: observed.map((member) => ({
							gitlabUserId: member.id,
							accessLevel: member.accessLevel,
						})),
					};
				}),
				reconcile: Effect.fn("Cpn.Gitlab.GroupMembers/reconcile")(function* ({
					news,
				}) {
					const client = yield* GitlabClient;
					const paths = tierPaths(news.slug, news);
					const desired = generateAccessLevelMapping(
						news.roles,
						news.memberships,
						paths,
					);
					// Observe — the live member list.
					const observed = yield* client.listGroupMembers(news.groupId);
					const observedById = new Map(
						observed.map((member) => [member.id, member]),
					);
					const members: { gitlabUserId: number; accessLevel: number }[] = [];
					// Sync — converge each desired member: add / edit / remove.
					for (const [userId, gitlabUserId] of Object.entries(
						news.gitlabUserIds,
					)) {
						const level = desired.get(userId) ?? ACCESS_LEVEL_GUEST;
						const existing = observedById.get(gitlabUserId);
						if (shouldRemoveMember(level)) {
							if (existing !== undefined) {
								yield* client.removeGroupMember(news.groupId, gitlabUserId);
							}
							continue;
						}
						if (existing === undefined) {
							yield* client.addGroupMember(news.groupId, gitlabUserId, level);
						} else if (existing.accessLevel !== level) {
							yield* client.editGroupMember(news.groupId, gitlabUserId, level);
						}
						members.push({ gitlabUserId, accessLevel: level });
					}
					// The owner is ALWAYS OWNER(50) — applied last so it wins.
					const owner = observedById.get(news.ownerGitlabUserId);
					if (owner === undefined) {
						yield* client.addGroupMember(
							news.groupId,
							news.ownerGitlabUserId,
							ACCESS_LEVEL_OWNER,
						);
					} else if (owner.accessLevel !== ACCESS_LEVEL_OWNER) {
						yield* client.editGroupMember(
							news.groupId,
							news.ownerGitlabUserId,
							ACCESS_LEVEL_OWNER,
						);
					}
					members.push({
						gitlabUserId: news.ownerGitlabUserId,
						accessLevel: ACCESS_LEVEL_OWNER,
					});
					return { members };
				}),
				delete: Effect.fn("Cpn.Gitlab.GroupMembers/delete")(function* () {
					// Members fall with the group; no standalone delete. The
					// console never removes users when a project loses a member —
					// only that group membership.
				}),
			});
		}),
	);
