import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export type CommitAction =
	| { action: "create"; filePath: string; content: string }
	| { action: "update"; filePath: string; content: string }
	| { action: "delete"; filePath: string };

export class GitClientError extends Data.TaggedError("GitClientError")<{
	message: string;
}> {}

export interface GitClient {
	listTree(
		zoneSlug: string,
		path: string,
	): Effect.Effect<string[], GitClientError>;
	readFile(
		zoneSlug: string,
		path: string,
	): Effect.Effect<string | undefined, GitClientError>;
	commit(
		zoneSlug: string,
		message: string,
		actions: CommitAction[],
	): Effect.Effect<void, GitClientError>;
}

export const ArgocdGitClient = Context.Service<GitClient>("ArgocdGitClient");
