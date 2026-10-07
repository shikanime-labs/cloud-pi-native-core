import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { VaultClient, type VaultClientService } from "./client.ts";
import { isNotFound, type VaultError } from "./credentials.ts";
import { projectMountName, zoneMountName } from "./paths.ts";

/**
 * Shared KV-v2 mount reconciler for project (`<slug>`) and zone
 * (`zone-<zone>`) mounts.
 *
 * Console semantics:
 * - create body sets `type: "kv"`, `options.version: 2` and
 *   `config.force_no_cache: true`;
 * - `force_no_cache` is create-time-only in Vault (`/tune` silently ignores
 *   it), so an existing mount is only TUNED (`options.version: 2`) — never
 *   reconciled for `force_no_cache`;
 * - a create that answers 400 means the mount already existed (console
 *   falls back to tuning);
 * - delete UNMOUNTS, which destroys every secret on the mount.
 */
export interface MountProps {
	/** Vault mount name — use {@link projectMountName} / {@link zoneMountName}. */
	readonly name: string;
}

export interface Mount {
	readonly Type: "Cpn.Vault.Mount";
}

const upsertMount = (client: VaultClientService, name: string) =>
	Effect.gen(function* () {
		// `force_no_cache` is create-only in Vault: /tune silently ignores it
		// (verified against Vault v2.0.3), so existing mounts are not
		// reconciled for it — they are only tuned on `options.version`.
		const createBody = {
			type: "kv",
			config: { force_no_cache: true },
			options: { version: 2 },
		} as const;
		const tuneBody = { options: { version: 2 } } as const;
		const mounts = yield* client.listSysMounts();
		const existing = mounts[`${name}/`];
		if (existing !== undefined) {
			yield* client.tuneSysMount(name, tuneBody);
			return "tuned" as const;
		}
		yield* client
			.createSysMount(name, createBody)
			.pipe(
				Effect.catchAll((error: VaultError) =>
					error.status === 400
						? client.tuneSysMount(name, tuneBody)
						: Effect.fail(error),
				),
			);
		return "created" as const;
	});

const deleteMount = (client: VaultClientService, name: string) =>
	client
		.deleteSysMount(name)
		.pipe(
			Effect.catchAll((error) =>
				isNotFound(error) ? Effect.void : Effect.fail(error),
			),
		);

/** KV-v2 mount per project; mount name = project slug. */
export interface ProjectMount
	extends Resource<
		"Cpn.Vault.ProjectMount",
		{ readonly slug: string },
		{ readonly mountName: string }
	> {}

export const ProjectMount = Resource<ProjectMount>("Cpn.Vault.ProjectMount");

export const ProjectMountProvider = () =>
	Provider.effect(
		ProjectMount,
		Effect.gen(function* () {
			const client = yield* VaultClient;
			return ProjectMount.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Vault.ProjectMount/read")(function* ({ olds }) {
					const name = projectMountName(olds.slug);
					const mounts = yield* client.listSysMounts();
					return mounts[`${name}/`] !== undefined
						? { mountName: name }
						: undefined;
				}),
				reconcile: Effect.fn("Cpn.Vault.ProjectMount/reconcile")(function* ({
					news,
				}) {
					const name = projectMountName(news.slug);
					yield* upsertMount(client, name);
					return { mountName: name };
				}),
				delete: Effect.fn("Cpn.Vault.ProjectMount/delete")(function* ({
					olds,
				}) {
					yield* deleteMount(client, projectMountName(olds.slug));
				}),
			});
		}),
	);

/** KV-v2 mount per zone; mount name = `zone-<zone>`. */
export interface ZoneMount
	extends Resource<
		"Cpn.Vault.ZoneMount",
		{ readonly zone: string },
		{ readonly mountName: string }
	> {}

export const ZoneMount = Resource<ZoneMount>("Cpn.Vault.ZoneMount");

export const ZoneMountProvider = () =>
	Provider.effect(
		ZoneMount,
		Effect.gen(function* () {
			const client = yield* VaultClient;
			return ZoneMount.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Vault.ZoneMount/read")(function* ({ olds }) {
					const name = zoneMountName(olds.zone);
					const mounts = yield* client.listSysMounts();
					return mounts[`${name}/`] !== undefined
						? { mountName: name }
						: undefined;
				}),
				reconcile: Effect.fn("Cpn.Vault.ZoneMount/reconcile")(function* ({
					news,
				}) {
					const name = zoneMountName(news.zone);
					yield* upsertMount(client, name);
					return { mountName: name };
				}),
				delete: Effect.fn("Cpn.Vault.ZoneMount/delete")(function* ({ olds }) {
					yield* deleteMount(client, zoneMountName(olds.zone));
				}),
			});
		}),
	);
