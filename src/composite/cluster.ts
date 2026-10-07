import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as vault from "../vault/index.ts";
import { clusterSecretPath } from "../vault/paths.ts";
import { deriveClusterChildProps, type ClusterProps } from "./derive.ts";

// ---------------------------------------------------------------------------
// Cpn.Cluster — one console cluster composed from the Vault child a cluster
// owns per docs/audit/domain-remap.md: the ArgoCD cluster secret the console
// writes on the zone mount (plugins/argocd/src/cluster.ts). The composite
// drives the EXISTING child provider (zero new HTTP calls, zero new clients);
// reconcile creates/updates it, delete destroys it.
// ---------------------------------------------------------------------------

export interface ClusterAttrs {
	readonly vaultSecretPath: string;
}

export interface Cluster extends Resource<
	"Cpn.Cluster",
	ClusterProps,
	ClusterAttrs
> {}

export const Cluster = Resource<Cluster>("Cpn.Cluster");

export const ClusterProvider = () =>
	Provider.effect(
		Cluster,
		Effect.gen(function* () {
			const services = {
				kubeconfigSecret: yield* vault.KubeconfigSecret.Provider.asEffect(),
			};
			return Cluster.Provider.of({
				list: () => Effect.succeed([]),
				reconcile: Effect.fn("Cpn.Cluster/reconcile")(function* ({
					id,
					fqn,
					instanceId,
					news,
					session,
				}) {
					const child = deriveClusterChildProps(news);
					const secret = yield* services.kubeconfigSecret.reconcile({
						id: `${id}/kubeconfig-secret`,
						fqn: `${fqn}/kubeconfig-secret`,
						instanceId,
						news: child.kubeconfigSecret,
						olds: undefined,
						output: undefined,
						session,
						bindings: [],
					});
					return { vaultSecretPath: secret.path };
				}),
				delete: Effect.fn("Cpn.Cluster/delete")(function* ({
					id,
					fqn,
					instanceId,
					olds,
					session,
				}) {
					const child = deriveClusterChildProps(olds);
					yield* services.kubeconfigSecret.delete({
						id: `${id}/kubeconfig-secret`,
						fqn: `${fqn}/kubeconfig-secret`,
						instanceId,
						olds: child.kubeconfigSecret,
						output: { path: clusterSecretPath(olds.cluster) },
						session,
						bindings: [],
					});
				}),
			});
		}),
	).pipe(
		Layer.provide(Layer.mergeAll(vault.KubeconfigSecretProvider())),
	);
