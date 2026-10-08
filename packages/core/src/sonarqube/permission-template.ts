import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { SonarqubeClient } from "./client.ts";
import { isNotFound } from "./credentials.ts";
import {
	DEFAULT_ROLE_SUFFIXES,
	permissionTemplateName,
	TEMPLATE_ADMIN_GRANT,
	templateDescription,
} from "./paths.ts";
import { ensureExists, findTemplateByName } from "./reconcile.ts";

/**
 * Per-project SonarQube permission template, named by the slug. The
 * project's default admin group (`/{slug}/console/admin`) is granted
 * `admin` on the template — the creator-equivalent grant the console
 * applies via `add_project_creator_to_template`. Delete is
 * 404-tolerant.
 */
export interface PermissionTemplateProps {
	/** Console project slug — the template name. */
	readonly slug: string;
	/**
	 * Group granted template admin; defaults to
	 * `/{slug}/console/{DEFAULT_ROLE_SUFFIXES.admin}`.
	 */
	readonly adminGroup?: string;
}

export interface PermissionTemplate
	extends Resource<
		"Cpn.Sonarqube.PermissionTemplate",
		PermissionTemplateProps,
		{
			readonly name: string;
			readonly id?: string;
		}
	> {}

export const PermissionTemplate = Resource<PermissionTemplate>(
	"Cpn.Sonarqube.PermissionTemplate",
);

export const PermissionTemplateProvider = () =>
	Provider.effect(
		PermissionTemplate,
		Effect.gen(function* () {
			const client = yield* SonarqubeClient;
			return PermissionTemplate.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Sonarqube.PermissionTemplate/read")(function* ({
					olds,
				}) {
					const name = permissionTemplateName(olds.slug);
					const template = yield* findTemplateByName(client, name);
					if (template === undefined) return undefined;
					return { name: template.name, id: template.id };
				}),
				reconcile: Effect.fn("Cpn.Sonarqube.PermissionTemplate/reconcile")(
					function* ({ news }) {
						const name = permissionTemplateName(news.slug);
						const adminGroup =
							news.adminGroup ?? `/${news.slug}${DEFAULT_ROLE_SUFFIXES.admin}`;
						yield* ensureExists({
							create: () =>
								client
									.createPermissionTemplate({
										name,
										description: templateDescription(news.slug),
									})
									.pipe(Effect.as(name)),
							reload: () =>
								Effect.map(
									findTemplateByName(client, name),
									(template) => template?.name ?? undefined,
								),
						});
						yield* client.addGroupToTemplate({
							groupName: adminGroup,
							templateName: name,
							permission: TEMPLATE_ADMIN_GRANT,
						});
						const template = yield* findTemplateByName(client, name);
						return { name, id: template?.id };
					},
				),
				delete: Effect.fn("Cpn.Sonarqube.PermissionTemplate/delete")(
					function* ({ olds }) {
						const name = permissionTemplateName(olds.slug);
						yield* client
							.deletePermissionTemplate(name)
							.pipe(
								Effect.catch((error) =>
									isNotFound(error) ? Effect.void : Effect.fail(error),
								),
							);
					},
				),
			});
		}),
	);
