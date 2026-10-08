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

import {
	AdminRole,
	Cluster,
	CpnProvider,
	Project,
	Zone,
} from "@cpn/core/src/composite/index.ts";
import { localState, Stack } from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export default Stack(
	"cpn",
	{
		providers: CpnProvider({
			// Config reads the environment; runSync fails naming any missing key.
			...Effect.runSync(
				Config.all({
					keycloak: Config.all({
						baseUrl: Config.String("KEYCLOAK_BASE_URL"),
						realm: Config.String("KEYCLOAK_REALM"),
						adminClientId: Config.String("KEYCLOAK_ADMIN_CLIENT_ID"),
						adminUser: Config.String("KEYCLOAK_ADMIN_USER"),
						adminPassword: Config.String("KEYCLOAK_ADMIN_PASSWORD"),
					}),
					gitlab: Config.all({
						url: Config.String("GITLAB_URL"),
						token: Config.String("GITLAB_TOKEN"),
					}),
					sonarqube: Config.all({
						url: Config.String("SONARQUBE_URL"),
						token: Config.String("SONARQUBE_TOKEN"),
					}),
					vault: Config.all({
						url: Config.String("VAULT_URL"),
						token: Config.String("VAULT_TOKEN"),
					}),
					nexus: Config.all({
						url: Config.String("NEXUS_URL"),
						token: Config.String("NEXUS_TOKEN"),
					}),
					harbor: Config.all({
						url: Config.String("HARBOR_URL"),
						username: Config.String("HARBOR_USERNAME"),
						password: Config.String("HARBOR_PASSWORD"),
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
		const ownerEmail = yield* Config.String("CPN_OWNER_EMAIL");

		// Platform tier — declared once, referenced by every project.
		yield* Zone("scw1", { slug: "scw1" });
		yield* Cluster("cluster-1", {
			zone: "scw1",
			cluster: "cluster-1",
			server: yield* Config.String("CPN_CLUSTER_SERVER"),
			config: yield* Config.String("CPN_CLUSTER_CONFIG"),
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
