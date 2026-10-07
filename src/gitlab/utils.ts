/**
 * Pure GitLab mapping logic, verified against the console's
 * gitlab.utils.ts + gitlab.constants.ts (server-nestjs gitlab module).
 */

// --- GitLab AccessLevel numeric values (gitbeaker `AccessLevel` enum). ---
export const ACCESS_LEVEL_NO_ACCESS = 0;
export const ACCESS_LEVEL_GUEST = 10;
export const ACCESS_LEVEL_REPORTER = 20;
export const ACCESS_LEVEL_DEVELOPER = 30;
export const ACCESS_LEVEL_MAINTAINER = 40;
export const ACCESS_LEVEL_OWNER = 50;

/**
 * Levels assignable to a group member. OWNER(50) equals the console's
 * `addMissingOwnerMember` access level and GitLab's ADMIN(50) shares the
 * numeric value — one number, distinct call sites.
 */
export type ProjectAccessLevel =
	| typeof ACCESS_LEVEL_GUEST
	| typeof ACCESS_LEVEL_REPORTER
	| typeof ACCESS_LEVEL_DEVELOPER
	| typeof ACCESS_LEVEL_MAINTAINER
	| typeof ACCESS_LEVEL_OWNER;

// --- Console defaults (gitlab.constants.ts). ---
export const DEFAULT_ADMIN_GROUP_PATH = "/console/admin";
export const DEFAULT_AUDITOR_GROUP_PATH = "/console/readonly,/console/security";
export const DEFAULT_MAINTAINER_GROUP_PATH_SUFFIX =
	"/console/admin,/console/devops";
export const DEFAULT_DEVELOPER_GROUP_PATH_SUFFIX = "/console/developer";
export const DEFAULT_REPORTER_GROUP_PATH_SUFFIX =
	"/console/readonly,/console/security";

// --- Ownership custom attributes + repo topics. ---
export const MANAGED_BY_CONSOLE_CUSTOM_ATTRIBUTE_KEY = "cpn_managed_by_console";
export const GROUP_ROOT_CUSTOM_ATTRIBUTE_KEY = "cpn_projects_root_dir";
export const PROJECT_GROUP_CUSTOM_ATTRIBUTE_KEY = "cpn_project_slug";
export const USER_ID_CUSTOM_ATTRIBUTE_KEY = "cpn_user_id";

export const TOPIC_PLUGIN_MANAGED = "plugin-managed";
export const TOPIC_SYSTEM_MANAGED = "system-managed";

// --- System repositories (gitlab.constants.ts). ---
export const INFRA_APPS_REPO_NAME = "infra-apps";
export const MIRROR_REPO_NAME = "mirror";

/**
 * Console-owned plumbing repositories, never a valid mirroring target.
 */
export const SPECIAL_REPO_NAMES: readonly string[] = [
	INFRA_APPS_REPO_NAME,
	MIRROR_REPO_NAME,
];

/** Mirror pipeline trigger token description (console TOKEN_DESCRIPTION). */
export const MIRROR_TOKEN_DESCRIPTION = "mirroring-from-external-repo";

/** Custom CI config path for repos mirroring an external URL. */
export const GITLAB_CI_CONFIG_PATH = ".gitlab-ci-dso.yml";

/**
 * Split a comma-separated group-path list; trims and drops empties.
 * `'/console/admin,/console/devops'` → both paths.
 */
export function parseGroupPaths(rawGroupPaths: string): string[] {
	return rawGroupPaths
		.split(",")
		.map((path) => path.trim())
		.filter(Boolean);
}

/**
 * Expand a raw suffix list into fully-qualified project role group paths:
 * `('/cpged', '/console/admin,/console/devops')` →
 * `['/cpged/console/admin', '/cpged/console/devops']`.
 */
export function generateProjectRoleGroupPaths(
	projectSlug: string,
	rawGroupPathSuffixes: string,
): string[] {
	return parseGroupPaths(rawGroupPathSuffixes).map(
		(suffix) => `/${projectSlug}${suffix}`,
	);
}

/**
 * Per-tier role group paths, defaulted from the console plugin values.
 * `admin` (platform `/console/admin`) beats `project` overrides — the
 * suffix sets are independently overridable admin>project, matching the
 * console's getAdminOrProjectPluginConfig resolution order.
 */
export interface RoleGroupPaths {
	readonly reporter: readonly string[];
	readonly developer: readonly string[];
	readonly maintainer: readonly string[];
}

export const defaultRoleGroupPaths = (projectSlug: string): RoleGroupPaths => ({
	reporter: generateProjectRoleGroupPaths(
		projectSlug,
		DEFAULT_REPORTER_GROUP_PATH_SUFFIX,
	),
	developer: generateProjectRoleGroupPaths(
		projectSlug,
		DEFAULT_DEVELOPER_GROUP_PATH_SUFFIX,
	),
	maintainer: generateProjectRoleGroupPaths(
		projectSlug,
		DEFAULT_MAINTAINER_GROUP_PATH_SUFFIX,
	),
});

/** A console project role: id + the OIDC group path it is bound to. */
export interface ConsoleRole {
	readonly id: string;
	readonly oidcGroup: string;
}

/** A console project membership: user id + the role ids the user holds. */
export interface ConsoleMembership {
	readonly userId: string;
	readonly roleIds: readonly string[];
}

const levelForOidcGroup = (
	oidcGroup: string,
	groupPaths: RoleGroupPaths,
): ProjectAccessLevel | null => {
	if (groupPaths.maintainer.includes(oidcGroup)) return ACCESS_LEVEL_MAINTAINER;
	if (groupPaths.developer.includes(oidcGroup)) return ACCESS_LEVEL_DEVELOPER;
	if (groupPaths.reporter.includes(oidcGroup)) return ACCESS_LEVEL_REPORTER;
	return null;
};

/**
 * The console's group→level mapping (gitlab.utils.ts
 * `generateAccessLevelMapping`):
 * - a role's level comes from its oidcGroup against the maintainer /
 *   developer / reporter path sets — no match contributes nothing;
 * - a member's level is the HIGHEST across their roleIds;
 * - a member with no matching role falls back to GUEST(10);
 * - the project owner is ALWAYS OWNER(50) — handled by the caller adding
 *   the owner after this mapping (`addMissingOwnerMember`);
 * - NO_ACCESS(0) never appears here; membership removal is the caller's
 *   `removeGroupMember` path.
 */
export function generateAccessLevelMapping(
	roles: readonly ConsoleRole[],
	memberships: readonly ConsoleMembership[],
	groupPaths: RoleGroupPaths,
): Map<string, ProjectAccessLevel> {
	const levelByRoleId = new Map<string, ProjectAccessLevel | null>(
		roles.map((role) => [
			role.id,
			levelForOidcGroup(role.oidcGroup, groupPaths),
		]),
	);
	const mapping = new Map<string, ProjectAccessLevel>();
	for (const membership of memberships) {
		let highest: ProjectAccessLevel | null = null;
		for (const roleId of membership.roleIds) {
			const level = levelByRoleId.get(roleId);
			if (level !== null && level !== undefined) {
				if (highest === null || level > highest) highest = level;
			}
		}
		mapping.set(membership.userId, highest ?? ACCESS_LEVEL_GUEST);
	}
	return mapping;
}

/**
 * Derive a GitLab username from an email: local part, every char outside
 * `[A-Za-z0-9_-]` stripped (console `generateUsername`).
 */
export function generateUsername(email: string): string {
	const localPart = email.split("@")[0] ?? "";
	return localPart.replaceAll(/[^\w-]/g, "");
}

/**
 * Username candidates the orphan purge treats as owned: the bare username
 * plus `_1`..`_3` (console `generateUsernameCandidates`).
 */
export function generateUsernameCandidates(email: string): string[] {
	const username = generateUsername(email);
	return [username, `${username}_1`, `${username}_2`, `${username}_3`];
}

/**
 * Instance admin/auditor flag, authoritative from the adminRole oidcGroup
 * paths (console `adminRoleFlag`):
 * - no resolved role ids → `undefined` (do not touch the flag);
 * - member of any resolved role → `true`;
 * - non-member → `false`.
 */
export function adminRoleFlag(
	user: { readonly adminRoleIds?: readonly string[] | undefined },
	adminRoleIds: readonly string[],
): boolean | undefined {
	if (adminRoleIds.length === 0) return undefined;
	return user.adminRoleIds?.some((id) => adminRoleIds.includes(id));
}

/**
 * Resolve admin/auditor role ids from the console roles and the configured
 * group paths (console `generateAdminRoleMapping`): each path maps to the
 * role bound to it; unmatched paths drop out, duplicate ids dedupe.
 */
export function generateAdminRoleMapping(
	roles: readonly ConsoleRole[],
	adminGroupPaths: readonly string[],
	auditorGroupPaths: readonly string[],
): { adminRoleIds: string[]; auditorRoleIds: string[] } {
	const roleIdByOidcGroup = new Map(
		roles.map((role) => [role.oidcGroup, role.id]),
	);
	const resolveRoleIds = (paths: readonly string[]) => [
		...new Set(
			paths
				.map((path) => roleIdByOidcGroup.get(path))
				.filter((id): id is string => id !== undefined),
		),
	];
	return {
		adminRoleIds: resolveRoleIds(adminGroupPaths),
		auditorRoleIds: resolveRoleIds(auditorGroupPaths),
	};
}

/**
 * Whole days between `now` and `created` (console `daysAgoFromNow`).
 */
export function daysAgoFromNow(created: Date, now: Date = new Date()): number {
	return Math.floor(
		(now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24),
	);
}

/**
 * Age-based mirror-robot token rotation predicate (console
 * `isMirrorTokenExpiring`): rotate when the credential's age in days is
 * STRICTLY past the threshold; a missing created time does not rotate.
 */
export function isMirrorTokenExpiring(
	createdTime: string | undefined,
	rotationThresholdDays: number,
	now: Date = new Date(),
): boolean {
	if (createdTime === undefined || createdTime === "") return false;
	const created = new Date(createdTime);
	if (Number.isNaN(created.getTime())) return false;
	return daysAgoFromNow(created, now) > rotationThresholdDays;
}

/** Mirror-robot access-token scopes (console `createMirrorAccessToken`). */
export const MIRROR_ROBOT_SCOPES: readonly string[] = [
	"write_repository",
	"read_repository",
	"read_api",
];

/** Mirror-robot group access token name (console: `<slug>-bot`). */
export const mirrorRobotTokenName = (projectSlug: string): string =>
	`${projectSlug}-bot`;

/** `YYYY-MM-DD`, `expirationDays` from now (console createProjectToken). */
export const mirrorTokenExpiryDate = (
	expirationDays: number,
	now: Date = new Date(),
): string =>
	new Date(now.getTime() + expirationDays * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10);

/** Mirror pipeline trigger variables (console `triggerMirror`). */
export interface MirrorTriggerVariables {
	readonly SYNC_ALL: string;
	readonly GIT_BRANCH_DEPLOY: string;
	readonly PROJECT_NAME: string;
}

/**
 * Derive the mirror pipeline trigger variables: `SYNC_ALL` is the boolean
 * stringified; `GIT_BRANCH_DEPLOY` is the branch, or EMPTY for a full
 * sync (the pipeline's expectation); `PROJECT_NAME` designates the target
 * repo. Special repo names (`mirror`, `infra-apps`) are refused — they are
 * the console's own plumbing, never a valid mirroring target.
 */
export function mirrorTriggerVariables(options: {
	projectSlug: string;
	targetRepo: string;
	syncAllBranches: boolean;
	branchName?: string | undefined;
}): MirrorTriggerVariables {
	if (SPECIAL_REPO_NAMES.includes(options.targetRepo)) {
		throw new Error(
			`User requested for invalid mirroring (${options.projectSlug}/${options.targetRepo})`,
		);
	}
	return {
		SYNC_ALL: options.syncAllBranches.toString(),
		GIT_BRANCH_DEPLOY: options.syncAllBranches
			? ""
			: (options.branchName ?? ""),
		PROJECT_NAME: options.targetRepo,
	};
}

/** Topics for a console-managed user repository. */
export const pluginManagedTopics = (
	extraTopics: readonly string[] = [],
): string[] => [TOPIC_PLUGIN_MANAGED, ...extraTopics];

/** Topics for a console-owned system repository (infra-apps, mirror, ...). */
export const systemManagedTopics = (): string[] => [
	TOPIC_PLUGIN_MANAGED,
	TOPIC_SYSTEM_MANAGED,
];

/** Whether a repo list/name carries the plugin-managed topic. */
export const isOwnedRepo = (topics: readonly string[]): boolean =>
	topics.includes(TOPIC_PLUGIN_MANAGED);

/** Whether a repo list/name carries the system-managed topic. */
export const isSystemRepo = (topics: readonly string[]): boolean =>
	topics.includes(TOPIC_SYSTEM_MANAGED);

/**
 * Group-bot users (`group_<id>_bot`) are GitLab-managed service accounts —
 * excluded from the orphan-member purge (console `isOwnedUser`).
 */
const ownedUserRegex = /group_\d+_bot/u;

export function isOwnedUser(username: string): boolean {
	return ownedUserRegex.test(username);
}

/** `{root}/{slug}` — the project subgroup full path. */
export const projectGroupFullPath = (
	rootGroupPath: string,
	projectSlug: string,
): string => `${rootGroupPath}/${projectSlug}`;

/**
 * Whether `member.level = HIGHEST across roleIds` resolves to removal:
 * NO_ACCESS(0) never comes out of {@link generateAccessLevelMapping}, so a
 * desired level of 0 means "remove the member" (console
 * `ensureGroupMemberAccessLevel`).
 */
export function shouldRemoveMember(desiredLevel: number): boolean {
	return desiredLevel === ACCESS_LEVEL_NO_ACCESS;
}
