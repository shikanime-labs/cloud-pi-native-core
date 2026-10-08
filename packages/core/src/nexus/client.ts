import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * A failed Nexus REST call. `status` is the HTTP status code when the server
 * answered, `undefined` for transport failures.
 */
export class NexusError extends Data.TaggedError("NexusError")<{
	readonly message: string;
	readonly status?: number;
	readonly method?: string;
	readonly path?: string;
}> {
	constructor(
		message: string,
		details: { status?: number; method?: string; path?: string } = {},
	) {
		super({ message, ...details });
	}
}

/** True when `error` is a Nexus 404 — safe to treat as "already gone". */
export const isNexusNotFound = (error: unknown): boolean =>
	error instanceof NexusError && error.status === 404;

/**
 * True when `error` signals an entity already existing (race collision):
 * a 409 conflict, or a 4xx whose message mentions "already"/"exists"
 * (Nexus reports some collisions as a generic Bad Request).
 */
export const isNexusAlreadyExists = (error: unknown): boolean => {
	if (!(error instanceof NexusError)) return false;
	if (error.status === 409) return true;
	return (
		error.status !== undefined &&
		error.status >= 400 &&
		error.status < 500 &&
		/already|exists/i.test(error.message)
	);
};

/**
 * Idempotent write: try `create`, and on a Nexus race collision reload via
 * `reload` instead of failing. If the reload finds nothing, the original
 * error is rethrown so genuine failures are not swallowed.
 */
export const ensureNexus = <T>(create: {
	create: () => Effect.Effect<T, NexusError>;
	reload: () => Effect.Effect<T | undefined, NexusError>;
}): Effect.Effect<T, NexusError> =>
	create
		.create()
		.pipe(
			Effect.catchIf(isNexusAlreadyExists, () =>
				create
					.reload()
					.pipe(
						Effect.flatMap((existing) =>
							existing === undefined
								? create.create()
								: Effect.succeed(existing),
						),
					),
			),
		);

export interface NexusRepositoryStorage {
	readonly blobStoreName: string;
	readonly strictContentTypeValidation: boolean;
	readonly writePolicy?: string;
}

export interface NexusRepositoryComponent {
	readonly proprietaryComponents: boolean;
}

export interface NexusRepositoryGroup {
	readonly memberNames: string[];
}

export interface NexusMavenHostedRepository {
	readonly name: string;
	readonly online: boolean;
	readonly storage: NexusRepositoryStorage & { readonly writePolicy: string };
	readonly component: NexusRepositoryComponent;
	readonly maven: {
		readonly versionPolicy: string;
		readonly layoutPolicy: string;
		readonly contentDisposition: string;
	};
}

export interface NexusMavenGroupRepository {
	readonly name: string;
	readonly online: boolean;
	readonly storage: NexusRepositoryStorage;
	readonly group: NexusRepositoryGroup;
}

export interface NexusNpmHostedRepository {
	readonly name: string;
	readonly online: boolean;
	readonly storage: NexusRepositoryStorage & { readonly writePolicy: string };
	readonly component: NexusRepositoryComponent;
}

export interface NexusNpmGroupRepository {
	readonly name: string;
	readonly online: boolean;
	readonly storage: NexusRepositoryStorage;
	readonly group: NexusRepositoryGroup;
}

export interface NexusRole {
	readonly id: string;
	readonly name: string;
	readonly privileges: ReadonlyArray<string>;
	readonly description?: string;
}

export interface NexusUser {
	readonly userId: string;
	readonly firstName: string;
	readonly lastName: string;
	readonly emailAddress: string;
	readonly password: string;
	readonly status: string;
	readonly roles: ReadonlyArray<string>;
}

export interface NexusConfig {
	readonly url: string;
	readonly token: string;
}

/**
 * Nexus client service tag — the service IS the request function. The
 * binding is effectful: url/token are resolved lazily on first use so
 * building provider layers never requires credentials.
 */
export type NexusClientService = (
	path: string,
	options?: { method?: string; body?: unknown },
) => Effect.Effect<unknown, NexusError>;

export const NexusClient = Context.Service<NexusClientService>("NexusClient");

/** Live client: resolves url/token at first call, not at layer construction. */
export const NexusClientLive = (
	config: () => Effect.Effect<NexusConfig>,
): NexusClientService => {
	let cached: { baseUrl: string; authorization: string } | undefined;
	const resolve = (): Effect.Effect<
		{ baseUrl: string; authorization: string },
		NexusError
	> => {
		if (cached !== undefined) return Effect.succeed(cached);
		return config().pipe(
			Effect.map((c) => {
				cached = {
					baseUrl: c.url.endsWith("/") ? c.url : `${c.url}/`,
					authorization: `Bearer ${c.token}`,
				};
				return cached;
			}),
		);
	};

	return (path, options): Effect.Effect<unknown, NexusError> =>
		Effect.gen(function* () {
			const { baseUrl, authorization } = yield* resolve();
			const method = options?.method ?? "GET";
			const url = new URL(path, baseUrl).toString();
			const headers: Record<string, string> = { authorization };
			let body: string | undefined;
			if (options?.body !== undefined) {
				headers["content-type"] = "application/json";
				body = JSON.stringify(options.body);
			}
			const response = yield* Effect.tryPromise({
				try: (signal) => fetch(url, { method, headers, body, signal }),
				catch: () =>
					new NexusError(`nexus: ${method} ${path} failed`, {
						method,
						path,
					}),
			});
			if (response.status === 204) return null;
			if (!response.ok) {
				const text = yield* Effect.promise(() =>
					response.text().catch(() => undefined),
				);
				yield* new NexusError(
					`nexus: ${method} ${path} responded ${response.status}${text === undefined ? "" : `: ${text}`}`,
					{ status: response.status, method, path },
				);
			}
			return yield* Effect.tryPromise({
				try: () => response.json(),
				catch: () =>
					new NexusError(`nexus: ${method} ${path} returned invalid JSON`, {
						method,
						path,
					}),
			});
		});
};
