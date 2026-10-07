import type {
	SonarqubeClientService,
	SonarqubeGeneratedToken,
	SonarqubePermissionTemplate,
	SonarqubeUser,
} from "./client.ts";
import type { SonarqubeError } from "./credentials.ts";
import * as Effect from "effect/Effect";
import { isAlreadyExists, isNotFound } from "./credentials.ts";

/**
 * Runs an idempotent write: tries `create`, and on a SonarQube race
 * collision reloads via `reload` and returns the existing entity instead
 * of failing. Mirrors the console's `ensure` helper.
 */
export const ensureExists = <A, E>(params: {
	readonly create: () => Effect.Effect<A, E>;
	readonly reload: () => Effect.Effect<A | undefined, E>;
}): Effect.Effect<A | undefined, E> =>
	Effect.catchAll(params.create(), (error) =>
		Effect.gen(function* () {
			if (!isAlreadyExists(error)) return yield* Effect.fail(error);
			return yield* params.reload();
		}),
	);

/** 404-tolerant run: `undefined` when the entity is already gone. */
export const tolerate404 = <A, E>(
	effect: Effect.Effect<A, E>,
): Effect.Effect<A | undefined, E> =>
	Effect.catchAll(effect, (error) =>
		isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
	);

/** Find a user by exact login via `users/search?q=<login>` (search-by-login). */
export const findUserByLogin = (
	client: SonarqubeClientService,
	login: string,
): Effect.Effect<SonarqubeUser | undefined, SonarqubeError> =>
	Effect.map(
		client.searchUsers(login),
		(users) => users.find((user) => user.login === login) ?? undefined,
	);

/** Find a permission template by exact (case-insensitive) name. */
export const findTemplateByName = (
	client: SonarqubeClientService,
	name: string,
): Effect.Effect<SonarqubePermissionTemplate | undefined, SonarqubeError> =>
	Effect.map(
		client.searchPermissionTemplates(name),
		(templates) =>
			templates.find(
				(template) => template.name.toLowerCase() === name.toLowerCase(),
			) ?? undefined,
	);

/**
 * Rotate the CI token for a login: revoke the old token (any failure
 * tolerated — a missing token is not an error), then generate a fresh one.
 * Returns the plaintext token for storage in Vault.
 */
export const rotateToken = (
	client: SonarqubeClientService,
	login: string,
): Effect.Effect<SonarqubeGeneratedToken, SonarqubeError> =>
	Effect.gen(function* () {
		const name = `Sonar Token for ${login}`;
		yield* Effect.catchAll(
			client.revokeUserToken(login, name),
			() => Effect.void,
		);
		return yield* client.generateUserToken(login, name);
	});
