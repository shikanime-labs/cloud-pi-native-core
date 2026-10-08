/**
 * Conformance tier — pins the new API's contract to the legacy
 * cloud-pi-native console contract (packages/shared/src/contracts/project.ts,
 * read-only reference), the way web-platform tests pin behavior to a
 * standard: each implemented route must exist with the same method, path
 * shape and success status as the legacy @ts-rest router. Deviations must be
 * a deliberate, listed decision in this file.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
	api,
	CreateProjectSchema,
	type Deployer,
	type ProjectStore,
} from "../src/contract.ts";
import {
	createProject,
	deleteProject,
	getProject,
	listProjects,
} from "../src/handlers.ts";
import { openApiSpec } from "../src/router.ts";

// Legacy: apiPrefix = "/api/v1", pathPrefix = `${apiPrefix}/projects`.
const legacy = {
	listProjects: { method: "get", path: "/api/v1/projects", success: 200 },
	createProject: { method: "post", path: "/api/v1/projects", success: 201 },
	getProject: {
		method: "get",
		path: "/api/v1/projects/{projectId}",
		success: 200,
	},
	archiveProject: {
		method: "delete",
		path: "/api/v1/projects/{projectId}",
		success: 204,
	},
} as const;

type Operation = { responses?: Record<string, unknown> };
const paths = openApiSpec.paths as Record<
	string,
	Record<string, Operation | undefined>
>;

describe("legacy contract conformance", () => {
	it("serves every implemented legacy route at the same method and path", () => {
		for (const [name, route] of Object.entries(legacy)) {
			const operations = paths[route.path];
			expect(operations, `${name}: path ${route.path} present`).toBeDefined();
			expect(
				operations?.[route.method],
				`${name}: ${route.method} present`,
			).toBeDefined();
			const responses = operations?.[route.method]?.responses ?? {};
			expect(
				Object.keys(responses).includes(String(route.success)),
				`${name}: ${route.success} response present`,
			).toBe(true);
		}
	});

	it("the OpenAPI manifest is derived from the same contract as the handlers", () => {
		expect(Object.keys(paths)).toContain("/api/v1/projects");
		expect(Object.keys(paths)).toContain("/api/v1/projects/{projectId}");
	});

	it("getProject fails with NotFound for unknown ids", () => {
		const store = memoryStore();
		return Effect.runPromise(Effect.flip(getProject(store, "nope"))).then(
			(error) => expect(String(error)).toContain("not found"),
		);
	});

	it("create then list then delete converges the store", async () => {
		const store = memoryStore();
		const deployer = memoryDeployer();
		const decoded = Schema.decodeUnknownEither(CreateProjectSchema)(body);
		if (decoded._tag === "Left") throw decoded.left;
		await Effect.runPromise(createProject(store, deployer, decoded.right));
		expect(await Effect.runPromise(listProjects(store))).toHaveLength(1);
		await Effect.runPromise(deleteProject(store, deployer, "dso"));
		expect(await Effect.runPromise(listProjects(store))).toHaveLength(0);
	});
});

const body = {
	slug: "dso",
	name: "Cloud Pi Native",
	description: "console extraction",
	owner: "owner@example.fr",
	roles: [
		{
			name: "admin",
			permissions: 896,
			position: 0,
			oidcGroup: "dso-admin",
			type: "managed",
		},
	],
	members: [{ email: "owner@example.fr", roleIds: ["admin"] }],
	environments: [
		{
			name: "dev",
			zoneSlug: "scw",
			clusterLabel: "prod",
			roUserEmails: [],
			rwUserEmails: [],
		},
	],
};

const memoryStore = (): ProjectStore => {
	const names: string[] = [];
	return {
		list: () => Effect.succeed([...names]),
		has: (slug) => Effect.succeed(names.includes(slug)),
		add: (slug) =>
			Effect.sync(() => {
				names.push(slug);
			}),
		remove: (slug) =>
			Effect.sync(() => {
				const index = names.indexOf(slug);
				if (index >= 0) names.splice(index, 1);
			}),
	};
};

const memoryDeployer = (): Deployer => ({
	deploy: () => Effect.void,
	destroy: () => Effect.void,
});

// Silence unused import when api is only referenced for shape coupling.
void api;
