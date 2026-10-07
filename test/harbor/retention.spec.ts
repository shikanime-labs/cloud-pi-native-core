import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import * as api from "../../src/harbor/api.ts";
import {
	HarborClient,
	type HarborCredentials,
} from "../../src/harbor/client.ts";

/**
 * Scripted Harbor: each call pops the next queued response. `retentions`
 * POST bodies are captured for assertions.
 */
interface ScriptedCall {
	method: string;
	path: string;
	body?: string;
}

const makeScriptedClient = (
	responses: Array<{ status: number; body: string }>,
) => {
	const calls: ScriptedCall[] = [];
	const queue = [...responses];
	const service = {
		get url() {
			return "https://harbor.example.test";
		},
		credentials: () =>
			Effect.succeed<HarborCredentials>({ username: "admin", password: "x" }),
		request: (path: string, init?: RequestInit) =>
			Effect.sync(() => {
				const next = queue.shift();
				if (next === undefined) throw new Error(`unexpected request: ${path}`);
				const raw = init?.body;
				calls.push({
					method: init?.method ?? "GET",
					path,
					body: typeof raw === "string" ? raw : undefined,
				});
				return new Response(next.body === "" ? null : next.body, {
					status: next.status,
					headers: { "Content-Type": "application/json" },
				});
			}),
	};
	return { calls, layer: Layer.succeed(HarborClient, service) };
};

const policy: api.RetentionPolicy = {
	algorithm: "or",
	scope: { level: "project", ref: 7 },
	rules: [{ template: "latestPushedK", count: 10 }],
	trigger: {
		kind: "Schedule",
		settings: { cron: "0 22 2 * * *" },
		references: [],
	},
};

describe("putRetention (plain read-then-create method)", () => {
	it("creates when the project has no retention id, then never PUTs on the same id-free path", async () => {
		const { calls, layer } = makeScriptedClient([
			{ status: 200, body: JSON.stringify({ project_id: 7, name: "demo" }) }, // read project: no retention_id
			{ status: 201, body: "1" }, // create retention
		]);
		await Effect.runPromise(
			Effect.provide(api.putRetention("demo", policy), layer),
		);
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"GET projects/demo",
			"POST retentions",
		]);
	});

	it("skips create and PUTs the desired policy when retention already exists", async () => {
		const { calls, layer } = makeScriptedClient([
			{
				status: 200,
				body: JSON.stringify({
					project_id: 7,
					name: "demo",
					metadata: { retention_id: 42 },
				}),
			},
			{ status: 200, body: "" }, // PUT
		]);
		await Effect.runPromise(
			Effect.provide(api.putRetention("demo", policy), layer),
		);
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"GET projects/demo",
			"PUT retentions/42",
		]);
		const put = calls[1];
		expect(put).toBeDefined();
		expect(put?.body).toBeDefined();
		const sent = JSON.parse(put?.body ?? "{}");
		expect(sent.algorithm).toBe("or");
		expect(sent.scope).toEqual({ level: "project", ref: 7 });
		expect(sent.rules[0].template).toBe("latestPushedK");
		expect(sent.rules[0].params).toEqual({ latestPushedK: 10 });
		expect(sent.trigger.settings.cron).toBe("0 22 2 * * *");
	});

	it("falls through to PUT when create answers the 400 'already has retention policy' duplicate", async () => {
		const { calls, layer } = makeScriptedClient([
			{ status: 200, body: JSON.stringify({ project_id: 7, name: "demo" }) }, // read: no retention yet
			{
				status: 400,
				body: JSON.stringify({
					errors: [
						{
							code: "BAD_REQUEST",
							message: "project demo already has retention policy",
						},
					],
				}),
			},
			{
				status: 200,
				body: JSON.stringify({
					project_id: 7,
					name: "demo",
					metadata: { retention_id: 99 },
				}),
			}, // re-read after race
			{ status: 200, body: "" }, // PUT on raced id
		]);
		await Effect.runPromise(
			Effect.provide(api.putRetention("demo", policy), layer),
		);
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"GET projects/demo",
			"POST retentions",
			"GET projects/demo",
			"PUT retentions/99",
		]);
	});

	it("fails on a create error that is not the retention duplicate", async () => {
		const { layer } = makeScriptedClient([
			{ status: 200, body: JSON.stringify({ project_id: 7, name: "demo" }) },
			{ status: 500, body: "boom" },
		]);
		const exit = await Effect.runPromiseExit(
			Effect.provide(api.putRetention("demo", policy), layer),
		);
		expect(exit._tag).toBe("Failure");
	});
});
