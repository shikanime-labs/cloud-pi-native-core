import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { NexusClient, NexusClientLive, type NexusConfig } from "./client.js";
import { GroupRepoProvider } from "./group-repo.js";
import { MavenReposProvider } from "./maven-repos.js";
import { PlatformRolesProvider } from "./platform-roles.js";
import { ProjectRolesProvider } from "./project-roles.js";

export {
	ensureNexus,
	isNexusAlreadyExists,
	isNexusNotFound,
	NexusClient,
	NexusClientLive,
	type NexusClientService,
	type NexusConfig,
	NexusError,
} from "./client.js";
export {
	GroupRepo,
	type GroupRepo as GroupRepoType,
	type GroupRepoProps,
	GroupRepoProvider,
} from "./group-repo.js";
export {
	MavenRepos,
	type MavenRepos as MavenReposType,
	type MavenReposProps,
	MavenReposProvider,
} from "./maven-repos.js";
export {
	PlatformRoles,
	type PlatformRoles as PlatformRolesType,
	type PlatformRolesProps,
	PlatformRolesProvider,
} from "./platform-roles.js";
export {
	ProjectRoles,
	type ProjectRoles as ProjectRolesType,
	type ProjectRolesProps,
	ProjectRolesProvider,
} from "./project-roles.js";
export * from "./roles.js";

/**
 * Nexus providers. `config` resolves url/token lazily on the first client
 * call — building the layer never requires credentials. Include from a
 * stack: `{ providers: Nexus.providers(() => Effect.succeed({ url, token })) }`.
 */
export const providers = (config: () => Effect.Effect<NexusConfig>) =>
	Layer.mergeAll(
		GroupRepoProvider(),
		MavenReposProvider(),
		PlatformRolesProvider(),
		ProjectRolesProvider(),
	).pipe(
		Layer.provide(
			Layer.effect(NexusClient, Effect.succeed(NexusClientLive(config))),
		),
	);
