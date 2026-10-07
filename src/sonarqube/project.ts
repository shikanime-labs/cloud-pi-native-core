import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { SonarqubeClient } from "./client.ts";
import { isAlreadyExists, isNotFound } from "./credentials.ts";
import { ensureExists } from "./reconcile.ts";
import { MAIN_BRANCH, projectKey } from "./paths.ts";

/**
 * One SonarQube project per console repository, keyed
 * `<slug>-<repo>-<hmac4>` (console `generateProjectKey`). Create is
 * idempotent against 409/already-exists races; delete is 404-tolerant.
 *
 * Console semantics: name is `<slug>-<repo>`, main branch pinned to
 * `main`, visibility derived from cluster privacy (public cluster →
 * public, else private) — the console itself hardcodes `private`, the
 * prop generalizes it.
 */
export interface ProjectProps {
	/** Console project slug — the join key every service uses. */
	readonly slug: string;
	/** Repository `internalRepoName`. */
	readonly repository: string;
	/** Cluster privacy driving visibility; defaults to `dedicated`. */
	readonly clusterPrivacy?: "public" | "dedicated";
}

export interface SonarqubeProject
	extends Resource<
		"Cpn.Sonarqube.Project",
		ProjectProps,
		{
			readonly key: string;
			readonly name: string;
			readonly visibility: "public" | "private";
		}
	> {}

export const Project = Resource<SonarqubeProject>("Cpn.Sonarqube.Project");

export const ProjectProvider = () =>
	Provider.effect(
		Project,
		Effect.gen(function* () {
			const client = yield* SonarqubeClient;
			return Project.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Sonarqube.Project/read")(function* ({ olds }) {
					const key = projectKey(olds.slug, olds.repository);
					const found = yield* Effect.map(
						client.searchProjects(key),
						(projects) =>
							projects.find((project) => project.key === key) ?? undefined,
					);
					if (found === undefined) return undefined;
					return {
						key: found.key,
						name: found.name,
						visibility: found.visibility,
					};
				}),
				reconcile: Effect.fn("Cpn.Sonarqube.Project/reconcile")(function* ({
					news,
				}) {
					const key = projectKey(news.slug, news.repository);
					const name = `${news.slug}-${news.repository}`;
					const visibility =
						news.clusterPrivacy === "public" ? "public" : "private";
					yield* ensureExists({
						create: () =>
							client.createProject({
								project: key,
								name,
								visibility,
								mainBranch: MAIN_BRANCH,
							}).pipe(Effect.as(key)),
						reload: () =>
							Effect.map(
								client.searchProjects(key),
								(projects) =>
									projects.find((project) => project.key === key)?.key ??
									undefined,
							),
					});
					return { key, name, visibility };
				}),
				delete: Effect.fn("Cpn.Sonarqube.Project/delete")(function* ({ olds }) {
					const key = projectKey(olds.slug, olds.repository);
					yield* client.deleteProject(key).pipe(
						Effect.catchAll((error) =>
							isNotFound(error) ? Effect.void : Effect.fail(error),
						),
					);
				}),
			});
		}),
	);
