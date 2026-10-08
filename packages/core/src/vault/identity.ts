import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { VaultClient } from "./client.ts";
import { isNotFound, VaultError } from "./credentials.ts";
import {
	type ProjectScope,
	projectGroupName,
	resolveGroupAliasPaths,
} from "./paths.ts";

/**
 * One external identity group per (project, scope) with its OIDC group
 * aliases.
 *
 * Console semantics:
 * - group name `project-<slug>-<scope>`, `type: "external"`, policies =
 *   the matching ACL policy;
 * - each configured Keycloak group path (comma-separated multi-path list;
 *   admin plugin value over project plugin value over the scope default
 *   `/<slug>/console/<suffix>`) aliases the group onto the `oidc/` mount
 *   accessor;
 * - a 400 on alias create means the alias already exists on this group —
 *   tolerated like the console does;
 * - delete removes the group by name (aliases fall with it), 404-tolerant.
 */
export interface IdentityGroupProps {
	readonly slug: string;
	readonly scope: ProjectScope;
	/** ACL policies attached to the group (the matching project policy). */
	readonly policies: readonly string[];
	/**
	 * Raw group-path suffix(es) for this scope: admin plugin value, else
	 * project plugin value, else `undefined` for the scope default.
	 * Comma-separated entries produce multiple aliases.
	 */
	readonly groupPathSuffix?: string | undefined;
}

export interface IdentityGroup
	extends Resource<
		"Cpn.Vault.IdentityGroup",
		IdentityGroupProps,
		{ readonly groupName: string; readonly aliasPaths: readonly string[] }
	> {}

export const IdentityGroup = Resource<IdentityGroup>("Cpn.Vault.IdentityGroup");

export const IdentityGroupProvider = () =>
	Provider.effect(
		IdentityGroup,
		Effect.gen(function* () {
			const client = yield* VaultClient;
			return IdentityGroup.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Vault.IdentityGroup/read")(function* ({ olds }) {
					const group = yield* client.readIdentityGroupByName(
						projectGroupName(olds.slug, olds.scope),
					);
					return group === undefined
						? undefined
						: {
								groupName: group.name,
								aliasPaths:
									group.alias?.name !== undefined ? [group.alias.name] : [],
							};
				}),
				reconcile: Effect.fn("Cpn.Vault.IdentityGroup/reconcile")(function* ({
					news,
				}) {
					const groupName = projectGroupName(news.slug, news.scope);
					yield* client.upsertIdentityGroup({
						name: groupName,
						type: "external",
						policies: news.policies,
					});
					const group = yield* client.readIdentityGroupByName(groupName);
					if (group === undefined || group.id.length === 0) {
						return yield* new VaultError({
							status: 0,
							method: "POST",
							path: `v1/identity/group/name/${groupName}`,
							message: `Vault group not found after upsert: ${groupName}`,
						});
					}
					const aliasPaths = resolveGroupAliasPaths(
						news.slug,
						news.scope,
						news.groupPathSuffix,
					);
					const authMethods = yield* client.listSysAuth();
					const oidc = authMethods["oidc/"];
					if (oidc === undefined) {
						return { groupName, aliasPaths: [] };
					}
					const existingAlias = group.alias?.name;
					for (const aliasPath of aliasPaths) {
						if (aliasPath === existingAlias) continue;
						yield* client
							.createIdentityGroupAlias({
								name: aliasPath,
								mount_accessor: oidc.accessor,
								canonical_id: group.id,
							})
							.pipe(
								Effect.catch((error: VaultError) =>
									error.status === 400 ? Effect.void : Effect.fail(error),
								),
							);
					}
					return { groupName, aliasPaths };
				}),
				delete: Effect.fn("Cpn.Vault.IdentityGroup/delete")(function* ({
					olds,
				}) {
					yield* client
						.deleteIdentityGroupByName(projectGroupName(olds.slug, olds.scope))
						.pipe(
							Effect.catch((error) =>
								isNotFound(error) ? Effect.void : Effect.fail(error),
							),
						);
				}),
			});
		}),
	);
