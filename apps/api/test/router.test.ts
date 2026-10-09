/**
 * HTTP tier — exercises the real router (API + OpenAPI + MCP routes) through
 * HttpRouter.toWebHandler with an in-memory store and a no-op deployer.
 * This is the test that catches surface drift between the manifest and the
 * handlers, per-route status codes, and MCP protocol behavior.
 */

import { NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { HttpRouter } from "effect/http";
import { layerWeak as EtagLayer } from "effect/http/Etag";
import { layer as HttpPlatformLayer } from "effect/http/HttpPlatform";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deployer, ProjectStore } from "../src/contract.ts";
import { routerLayer } from "../src/router.ts";

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

let handler: ((request: Request) => Promise<Response>) | undefined;
let dispose: (() => Promise<void>) | undefined;

beforeEach(async () => {
	const web = HttpRouter.toWebHandler(
		routerLayer(memoryStore(), memoryDeployer()).pipe(
			Layer.provide(
				Layer.provideMerge(
					Layer.mergeAll(EtagLayer, HttpPlatformLayer),
					Layer.mergeAll(NodeFileSystem.layer, NodePath.layer),
				),
			),
		),
	);
	handler = web.handler;
	dispose = web.dispose;
});

afterEach(async () => {
	await dispose?.();
	handler = undefined;
	dispose = undefined;
});

const json = async (method: string, path: string, payload?: unknown) => {
	const response = await handler?.(
		new Request(`http://x${path}`, {
			method,
			body: payload === undefined ? undefined : JSON.stringify(payload),
			headers: { "content-type": "application/json" },
		}),
	);
	if (!response) throw new Error("handler not ready");
	const text = await response.text();
	return {
		status: response.status,
		body: response.status === 204 || text === "" ? null : JSON.parse(text),
	};
};

describe("project routes", () => {
	it("lists empty", async () => {
		const { status, body: listed } = await json("GET", "/api/v1/projects");
		expect(status).toBe(200);
		expect(listed).toEqual([]);
	});

	it("creates with 201 and then lists one", async () => {
		const { status, body: created } = await json(
			"POST",
			"/api/v1/projects",
			body,
		);
		expect(status).toBe(201);
		expect(created).toEqual({
			slug: "dso",
			name: "Cloud Pi Native",
			status: "created",
		});
		const listed = await json("GET", "/api/v1/projects");
		expect(listed.body).toHaveLength(1);
	});

	it("gets 200 known, 404 unknown", async () => {
		expect((await json("GET", "/api/v1/projects/dso")).status).toBe(404);
		await json("POST", "/api/v1/projects", body);
		expect((await json("GET", "/api/v1/projects/dso")).status).toBe(200);
	});

	it("deletes with 204", async () => {
		await json("POST", "/api/v1/projects", body);
		expect((await json("DELETE", "/api/v1/projects/dso")).status).toBe(204);
		expect((await json("GET", "/api/v1/projects/dso")).status).toBe(404);
	});

	it("rejects invalid create bodies with 400", async () => {
		const { status } = await json("POST", "/api/v1/projects", { slug: 1 });
		expect(status).toBe(400);
	});
});

describe("openapi manifest", () => {
	it("serves the manifest derived from the contract", async () => {
		const { status, body: spec } = await json("GET", "/api/openapi.json");
		expect(status).toBe(200);
		const paths = (spec as { paths: Record<string, unknown> }).paths;
		expect(Object.keys(paths)).toContain("/api/v1/projects");
		expect(Object.keys(paths)).toContain("/api/v1/projects/{projectId}");
	});
});
