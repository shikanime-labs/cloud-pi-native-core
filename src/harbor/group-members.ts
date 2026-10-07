import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as api from "./api.ts";
import { defaultGroupPaths, harborRoleByGroup } from "./roles.ts";

export interface GroupMembersProps {
	/** Console project slug — the Harbor project whose members converge. */
	readonly slug: string;
	/**
	 * Desired OIDC group paths per tier, defaulted from the console's
	 * registry plugin mapping (project-scoped under `/{slug}/console/...`).
	 */
	readonly adminGroups?: readonly string[];
	readonly maintainerGroups?: readonly string[];
	readonly developerGroups?: readonly string[];
	readonly guestGroups?: readonly string[];
	readonly platformAdminGroups?: readonly string[];
	readonly platformGuestGroups?: readonly string[];
}

export interface GroupMembers
	extends Resource<
		"Cpn.Harbor.GroupMembers",
		GroupMembersProps,
		{
			readonly groups: readonly {
				readonly group: string;
				readonly roleId: number;
			}[];
		}
	> {}

/**
 * Desired-state Harbor group membership for a project: every console role
 * group mapped to its Harbor role — including the quirk that project
 * `/{slug}/console/admin` maps to DEVELOPER (2), never PROJECT_ADMIN;
 * only platform `/console/admin` is PROJECT_ADMIN (1).
 */
export const GroupMembers = Resource<GroupMembers>("Cpn.Harbor.GroupMembers");

const desiredGroups = (slug: string, news: GroupMembersProps) =>
	harborRoleByGroup({
		admin: news.adminGroups ?? defaultGroupPaths(slug).admin,
		maintainer: news.maintainerGroups ?? defaultGroupPaths(slug).maintainer,
		developer: news.developerGroups ?? defaultGroupPaths(slug).developer,
		guest: news.guestGroups ?? defaultGroupPaths(slug).guest,
		platformAdmin:
			news.platformAdminGroups ?? defaultGroupPaths(slug).platformAdmin,
		platformGuest:
			news.platformGuestGroups ?? defaultGroupPaths(slug).platformGuest,
	});

const desiredEntries = (slug: string, news: GroupMembersProps) =>
	Array.from(desiredGroups(slug, news).entries()).map(([group, roleId]) => ({
		group,
		roleId,
	}));

export const GroupMembersProvider = () =>
	Provider.succeed(GroupMembers, {
		read: ({ olds }) =>
			Effect.gen(function* () {
				const slug = olds?.slug ?? "";
				const members = yield* api.getGroupMembers(slug);
				return {
					groups: members.map((member) => ({
						group: member.entityName,
						roleId: member.roleId ?? 0,
					})),
				};
			}),
		reconcile: ({ news }) =>
			Effect.gen(function* () {
				const desired = desiredGroups(news.slug, news);

				// Observe — live membership, keyed by group name.
				const members = yield* api.getGroupMembers(news.slug);
				const membersByGroup = new Map(
					members.map((member) => [member.entityName, member]),
				);

				// Ensure + sync — remove stale or wrong-role entries, add missing.
				for (const [group, roleId] of desired) {
					const existing = membersByGroup.get(group);
					if (
						existing !== undefined &&
						existing.roleId === roleId &&
						existing.entityType === "g"
					) {
						continue;
					}
					if (existing !== undefined) {
						yield* api.deleteGroupMember(news.slug, existing.id);
					}
					yield* api.putGroupMember(news.slug, group, roleId);
				}
				for (const member of members) {
					if (!desired.has(member.entityName)) {
						yield* api.deleteGroupMember(news.slug, member.id);
					}
				}

				return { groups: desiredEntries(news.slug, news) };
			}),
		delete: ({ olds }) =>
			Effect.gen(function* () {
				// Removing the resource removes every group membership it managed.
				const members = yield* api.getGroupMembers(olds.slug);
				const ours = new Set(
					olds.adminGroups ?? olds.maintainerGroups ?? olds.guestGroups ?? [],
				);
				for (const member of members) {
					if (ours.has(member.entityName)) {
						yield* api.deleteGroupMember(olds.slug, member.id);
					}
				}
			}),
	});
