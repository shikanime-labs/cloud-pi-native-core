import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { VaultClient } from "./client.ts";
import { isNotFound } from "./credentials.ts";
import { appRoleBody, projectAppRoleName, zoneAppRoleName } from "./paths.ts";

/**
 * AppRole for a project (`<slug>`) or a zone (`zone-<zone>`). Console
 * semantics: `token_type: "batch"`, every ttl and use count `"0"`,
 * `token_policies` wired to the matching ACL policies; delete is
 * 404-tolerant.
 */
export interface ProjectAppRoleProps {
	readonly slug: string;
	/** Policies granted to tokens; defaults to `[tech--{slug}--ro, app--{slug}--admin]`. */
	readonly policies?: readonly string[] | undefined;
}

export interface ProjectAppRole
	extends Resource<
		"Cpn.Vault.ProjectAppRole",
		ProjectAppRoleProps,
		{ readonly roleName: string }
	> {}

export const ProjectAppRole = Resource<ProjectAppRole>(
	"Cpn.Vault.ProjectAppRole",
);

export const ProjectAppRoleProvider = () =>
	Provider.effect(
		ProjectAppRole,
		Effect.gen(function* () {
			const client = yield* VaultClient;
			return ProjectAppRole.Provider.of({
				list: () => Effect.succeed([]),
				read: ({ olds }) =>
					Effect.succeed({ roleName: projectAppRoleName(olds.slug) }),
				reconcile: Effect.fn("Cpn.Vault.ProjectAppRole/reconcile")(function* ({
					news,
				}) {
					const roleName = projectAppRoleName(news.slug);
					const policies = news.policies ?? [
						`tech--${news.slug}--ro`,
						`app--${news.slug}--admin`,
					];
					yield* client.upsertAuthApproleRole(roleName, appRoleBody(policies));
					return { roleName };
				}),
				delete: Effect.fn("Cpn.Vault.ProjectAppRole/delete")(function* ({
					olds,
				}) {
					yield* client
						.deleteAuthApproleRole(projectAppRoleName(olds.slug))
						.pipe(
							Effect.catchAll((error) =>
								isNotFound(error) ? Effect.void : Effect.fail(error),
							),
						);
				}),
			});
		}),
	);

/**
 * AppRole for a zone: role name `zone-<zone>` (the zone mount name),
 * policies `[tech--zone-<zone>--ro]`.
 */
export interface ZoneAppRoleProps {
	readonly zone: string;
	readonly policies?: readonly string[] | undefined;
}

export interface ZoneAppRole
	extends Resource<
		"Cpn.Vault.ZoneAppRole",
		ZoneAppRoleProps,
		{ readonly roleName: string }
	> {}

export const ZoneAppRole = Resource<ZoneAppRole>("Cpn.Vault.ZoneAppRole");

export const ZoneAppRoleProvider = () =>
	Provider.effect(
		ZoneAppRole,
		Effect.gen(function* () {
			const client = yield* VaultClient;
			return ZoneAppRole.Provider.of({
				list: () => Effect.succeed([]),
				read: ({ olds }) =>
					Effect.succeed({ roleName: zoneAppRoleName(olds.zone) }),
				reconcile: Effect.fn("Cpn.Vault.ZoneAppRole/reconcile")(function* ({
					news,
				}) {
					const roleName = zoneAppRoleName(news.zone);
					const policies = news.policies ?? [
						`tech--${zoneAppRoleName(news.zone)}--ro`,
					];
					yield* client.upsertAuthApproleRole(roleName, appRoleBody(policies));
					return { roleName };
				}),
				delete: Effect.fn("Cpn.Vault.ZoneAppRole/delete")(function* ({ olds }) {
					yield* client
						.deleteAuthApproleRole(zoneAppRoleName(olds.zone))
						.pipe(
							Effect.catchAll((error) =>
								isNotFound(error) ? Effect.void : Effect.fail(error),
							),
						);
				}),
			});
		}),
	);
