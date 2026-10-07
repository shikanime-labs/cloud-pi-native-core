import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { GitlabClient, type GitlabProject } from "./client.ts";
import { type GitlabError, isAlreadyTaken, isNotFound } from "./credentials.ts";
import {
	GITLAB_CI_CONFIG_PATH,
	MANAGED_BY_CONSOLE_CUSTOM_ATTRIBUTE_KEY,
	PROJECT_GROUP_CUSTOM_ATTRIBUTE_KEY,
	pluginManagedTopics,
	systemManagedTopics,
} from "./utils.ts";

/**
 * Cpn.Gitlab.Repository — one repository (project) inside a project
 * subgroup, including the system repositories `infra-apps` and `mirror`.
 *
 * Console semantics:
 * - user repos carry the `plugin-managed` topic; system repos
 *   (infra-apps, mirror, ...) additionally carry `system-managed` and are
 *   NEVER a valid mirroring target (SPECIAL_REPO_NAMES);
 * - a repo mirroring an external URL gets the custom CI config path
 *   `.gitlab-ci-dso.yml`, else the default (`ciConfigPath: ''`);
 * - repos are tagged `cpn_managed_by_console=true` and user repos
 *   `cpn_project_slug=<slug>`;
 * - a create that answers "already taken" is a race — reload and adopt;
 * - delete schedules + purges (`permanently_remove`), 404 and
 *   already-marked-for-deletion tolerated.
 */
export interface RepositoryProps {
	/** Project subgroup id — the repository's namespace. */
	readonly groupId: number;
	/** Full path `{root}/{slug}` — lookup and delete key. */
	readonly groupFullPath: string;
	/** Repository name (console internalRepoName). */
	readonly name: string;
	/**
	 * `user` repos are plugin-managed; `system` repos (infra-apps,
	 * mirror) are console plumbing — system-managed topic, never a mirror
	 * target.
	 */
	readonly kind: "user" | "system";
	/** External repo URL being mirrored — sets the mirror CI config path. */
	readonly externalRepoUrl?: string | undefined;
	readonly description?: string | undefined;
}

export interface RepositoryAttrs {
	readonly projectId: number;
	readonly path: string;
	readonly pathWithNamespace: string;
	readonly topics: readonly string[];
}

export interface Repository
	extends Resource<"Cpn.Gitlab.Repository", RepositoryProps, RepositoryAttrs> {}

export const Repository = Resource<Repository>("Cpn.Gitlab.Repository");

const repoTopics = (kind: RepositoryProps["kind"]): readonly string[] =>
	kind === "system" ? systemManagedTopics() : pluginManagedTopics();

const repoFullPath = (props: { groupFullPath: string; name: string }): string =>
	`${props.groupFullPath}/${props.name}`;

const ciConfigPathOf = (externalRepoUrl: string | undefined): string =>
	externalRepoUrl === undefined ? "" : GITLAB_CI_CONFIG_PATH;

/**
 * Slug segment of `{root}/{slug}` — the `cpn_project_slug` custom
 * attribute value.
 */
const repoProjectSlug = (groupFullPath: string): string => {
	const segment = groupFullPath.split("/").pop();
	if (segment === undefined || segment.length === 0) {
		throw new Error(
			`Repository group full path has no project segment: ${groupFullPath}`,
		);
	}
	return segment;
};

const findProject = (
	fullPath: string,
): Effect.Effect<GitlabProject | undefined, GitlabError, GitlabClient> =>
	Effect.gen(function* () {
		const client = yield* GitlabClient;
		const observed = yield* client.showProjectByPath(fullPath);
		if (observed !== undefined) return observed;
		// Fall back to undefined when the direct lookup 404s (GitLab's
		// URL-encoded path lookup can miss renamed projects).
		return undefined;
	});

export const RepositoryProvider = () =>
	Provider.effect(
		Repository,
		Effect.gen(function* () {
			return Repository.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Gitlab.Repository/read")(function* ({ olds }) {
					const observed = yield* findProject(repoFullPath(olds));
					if (observed === undefined) return undefined;
					return {
						projectId: observed.id,
						path: observed.path,
						pathWithNamespace: observed.pathWithNamespace,
						topics: observed.topics,
					};
				}),
				reconcile: Effect.fn("Cpn.Gitlab.Repository/reconcile")(function* ({
					news,
				}) {
					const client = yield* GitlabClient;
					const fullPath = repoFullPath(news);
					// Observe.
					let observed = yield* findProject(fullPath);
					// Ensure — create when missing; "already taken" = race,
					// reload and adopt.
					if (observed === undefined) {
						observed = yield* client
							.createProject(news.groupId, news.name, {
								ciConfigPath:
									news.externalRepoUrl === undefined
										? undefined
										: GITLAB_CI_CONFIG_PATH,
							})
							.pipe(
								Effect.catchIf(isAlreadyTaken, () =>
									Effect.gen(function* () {
										const raced = yield* findProject(fullPath);
										if (raced === undefined) {
											return yield* Effect.fail(
												new Error(
													`GitLab project not found after create race: ${fullPath}`,
												),
											);
										}
										return raced;
									}),
								),
							);
					}
					// Sync — converge name/path/topics/description/ciConfigPath.
					const updated = yield* client.editProject(observed.id, {
						name: news.name,
						path: news.name,
						topics: [...repoTopics(news.kind)],
						description: news.description,
						ciConfigPath: ciConfigPathOf(news.externalRepoUrl),
					});
					// Sync — ownership custom attributes.
					yield* client.upsertProjectCustomAttribute(
						updated.id,
						MANAGED_BY_CONSOLE_CUSTOM_ATTRIBUTE_KEY,
						"true",
					);
					if (news.kind === "user") {
						yield* client.upsertProjectCustomAttribute(
							updated.id,
							PROJECT_GROUP_CUSTOM_ATTRIBUTE_KEY,
							repoProjectSlug(news.groupFullPath),
						);
					}
					return {
						projectId: updated.id,
						path: updated.path,
						pathWithNamespace: updated.pathWithNamespace,
						topics: updated.topics,
					};
				}),
				delete: Effect.fn("Cpn.Gitlab.Repository/delete")(function* ({
					olds,
					output,
				}) {
					const client = yield* GitlabClient;
					const fullPath = output?.pathWithNamespace ?? repoFullPath(olds);
					const observed = yield* findProject(fullPath);
					if (observed === undefined) return;
					yield* client.deleteProject(observed.id, fullPath).pipe(
						Effect.catchIf(
							(error) => isNotFound(error) || isAlreadyTaken(error),
							() => Effect.void,
						),
					);
				}),
			});
		}),
	);
