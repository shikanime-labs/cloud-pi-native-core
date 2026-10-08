import { describe, expect, it } from "vitest";
import {
	additionSet,
	consoleGroupPath,
	desiredEnvGroupMembers,
	desiredProjectMembers,
	envGroupPaths,
	evictionSet,
	findOrphanEnvGroups,
	findOrphanTopGroups,
	type GroupSummary,
	projectGroupPath,
	roleGroupPath,
	roleRelativeGroupPath,
	toGroupPath,
} from "../../src/keycloak/paths.ts";

const group = (
	id: string,
	name: string,
	subGroups: string[],
): GroupSummary => ({
	id,
	name,
	subGroups: subGroups.map((sub) => ({ name: sub })),
});

describe("group-path derivation", () => {
	it("derives the project tree paths from a slug", () => {
		expect(projectGroupPath("my-proj")).toBe("/my-proj");
		expect(consoleGroupPath("my-proj")).toBe("/my-proj/console");
		expect(roleGroupPath("my-proj", "admin")).toBe("/my-proj/console/admin");
		expect(roleGroupPath("my-proj", "devops")).toBe("/my-proj/console/devops");
	});

	it("derives per-environment RO/RW paths", () => {
		expect(envGroupPaths("my-proj", "staging")).toEqual({
			ro: "/my-proj/console/staging/RO",
			rw: "/my-proj/console/staging/RW",
		});
	});

	it("normalizes oidcGroup values the way the console does", () => {
		expect(toGroupPath("admin")).toBe("/admin");
		expect(toGroupPath("/admin")).toBe("/admin");
		expect(toGroupPath("  ")).toBeUndefined();
		expect(toGroupPath(undefined)).toBeUndefined();
	});

	it("strips the console-group prefix for role-relative paths", () => {
		expect(
			roleRelativeGroupPath("/my-proj/console/admin", "/my-proj/console"),
		).toBe("/admin");
	});
});

describe("desired-members computation", () => {
	it("union of owner and member emails, deduplicated", () => {
		const desired = desiredProjectMembers("owner@x.io", [
			"a@x.io",
			"owner@x.io",
			"b@x.io",
		]);
		expect([...desired].sort()).toEqual(["a@x.io", "b@x.io", "owner@x.io"]);
		expect(desired.size).toBe(3);
	});

	it("environment groups: owner plus the env's user lists, per side", () => {
		const desired = desiredEnvGroupMembers("owner@x.io", {
			name: "prod",
			roUserEmails: ["viewer@x.io"],
			rwUserEmails: ["editor@x.io", "owner@x.io"],
		});
		expect([...desired.ro].sort()).toEqual(["owner@x.io", "viewer@x.io"]);
		expect([...desired.rw].sort()).toEqual(["editor@x.io", "owner@x.io"]);
	});
});

describe("eviction set", () => {
	it("current members absent from desired are evicted", () => {
		const current = new Set(["a@x.io", "gone@x.io", "owner@x.io"]);
		const desired = new Set(["a@x.io", "owner@x.io"]);
		expect(evictionSet(current, desired)).toEqual(new Set(["gone@x.io"]));
	});

	it("desired members missing from current are additions", () => {
		const current = new Set(["a@x.io"]);
		const desired = new Set(["a@x.io", "new@x.io"]);
		expect(additionSet(current, desired)).toEqual(new Set(["new@x.io"]));
	});

	it("identical sets produce empty diffs both ways", () => {
		const a = new Set(["a@x.io"]);
		expect(additionSet(a, a)).toEqual(new Set());
		expect(evictionSet(a, a)).toEqual(new Set());
	});
});

describe("orphan detection over a fixture tree", () => {
	const tree: GroupSummary[] = [
		group("g1", "current-proj", ["console"]),
		group("g2", "deleted-proj", ["console"]),
		group("g3", "plain-group", ["something-else"]),
		group("g4", "admin", ["reader"]),
	];

	it("top-level orphans: no matching slug AND a console subgroup", () => {
		const orphans = findOrphanTopGroups(tree, new Set(["current-proj"]));
		expect(orphans.map((o) => o.name)).toEqual(["deleted-proj"]);
	});

	it("a matching slug is never an orphan even with a console subgroup", () => {
		const orphans = findOrphanTopGroups(
			tree,
			new Set(["current-proj", "deleted-proj"]),
		);
		expect(orphans).toEqual([]);
	});

	it("groups without a console subgroup are never purged", () => {
		const orphans = findOrphanTopGroups(tree, new Set(["current-proj"]));
		expect(orphans.every((o) => o.name !== "plain-group")).toBe(true);
		expect(orphans.every((o) => o.name !== "admin")).toBe(true);
	});
});

describe("env-orphan detection over a fixture console group", () => {
	const consoleChildren: GroupSummary[] = [
		group("e1", "dev", ["RO", "RW"]),
		group("e2", "stale-env", ["RO", "RW"]),
		group("e3", "admin", []),
		group("e4", "devops", []),
	];

	it("env-shaped children whose name matches no environment are orphans", () => {
		const orphans = findOrphanEnvGroups(consoleChildren, new Set(["dev"]));
		expect(orphans.map((o) => o.name)).toEqual(["stale-env"]);
	});

	it("role-shaped children (no RO/RW subgroups) are left alone", () => {
		const orphans = findOrphanEnvGroups(consoleChildren, new Set([]));
		expect(orphans.map((o) => o.name)).toEqual(["dev", "stale-env"]);
		expect(orphans.every((o) => o.name !== "admin")).toBe(true);
		expect(orphans.every((o) => o.name !== "devops")).toBe(true);
	});
});
