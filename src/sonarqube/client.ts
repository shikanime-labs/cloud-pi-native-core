import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
	Credentials,
	type SonarqubeConnection,
	SonarqubeError,
} from "./credentials.ts";

// ---- wire types (only fields the resources rely on) ----

export interface SonarqubePaging {
	readonly pageIndex: number;
	readonly pageSize: number;
	readonly total: number;
}

export interface SonarqubeGroup {
	readonly id: string;
	readonly name: string;
	readonly default: boolean;
}

export interface SonarqubeUser {
	readonly login: string;
	readonly name: string;
	readonly active: boolean;
	readonly email?: string | undefined;
	readonly local?: boolean | undefined;
	readonly tokensCount?: number | undefined;
}

export type SonarqubeVisibility = "private" | "public";

export interface SonarqubeProjectComponent {
	readonly key: string;
	readonly name: string;
	readonly qualifier: string;
	readonly visibility: SonarqubeVisibility;
}

export interface SonarqubePermissionTemplate {
	readonly id: string;
	readonly name: string;
	readonly description?: string | undefined;
}

export interface SonarqubeGeneratedToken {
	readonly token: string;
	readonly login: string;
	readonly name: string;
}

/** `users/search` q filter matches login, name and email. */
export interface SonarqubeUserSearchRow {
	readonly login: string;
	readonly email: string;
}

// ---- response schemas (runtime parsing boundary: parse, don't validate) ----

const pagingSchema = Schema.Struct({
	pageIndex: Schema.Number,
	pageSize: Schema.Number,
	total: Schema.Number,
});

const groupsSearchSchema = Schema.Struct({
	paging: pagingSchema,
	groups: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			default: Schema.Boolean,
		}),
	),
});

const templatesSearchSchema = Schema.Struct({
	permissionTemplates: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			description: Schema.optional(Schema.String),
		}),
	),
});

const usersSearchSchema = Schema.Struct({
	paging: pagingSchema,
	users: Schema.Array(
		Schema.Struct({
			login: Schema.String,
			name: Schema.String,
			active: Schema.Boolean,
			email: Schema.optional(Schema.String),
			local: Schema.optional(Schema.Boolean),
			tokensCount: Schema.optional(Schema.Number),
		}),
	),
});

const projectsSearchSchema = Schema.Struct({
	paging: pagingSchema,
	components: Schema.Array(
		Schema.Struct({
			key: Schema.String,
			name: Schema.String,
			qualifier: Schema.String,
			visibility: Schema.Union(
				Schema.Literal("private"),
				Schema.Literal("public"),
			),
		}),
	),
});

const tokenGenerateSchema = Schema.Struct({
	token: Schema.String,
	login: Schema.String,
	name: Schema.String,
});

/** Parse an unknown body into a descriptive {@link SonarqubeError} on mismatch. */
const parse = <A, I>(
	schema: Schema.Schema<A, I>,
	body: unknown,
	ctx: { method: string; path: string },
): A => {
	const result = Schema.decodeUnknownEither(schema)(body);
	if (result._tag === "Left") {
		throw new SonarqubeError({
			status: 0,
			method: ctx.method,
			path: ctx.path,
			message: `Unexpected SonarQube response shape: ${String(result.left).slice(0, 200)}`,
		});
	}
	return result.right;
};

/**
 * Minimal SonarQube web API client over `/api/*`: the group, permission
 * template, project, user, and token operations the resources need.
 * SonarQube web APIs are POST-with-query-string endpoints; every write
 * here follows that convention.
 */
export interface SonarqubeClientService {
	readonly searchUserGroups: (
		query: string,
	) => Effect.Effect<readonly SonarqubeGroup[], SonarqubeError>;
	readonly createUserGroup: (
		name: string,
	) => Effect.Effect<void, SonarqubeError>;
	readonly searchPermissionTemplates: (
		query: string,
	) => Effect.Effect<readonly SonarqubePermissionTemplate[], SonarqubeError>;
	readonly createPermissionTemplate: (params: {
		readonly name: string;
		readonly description?: string;
		readonly projectKeyPattern?: string;
	}) => Effect.Effect<void, SonarqubeError>;
	readonly deletePermissionTemplate: (
		name: string,
	) => Effect.Effect<void, SonarqubeError>;
	readonly setDefaultPermissionTemplate: (
		name: string,
	) => Effect.Effect<void, SonarqubeError>;
	readonly addGroupToTemplate: (params: {
		readonly groupName: string;
		readonly templateName: string;
		readonly permission: string;
	}) => Effect.Effect<void, SonarqubeError>;
	readonly addGroupPermission: (params: {
		readonly groupName: string;
		readonly permission: string;
		readonly projectKey?: string;
	}) => Effect.Effect<void, SonarqubeError>;
	readonly addUserPermission: (params: {
		readonly projectKey: string;
		readonly permission: string;
		readonly login: string;
	}) => Effect.Effect<void, SonarqubeError>;
	readonly searchUsers: (
		query: string,
	) => Effect.Effect<readonly SonarqubeUser[], SonarqubeError>;
	readonly createUser: (params: {
		readonly login: string;
		readonly name: string;
		readonly email: string;
		readonly password: string;
	}) => Effect.Effect<void, SonarqubeError>;
	readonly updateUser: (params: {
		readonly login: string;
		readonly email?: string;
		readonly password?: string;
	}) => Effect.Effect<void, SonarqubeError>;
	readonly deactivateUser: (
		login: string,
	) => Effect.Effect<void, SonarqubeError>;
	readonly generateUserToken: (
		login: string,
		name: string,
	) => Effect.Effect<SonarqubeGeneratedToken, SonarqubeError>;
	readonly revokeUserToken: (
		login: string,
		name: string,
	) => Effect.Effect<void, SonarqubeError>;
	readonly searchProjects: (
		query: string,
	) => Effect.Effect<readonly SonarqubeProjectComponent[], SonarqubeError>;
	readonly createProject: (params: {
		readonly project: string;
		readonly name: string;
		readonly visibility: SonarqubeVisibility;
		readonly mainBranch: string;
	}) => Effect.Effect<void, SonarqubeError>;
	readonly deleteProject: (
		project: string,
	) => Effect.Effect<void, SonarqubeError>;
}

export class SonarqubeClient extends Context.Tag("Cpn.Sonarqube.Client")<
	SonarqubeClient,
	SonarqubeClientService
>() {}

/** SonarQube search API page size (server caps `ps` at 500). */
const PAGE_SIZE = 100;
/** Defensive page cap (1000 × 100 → 100k items) against a misbehaving endpoint. */
const MAX_PAGES = 1000;

/** `Effect.tryPromise` mapping any throw onto a {@link SonarqubeError}. */
const tryPromise = <A>(
	method: string,
	path: string,
	fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, SonarqubeError> =>
	Effect.tryPromise({
		try: fn,
		catch: (cause) =>
			new SonarqubeError({
				status: 0,
				method,
				path,
				message: `SonarQube request failed: ${String(cause)}`,
			}),
	});

/** URL-encode query params; `undefined` entries are dropped. */
const queryString = (
	params: Readonly<Record<string, string | number | boolean | undefined>>,
): string =>
	new URLSearchParams(
		Object.entries(params).flatMap(([key, value]) =>
			value === undefined ? [] : [[key, String(value)]],
		),
	).toString();

/**
 * Build a {@link SonarqubeClient} layer over {@link Credentials}. The
 * `request` helper performs the fetch with the bearer token and maps every
 * failure (transport or non-2xx) onto {@link SonarqubeError}.
 */
export const SonarqubeClientLive: Layer.Layer<
	SonarqubeClient,
	never,
	Credentials
> = Layer.effect(
	SonarqubeClient,
	Effect.gen(function* () {
		const credentials = yield* Credentials;

		const send = (
			method: string,
			path: string,
			params: Readonly<
				Record<string, string | number | boolean | undefined>
			>,
		): Effect.Effect<Response, SonarqubeError> =>
			Effect.gen(function* () {
				const connection: SonarqubeConnection = yield* credentials.resolve;
				const base = new URL("api/", connection.url).toString();
				const search = queryString(params);
				const url = search.length > 0 ? `${base}${path}?${search}` : base + path;
				const response = yield* tryPromise(method, path, (signal) =>
					fetch(url, {
						method,
						signal,
						headers: { authorization: `Bearer ${connection.token}` },
					}),
				);
				if (!response.ok) {
					return yield* new SonarqubeError({
						status: response.status,
						method,
						path,
						message: `SonarQube ${method} ${path} -> ${response.status}`,
					});
				}
				return response;
			});

		const request = <A>(
			method: string,
			path: string,
			params: Readonly<
				Record<string, string | number | boolean | undefined>
			>,
			decode: (raw: unknown) => A,
		): Effect.Effect<A, SonarqubeError> =>
			Effect.gen(function* () {
				const response = yield* send(method, path, params);
				if (response.status === 204) {
					return decode(undefined);
				}
				const raw: unknown = yield* tryPromise(method, path, () =>
					response.json(),
				);
				return decode(raw);
			});

		const emptyRequest = (
			method: string,
			path: string,
			params: Readonly<
				Record<string, string | number | boolean | undefined>
			>,
		): Effect.Effect<void, SonarqubeError> =>
			Effect.asVoid(send(method, path, params));

		/** Collect every page of a paginated search endpoint. */
		const collect = <A>(
			path: string,
			params: Readonly<
				Record<string, string | number | boolean | undefined>
			>,
			decodePage: (
				raw: unknown,
				ctx: { method: string; path: string },
			) => { readonly items: readonly A[]; readonly total: number },
		): Effect.Effect<readonly A[], SonarqubeError> =>
			Effect.gen(function* () {
				const all: A[] = [];
				for (let page = 1; page <= MAX_PAGES; page++) {
					const decoded = yield* request(
						"GET",
						path,
						{ ...params, p: page, ps: PAGE_SIZE },
						(raw) =>
							decodePage(raw, {
								method: "GET",
								path,
							}),
					);
					all.push(...decoded.items);
					if (all.length >= decoded.total || decoded.items.length < PAGE_SIZE) {
						return all;
					}
				}
				return all;
			});

		return {
			searchUserGroups: (query) =>
				collect("user_groups/search", { q: query }, (raw, ctx) => {
					const parsed = parse(groupsSearchSchema, raw, ctx);
					return { items: parsed.groups, total: parsed.paging.total };
				}),
			createUserGroup: (name) =>
				emptyRequest("POST", "user_groups/create", { name }),
			searchPermissionTemplates: (query) =>
				request("GET", "permissions/search_templates", { q: query }, (raw) => {
					const parsed = parse(templatesSearchSchema, raw, {
						method: "GET",
						path: "permissions/search_templates",
					});
					return parsed.permissionTemplates;
				}),
			createPermissionTemplate: (params) =>
				emptyRequest("POST", "permissions/create_template", {
					name: params.name,
					description: params.description,
					projectKeyPattern: params.projectKeyPattern,
				}),
			deletePermissionTemplate: (name) =>
				emptyRequest("POST", "permissions/delete_template", {
					templateName: name,
				}),
			setDefaultPermissionTemplate: (name) =>
				emptyRequest("POST", "permissions/set_default_template", {
					templateName: name,
				}),
			addGroupToTemplate: (params) =>
				emptyRequest("POST", "permissions/add_group_to_template", {
					groupName: params.groupName,
					templateName: params.templateName,
					permission: params.permission,
				}),
			addGroupPermission: (params) =>
				emptyRequest("POST", "permissions/add_group", {
					groupName: params.groupName,
					permission: params.permission,
					projectKey: params.projectKey,
				}),
			addUserPermission: (params) =>
				emptyRequest("POST", "permissions/add_user", {
					projectKey: params.projectKey,
					permission: params.permission,
					login: params.login,
				}),
			searchUsers: (query) =>
				collect("users/search", { q: query }, (raw, ctx) => {
					const parsed = parse(usersSearchSchema, raw, ctx);
					return { items: parsed.users, total: parsed.paging.total };
				}),
			createUser: (params) =>
				emptyRequest("POST", "users/create", {
					login: params.login,
					name: params.name,
					email: params.email,
					password: params.password,
					local: "true",
				}),
			updateUser: (params) =>
				emptyRequest("POST", "users/update", {
					login: params.login,
					email: params.email,
					password: params.password,
				}),
			deactivateUser: (login) =>
				emptyRequest("POST", "users/deactivate", {
					login,
					anonymize: "true",
				}),
			generateUserToken: (login, name) =>
				request(
					"POST",
					"user_tokens/generate",
					{ login, name },
					(raw) => {
						const parsed = parse(tokenGenerateSchema, raw, {
							method: "POST",
							path: "user_tokens/generate",
						});
						return parsed;
					},
				),
			revokeUserToken: (login, name) =>
				emptyRequest("POST", "user_tokens/revoke", { login, name }),
			searchProjects: (query) =>
				collect("projects/search", { q: query }, (raw, ctx) => {
					const parsed = parse(projectsSearchSchema, raw, ctx);
					return { items: parsed.components, total: parsed.paging.total };
				}),
			createProject: (params) =>
				emptyRequest("POST", "projects/create", {
					project: params.project,
					name: params.name,
					visibility: params.visibility,
					mainbranch: params.mainBranch,
				}),
			deleteProject: (project) =>
				emptyRequest("POST", "projects/delete", { project }),
		};
	}),
);
