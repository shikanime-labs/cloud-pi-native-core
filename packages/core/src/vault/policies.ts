import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { VaultClient } from "./client.ts";
import { isNotFound } from "./credentials.ts";
import {
	appAdminPolicyName,
	type PolicyName,
	projectPolicyName,
	renderProjectPolicy,
	techReadOnlyPolicyName,
	zoneMountName,
	zoneTechReadOnlyPolicyName,
} from "./paths.ts";

/**
 * One project ACL policy. Console semantics: `POST
 * /v1/sys/policies/acl/{name}` with `{policy: HCL}` is an UPSERT (create
 * or full replace), and `DELETE` is 404-tolerant.
 *
 * `tech-ro-path` lets the `tech--{slug}--ro` policy point its single read
 * grant at the console's registry robot secret path inside the shared
 * platform KV (default `<slug>/REGISTRY/ro-robot` on mount `kv`).
 */
export interface ProjectPoliciesProps {
	readonly slug: string;
	/** Shared KV mount the tech-readonly robot secret lives on. */
	readonly kvName?: string | undefined;
	/** Project-relative robot secret path for the tech-readonly policy. */
	readonly robotSecretPath?: string | undefined;
}

export interface ProjectPolicies
	extends Resource<
		"Cpn.Vault.ProjectPolicies",
		ProjectPoliciesProps,
		{ readonly policyNames: readonly string[] }
	> {}

export const ProjectPolicies = Resource<ProjectPolicies>(
	"Cpn.Vault.ProjectPolicies",
);

export const ProjectPoliciesProvider = () =>
	Provider.effect(
		ProjectPolicies,
		Effect.gen(function* () {
			const client = yield* VaultClient;
			const policyBody = (
				slug: string,
				props: ProjectPoliciesProps,
				name: PolicyName,
			) =>
				renderProjectPolicy(name, slug, {
					kvName: props.kvName,
					robotSecretPath: props.robotSecretPath,
				});
			return ProjectPolicies.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Vault.ProjectPolicies/read")(function* ({ olds }) {
					const first = yield* client.readSysPolicyAcl(
						appAdminPolicyName(olds.slug),
					);
					return first === undefined ? undefined : { policyNames: [] };
				}),
				reconcile: Effect.fn("Cpn.Vault.ProjectPolicies/reconcile")(function* ({
					news,
				}) {
					const names = [
						appAdminPolicyName(news.slug),
						techReadOnlyPolicyName(news.slug),
						projectPolicyName(news.slug, "devops"),
						projectPolicyName(news.slug, "developer"),
						projectPolicyName(news.slug, "readonly"),
						projectPolicyName(news.slug, "security"),
					];
					for (const name of names) {
						yield* client.upsertSysPolicyAcl(
							name,
							policyBody(news.slug, news, name),
						);
					}
					return { policyNames: names };
				}),
				delete: Effect.fn("Cpn.Vault.ProjectPolicies/delete")(function* ({
					olds,
				}) {
					const names = [
						appAdminPolicyName(olds.slug),
						techReadOnlyPolicyName(olds.slug),
						projectPolicyName(olds.slug, "devops"),
						projectPolicyName(olds.slug, "developer"),
						projectPolicyName(olds.slug, "readonly"),
						projectPolicyName(olds.slug, "security"),
					];
					for (const name of names) {
						yield* client
							.deleteSysPolicyAcl(name)
							.pipe(
								Effect.catch((error) =>
									isNotFound(error) ? Effect.void : Effect.fail(error),
								),
							);
					}
				}),
			});
		}),
	);

/**
 * The zone tech-readonly policy (`tech--zone-<zone>--ro`): read on
 * `zone-<zone>/*`. Created/updated with the zone mount, deleted with it
 * (404-tolerant).
 */
export interface ZonePolicyProps {
	readonly zone: string;
}

export interface ZonePolicy
	extends Resource<
		"Cpn.Vault.ZonePolicy",
		ZonePolicyProps,
		{ readonly policyName: string }
	> {}

export const ZonePolicy = Resource<ZonePolicy>("Cpn.Vault.ZonePolicy");

export const ZonePolicyProvider = () =>
	Provider.effect(
		ZonePolicy,
		Effect.gen(function* () {
			const client = yield* VaultClient;
			return ZonePolicy.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Vault.ZonePolicy/read")(function* ({ olds }) {
					const name = zoneTechReadOnlyPolicyName(olds.zone);
					const existing = yield* client.readSysPolicyAcl(name);
					return existing === undefined ? undefined : { policyName: name };
				}),
				reconcile: Effect.fn("Cpn.Vault.ZonePolicy/reconcile")(function* ({
					news,
				}) {
					const name = zoneTechReadOnlyPolicyName(news.zone);
					const kvName = zoneMountName(news.zone);
					yield* client.upsertSysPolicyAcl(
						name,
						`path "${kvName}/*" { capabilities = ["read"] }`,
					);
					return { policyName: name };
				}),
				delete: Effect.fn("Cpn.Vault.ZonePolicy/delete")(function* ({ olds }) {
					yield* client
						.deleteSysPolicyAcl(zoneTechReadOnlyPolicyName(olds.zone))
						.pipe(
							Effect.catch((error) =>
								isNotFound(error) ? Effect.void : Effect.fail(error),
							),
						);
				}),
			});
		}),
	);
