/**
 * Console API contract — the legacy cloud-pi-native project surface.
 *
 * The OpenAPI manifest (/api/openapi.json) is derived from this single
 * definition; test/api/conformance.test.ts
 * pins it to the legacy @ts-rest contract (packages/shared project router).
 *
 * Handlers depend only on ProjectStore/Deployer: the second pass swaps the
 * store for a database and adds auth behind these same signatures.
 */

import type { ProjectProps } from "@cpn/core/src/composite/derive.ts";
import type * as Effect from "effect/Effect";
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
} from "effect/http-api";
import * as Schema from "effect/Schema";

// JSON carries permissions as number; ProjectProps wants bigint.
const RoleSchema = Schema.Struct({
	name: Schema.String,
	permissions: Schema.Number,
	position: Schema.Number,
	oidcGroup: Schema.String,
	type: Schema.Literal("managed"),
});

export const CreateProjectSchema = Schema.Struct({
	slug: Schema.String,
	name: Schema.String,
	description: Schema.String,
	owner: Schema.String,
	roles: Schema.Array(RoleSchema),
	members: Schema.Array(
		Schema.Struct({
			email: Schema.String,
			roleIds: Schema.Array(Schema.String),
		}),
	),
	environments: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			zoneSlug: Schema.String,
			clusterLabel: Schema.String,
			roUserEmails: Schema.Array(Schema.String),
			rwUserEmails: Schema.Array(Schema.String),
		}),
	),
});

export const ProjectSummary = Schema.Struct({
	slug: Schema.String,
	name: Schema.String,
	status: Schema.Literal("created"),
});

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
	message: Schema.String,
}) {}

const ProjectIdParams = Schema.Struct({ projectId: Schema.String });

export const api = HttpApi.make("cpn").add(
	HttpApiGroup.make("projects")
		.add(
			HttpApiEndpoint.get("listProjects", "/api/v1/projects", {
				success: Schema.Array(ProjectSummary),
			}),
		)
		.add(
			HttpApiEndpoint.post("createProject", "/api/v1/projects", {
				success: HttpApiSchema.status(201)(ProjectSummary),
				payload: CreateProjectSchema,
			}),
		)
		.add(
			HttpApiEndpoint.get("getProject", "/api/v1/projects/:projectId", {
				params: ProjectIdParams,
				success: ProjectSummary,
				error: HttpApiSchema.status(404)(NotFound),
			}),
		)
		.add(
			HttpApiEndpoint.make("DELETE")(
				"deleteProject",
				"/api/v1/projects/:projectId",
				{
					params: ProjectIdParams,
					success: HttpApiSchema.NoContent,
				},
			),
		),
);

/** Where project records live. ponytail: alchemy local state dir; database in pass two. */
export interface ProjectStore {
	list(): Effect.Effect<readonly string[], never>;
	has(slug: string): Effect.Effect<boolean, never>;
	add(slug: string): Effect.Effect<void, never>;
	remove(slug: string): Effect.Effect<void, never>;
}

/** Provisions one project. ponytail: alchemy deploy/destroy; the swappable layer. */
export interface Deployer {
	deploy(props: ProjectProps): Effect.Effect<void, never>;
	destroy(slug: string): Effect.Effect<void, never>;
}
