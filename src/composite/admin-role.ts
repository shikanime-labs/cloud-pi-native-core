import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as keycloak from "../keycloak/index.ts";
import { type AdminRoleProps, deriveAdminRoleChildProps } from "./derive.ts";

// ---------------------------------------------------------------------------
// Cpn.AdminRole — one managed AdminRole composed from the child resources an
// admin role owns per docs/audit/keycloak.md: the Keycloak group at the
// role's absolute oidcGroup path ("Admin-role groups | AdminRole.oidcGroup
// (/admin, /console/reader, ...) | Managed roles only").
//
// Nexus platform roles are intentionally NOT owned per admin role — they
// aggregate privileges across ALL projects (docs/audit/nexus.md) and stay a
// stack-level resource (Cpn.Nexus.PlatformRoles); noted in docs/usage.md.
//
// The composite drives the EXISTING child provider service (zero new HTTP
// calls, zero new clients). Child deletion rides the composite's delete:
// the group tree falls with the Keycloak group resource itself.
// ---------------------------------------------------------------------------

export interface AdminRoleAttrs {
	readonly groupPath: string;
	readonly memberEmails: readonly string[];
}

export interface AdminRole
	extends Resource<"Cpn.AdminRole", AdminRoleProps, AdminRoleAttrs> {}

export const AdminRole = Resource<AdminRole>("Cpn.AdminRole");

export const AdminRoleProvider = () =>
	Provider.effect(
		AdminRole,
		Effect.gen(function* () {
			const svc = yield* keycloak.AdminRoleGroup.Provider.asEffect();
			return AdminRole.Provider.of({
				list: () => Effect.succeed([]),
				reconcile: Effect.fn("Cpn.AdminRole/reconcile")(function* ({
					id,
					fqn,
					instanceId,
					news,
					session,
				}) {
					const child = deriveAdminRoleChildProps(news);
					const out = yield* svc.reconcile({
						id: `${id}/keycloak-group`,
						fqn: `${fqn}/keycloak-group`,
						instanceId,
						news: child.keycloakGroup,
						olds: undefined,
						output: undefined,
						session,
						bindings: [],
					});
					return {
						groupPath: out.groupPath,
						memberEmails: out.memberEmails,
					};
				}),
				delete: Effect.fn("Cpn.AdminRole/delete")(function* ({
					id,
					fqn,
					instanceId,
					olds,
					session,
				}) {
					const child = deriveAdminRoleChildProps(olds);
					yield* svc.delete({
						id: `${id}/keycloak-group`,
						fqn: `${fqn}/keycloak-group`,
						instanceId,
						olds: child.keycloakGroup,
						output: {
							groupPath: child.keycloakGroup.groupPath,
							memberEmails: [],
						},
						session,
						bindings: [],
					});
				}),
			});
		}),
	).pipe(Layer.provide(keycloak.AdminRoleGroupProvider()));
