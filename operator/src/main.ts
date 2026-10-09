import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { CpnProviderConfig } from "@cpn/core/src/composite/index.ts";
import { Bridge, BridgeLive, OperatorProviders } from "./bridge.ts";
import { WatchLoop, WatchLoopLive } from "./watch.ts";

/**
 * Operator entrypoint. Configuration arrives as plain env vars (the same
 * names examples/full.ts uses) — read once at startup, then handed to the
 * bridge. Pairwise-required vars throw at the edge; nothing re-validates.
 */

const env = (name: string): string | undefined => {
	const value = process.env[name];
	return value === undefined || value === "" ? undefined : value;
};

const pair = (
	urlName: string,
	tokenName: string,
): { url: string; token: string } | undefined => {
	const url = env(urlName);
	const token = env(tokenName);
	if (url === undefined && token === undefined) return undefined;
	if (url === undefined || token === undefined) {
		throw new Error(
			`cpn operator: ${urlName} and ${tokenName} are set together`,
		);
	}
	return { url, token };
};

export const operatorConfig = (): CpnProviderConfig => ({
	keycloak: (() => {
		const baseUrl = env("KEYCLOAK_BASE_URL");
		if (baseUrl === undefined) return undefined;
		const realm = env("KEYCLOAK_REALM");
		const adminUser = env("KEYCLOAK_ADMIN_USER");
		const adminPassword = env("KEYCLOAK_ADMIN_PASSWORD");
		const adminClientId = env("KEYCLOAK_ADMIN_CLIENT_ID") ?? "admin-cli";
		if (
			realm === undefined ||
			adminUser === undefined ||
			adminPassword === undefined
		) {
			throw new Error(
				"cpn operator: KEYCLOAK_REALM/ADMIN_USER/ADMIN_PASSWORD required with KEYCLOAK_BASE_URL",
			);
		}
		return { baseUrl, realm, adminClientId, adminUser, adminPassword };
	})(),
	gitlab: pair("GITLAB_URL", "GITLAB_TOKEN"),
	sonarqube: pair("SONARQUBE_URL", "SONARQUBE_TOKEN"),
	vault: pair("VAULT_URL", "VAULT_TOKEN"),
	nexus: pair("NEXUS_URL", "NEXUS_TOKEN"),
	harbor: (() => {
		const url = env("HARBOR_URL");
		const username = env("HARBOR_USERNAME");
		const password = env("HARBOR_PASSWORD");
		if (url === undefined && username === undefined && password === undefined) {
			return undefined;
		}
		if (url === undefined || username === undefined || password === undefined) {
			throw new Error(
				"cpn operator: HARBOR_URL/USERNAME/PASSWORD are set together",
			);
		}
		return { url, username, password };
	})(),
	argocd: {
		// ponytail: no-op git client — real platform-apps commits come with a
		// working GitClient implementation.
		listTree: () => Effect.succeed([]),
		readFile: () => Effect.succeed(undefined),
		commit: () => Effect.void,
	},
});

export const operatorMain = (): Effect.Effect<void, unknown, Scope.Scope> =>
	Effect.gen(function* () {
		const config = operatorConfig();
		// Bridge builds the full composite provider stack once; the watch
		// loop runs forever against it. Building the watch layer resolves
		// after all watchers have started; the caller owns the scope.
		const bridgeCtx = yield* Layer.build(
			Layer.provide(BridgeLive(config), OperatorProviders(config)),
		).pipe(Effect.orDie);
		const bridge = Context.get(bridgeCtx, Bridge);
		const loopCtx = yield* Layer.build(WatchLoopLive(bridge)).pipe(
			Effect.orDie,
		);
		yield* Context.get(loopCtx, WatchLoop).start();
		yield* Effect.never;
	});

// Entry: tsx src/main.ts
Effect.runPromise(Effect.scoped(operatorMain()) as never).catch(
	(error: unknown) => {
		console.error("cpn operator: fatal", error);
		process.exit(1);
	},
);
