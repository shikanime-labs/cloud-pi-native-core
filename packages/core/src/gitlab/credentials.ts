import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Error raised by every GitLab HTTP operation. `status` is the HTTP status
 * code (0 for transport failures and configuration errors), so callers can
 * implement GitLab's 404-tolerant delete convention (`isNotFound`).
 */
export class GitlabError extends Data.TaggedError("GitlabError")<{
	readonly status: number;
	readonly method: string;
	readonly path: string;
	readonly message: string;
	readonly body: unknown;
}> {
	get isNotFound(): boolean {
		return this.status === 404;
	}
}

/** Narrow `error` to a 404 {@link GitlabError}. */
export const isNotFound = (error: unknown): boolean =>
	error instanceof GitlabError && error.isNotFound;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * GitLab reports entity collisions ("has already been taken" on groups,
 * projects and usernames; "already exists" variants) with a `message` field
 * that can be a string OR an object of per-field messages — key the check
 * off the serialized description, never off the status code alone.
 */
const descriptionOf = (body: unknown): string => {
	if (!isRecord(body)) return "";
	const message = body.message;
	if (typeof message === "string") return message;
	try {
		return JSON.stringify(message ?? "");
	} catch {
		return "";
	}
};

/**
 * Whether `error` signals an entity that already exists (race collision):
 * "has already been taken" / "already exists" message bodies. The console
 * tolerates these on every ensure-style writer and reloads instead of
 * failing; a 409 username-taken on user create is NORMAL.
 */
export const isAlreadyTaken = (error: unknown): boolean => {
	if (!(error instanceof GitlabError)) return false;
	const description = descriptionOf(error.body);
	return (
		description.includes("has already been taken") ||
		/already exists/i.test(description) ||
		description.includes("already marked for deletion")
	);
};

/** Resolved GitLab connection: instance URL and access token. */
export interface GitlabConnection {
	readonly url: string;
	readonly token: string;
}

/**
 * Credentials tag for GitLab. The service holds an *effect* so nothing is
 * resolved until the first API call — building provider layers never
 * requires a token (the lazy-Credentials pattern shared across services).
 */
export interface GitlabCredentialsService {
	readonly resolve: Effect.Effect<GitlabConnection, GitlabError>;
}

export class Credentials extends Context.Service<
	Credentials,
	GitlabCredentialsService
>()("Cpn.Gitlab.Credentials") {}

/** Static credentials: resolved once, then cached. */
export const credentialsStatic = (
	url: string,
	token: string,
): Layer.Layer<Credentials> =>
	Layer.effect(
		Credentials,
		Effect.map(Effect.cached(Effect.succeed({ url, token })), (resolve) => ({
			resolve,
		})),
	);

/** Dynamic credentials from any effect; resolved once, then cached. */
export const credentialsLayer = (
	resolve: Effect.Effect<GitlabConnection, GitlabError>,
): Layer.Layer<Credentials> =>
	Layer.effect(
		Credentials,
		Effect.map(Effect.cached(resolve), (cached) => ({ resolve: cached })),
	);

/**
 * Layer used when no credentials were provided — every resolve fails with
 * a descriptive {@link GitlabError} at first use, not at layer build.
 */
export const credentialsUnavailable: Layer.Layer<Credentials> = Layer.succeed(
	Credentials,
	{
		resolve: Effect.fail(
			new GitlabError({
				status: 0,
				method: "CONFIG",
				path: "Cpn.Gitlab.Credentials",
				message: "GitLab credentials not provided (pass a Credentials layer)",
				body: null,
			}),
		),
	},
);
