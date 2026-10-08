// Harbor role identifiers.
export const HARBOR_ROLE_PROJECT_ADMIN = 1;
export const HARBOR_ROLE_DEVELOPER = 2;
export const HARBOR_ROLE_GUEST = 3;
export const HARBOR_ROLE_MAINTAINER = 4;
export const HARBOR_ROLE_LIMITED_GUEST = 5;

/**
 * Console group paths that map onto Harbor project roles. Defaults mirror
 * the console's registry plugin; every path is overridable per resource.
 */
export interface GroupPaths {
	/** Project-scoped `/{slug}/console/admin` — maps to DEVELOPER (2), NOT PROJECT_ADMIN. */
	readonly admin: readonly string[];
	/** Project-scoped `/{slug}/console/devops` — collapses to GUEST (3). */
	readonly maintainer: readonly string[];
	/** Project-scoped `/{slug}/console/developer` — collapses to GUEST (3). */
	readonly developer: readonly string[];
	/** Project-scoped `/{slug}/console/security,/console/readonly` — GUEST (3). */
	readonly guest: readonly string[];
	/** Platform `/console/admin` — the ONLY path that gets PROJECT_ADMIN (1). */
	readonly platformAdmin: readonly string[];
	/** Platform `/console/security,/console/readonly` — collapses to GUEST (3). */
	readonly platformGuest: readonly string[];
}

export const defaultGroupPaths = (projectSlug: string): GroupPaths => ({
	admin: [`/${projectSlug}/console/admin`],
	maintainer: [`/${projectSlug}/console/devops`],
	developer: [`/${projectSlug}/console/developer`],
	guest: [
		`/${projectSlug}/console/security`,
		`/${projectSlug}/console/readonly`,
	],
	platformAdmin: ["/console/admin"],
	platformGuest: ["/console/security", "/console/readonly"],
});

/**
 * The console's group→role mapping, quirk included: project admin groups
 * land on DEVELOPER, never PROJECT_ADMIN; only platform /console/admin is
 * PROJECT_ADMIN; guest/developer/maintainer/platform-guest all collapse to
 * GUEST. Later entries win on duplicate group paths, matching the console's
 * sequential overwrite.
 */
export function harborRoleByGroup(paths: GroupPaths): Map<string, number> {
	const byGroup = new Map<string, number>();
	for (const group of paths.guest) byGroup.set(group, HARBOR_ROLE_GUEST);
	for (const group of paths.developer) byGroup.set(group, HARBOR_ROLE_GUEST);
	for (const group of paths.maintainer) byGroup.set(group, HARBOR_ROLE_GUEST);
	for (const group of paths.admin) byGroup.set(group, HARBOR_ROLE_DEVELOPER);
	for (const group of paths.platformAdmin)
		byGroup.set(group, HARBOR_ROLE_PROJECT_ADMIN);
	for (const group of paths.platformGuest)
		byGroup.set(group, HARBOR_ROLE_GUEST);
	return byGroup;
}

// Robot name identifiers, matching the console's registry plugin.
export const ROBOT_NAME_RO = "ro-robot";
export const ROBOT_NAME_RW = "rw-robot";
export const ROBOT_NAME_PROJECT = "project-robot";

/** Robot kinds this library provisions: `ro`/`rw` always, `project` opt-in. */
export type RobotKind = "ro" | "rw" | "project";

/**
 * Read-only robot access — pull + artifact read.
 */
export const roAccess: ReadonlyArray<{ resource: string; action: string }> = [
	{ resource: "repository", action: "pull" },
	{ resource: "artifact", action: "read" },
];

/**
 * Read-write robot access — ro plus push, tag/label management, scans.
 */
export const rwAccess: ReadonlyArray<{ resource: string; action: string }> = [
	...roAccess,
	{ resource: "repository", action: "list" },
	{ resource: "tag", action: "list" },
	{ resource: "artifact", action: "list" },
	{ resource: "scan", action: "create" },
	{ resource: "scan", action: "stop" },
	{ resource: "repository", action: "push" },
	{ resource: "artifact-label", action: "create" },
	{ resource: "artifact-label", action: "delete" },
	{ resource: "tag", action: "create" },
	{ resource: "tag", action: "delete" },
];

/**
 * Harbor prefixes every project-level robot name with
 * `robot$<project>+` — the full login username.
 */
export function robotFullName(projectSlug: string, robotName: string): string {
	return `robot$${projectSlug}+${robotName}`;
}

/** Console robot name for each kind. */
export const kindName = (kind: RobotKind): string => {
	if (kind === "ro") return ROBOT_NAME_RO;
	if (kind === "rw") return ROBOT_NAME_RW;
	return ROBOT_NAME_PROJECT;
};

/** Access set for each kind — the project robot is read-only. */
export const kindAccess = (kind: RobotKind) =>
	kind === "rw" ? rwAccess : roAccess;
