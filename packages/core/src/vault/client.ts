import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
	Credentials,
	isNotFound,
	type VaultConnection,
	VaultError,
} from "./credentials.ts";

// ---- wire types (only fields the resources rely on) ----

/** One `sys/mounts` entry; Vault adds engine-specific keys we ignore. */
export interface VaultSysMount {
	readonly type: string;
	readonly description?: string | undefined;
	readonly options?: Readonly<Record<string, string>> | undefined;
}

export interface VaultSysMountCreateRequest {
	readonly type: "kv";
	readonly config: { readonly force_no_cache: boolean };
	readonly options: { readonly version: number };
}

export interface VaultSysMountTuneRequest {
	readonly options: { readonly version: number };
}

export interface VaultAuthMethod {
	readonly accessor: string;
	readonly type: string;
}

export interface VaultAppRoleUpsertRequest {
	readonly token_type: "batch";
	readonly token_ttl: "0";
	readonly token_max_ttl: "0";
	readonly token_num_uses: "0";
	readonly secret_id_ttl: "0";
	readonly secret_id_num_uses: "0";
	readonly token_policies: readonly string[];
}

export interface VaultIdentityGroup {
	readonly id: string;
	readonly name: string;
	readonly alias?: { readonly name?: string | undefined } | undefined;
}

export interface VaultIdentityGroupUpsertRequest {
	readonly name: string;
	readonly type: "external";
	readonly policies: readonly string[];
}

export interface VaultIdentityGroupAliasCreateRequest {
	readonly name: string;
	readonly mount_accessor: string;
	readonly canonical_id: string;
}

// ---- response schemas (runtime parsing boundary: parse, don't validate) ----

const sysMountsResponse = Schema.Struct({
	data: Schema.Record(Schema.String, Schema.Unknown),
});

const sysAuthResponse = Schema.Struct({
	data: Schema.Record(Schema.String, Schema.Unknown),
});

const identityGroupResponse = Schema.Struct({
	data: Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		alias: Schema.optional(
			Schema.Struct({ name: Schema.optional(Schema.String) }),
		),
	}),
});

const policyResponse = Schema.Struct({
	data: Schema.Struct({ policy: Schema.String }),
});

const kvReadResponse = Schema.Struct({
	data: Schema.Struct({
		data: Schema.Record(Schema.String, Schema.String),
	}),
});

/** Parse an unknown body, throwing a descriptive {@link VaultError} on mismatch. */
const parse = <S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	body: unknown,
	ctx: { method: string; path: string },
): S["Type"] => {
	try {
		return Schema.decodeUnknownSync(schema)(body);
	} catch (error) {
		throw new VaultError({
			status: 0,
			method: ctx.method,
			path: ctx.path,
			message: `Unexpected Vault response shape: ${String(error).slice(0, 200)}`,
		});
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/** Narrow a `sys/mounts` entry to {@link VaultSysMount} with named errors. */
const toSysMount = (entry: unknown): VaultSysMount => {
	if (!isRecord(entry)) {
		throw new VaultError({
			status: 0,
			method: "GET",
			path: "sys/mounts",
			message: `mount entry '${String(entry)}' is not an object`,
		});
	}
	const type = entry.type;
	if (typeof type !== "string") {
		throw new VaultError({
			status: 0,
			method: "GET",
			path: "sys/mounts",
			message: "mount entry 'type' is not a string",
		});
	}
	const description = entry.description;
	const options = entry.options;
	return {
		type,
		description: typeof description === "string" ? description : undefined,
		options: isRecord(options)
			? Object.fromEntries(
					Object.entries(options).flatMap(([k, v]) =>
						typeof v === "string" ? [[k, v] as const] : [],
					),
				)
			: undefined,
	};
};

/** Narrow a `sys/auth` entry to {@link VaultAuthMethod} with named errors. */
const toAuthMethod = (entry: unknown): VaultAuthMethod => {
	if (!isRecord(entry)) {
		throw new VaultError({
			status: 0,
			method: "GET",
			path: "sys/auth",
			message: `auth entry '${String(entry)}' is not an object`,
		});
	}
	const accessor = entry.accessor;
	const type = entry.type;
	if (typeof accessor !== "string" || typeof type !== "string") {
		throw new VaultError({
			status: 0,
			method: "GET",
			path: "sys/auth",
			message: "auth entry 'accessor'/'type' is not a string",
		});
	}
	return { accessor, type };
};

/**
 * Minimal Vault HTTP client over `/v1/*`: the sys/mount, ACL policy,
 * AppRole, identity group, and KV-secret operations the resources need.
 * All failures are {@link VaultError} carrying the HTTP status.
 */
export interface VaultClientService {
	readonly listSysMounts: () => Effect.Effect<
		Readonly<Record<string, VaultSysMount>>,
		VaultError
	>;
	readonly createSysMount: (
		name: string,
		body: VaultSysMountCreateRequest,
	) => Effect.Effect<void, VaultError>;
	readonly tuneSysMount: (
		name: string,
		body: VaultSysMountTuneRequest,
	) => Effect.Effect<void, VaultError>;
	readonly deleteSysMount: (name: string) => Effect.Effect<void, VaultError>;
	readonly readSysPolicyAcl: (
		name: string,
	) => Effect.Effect<string | undefined, VaultError>;
	readonly upsertSysPolicyAcl: (
		name: string,
		policy: string,
	) => Effect.Effect<void, VaultError>;
	readonly deleteSysPolicyAcl: (
		name: string,
	) => Effect.Effect<void, VaultError>;
	readonly upsertAuthApproleRole: (
		name: string,
		body: VaultAppRoleUpsertRequest,
	) => Effect.Effect<void, VaultError>;
	readonly deleteAuthApproleRole: (
		name: string,
	) => Effect.Effect<void, VaultError>;
	readonly listSysAuth: () => Effect.Effect<
		Readonly<Record<string, VaultAuthMethod>>,
		VaultError
	>;
	readonly readIdentityGroupByName: (
		name: string,
	) => Effect.Effect<VaultIdentityGroup | undefined, VaultError>;
	readonly upsertIdentityGroup: (
		body: VaultIdentityGroupUpsertRequest,
	) => Effect.Effect<void, VaultError>;
	readonly deleteIdentityGroupByName: (
		name: string,
	) => Effect.Effect<void, VaultError>;
	readonly createIdentityGroupAlias: (
		body: VaultIdentityGroupAliasCreateRequest,
	) => Effect.Effect<void, VaultError>;
	readonly writeKvSecret: (
		mount: string,
		path: string,
		data: Readonly<Record<string, string>>,
	) => Effect.Effect<void, VaultError>;
	readonly readKvSecret: (
		mount: string,
		path: string,
	) => Effect.Effect<Readonly<Record<string, string>> | undefined, VaultError>;
	readonly deleteKvSecret: (
		mount: string,
		path: string,
	) => Effect.Effect<void, VaultError>;
}

export class VaultClient extends Context.Service<
	VaultClient,
	VaultClientService
>()("Cpn.Vault.VaultClient") {}

/** `Effect.tryPromise` mapping any throw onto a {@link VaultError}. */
const tryPromise = <A>(
	method: string,
	path: string,
	fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, VaultError> =>
	Effect.tryPromise({
		try: fn,
		catch: (cause) =>
			new VaultError({
				status: 0,
				method,
				path,
				message: `Vault request failed: ${String(cause)}`,
			}),
	});

/**
 * Build a {@link VaultClient} layer over {@link Credentials}. The `request`
 * helper performs the fetch, attaches the token header, and maps every
 * failure (transport or non-2xx) onto {@link VaultError}.
 */
export const VaultClientLive: Layer.Layer<VaultClient, never, Credentials> =
	Layer.effect(
		VaultClient,
		Effect.gen(function* () {
			const credentials = yield* Credentials;

			const send = (
				method: string,
				path: string,
				body: unknown | undefined,
			): Effect.Effect<Response, VaultError> =>
				Effect.gen(function* () {
					const connection: VaultConnection = yield* credentials.resolve;
					const response = yield* tryPromise(method, path, (signal) =>
						fetch(new URL(path, connection.url).toString(), {
							method,
							signal,
							headers: {
								"content-type": "application/json",
								authorization: `Bearer ${connection.token}`,
							},
							body: body === undefined ? undefined : JSON.stringify(body),
						}),
					);
					if (!response.ok) {
						return yield* new VaultError({
							status: response.status,
							method,
							path,
							message: `Vault ${method} ${path} -> ${response.status}`,
						});
					}
					return response;
				});

			const request = <A>(
				method: string,
				path: string,
				body: unknown | undefined,
				decode: (raw: unknown) => A,
			): Effect.Effect<A, VaultError> =>
				Effect.gen(function* () {
					const response = yield* send(method, path, body);
					const raw: unknown = yield* tryPromise(method, path, () =>
						response.json(),
					);
					return decode(raw);
				});

			const emptyRequest = (method: string, path: string, body?: unknown) =>
				Effect.asVoid(send(method, path, body));

			const tolerate404 = <A>(
				effect: Effect.Effect<A, VaultError>,
			): Effect.Effect<A | undefined, VaultError> =>
				Effect.catch(effect, (error) =>
					isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
				);

			return {
				listSysMounts: () =>
					request("GET", "v1/sys/mounts", undefined, (raw) => {
						const parsed = parse(sysMountsResponse, raw, {
							method: "GET",
							path: "v1/sys/mounts",
						});
						return Object.fromEntries(
							Object.entries(parsed.data).map(([key, value]) => [
								key,
								toSysMount(value),
							]),
						);
					}),
				createSysMount: (name, body) =>
					emptyRequest("POST", `v1/sys/mounts/${name}`, body),
				tuneSysMount: (name, body) =>
					emptyRequest("POST", `v1/sys/mounts/${name}/tune`, body),
				deleteSysMount: (name) =>
					emptyRequest("DELETE", `v1/sys/mounts/${name}`),
				readSysPolicyAcl: (name) =>
					tolerate404(
						request("GET", `v1/sys/policies/acl/${name}`, undefined, (raw) => {
							const parsed = parse(policyResponse, raw, {
								method: "GET",
								path: `v1/sys/policies/acl/${name}`,
							});
							return parsed.data.policy;
						}),
					),
				upsertSysPolicyAcl: (name, policy) =>
					emptyRequest("POST", `v1/sys/policies/acl/${name}`, { policy }),
				deleteSysPolicyAcl: (name) =>
					emptyRequest("DELETE", `v1/sys/policies/acl/${name}`),
				upsertAuthApproleRole: (name, body) =>
					emptyRequest("POST", `v1/auth/approle/role/${name}`, body),
				deleteAuthApproleRole: (name) =>
					emptyRequest("DELETE", `v1/auth/approle/role/${name}`),
				listSysAuth: () =>
					request("GET", "v1/sys/auth", undefined, (raw) => {
						const parsed = parse(sysAuthResponse, raw, {
							method: "GET",
							path: "v1/sys/auth",
						});
						return Object.fromEntries(
							Object.entries(parsed.data).map(([key, value]) => [
								key,
								toAuthMethod(value),
							]),
						);
					}),
				readIdentityGroupByName: (name) =>
					tolerate404(
						request(
							"GET",
							`v1/identity/group/name/${name}`,
							undefined,
							(raw) => {
								const parsed = parse(identityGroupResponse, raw, {
									method: "GET",
									path: `v1/identity/group/name/${name}`,
								});
								return parsed.data;
							},
						),
					),
				upsertIdentityGroup: (body) =>
					emptyRequest("POST", "v1/identity/group/name", body),
				deleteIdentityGroupByName: (name) =>
					emptyRequest("DELETE", `v1/identity/group/name/${name}`),
				createIdentityGroupAlias: (body) =>
					emptyRequest("POST", "v1/identity/group-alias", body),
				writeKvSecret: (mount, path, data) =>
					emptyRequest("POST", `v1/${mount}/data/${path}`, { data }),
				readKvSecret: (mount, path) =>
					tolerate404(
						request("GET", `v1/${mount}/data/${path}`, undefined, (raw) => {
							const parsed = parse(kvReadResponse, raw, {
								method: "GET",
								path: `v1/${mount}/data/${path}`,
							});
							return parsed.data.data;
						}),
					),
				deleteKvSecret: (mount, path) =>
					emptyRequest("DELETE", `v1/${mount}/metadata/${path}`),
			};
		}),
	);
