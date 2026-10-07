import { Resource, type Resource as ResourceT } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import {
	isNexusNotFound,
	NexusClient,
	type NexusMavenHostedRepository,
} from "./client.js";
import {
	MAVEN_RELEASE_WRITE_POLICY,
	MAVEN_SNAPSHOT_WRITE_POLICY,
	type MavenRepoKind,
	mavenHostedRepoName,
} from "./roles.js";

export interface MavenReposProps {
	readonly slug: string;
}

export type MavenRepos = ResourceT<
	"Cpn.Nexus.MavenRepos",
	MavenReposProps,
	{
		readonly releaseRepoName: string;
		readonly snapshotRepoName: string;
	}
>;

export const MavenRepos = Resource<MavenRepos>("Cpn.Nexus.MavenRepos");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const expectString = (value: unknown, where: string): string => {
	if (typeof value !== "string") {
		throw new Error(`nexus: ${where} is not a string`);
	}
	return value;
};

const expectBoolean = (value: unknown, where: string): boolean => {
	if (typeof value !== "boolean") {
		throw new Error(`nexus: ${where} is not a boolean`);
	}
	return value;
};

/** Parse, don't validate: turn the JSON body into the precise repo shape. */
export const parseMavenHosted = (
	data: unknown,
	repoName: string,
): NexusMavenHostedRepository => {
	if (!isRecord(data)) {
		throw new Error(
			`nexus: maven hosted repo "${repoName}" response is not an object`,
		);
	}
	const storage = data.storage;
	const component = data.component;
	const maven = data.maven;
	if (!isRecord(storage) || !isRecord(component) || !isRecord(maven)) {
		throw new Error(
			`nexus: maven hosted repo "${repoName}" is missing storage/component/maven`,
		);
	}
	return {
		name: expectString(data.name, `maven hosted repo "${repoName}" name`),
		online: expectBoolean(
			data.online,
			`maven hosted repo "${repoName}" online`,
		),
		storage: {
			blobStoreName: expectString(
				storage.blobStoreName,
				`maven hosted repo "${repoName}" blobStoreName`,
			),
			strictContentTypeValidation: expectBoolean(
				storage.strictContentTypeValidation,
				`maven hosted repo "${repoName}" strictContentTypeValidation`,
			),
			writePolicy: expectString(
				storage.writePolicy,
				`maven hosted repo "${repoName}" writePolicy`,
			),
		},
		component: {
			proprietaryComponents: expectBoolean(
				component.proprietaryComponents,
				`maven hosted repo "${repoName}" proprietaryComponents`,
			),
		},
		maven: {
			versionPolicy: expectString(
				maven.versionPolicy,
				`maven hosted repo "${repoName}" versionPolicy`,
			),
			layoutPolicy: expectString(
				maven.layoutPolicy,
				`maven hosted repo "${repoName}" layoutPolicy`,
			),
			contentDisposition: expectString(
				maven.contentDisposition,
				`maven hosted repo "${repoName}" contentDisposition`,
			),
		},
	};
};

const hostedBody = (repoName: string, writePolicy: string) => ({
	name: repoName,
	online: true,
	storage: {
		blobStoreName: "default",
		strictContentTypeValidation: true,
		writePolicy,
	},
	component: { proprietaryComponents: true },
	maven: {
		versionPolicy: "MIXED",
		layoutPolicy: "STRICT",
		contentDisposition: "ATTACHMENT",
	},
});

const needsUpdate = (
	observed: NexusMavenHostedRepository,
	writePolicy: string,
): boolean =>
	!observed.online ||
	observed.storage.writePolicy !== writePolicy ||
	observed.storage.blobStoreName !== "default" ||
	!observed.storage.strictContentTypeValidation;

export const MavenReposProvider = () =>
	Provider.effect(
		MavenRepos,
		Effect.gen(function* () {
			const nexus = yield* NexusClient;

			const getHosted = (repoName: string) =>
				nexus(`repositories/maven/hosted/${repoName}`).pipe(
					Effect.catchIf(isNexusNotFound, () => Effect.succeed(undefined)),
					Effect.map((data) =>
						data === undefined ? undefined : parseMavenHosted(data, repoName),
					),
				);

			const upsertHosted = (
				_kind: MavenRepoKind,
				repoName: string,
				writePolicy: string,
				observed: NexusMavenHostedRepository | undefined,
			) =>
				observed === undefined
					? nexus("repositories/maven/hosted", {
							method: "POST",
							body: hostedBody(repoName, writePolicy),
						})
					: needsUpdate(observed, writePolicy)
						? nexus(`repositories/maven/hosted/${repoName}`, {
								method: "PUT",
								body: hostedBody(repoName, writePolicy),
							})
						: Effect.void;

			return {
				reconcile: Effect.fn("Cpn.Nexus.MavenRepos/reconcile")(function* ({
					news,
				}: {
					news: MavenReposProps;
				}) {
					const slug = news.slug;
					const release = mavenHostedRepoName(slug, "release");
					const snapshot = mavenHostedRepoName(slug, "snapshot");

					// Observe → ensure → sync; converges from any starting point.
					yield* upsertHosted(
						"release",
						release,
						MAVEN_RELEASE_WRITE_POLICY,
						yield* getHosted(release),
					);
					yield* upsertHosted(
						"snapshot",
						snapshot,
						MAVEN_SNAPSHOT_WRITE_POLICY,
						yield* getHosted(snapshot),
					);

					return { releaseRepoName: release, snapshotRepoName: snapshot };
				}),
				delete: Effect.fn("Cpn.Nexus.MavenRepos/delete")(function* ({
					olds,
				}: {
					olds: MavenReposProps;
				}) {
					for (const kind of ["release", "snapshot"] as const) {
						yield* nexus(
							`repositories/${mavenHostedRepoName(olds.slug, kind)}`,
							{
								method: "DELETE",
							},
						).pipe(Effect.catchIf(isNexusNotFound, () => Effect.void));
					}
				}),
			};
		}),
	);
