import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { decodeWatchEvent, decodeSpec, FINALIZER, ResourceQueue } from "../src/watch.ts";
import { ProjectSpecSchema, toDomainProps } from "../src/spec.ts";

// Unit specs for the watch loop: event decoding, per-key dedupe, and CRD
// YAML schemas decoding a sample spec via the shared effect Schema.

const validProject = {
	slug: "dso",
	name: "Cloud Pi Native",
	description: "console extraction",
	owner: "owner@example.fr",
	roles: [
		{
			name: "devops",
			permissions: "896",
			position: 0,
			oidcGroup: "devops",
			type: "managed",
		},
	],
	members: [{ email: "owner@example.fr", roleIds: ["devops"] }],
	environments: [],
};

describe("operator watch event decoding", () => {
	it("decodes a project watch event", () => {
		const event = decodeWatchEvent({
			kind: "Project",
			apiVersion: "cpn.shikanime.studio/v1alpha1",
			metadata: { name: "dso", namespace: "cpn", generation: 3 },
			spec: validProject,
		});
		expect(event?.kind).toBe("Project");
		expect(event?.name).toBe("dso");
		expect(event?.generation).toBe(3);

		const decoded = decodeSpec("Project", validProject);
		expect(decoded.success).toBe(true);
	});

	it("rejects foreign api versions", () => {
		const event = decodeWatchEvent({
			kind: "Project",
			apiVersion: "apps/v1",
			metadata: { name: "x" },
			spec: {},
		});
		expect(event).toBeUndefined();
	});

	it("rejects unknown kinds", () => {
		const event = decodeWatchEvent({
			kind: "Deployment",
			apiVersion: "cpn.shikanime.studio/v1alpha1",
			metadata: { name: "x" },
			spec: {},
		});
		expect(event).toBeUndefined();
	});
});

describe("per-key dedupe", () => {
	it("serializes and collapses concurrent events for one key", async () => {
		const order: string[] = [];
		let resolveFirst: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		const runs: string[] = [];
		const queue = new ResourceQueue((event) => {
			runs.push(event.name);
			return gate.then(() => {
				order.push(`done:${event.name}`);
			});
		});
		const ev = (name: string) =>
			({
				kind: "Zone",
				name,
				namespace: "cpn",
				generation: 1,
				deletionTimestamp: undefined,
				finalizers: [FINALIZER],
				observedGeneration: undefined,
				appliedSpec: undefined,
				attributes: undefined,
				spec: { slug: name },
			}) as never;
		queue.offer(ev("a"));
		queue.offer(ev("a")); // collapses into pending
		queue.offer(ev("a")); // replaces pending
		queue.offer(ev("b")); // distinct key: runs immediately
		expect(runs).toEqual(["a", "b"]);
		resolveFirst();
		await new Promise((r) => setTimeout(r, 20));
		expect(order).toEqual(["done:a", "done:b", "done:a"]);
		expect(runs).toEqual(["a", "b", "a"]);
	});
});

describe("CRD YAML → shared schema decode", () => {
	it("each CRD embeds a schema and decodes a sample spec", async () => {
		for (const file of [
			"project-crd.yaml",
			"admin-role-crd.yaml",
			"zone-crd.yaml",
			"cluster-crd.yaml",
		]) {
			const doc = parse(
				await readFile(new URL(`../crds/${file}`, import.meta.url), "utf8"),
			);
			expect(doc.spec.versions[0].schema.openAPIV3Schema.properties.spec)
				.toBeTruthy();
			expect(
				doc.spec.versions[0].schema.openAPIV3Schema.properties.status[
					"x-kubernetes-preserve-unknown-fields"
				],
			).toBe(true);
		}

		const spec = decodeSpec("Project", validProject);
		expect(spec.success).toBe(true);
		if (spec.success) {
			const props = toDomainProps("Project", spec.value as never) as {
				slug: string;
				roles: readonly { permissions: bigint }[];
			};
			expect(props.slug).toBe("dso");
			expect(props.roles[0]?.permissions).toBe(896n);
		}
	});
});
