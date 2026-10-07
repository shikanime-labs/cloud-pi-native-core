import * as Schema from "effect/Schema";

/**
 * A 4xx/5xx response, carrying the raw (unparsed) body Harbor sent.
 */
export interface HarborErrorResponse {
	readonly status: number;
	readonly body: unknown;
}

export function parseErrorBody(body: unknown): unknown {
	if (body === null || body === undefined) return null;
	try {
		return typeof body === "string" && body.length > 0
			? JSON.parse(body)
			: body;
	} catch {
		return null;
	}
}

const errorBodySchema = Schema.Struct({
	errors: Schema.Array(
		Schema.Struct({ code: Schema.String, message: Schema.String }),
	),
});

/**
 * First message from a Harbor error body, if any — identifies the retention
 * "already has retention policy" duplicate without matching status alone.
 */
export function harborErrorMessage(
	response: HarborErrorResponse,
): string | undefined {
	const parsed = Schema.decodeUnknownEither(errorBodySchema)(
		parseErrorBody(response.body),
	);
	if (parsed._tag !== "Right") return undefined;
	const first = parsed.right.errors[0];
	return first === undefined ? undefined : first.message;
}

const conflictBodySchema = Schema.Struct({
	errors: Schema.Array(Schema.Struct({ code: Schema.String })),
});

/**
 * Harbor signals "already exists" two ways: a plain HTTP 409 (project
 * create), or a 400 whose body carries `errors[].code === "CONFLICT"`
 * (robot create). The retention duplicate is a third shape — 400 with a
 * message — and is deliberately NOT a conflict here.
 */
export function isRegistryConflict(response: HarborErrorResponse): boolean {
	if (response.status === 409) return true;
	if (response.status !== 400) return false;
	const parsed = Schema.decodeUnknownEither(conflictBodySchema)(
		parseErrorBody(response.body),
	);
	return (
		parsed._tag === "Right" &&
		parsed.right.errors.some((error) => error.code === "CONFLICT")
	);
}

/**
 * Harbor signals the retention duplicate as 400 BAD_REQUEST whose message
 * contains "already has retention policy".
 */
export function isRetentionDuplicate(response: HarborErrorResponse): boolean {
	if (response.status !== 400) return false;
	const message = harborErrorMessage(response);
	return message?.includes("already has retention policy") === true;
}
