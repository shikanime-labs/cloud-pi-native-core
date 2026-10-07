import { createHmac } from "node:crypto";
import { stringify } from "yaml";
import type { CommitAction } from "./git-client.ts";

export const CONSOLE_ADMIN_GROUP_PATH = "/console/admin";
export const PLATFORM_ADMIN_GROUP_PATH = "/console/admin";
export const PLATFORM_READONLY_GROUP_PATH = "/console/readonly";
export const PLATFORM_SECURITY_GROUP_PATH = "/console/security";
export const PROJECT_ADMIN_GROUP_PATH_SUFFIX = "/console/admin";
export const PROJECT_DEVOPS_GROUP_PATH_SUFFIX = "/console/devops";
export const PROJECT_DEVELOPER_GROUP_PATH_SUFFIX = "/console/developer";
export const PROJECT_SECURITY_GROUP_PATH_SUFFIX = "/console/security";

const VALUES_FILE_NAME = "values.yaml";

export function valuesFilePath(
	projectName: string,
	clusterLabel: string,
	environmentName: string,
): string {
	return `${projectName}/${clusterLabel}/${environmentName}/${VALUES_FILE_NAME}`;
}

export function appProjectName(
	projectSlug: string,
	environmentName: string,
): string {
	const environmentHash = createHmac("sha256", "")
		.update(environmentName)
		.digest("hex")
		.slice(0, 4);
	return `${projectSlug}-${environmentName}-${environmentHash}`;
}

export interface GroupPaths {
	roGroup: string;
	rwGroup: string;
	consoleAdminGroup: string;
	platformAdminGroup: string;
	platformReadonlyGroup: string;
	platformSecurityGroup: string;
	projectAdminGroup: string;
	projectDevopsGroup: string;
	projectDevelopperGroup: string;
	projectSecurityGroup: string;
}

function environmentConsoleGroupPath(
	projectSlug: string,
	environmentName: string,
	access: "RO" | "RW",
): string {
	return `/${projectSlug}/console/${environmentName}/${access}`;
}

function projectConsoleGroupPath(projectSlug: string, suffix: string): string {
	return `/${projectSlug}${suffix}`;
}

export function groupPaths(
	projectSlug: string,
	environmentName: string,
): GroupPaths {
	return {
		roGroup: environmentConsoleGroupPath(projectSlug, environmentName, "RO"),
		rwGroup: environmentConsoleGroupPath(projectSlug, environmentName, "RW"),
		consoleAdminGroup: CONSOLE_ADMIN_GROUP_PATH,
		platformAdminGroup: PLATFORM_ADMIN_GROUP_PATH,
		platformReadonlyGroup: PLATFORM_READONLY_GROUP_PATH,
		platformSecurityGroup: PLATFORM_SECURITY_GROUP_PATH,
		projectAdminGroup: projectConsoleGroupPath(
			projectSlug,
			PROJECT_ADMIN_GROUP_PATH_SUFFIX,
		),
		projectDevopsGroup: projectConsoleGroupPath(
			projectSlug,
			PROJECT_DEVOPS_GROUP_PATH_SUFFIX,
		),
		projectDevelopperGroup: projectConsoleGroupPath(
			projectSlug,
			PROJECT_DEVELOPER_GROUP_PATH_SUFFIX,
		),
		projectSecurityGroup: projectConsoleGroupPath(
			projectSlug,
			PROJECT_SECURITY_GROUP_PATH_SUFFIX,
		),
	};
}

export interface EnvironmentValuesShape {
	argocd: {
		project: string;
	};
	environment: GroupPaths;
}

export function environmentValues(
	projectSlug: string,
	environmentName: string,
): EnvironmentValuesShape {
	return {
		argocd: {
			project: appProjectName(projectSlug, environmentName),
		},
		environment: groupPaths(projectSlug, environmentName),
	};
}

export function renderEnvironmentValues(
	projectSlug: string,
	environmentName: string,
): string {
	return stringify(environmentValues(projectSlug, environmentName));
}

export function projectPrefix(projectName: string): string {
	return `${projectName}/`;
}

export function syncCommitMessage(projectSlug: string): string {
	return `ci: :robot_face: Sync ${projectSlug}`;
}

export function deleteCommitMessage(projectSlug: string): string {
	return `ci: :robot_face: Delete ${projectSlug}`;
}

function isValuesFile(path: string, prefix: string): boolean {
	if (!path.startsWith(prefix)) return false;
	const segments = path.split("/");
	const fileName = segments[segments.length - 1];
	return fileName === VALUES_FILE_NAME;
}

export function purgeActions(
	existingPaths: string[],
	neededPaths: string[],
	projectName: string,
): CommitAction[] {
	const needed = new Set(neededPaths);
	const prefix = projectPrefix(projectName);
	return existingPaths
		.filter((path) => isValuesFile(path, prefix) && !needed.has(path))
		.map(
			(path) => ({ action: "delete", filePath: path }) satisfies CommitAction,
		);
}

export function sweepActions(
	existingPaths: string[],
	projectName: string,
): CommitAction[] {
	const prefix = projectPrefix(projectName);
	return existingPaths
		.filter((path) => isValuesFile(path, prefix))
		.map(
			(path) => ({ action: "delete", filePath: path }) satisfies CommitAction,
		);
}

export function upsertAction(
	existingContent: string | undefined,
	filePath: string,
	content: string,
): CommitAction | null {
	if (existingContent === content) return null;
	return {
		action: existingContent === undefined ? "create" : "update",
		filePath,
		content,
	};
}
