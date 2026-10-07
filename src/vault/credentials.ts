import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Error raised by every Vault HTTP operation. `status` is the HTTP status
 * code (0 for transport failures and configuration errors), so callers can
 * implement Vault's 404-tolerant delete convention (`isNotFound`).
 */
export class VaultError extends Data.TaggedError("VaultError")<{
	readonly status: number;
	readonly method: string;
	readonly path: string;
	readonly message: string;
}> {
	get isNotFound(): boolean {
		return this.status === 404;
	}
}

/** Narrow `error` to a 404 {@link VaultError}. */
export const isNotFound = (error: unknown): boolean =>
	error instanceof VaultError && error.isNotFound;

/** Resolved Vault connection: address and token. */
export interface VaultConnection {
	readonly url: string;
	readonly token: string;
}

/**
 * Credentials tag for Vault. The service holds an *effect* so nothing is
 * resolved until the first API call — building provider layers never
 * requires a token (the lazy-Credentials pattern shared across services).
 */
export interface VaultCredentialsService {
	readonly resolve: Effect.Effect<VaultConnection, VaultError>;
}

export class Credentials extends Context.Tag("Cpn.Vault.Credentials")<
	Credentials,
	VaultCredentialsService
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
	resolve: Effect.Effect<VaultConnection, VaultError>,
): Layer.Layer<Credentials> =>
	Layer.effect(
		Credentials,
		Effect.map(Effect.cached(resolve), (cached) => ({ resolve: cached })),
	);

/**
 * Layer used when no credentials were provided — every resolve fails with
 * a descriptive {@link VaultError} at first use, not at layer build.
 */
export const credentialsUnavailable: Layer.Layer<Credentials> = Layer.succeed(
	Credentials,
	{
		resolve: Effect.fail(
			new VaultError({
				status: 0,
				method: "CONFIG",
				path: "Cpn.Vault.Credentials",
				message: "Vault credentials not provided (pass a Credentials layer)",
			}),
		),
	},
);
