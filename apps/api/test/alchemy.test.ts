/**
 * Alchemy tier — pins the provisioning contract between the API and
 * Cpn.Project. Effect 3.22.2 cannot load alchemy (./FileSystem), so this spec
 * exercises the alchemy-free half: the props mapping (the API's wire format
 * to Cpn.Project's desired state) and the store semantics the deployer
 * relies on (deploy writes the stage dir; delete removes it).
 */

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { CreateProjectSchema } from "../src/contract.ts";
import { localProjectStore } from "../src/handlers.ts";

const wireBody = {
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

import { propsFrom } from "../src/handlers.ts";

describe("wire body to Cpn.Project props", () => {
	it("decodes the legacy-shaped body", () => {
		const decoded = Schema.decodeUnknownExit(CreateProjectSchema)(wireBody);
		expect(Exit.isSuccess(decoded)).toBe(true);
	});

	it("maps number permissions to bigint", () => {
		const decoded = Schema.decodeUnknownExit(CreateProjectSchema)(wireBody);
		if (Exit.isFailure(decoded)) throw decoded.cause;
		const props = propsFrom(decoded.value);
		expect(props.roles[0]?.permissions).toBe(896n);
		expect(typeof props.roles[0]?.permissions).toBe("bigint");
	});

	it("rejects non-managed role types like the legacy enum would", () => {
		const decoded = Schema.decodeUnknownExit(CreateProjectSchema)({
			...wireBody,
			roles: [{ ...wireBody.roles[0], type: "custom" }],
		});
		expect(Exit.isFailure(decoded)).toBe(true);
	});
});

describe("local store over alchemy state dir", () => {
	it("lists, finds and removes stage directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "cpn-alchemy-"));
		try {
			await mkdir(join(root, "dso"));
			const store = localProjectStore(root);
			expect(await Effect.runPromise(store.list())).toEqual(["dso"]);
			expect(await Effect.runPromise(store.has("dso"))).toBe(true);
			await Effect.runPromise(store.remove("dso"));
			expect(await readdir(root)).toEqual([]);
			expect(await Effect.runPromise(store.has("dso"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("lists empty when the state root does not exist", async () => {
		const store = localProjectStore(join(tmpdir(), "cpn-missing-root"));
		expect(await Effect.runPromise(store.list())).toEqual([]);
	});
});
