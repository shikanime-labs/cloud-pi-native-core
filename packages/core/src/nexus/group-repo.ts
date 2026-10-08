import { Resource, type Resource as ResourceT } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { isNexusNotFound, NexusClient } from "./client.js";
import { groupRepoName } from "./roles.js";

export interface GroupRepoProps {
	readonly slug: string;
	/** Members of the group, in order. Maven release+snapshot first. */
	readonly members: ReadonlyArray<string>;
}

export type GroupRepo = ResourceT<
	"Cpn.Nexus.GroupRepo",
	GroupRepoProps,
	{
		readonly groupRepoName: string;
		readonly members: ReadonlyArray<string>;
	}
>;

export const GroupRepo = Resource<GroupRepo>("Cpn.Nexus.GroupRepo");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const parseMembers = (
	data: unknown,
	repoName: string,
): ReadonlyArray<string> => {
	if (
		!isRecord(data) ||
		!isRecord(data.group) ||
		!Array.isArray(data.group.memberNames)
	) {
		throw new Error(
			`nexus: group repo "${repoName}" is missing group.memberNames`,
		);
	}
	const members: string[] = [];
	for (const entry of data.group.memberNames) {
		if (typeof entry !== "string") {
			throw new Error(
				`nexus: group repo "${repoName}" memberNames contains a non-string`,
			);
		}
		members.push(entry);
	}
	return members;
};

const groupBody = (repoName: string, members: ReadonlyArray<string>) => ({
	name: repoName,
	online: true,
	storage: {
		blobStoreName: "default",
		strictContentTypeValidation: true,
	},
	group: { memberNames: members },
});

export const GroupRepoProvider = () =>
	Provider.effect(
		GroupRepo,
		Effect.gen(function* () {
			const nexus = yield* NexusClient;

			const getGroup = (repoName: string) =>
				nexus(`repositories/maven/group/${repoName}`).pipe(
					Effect.catchIf(isNexusNotFound, () => Effect.succeed(undefined)),
					Effect.map((data) =>
						data === undefined ? undefined : parseMembers(data, repoName),
					),
				);

			return {
				reconcile: Effect.fn("Cpn.Nexus.GroupRepo/reconcile")(function* ({
					news,
				}: {
					news: GroupRepoProps;
				}) {
					const name = groupRepoName(news.slug);

					// Observe
					const observed = yield* getGroup(name);

					// Ensure / sync — no `olds` consulted: observed state is truth.
					if (
						observed === undefined ||
						observed.length !== news.members.length ||
						observed.some((member, index) => member !== news.members[index])
					) {
						yield* nexus(
							observed === undefined
								? "repositories/maven/group"
								: `repositories/maven/group/${name}`,
							{
								method: observed === undefined ? "POST" : "PUT",
								body: groupBody(name, news.members),
							},
						);
					}

					return { groupRepoName: name, members: news.members };
				}),
				delete: Effect.fn("Cpn.Nexus.GroupRepo/delete")(function* ({
					olds,
				}: {
					olds: GroupRepoProps;
				}) {
					yield* nexus(`repositories/${groupRepoName(olds.slug)}`, {
						method: "DELETE",
					}).pipe(Effect.catchIf(isNexusNotFound, () => Effect.void));
				}),
			};
		}),
	);
