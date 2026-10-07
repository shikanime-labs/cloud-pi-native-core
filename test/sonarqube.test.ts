import { describe, expect, it } from "vitest";
import {
	ADMIN_PERMISSIONS,
	DEFAULT_ROLE_SUFFIXES,
	DEVOPS_PERMISSIONS,
	permissionsForRole,
	permissionTemplateName,
	PROJECT_ROLES,
	projectKey,
	READONLY_PERMISSIONS,
	roleGroupPaths,
	ROBOT_PERMISSIONS,
	robotEmail,
	robotLogin,
	ciTokenName,
	visibilityForCluster,
} from "../src/sonarqube/paths.ts";

describe("visibility predicate", () => {
	it("public cluster privacy → public visibility", () => {
		expect(visibilityForCluster("public")).toBe("public");
	});
	it("dedicated cluster privacy → private visibility", () => {
		expect(visibilityForCluster("dedicated")).toBe("private");
	});
});

describe("project key derivation", () => {
	// Golden values from console crypto.spec.ts — existing SonarQube
	// projects were created with these exact keys.
	it("matches the legacy console golden keys", () => {
		expect(projectKey("my-app", "my-repo")).toBe("my-app-my-repo-923f");
		expect(projectKey("my-app", "front")).toBe("my-app-front-1013");
		expect(projectKey("my-app", "api")).toBe("my-app-api-a814");
	});
});

describe("permission-set derivation per role", () => {
	it("admin gets admin + scan + user + codeviewer + issueadmin + securityhotspotadmin", () => {
		expect(permissionsForRole("admin")).toEqual(ADMIN_PERMISSIONS);
		expect([...ADMIN_PERMISSIONS]).toContain("admin");
	});
	it("devops, developer, security share the devops set without admin", () => {
		for (const role of ["devops", "developer", "security"] as const) {
			expect(permissionsForRole(role)).toEqual(DEVOPS_PERMISSIONS);
			expect(permissionsForRole(role)).not.toContain("admin");
		}
	});
	it("readonly gets only user + codeviewer", () => {
		expect(permissionsForRole("readonly")).toEqual(READONLY_PERMISSIONS);
	});
	it("robot gets scan + user + codeviewer", () => {
		expect([...ROBOT_PERMISSIONS]).toEqual(["scan", "user", "codeviewer"]);
	});
});

describe("template name derivation", () => {
	it("template per project named by the slug", () => {
		expect(permissionTemplateName("cpged")).toBe("cpged");
		expect(permissionTemplateName("my-app")).toBe("my-app");
	});
});

describe("role group paths", () => {
	it("defaults derive /{slug}/console/{suffix}", () => {
		expect(roleGroupPaths("cpged", "admin")).toEqual(["/cpged/console/admin"]);
		expect(roleGroupPaths("cpged", "readonly")).toEqual([
			"/cpged/console/readonly",
		]);
	});
	it("comma-separated multi-paths expand", () => {
		expect(
			roleGroupPaths("cpged", "admin", "/console/admin, /console/ops"),
		).toEqual(["/cpged/console/admin", "/cpged/console/ops"]);
	});
	it("empty segments are dropped", () => {
		expect(roleGroupPaths("cpged", "devops", " ,/console/devops,")).toEqual([
			"/cpged/console/devops",
		]);
	});
	it("every default suffix maps under /console/", () => {
		for (const role of PROJECT_ROLES) {
			expect(roleGroupPaths("s", role)).toEqual([
				`/s${DEFAULT_ROLE_SUFFIXES[role]}`,
			]);
		}
	});
});

describe("robot identity", () => {
	it("robot login is the slug", () => {
		expect(robotLogin("cpged")).toBe("cpged");
	});
	it("robot email is the per-project fake email", () => {
		expect(robotEmail("cpged")).toBe("cpged@cloud-pi-native.fr");
	});
	it("CI token name follows the console convention", () => {
		expect(ciTokenName("cpged")).toBe("Sonar Token for cpged");
	});
});
