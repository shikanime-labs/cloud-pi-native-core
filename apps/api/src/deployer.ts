/**
 * Alchemy deployer — the swappable provisioning layer behind the API.
 * One alchemy stage per project slug; deploy writes .alchemy/state/<slug>.
 *
 * ponytail: alchemy beta types deploy()/destroy() services as `any`, so the
 * Effect erasure lives once, at this boundary.
 */

import type { ProjectProps } from "@cpn/core/src/composite/derive.ts";
import { CpnProvider, Project } from "@cpn/core/src/composite/index.ts";
import { localState, Stack } from "alchemy";
import { deploy } from "alchemy/Deploy";
import { destroy } from "alchemy/Destroy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type { Deployer } from "./contract.ts";

// ponytail: no-op git client — real platform-apps commits come with a
// working GitClient implementation.
const argocdGitClient = {
	listTree: () => Effect.succeed([]),
	readFile: () => Effect.succeed(undefined),
	commit: () => Effect.void,
};

// Delete needs only the resource declared; olds come from state.
const emptyProps: ProjectProps = {
	slug: "",
	name: "",
	description: "",
	owner: "",
	roles: [],
	members: [],
	environments: [],
};

const runAlchemy = (program: Effect.Effect<unknown, unknown, unknown>) =>
	Effect.runPromise(program as Effect.Effect<void>);

const projectStack = (props: ProjectProps) =>
	Stack(
		"cpn-project",
		{ providers: cpnProviders(), state: localState() },
		Effect.gen(function* () {
			yield* Project(props.slug, props);
		}),
	);

const cpnProviders = () =>
	CpnProvider({
		...Effect.runSync(
			Config.all({
				keycloak: Config.all({
					baseUrl: Config.String("KEYCLOAK_BASE_URL"),
					realm: Config.String("KEYCLOAK_REALM"),
					nodeAddress: Config.String("KEYCLOAK_NODE_ADDRESS"),
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
			}),
		),
		argocd: argocdGitClient,
	});

export const alchemyDeployer = (): Deployer => ({
	deploy: (props) =>
		Effect.promise(() =>
			runAlchemy(deploy({ stack: projectStack(props), stage: props.slug })),
		),
	destroy: (slug) =>
		Effect.promise(() =>
			runAlchemy(
				destroy({ stack: projectStack({ ...emptyProps, slug }), stage: slug }),
			),
		),
});
