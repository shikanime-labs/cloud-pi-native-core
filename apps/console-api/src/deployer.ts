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
					baseUrl: Config.string("KEYCLOAK_BASE_URL"),
					realm: Config.string("KEYCLOAK_REALM"),
					nodeAddress: Config.string("KEYCLOAK_NODE_ADDRESS"),
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
