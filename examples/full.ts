/**
 * A console platform and one project — the whole deployment in one file.
 * Terraform shape: one provider block, then resources in dependency order,
 * later resources referencing earlier ones by key (zone slug, cluster label).
 * Inputs are environment variables read through effect Config — a missing
 * variable fails the run naming the key.
 *
 * Compile-check: pnpm exec tsc -p tsconfig.examples.json
 * Run: alchemy deploy --config examples/full.ts
 */

import { localState, Stack } from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import {
	AdminRole,
	Cluster,
	CpnProvider,
	Project,
	Zone,
} from "../src/composite/index.ts";

export default Stack(
	"cpn",
	{
		providers: CpnProvider({
			// Config reads the environment; runSync fails naming any missing key.
			...Effect.runSync(
				Config.all({
					keycloak: Config.all({
						baseUrl: Config.string("KEYCLOAK_BASE_URL"),
						realm: Config.string("KEYCLOAK_REALM"),
						adminClientId: Config.string("KEYCLOAK_ADMIN_CLIENT_ID"),
						adminUser: Config.string("KEYCLOAK_ADMIN_USER"),
						adminPassword: Config.string("KEYCLOAK_ADMIN_PASSWORD"),
					}),
					gitlab: Config.all({
						url: Config.string("GITLAB_URL"),
						token: Config.string("GITLAB_TOKEN"),
					}),
					sonarqube: Config.all({
						url: Config.string("SONARQUBE_URL"),
						token: Config.string("SONARQUBE_TOKEN"),
					}),
					vault: Config.all({
						url: Config.string("VAULT_URL"),
						token: Config.string("VAULT_TOKEN"),
					}),
					nexus: Config.all({
						url: Config.string("NEXUS_URL"),
						token: Config.string("NEXUS_TOKEN"),
					}),
					harbor: Config.all({
						url: Config.string("HARBOR_URL"),
						username: Config.string("HARBOR_USERNAME"),
						password: Config.string("HARBOR_PASSWORD"),
					}),
				}),
			),
			// ponytail: no-op git client — point at the zone platform-apps repos
			// (listTree/readFile/commit) when ArgoCD values must really land.
			argocd: {
				listTree: () => Effect.succeed([]),
				readFile: () => Effect.succeed(undefined),
				commit: () => Effect.void,
			},
		}),
		state: localState(),
	},
	Effect.gen(function* () {
		const ownerEmail = yield* Config.string("CPN_OWNER_EMAIL");

		// Platform tier — declared once, referenced by every project.
		yield* Zone("scw1", { slug: "scw1" });
		yield* Cluster("cluster-1", {
			zone: "scw1",
			cluster: "cluster-1",
			server: yield* Config.string("CPN_CLUSTER_SERVER"),
			config: yield* Config.string("CPN_CLUSTER_CONFIG"),
			clusterResources: true,
		});
		yield* AdminRole("platform-admin", {
			role: {
				name: "platform-admin",
				permissions: 896n,
				position: 0,
				oidcGroup: "/console/admin",
				type: "managed",
			},
			userEmails: [ownerEmail],
		});

		// One resource, every service — children derive from these props.
		const project = yield* Project("demo", {
			slug: "demo",
			name: "Demo",
			description: "one resource, every service",
			owner: ownerEmail,
			roles: [
				{
					name: "devops",
					permissions: 896n,
					position: 0,
					oidcGroup: "devops",
					type: "managed",
				},
			],
			members: [{ email: ownerEmail, roleIds: ["devops"] }],
			environments: [
				{
					name: "dev",
					zoneSlug: "scw1",
					clusterLabel: "cluster-1",
					roUserEmails: [],
					rwUserEmails: [ownerEmail],
				},
			],
		});
		return {
			slug: "demo",
			repoPath: project.gitlabRepoPathWithNamespace,
			policyNames: project.vaultPolicyNames,
		};
	}),
);
