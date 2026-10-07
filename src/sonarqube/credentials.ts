import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Error raised by every SonarQube web API operation. `status` is the HTTP
 * status code (0 for transport/configuration failures), so callers can
 * implement the 404-tolerant delete convention (`isNotFound`).
 */
export class SonarqubeError extends Data.TaggedError("SonarqubeError")<{
	readonly status: number;
	readonly method: string;
	readonly path: string;
	readonly message: string;
}> {
	get isNotFound(): boolean {
		return this.status === 404;
	}

	/**
	 * Whether the error signals an entity already existing (race
	 * collision): a 409, or a 4xx whose message mentions
	 * "already"/"exists" — SonarQube reports some collisions as a
	 * generic Bad Request. Mirrors the console's
	 * `isSonarqubeAlreadyExists`.
	 */
	get isAlreadyExists(): boolean {
		if (this.status === 409) return true;
		return (
			this.status >= 400 &&
			this.status < 500 &&
			/already|exists/i.test(this.message)
		);
	}
}

/** Narrow `error` to a 404 {@link SonarqubeError}. */
export const isNotFound = (error: unknown): boolean =>
	error instanceof SonarqubeError && error.isNotFound;

/** Narrow `error` to an already-exists {@link SonarqubeError}. */
export const isAlreadyExists = (error: unknown): boolean =>
	error instanceof SonarqubeError && error.isAlreadyExists;

/** Resolved SonarQube connection: base URL and API token. */
export interface SonarqubeConnection {
	readonly url: string;
	readonly token: string;
}

/**
 * Credentials tag for SonarQube. The service holds an *effect* so nothing
 * is resolved until the first API call — building provider layers never
 * requires a token (the lazy-Credentials pattern shared across services).
 */
export interface SonarqubeCredentialsService {
	readonly resolve: Effect.Effect<SonarqubeConnection, SonarqubeError>;
}

export class Credentials extends Context.Tag("Cpn.Sonarqube.Credentials")<
	Credentials,
	SonarqubeCredentialsService
>() {}

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
	resolve: Effect.Effect<SonarqubeConnection, SonarqubeError>,
): Layer.Layer<Credentials> =>
	Layer.effect(
		Credentials,
		Effect.map(Effect.cached(resolve), (cached) => ({ resolve: cached })),
	);

/**
 * Layer used when no credentials were provided — every resolve fails with
 * a descriptive {@link SonarqubeError} at first use, not at layer build.
 */
export const credentialsUnavailable: Layer.Layer<Credentials> = Layer.succeed(
	Credentials,
	{
		resolve: Effect.fail(
			new SonarqubeError({
				status: 0,
				method: "CONFIG",
				path: "Cpn.Sonarqube.Credentials",
				message:
					"SonarQube credentials not provided (pass a Credentials layer)",
			}),
		),
	},
);
