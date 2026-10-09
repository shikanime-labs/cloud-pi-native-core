import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as vault from "../vault/index.ts";
import {
	zoneAppRoleName,
	zoneMountName,
	zoneTechReadOnlyPolicyName,
} from "../vault/paths.ts";
import { deriveZoneChildProps, type ZoneProps } from "./derive.ts";

// ---------------------------------------------------------------------------
// Cpn.Zone — one console zone composed from the Vault children a zone owns
// per docs/audit/vault.md: the `zone-<slug>` KV mount, the tech-readonly
// policy, and the zone AppRole. The composite drives the EXISTING child
// provider services (zero new HTTP calls, zero new clients); reconcile
// walks zoneCreateOrder, delete walks the exact reverse.
// ---------------------------------------------------------------------------

export interface ZoneAttrs {
	readonly vaultMountName: string;
	readonly vaultPolicyName: string;
	readonly vaultAppRoleName: string;
}

export interface Zone extends Resource<"Cpn.Zone", ZoneProps, ZoneAttrs> {}

export const Zone = Resource<Zone>("Cpn.Zone");

export const ZoneProvider = () =>
	Provider.effect(
		Zone,
		Effect.gen(function* () {
			const services = {
				vaultMount: yield* vault.ZoneMount.Provider,
				vaultPolicy: yield* vault.ZonePolicy.Provider,
				vaultAppRole: yield* vault.ZoneAppRole.Provider,
			};
			return Zone.Provider.of({
				list: () => Effect.succeed([]),
				reconcile: Effect.fn("Cpn.Zone/reconcile")(function* ({
					id,
					fqn,
					instanceId,
					news,
					olds,
					session,
				}) {
					// A slug change would provision children under the new slug
					// while the old slug's Vault children remain (delete only
					// knows the latest slug) — force a delete-and-recreate.
					if (olds !== undefined && olds.slug !== news.slug) {
						return yield* Effect.fail(
							new Error(
								`Cpn.Zone '${id}': changing slug from '${olds.slug}' to '${news.slug}' is not supported; delete and recreate the zone`,
							),
						);
					}
					const child = deriveZoneChildProps(news);
					const call = <News>(kind: string, news: News) => ({
						id: `${id}/${kind}`,
						fqn: `${fqn}/${kind}`,
						instanceId,
						news,
						olds: undefined,
						output: undefined,
						session,
						bindings: [],
					});
					const mount = yield* services.vaultMount.reconcile(
						call("vault-mount", child.vaultMount),
					);
					const policy = yield* services.vaultPolicy.reconcile(
						call("vault-policy", child.vaultPolicy),
					);
					const appRole = yield* services.vaultAppRole.reconcile(
						call("vault-approle", child.vaultAppRole),
					);
					return {
						vaultMountName: mount.mountName,
						vaultPolicyName: policy.policyName,
						vaultAppRoleName: appRole.roleName,
					};
				}),
				delete: Effect.fn("Cpn.Zone/delete")(function* ({
					id,
					fqn,
					instanceId,
					olds,
					session,
				}) {
					const child = deriveZoneChildProps(olds);
					const call = <Olds, Out>(kind: string, olds: Olds, output: Out) => ({
						id: `${id}/${kind}`,
						fqn: `${fqn}/${kind}`,
						instanceId,
						olds,
						output,
						session,
						bindings: [],
					});
					// approle → policy → mount (exact reverse of create).
					yield* services.vaultAppRole.delete(
						call("vault-approle", child.vaultAppRole, {
							roleName: zoneAppRoleName(olds.slug),
						}),
					);
					yield* services.vaultPolicy.delete(
						call("vault-policy", child.vaultPolicy, {
							policyName: zoneTechReadOnlyPolicyName(olds.slug),
						}),
					);
					yield* services.vaultMount.delete(
						call("vault-mount", child.vaultMount, {
							mountName: zoneMountName(olds.slug),
						}),
					);
				}),
			});
		}),
	).pipe(
		Layer.provide(
			Layer.mergeAll(
				vault.ZoneMountProvider(),
				vault.ZonePolicyProvider(),
				vault.ZoneAppRoleProvider(),
			),
		),
	);
