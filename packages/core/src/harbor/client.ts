import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { type HarborErrorResponse, isRegistryConflict } from "./conflict.ts";
import { parseOrUndefined } from "./project.ts";

/**
 * Basic-auth credentials for the Harbor admin API.
 */
export interface HarborCredentials {
	readonly username: string;
	readonly password: string;
}

export class HarborHttpError extends Data.TaggedError("HarborHttpError")<{
	readonly status: number;
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
}> {
	override get message(): string {
		return `Harbor request failed (${this.method} /${this.path} -> ${this.status})`;
	}
}

/**
 * The Harbor API client service. `url` and `credentials` are lazy so wiring
 * the layer never requires a configured registry.
 */
export class HarborClient extends Context.Service<
	HarborClient,
	{
		readonly url: string;
		readonly credentials: () => Effect.Effect<HarborCredentials>;
		readonly request: (
			path: string,
			init?: RequestInit,
		) => Effect.Effect<Response, HarborHttpError>;
	}
>()("HarborClient") {}

export type HarborClientService = Context.Service.Shape<typeof HarborClient>;

export type { HarborErrorResponse };
export { isRegistryConflict };

// ---------------------------------------------------------------------------
// Response handling — parse, don't validate; no `as`, narrow with guards.
// ---------------------------------------------------------------------------

const projectSchema = Schema.Struct({
	project_id: Schema.Number,
	name: Schema.String,
	metadata: Schema.optional(
		Schema.Struct({
			retention_id: Schema.optional(
				Schema.Union([Schema.Number, Schema.String]),
			),
		}),
	),
});

export interface HarborProject {
	readonly projectId: number;
	readonly name: string;
	readonly retentionId: number | null;
}

const toRetentionId = (raw: number | string | undefined): number | null => {
	if (raw === undefined) return null;
	const id = Number(raw);
	return Number.isFinite(id) ? id : null;
};

export const decodeHarborProject = (
	body: unknown,
): HarborProject | undefined => {
	const parsed = parseOrUndefined(projectSchema, body);
	if (parsed === undefined) return undefined;
	return {
		projectId: parsed.project_id,
		name: parsed.name,
		retentionId: toRetentionId(parsed.metadata?.retention_id),
	};
};

const robotSchema = Schema.Struct({
	id: Schema.Number,
	name: Schema.String,
});

export interface HarborRobot {
	readonly id: number;
	readonly name: string;
}

export const decodeHarborRobot = (body: unknown): HarborRobot | undefined => {
	const parsed = parseOrUndefined(robotSchema, body);
	if (parsed === undefined) return undefined;
	return { id: parsed.id, name: parsed.name };
};

const robotCreatedSchema = Schema.Struct({
	id: Schema.Number,
	name: Schema.String,
	secret: Schema.String,
});

export interface HarborRobotCreated extends HarborRobot {
	readonly secret: string;
}

export const decodeHarborRobotCreated = (
	body: unknown,
): HarborRobotCreated | undefined => {
	const parsed = parseOrUndefined(robotCreatedSchema, body);
	if (parsed === undefined) return undefined;
	return {
		id: parsed.id,
		name: parsed.name,
		secret: parsed.secret,
	};
};

const memberSchema = Schema.Struct({
	id: Schema.Number,
	entity_name: Schema.String,
	entity_type: Schema.optional(Schema.String),
	role_id: Schema.optional(Schema.Number),
});

export interface HarborMember {
	readonly id: number;
	readonly entityName: string;
	readonly entityType: string | undefined;
	readonly roleId: number | undefined;
}

const memberArraySchema = Schema.Array(memberSchema);

export const decodeHarborMembers = (
	body: unknown,
): HarborMember[] | undefined => {
	const parsed = parseOrUndefined(memberArraySchema, body);
	if (parsed === undefined) return undefined;
	return parsed.map((member) => ({
		id: member.id,
		entityName: member.entity_name,
		entityType: member.entity_type,
		roleId: member.role_id,
	}));
};

const quotaSchema = Schema.Struct({
	ref: Schema.optional(Schema.Struct({ id: Schema.optional(Schema.Number) })),
	hard: Schema.optional(
		Schema.Struct({ storage: Schema.optional(Schema.Number) }),
	),
});

export interface HarborQuota {
	readonly refId: number | undefined;
	readonly storage: number | undefined;
}

const quotaArraySchema = Schema.Array(quotaSchema);

export const decodeHarborQuotas = (
	body: unknown,
): HarborQuota[] | undefined => {
	const parsed = parseOrUndefined(quotaArraySchema, body);
	if (parsed === undefined) return undefined;
	return parsed.map((quota) => ({
		refId: quota.ref?.id,
		storage: quota.hard?.storage,
	}));
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const errorResponseOf = async (
	response: Response,
): Promise<HarborErrorResponse> => {
	const body = await response.text().catch(() => "");
	return { status: response.status, body };
};

/**
 * Read a JSON response body, null on empty/non-JSON.
 */
async function readJsonBody(response: Response): Promise<unknown> {
	const text = await response.text().catch(() => "");
	if (text === "") return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Throw {@link HarborHttpError} unless the response is 2xx.
 */
export function expectOk(
	method: string,
	path: string,
): (response: Response) => Effect.Effect<Response, HarborHttpError> {
	return (response) =>
		response.status >= 200 && response.status < 300
			? Effect.succeed(response)
			: Effect.flatMap(
					Effect.promise(async (): Promise<HarborErrorResponse> => {
						try {
							return await errorResponseOf(response);
						} catch {
							return { status: response.status, body: null };
						}
					}),
					(errorResponse) =>
						Effect.fail(
							new HarborHttpError({
								status: errorResponse.status,
								method,
								path,
								body: errorResponse.body,
							}),
						),
				);
}

/**
 * Build a {@link HarborClient} from a lazy URL + lazy credentials pair. Both
 * are only evaluated on the first request, so wiring the service never
 * requires the registry to be configured yet.
 */
export const makeHarborClient = (options: {
	url: () => string;
	credentials: () => Effect.Effect<HarborCredentials>;
}): HarborClientService => {
	let cachedUrl: string | undefined;
	let cachedAuth: string | undefined;
	const baseUrl = () =>
		(cachedUrl ??= new URL("api/v2.0/", options.url()).toString());
	const authorization = () =>
		Effect.map(options.credentials(), ({ username, password }) => {
			if (cachedAuth === undefined) {
				cachedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
			}
			return cachedAuth;
		});

	return {
		get url() {
			return options.url();
		},
		credentials: () => options.credentials(),
		request: (path: string, init?: RequestInit) =>
			Effect.gen(function* () {
				const auth = yield* authorization();
				return yield* Effect.tryPromise({
					try: () =>
						fetch(new URL(path, baseUrl()), {
							...init,
							headers: {
								Accept: "application/json",
								Authorization: auth,
								...(init?.body === undefined
									? {}
									: { "Content-Type": "application/json" }),
								...init?.headers,
							},
						}),
					catch: (cause) =>
						new HarborHttpError({
							status: 0,
							method: init?.method ?? "GET",
							path,
							body: cause,
						}),
				});
			}),
	};
};

export { errorResponseOf, readJsonBody };
