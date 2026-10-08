import { describe, expect, it } from "vitest";
import {
	adminRoleCreateOrder,
	type CpnProviderConfig,
	clusterCreateOrder,
	clusterDeleteOrder,
	deriveAdminRoleChildProps,
	deriveClusterChildProps,
	deriveProjectChildProps,
	deriveZoneChildProps,
	type ProjectProps,
	projectCreateOrder,
	projectDeleteOrder,
	type ZoneProps,
	zoneCreateOrder,
	zoneDeleteOrder,
} from "../../src/composite/derive.ts";
import {
	gitlabMirrorCredPath,
	PROJECT_SCOPES,
	projectPolicyName,
	registryGroupSecretPath,
	sonarqubeCredPath,
} from "../../src/vault/paths.ts";

// This spec imports ONLY alchemy-free modules (src/composite/derive.ts and
// the pure leaf helpers): loading alchemy at test time fails on
// effect 3.22.2 (`./FileSystem` not exported), so the resource/provider
// halves of src/composite stay unimported here.

const props: ProjectProps = {
	slug: "dso",
	name: "Cloud Pi Native",
	description: "console extraction",
	owner: "owner@example.fr",
	roles: [
		{
			name: "admin",
			permissions: 896n,
			position: 0,
			oidcGroup: "admin",
			type: "managed",
		},
		{
			name: "developer",
			permissions: 128n,
			position: 2,
			oidcGroup: "developer",
			type: "managed",
		},
	],
	members: [
		{ email: "dev@example.fr", roleIds: ["developer"] },
		{ userId: "usr-123", roleIds: ["admin"] },
	],
	environments: [
		{
			name: "dev",
			zoneSlug: "scw1",
			clusterLabel: "cluster-1",
			roUserEmails: [],
			rwUserEmails: ["owner@example.fr"],
		},
	],
};

describe("deriveProjectChildProps", () => {
	const child = deriveProjectChildProps(props);

	it("keycloak groups: role suffixes from oidcGroup, owner+email members", () => {
		expect(child.keycloakGroups.roleSuffixes).toEqual(["admin", "developer"]);
		expect(child.keycloakGroups.memberEmails).toEqual([
			"owner@example.fr",
			"dev@example.fr",
		]);
		expect(child.keycloakGroups.environments).toEqual([
			{
				name: "dev",
				roUserEmails: [],
				rwUserEmails: ["owner@example.fr"],
			},
		]);
	});

	it("gitlab: root + project group, users from emails only", () => {
		expect(child.gitlabRootGroup).toEqual({ rootGroupPath: "projects" });
		expect(child.gitlabProjectGroup).toEqual({
			rootGroupPath: "projects",
			slug: "dso",
		});
		expect(child.gitlabUsers).toEqual([
			{
				email: "owner@example.fr",
				name: "owner",
				cpnUserId: "owner@example.fr",
			},
			{ email: "dev@example.fr", name: "dev", cpnUserId: "dev@example.fr" },
		]);
	});

	it("gitlab roles map role.name→id, oidcGroup is absolute", () => {
		expect(child.gitlabGroupMembers.roles).toEqual([
			{ id: "admin", oidcGroup: "/dso/console/admin" },
			{ id: "developer", oidcGroup: "/dso/console/developer" },
		]);
	});

	it("gitlab memberships keep userId-keyed members by their id", () => {
		expect(child.gitlabGroupMembers.memberships).toEqual([
			{ userId: "dev@example.fr", roleIds: ["developer"] },
			{ userId: "usr-123", roleIds: ["admin"] },
		]);
	});

	it("harbor: project named by slug, both robot kinds, retention defaults", () => {
		expect(child.harborProject).toEqual({
			name: "dso",
			storageLimit: 10 * 1024 * 1024 * 1024,
		});
		expect(child.harborRobots.ro).toEqual({
			slug: "dso",
			kind: "ro",
			durationDays: 30,
		});
		expect(child.harborRobots.rw.kind).toBe("rw");
		expect(child.harborRetention.template).toBe("nDaysSinceLastPush");
		expect(child.harborRetention.cron).toBe("0 0 0 * * 0");
	});

	it("nexus: group repo aggregates maven release+snapshot", () => {
		expect(child.nexusGroupRepo.members).toEqual([
			"dso-maven-release",
			"dso-maven-snapshot",
		]);
		expect(child.nexusProjectRoles.npm).toBe(false);
	});

	it("vault: one identity group per project scope with its policy", () => {
		expect(child.vaultIdentityGroups).toEqual(
			PROJECT_SCOPES.map((scope) => ({
				slug: "dso",
				scope,
				policies: [projectPolicyName("dso", scope)],
			})),
		);
	});

	it("argocd: zone slugs deduped, environments mapped", () => {
		expect(child.argocdEnvironments.zoneSlugs).toEqual(["scw1"]);
		expect(child.argocdEnvironments.environments).toEqual([
			{
				zoneSlug: "scw1",
				clusterLabel: "cluster-1",
				environmentName: "dev",
			},
		]);
	});

	it("sonar secret path derives from the vault path helper", () => {
		expect(child.sonarPermissions.vaultSecretPath).toBe(
			sonarqubeCredPath("projects", "dso"),
		);
	});

	it("vault secrets cover mirror creds, sonar creds, and registry group", () => {
		expect(child.vaultSecrets.map((secret) => secret.path)).toEqual([
			gitlabMirrorCredPath("projects", "dso", "dso-app"),
			sonarqubeCredPath("projects", "dso"),
			registryGroupSecretPath("projects", "dso"),
		]);
	});

	it("defaults are overridable", () => {
		const custom = deriveProjectChildProps({
			...props,
			projectRootDir: "console-projects",
			repositoryName: "custom-repo",
			storageLimitBytes: 1024,
			robotDurationDays: 7,
			mirrorTokenExpirationDays: 14,
			mirrorRotationThresholdDays: 10,
			npm: true,
			clusterPrivacy: "public",
			retention: { template: "always", count: 1, cron: "0 0 0 * * *" },
		});
		expect(custom.gitlabProjectGroup.rootGroupPath).toBe("console-projects");
		expect(custom.gitlabRepository.name).toBe("custom-repo");
		expect(custom.harborProject.storageLimit).toBe(1024);
		expect(custom.harborRobots.ro.durationDays).toBe(7);
		expect(custom.gitlabMirrorRobot.expirationDays).toBe(14);
		expect(custom.gitlabMirrorRobot.rotationThresholdDays).toBe(10);
		expect(custom.nexusProjectRoles.npm).toBe(true);
		expect(custom.sonarProject.clusterPrivacy).toBe("public");
		expect(custom.harborRetention).toEqual({
			slug: "dso",
			template: "always",
			count: 1,
			cron: "0 0 0 * * *",
		});
	});
});

describe("child order", () => {
	it("delete order is the exact reverse of create order", () => {
		expect(projectDeleteOrder).toEqual([...projectCreateOrder].reverse());
	});

	it("covers every ProjectChildProps key exactly once", () => {
		const expected = [
			"keycloakGroups",
			"gitlabRootGroup",
			"gitlabProjectGroup",
			"gitlabUsers",
			"gitlabRepository",
			"gitlabMirrorRobot",
			"gitlabGroupMembers",
			"sonarProject",
			"sonarPermissions",
			"sonarTemplate",
			"harborProject",
			"harborRobots",
			"harborRetention",
			"harborGroupMembers",
			"nexusMavenRepos",
			"nexusGroupRepo",
			"nexusProjectRoles",
			"vaultMount",
			"vaultPolicies",
			"vaultAppRole",
			"vaultSecrets",
			"vaultIdentityGroups",
			"argocdEnvironments",
		];
		expect([...projectCreateOrder]).toEqual(expected);
	});

	it("keycloak groups come first, argocd last", () => {
		expect(projectCreateOrder[0]).toBe("keycloakGroups");
		expect(projectCreateOrder.at(-1)).toBe("argocdEnvironments");
	});

	it("gitlab repository comes after its group, robots before members", () => {
		const groupAt = projectCreateOrder.indexOf("gitlabProjectGroup");
		const repoAt = projectCreateOrder.indexOf("gitlabRepository");
		const robotAt = projectCreateOrder.indexOf("gitlabMirrorRobot");
		const membersAt = projectCreateOrder.indexOf("gitlabGroupMembers");
		expect(groupAt).toBeLessThan(repoAt);
		expect(repoAt).toBeLessThan(robotAt);
		expect(robotAt).toBeLessThan(membersAt);
	});

	it("harbor robots and retention follow the harbor project", () => {
		const projectAt = projectCreateOrder.indexOf("harborProject");
		expect(projectAt).toBeLessThan(projectCreateOrder.indexOf("harborRobots"));
		expect(projectAt).toBeLessThan(
			projectCreateOrder.indexOf("harborRetention"),
		);
	});

	it("vault secrets come after mount, policies, approle and robots", () => {
		const secretsAt = projectCreateOrder.indexOf("vaultSecrets");
		expect(projectCreateOrder.indexOf("vaultMount")).toBeLessThan(secretsAt);
		expect(projectCreateOrder.indexOf("vaultPolicies")).toBeLessThan(secretsAt);
		expect(projectCreateOrder.indexOf("gitlabMirrorRobot")).toBeLessThan(
			secretsAt,
		);
		expect(projectCreateOrder.indexOf("sonarPermissions")).toBeLessThan(
			secretsAt,
		);
	});
});

describe("deriveAdminRoleChildProps", () => {
	it("maps the role oidcGroup to the keycloak group path", () => {
		const child = deriveAdminRoleChildProps({
			role: {
				name: "platform-admin",
				permissions: 896n,
				position: 0,
				oidcGroup: "/console/admin",
				type: "managed",
			},
			userEmails: ["admin@example.fr"],
		});
		expect(child.keycloakGroup).toEqual({
			groupPath: "/console/admin",
			userEmails: ["admin@example.fr"],
		});
	});

	it("create order covers the single keycloak child", () => {
		expect(adminRoleCreateOrder).toEqual(["keycloakGroup"]);
	});
});

describe("deriveZoneChildProps", () => {
	it("derives every vault child from the zone slug", () => {
		const child = deriveZoneChildProps({ slug: "scw1" } satisfies ZoneProps);
		expect(child).toEqual({
			vaultMount: { zone: "scw1" },
			vaultPolicy: { zone: "scw1" },
			vaultAppRole: { zone: "scw1" },
		});
	});

	it("delete order is the exact reverse of create order", () => {
		expect(zoneDeleteOrder).toEqual([...zoneCreateOrder].reverse());
	});

	it("create order is mount → policy → approle", () => {
		expect([...zoneCreateOrder]).toEqual([
			"vaultMount",
			"vaultPolicy",
			"vaultAppRole",
		]);
	});
});

describe("deriveClusterChildProps", () => {
	it("threads the cluster inputs straight into the vault secret child", () => {
		const child = deriveClusterChildProps({
			zone: "scw1",
			cluster: "cluster-1",
			server: "https://kube.example.fr",
			config: "{}",
			clusterResources: true,
		});
		expect(child).toEqual({
			kubeconfigSecret: {
				zone: "scw1",
				cluster: "cluster-1",
				server: "https://kube.example.fr",
				config: "{}",
				clusterResources: true,
			},
		});
	});

	it("create order covers the single vault child, delete is the reverse", () => {
		expect([...clusterCreateOrder]).toEqual(["kubeconfigSecret"]);
		expect(clusterDeleteOrder).toEqual([...clusterCreateOrder].reverse());
	});
});

describe("CpnProviderConfig shape", () => {
	it("accepts one field per service client", () => {
		const config: CpnProviderConfig = {
			keycloak: {
				baseUrl: "http://kc",
				realm: "cpn",
				adminClientId: "admin-cli",
				adminUser: "admin",
				adminPassword: "admin",
			},
			gitlab: { url: "http://gl", token: "t" },
			sonarqube: { url: "http://sq", token: "t" },
			vault: { url: "http://vault", token: "t" },
			nexus: { url: "http://nexus", token: "t" },
			harbor: { url: "http://harbor", username: "u", password: "p" },
			argocd: {
				listTree: () => {
					throw new Error("not called");
				},
				readFile: () => {
					throw new Error("not called");
				},
				commit: () => {
					throw new Error("not called");
				},
			},
		};
		expect(Object.keys(config).sort()).toEqual([
			"argocd",
			"gitlab",
			"harbor",
			"keycloak",
			"nexus",
			"sonarqube",
			"vault",
		]);
	});
});
