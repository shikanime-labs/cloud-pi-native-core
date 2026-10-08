import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { VaultClient } from "./client.ts";
import { isNotFound } from "./credentials.ts";
import { clusterSecretPath, zoneMountName } from "./paths.ts";

/**
 * The ArgoCD cluster secret the console's argocd plugin writes for every
 * cluster: one KV-v2 secret at `clusters/cluster-<label>/argocd-cluster-secret`
 * under the ZONE mount (`zone-<slug>`, plugins/argocd/src/cluster.ts via
 * VaultZoneApi). Body mirrors the console payload exactly: `name` (the
 * cluster label), `clusterResources` ("true"/"false"), `server` (API URL),
 * and `config` — a JSON-encoded string of the kubeconfig user/cluster
 * credentials ArgoCD stores as its cluster secret (console `convertConfig`).
 */
export interface KubeconfigSecretProps {
	/** Zone slug; the secret lands on the `zone-<slug>` KV mount. */
	readonly zone: string;
	/** Cluster label; keys both the path segment and the `name` field. */
	readonly cluster: string;
	/** Cluster API server URL (console `cluster.cluster.server`). */
	readonly server: string;
	/** JSON-encoded kubeconfig credentials string ArgoCD accepts. */
	readonly config: string;
	/** Whether namespace-scoped resources are allowed (console boolean, wire "true"/"false"). */
	readonly clusterResources: boolean;
}

export interface KubeconfigSecret
	extends Resource<
		"Cpn.Vault.KubeconfigSecret",
		KubeconfigSecretProps,
		{ readonly path: string }
	> {}

export const KubeconfigSecret = Resource<KubeconfigSecret>(
	"Cpn.Vault.KubeconfigSecret",
);

export const KubeconfigSecretProvider = () =>
	Provider.effect(
		KubeconfigSecret,
		Effect.gen(function* () {
			const client = yield* VaultClient;
			return KubeconfigSecret.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Vault.KubeconfigSecret/read")(function* ({
					olds,
				}) {
					const path = clusterSecretPath(olds.cluster);
					const existing = yield* client.readKvSecret(
						zoneMountName(olds.zone),
						path,
					);
					return existing === undefined ? undefined : { path };
				}),
				reconcile: Effect.fn("Cpn.Vault.KubeconfigSecret/reconcile")(
					function* ({ news }) {
						const path = clusterSecretPath(news.cluster);
						const mount = zoneMountName(news.zone);
						const existing = yield* client.readKvSecret(mount, path);
						if (
							existing !== undefined &&
							existing.name === news.cluster &&
							existing.server === news.server &&
							existing.config === news.config &&
							existing.clusterResources ===
								(news.clusterResources ? "true" : "false")
						) {
							return { path };
						}
						yield* client.writeKvSecret(mount, path, {
							name: news.cluster,
							clusterResources: news.clusterResources ? "true" : "false",
							server: news.server,
							config: news.config,
						});
						return { path };
					},
				),
				delete: Effect.fn("Cpn.Vault.KubeconfigSecret/delete")(function* ({
					olds,
				}) {
					yield* client
						.deleteKvSecret(
							zoneMountName(olds.zone),
							clusterSecretPath(olds.cluster),
						)
						.pipe(
							Effect.catch((error) =>
								isNotFound(error) ? Effect.void : Effect.fail(error),
							),
						);
				}),
			});
		}),
	);
