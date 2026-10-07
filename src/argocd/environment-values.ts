import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import type { CommitAction } from "./git-client.ts";
import { ArgocdGitClient } from "./git-client.ts";
import {
	deleteCommitMessage,
	renderEnvironmentValues,
	syncCommitMessage,
	upsertAction,
	valuesFilePath,
} from "./values.ts";

export interface EnvironmentValuesProps {
	projectName: string;
	projectSlug: string;
	zoneSlug: string;
	clusterLabel: string;
	environmentName: string;
}

export interface EnvironmentValues
	extends Resource<
		"Cpn.Argocd.EnvironmentValues",
		EnvironmentValuesProps,
		{
			filePath: string;
			committed: boolean;
		}
	> {}

export const EnvironmentValues = Resource<EnvironmentValues>(
	"Cpn.Argocd.EnvironmentValues",
);

export const EnvironmentValuesProvider = Provider.effect(
	EnvironmentValues,
	Effect.gen(function* () {
		const git = yield* ArgocdGitClient;
		return {
			reconcile: Effect.fn(function* ({
				news,
			}: {
				news: EnvironmentValuesProps;
			}) {
				const filePath = valuesFilePath(
					news.projectName,
					news.clusterLabel,
					news.environmentName,
				);
				const content = renderEnvironmentValues(
					news.projectSlug,
					news.environmentName,
				);
				const existing = yield* git.readFile(news.zoneSlug, filePath);
				const action = upsertAction(existing, filePath, content);
				if (action === null) {
					return {
						filePath,
						committed: false,
					} satisfies EnvironmentValues["Attributes"];
				}
				yield* git.commit(news.zoneSlug, syncCommitMessage(news.projectSlug), [
					action,
				]);
				return {
					filePath,
					committed: true,
				} satisfies EnvironmentValues["Attributes"];
			}),

			delete: Effect.fn(function* ({ olds }: { olds: EnvironmentValuesProps }) {
				const filePath = valuesFilePath(
					olds.projectName,
					olds.clusterLabel,
					olds.environmentName,
				);
				const existing = yield* git.readFile(olds.zoneSlug, filePath);
				if (existing === undefined) return;
				const action: CommitAction = { action: "delete", filePath };
				yield* git.commit(
					olds.zoneSlug,
					deleteCommitMessage(olds.projectSlug),
					[action],
				);
			}),
		};
	}),
);
