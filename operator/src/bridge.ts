import { noopSession } from "alchemy/Report";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AdminRoleAttrs } from "@cpn/core/src/composite/admin-role.ts";
import type { ClusterAttrs } from "@cpn/core/src/composite/cluster.ts";
import {
	AdminRole,
	Cluster,
	CpnProvider,
	type CpnProviderConfig,
	Project,
	Zone,
} from "@cpn/core/src/composite/index.ts";
import type {
	AdminRoleProps,
	ClusterProps,
	ProjectProps,
	ZoneProps,
} from "@cpn/core/src/composite/derive.ts";
import type { ProjectAttrs } from "@cpn/core/src/composite/project.ts";
import type { ZoneAttrs } from "@cpn/core/src/composite/zone.ts";
import {
	type AdminRoleSpecCrd,
	type ClusterSpecCrd,
	type ProjectSpecCrd,
	toDomainProps,
	type ZoneSpecCrd,
} from "./spec.ts";

/**
 * CRD → alchemy reconcile bridge. The operator owns no business logic: it
 * turns a decoded CRD spec into composite props and drives the composite
 * provider services' reconcile/delete. The session is the noop renderer —
 * a headless operator has no plan widget to update.
 */

export type Phase = "Ready" | "Progressing" | "Failed";

export interface ReconcileOutcome {
	readonly phase: Phase;
	/** Domain attributes to persist in the CRD status for later deletes. */
	readonly attributes: Record<string, unknown>;
	readonly message?: string;
}

const noSession = {
	...noopSession,
	note: () => Effect.void,
};

const callBase = (id: string, fqn: string) => ({
	id,
	fqn,
	instanceId: "operator",
	session: noSession,
	bindings: [] as never[],
});

/** Composite output → status attributes (numbers stringify; CRD has no bigint). */
const toStatusAttributes = (
	attributes: Record<string, unknown>,
): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(attributes)) {
		out[key] = typeof value === "bigint" ? value.toString() : value;
	}
	return out;
};

/**
 * The bridge service: per-kind reconcile/delete over a long-lived composite
 * provider stack. Reconcile feeds the stored spec as `olds` and the stored
 * attributes as `output` so providers see updates, not fresh creates.
 */
export interface BridgeService {
	readonly reconcileProject: (
		spec: ProjectSpecCrd,
		state: StoredState<ProjectAttrs> | undefined,
	) => Effect.Effect<ReconcileOutcome, unknown>;
	readonly deleteProject: (
		spec: ProjectSpecCrd,
		state: StoredState<ProjectAttrs> | undefined,
	) => Effect.Effect<ReconcileOutcome, unknown>;
	readonly reconcileAdminRole: (
		spec: AdminRoleSpecCrd,
		state: StoredState<AdminRoleAttrs> | undefined,
	) => Effect.Effect<ReconcileOutcome, unknown>;
	readonly deleteAdminRole: (
		spec: AdminRoleSpecCrd,
		state: StoredState<AdminRoleAttrs> | undefined,
	) => Effect.Effect<ReconcileOutcome, unknown>;
	readonly reconcileZone: (
		spec: ZoneSpecCrd,
		state: StoredState<ZoneAttrs> | undefined,
	) => Effect.Effect<ReconcileOutcome, unknown>;
	readonly deleteZone: (
		spec: ZoneSpecCrd,
		state: StoredState<ZoneAttrs> | undefined,
	) => Effect.Effect<ReconcileOutcome, unknown>;
	readonly reconcileCluster: (
		spec: ClusterSpecCrd,
		state: StoredState<ClusterAttrs> | undefined,
	) => Effect.Effect<ReconcileOutcome, unknown>;
	readonly deleteCluster: (
		spec: ClusterSpecCrd,
		state: StoredState<ClusterAttrs> | undefined,
	) => Effect.Effect<ReconcileOutcome, unknown>;
}

/** What the CR status carries between reconciles. */
export interface StoredState<A> {
	/** Last-applied domain props (olds). */
	readonly olds: unknown;
	/** Last provider output (attributes), already status-decoded. */
	readonly output: A | undefined;
}

export class Bridge extends Context.Service<Bridge, BridgeService>()(
	"cpn.operator.Bridge",
) {}

/** The full provider stack: composite providers + every client they need. */
export const OperatorProviders = (config: CpnProviderConfig) =>
	CpnProvider(config);

// The composite Provider services are alchemy-generic; the operator calls
// them through this structural shape. ponytail: one structural interface
// at this boundary instead of four generic wrappers — provider types are
// stable (reconcile/delete over the same call record).
interface ProviderLike {
	readonly reconcile: (call: {
		readonly id: string;
		readonly fqn: string;
		readonly instanceId: string;
		readonly session: typeof noSession;
		readonly bindings: never[];
		readonly news: unknown;
		readonly olds: unknown;
		readonly output: unknown;
	}) => Effect.Effect<Record<string, unknown>, unknown>;
	readonly delete: (call: {
		readonly id: string;
		readonly fqn: string;
		readonly instanceId: string;
		readonly session: typeof noSession;
		readonly bindings: never[];
		readonly olds: unknown;
		readonly output: unknown;
	}) => Effect.Effect<unknown, unknown>;
}

const outcome = (
	attributes: Record<string, unknown>,
): ReconcileOutcome => ({
	phase: "Ready",
	attributes: toStatusAttributes(attributes),
});

export const BridgeLive = (
	config: CpnProviderConfig,
): Layer.Layer<Bridge, never, never> =>
	Layer.unwrap(
		Effect.gen(function* () {
			// Yield each Provider reference (asEffect is not iterable on
			// effect 4) over the single merged provider stack.
			const [project, adminRole, zone, cluster] = yield* Effect.provide(
				Effect.all([
					Project.Provider,
					AdminRole.Provider,
					Zone.Provider,
					Cluster.Provider,
				] as const),
				OperatorProviders(config),
			).pipe(Effect.orDie);
			const service: BridgeService = {
				reconcileProject: (spec, state) =>
					(project as unknown as ProviderLike).reconcile({
						...callBase(spec.slug, `operator/${spec.slug}`),
						news: toDomainProps("Project", spec),
						olds: state?.olds,
						output: state?.output,
					}).pipe(Effect.map(outcome)),
				deleteProject: (spec, state) =>
					(project as unknown as ProviderLike).delete({
						...callBase(spec.slug, `operator/${spec.slug}`),
						olds: toDomainProps("Project", spec),
						output: state?.output,
					}).pipe(Effect.map(() => outcome({}))),
				reconcileAdminRole: (spec, state) =>
					(adminRole as unknown as ProviderLike).reconcile({
						...callBase(
							spec.role.oidcGroup,
							`operator/admin-role/${spec.role.name}`,
						),
						news: toDomainProps("AdminRole", spec),
						olds: state?.olds,
						output: state?.output,
					}).pipe(Effect.map(outcome)),
				deleteAdminRole: (spec, state) =>
					(adminRole as unknown as ProviderLike).delete({
						...callBase(
							spec.role.oidcGroup,
							`operator/admin-role/${spec.role.name}`,
						),
						olds: toDomainProps("AdminRole", spec),
						output: state?.output,
					}).pipe(Effect.map(() => outcome({}))),
				reconcileZone: (spec, state) =>
					(zone as unknown as ProviderLike).reconcile({
						...callBase(spec.slug, `operator/zone/${spec.slug}`),
						news: toDomainProps("Zone", spec),
						olds: state?.olds,
						output: state?.output,
					}).pipe(Effect.map(outcome)),
				deleteZone: (spec, state) =>
					(zone as unknown as ProviderLike).delete({
						...callBase(spec.slug, `operator/zone/${spec.slug}`),
						olds: toDomainProps("Zone", spec),
						output: state?.output,
					}).pipe(Effect.map(() => outcome({}))),
				reconcileCluster: (spec, state) =>
					(cluster as unknown as ProviderLike).reconcile({
						...callBase(
							`${spec.zone}/${spec.cluster}`,
							`operator/cluster/${spec.zone}/${spec.cluster}`,
						),
						news: toDomainProps("Cluster", spec),
						olds: state?.olds,
						output: state?.output,
					}).pipe(Effect.map(outcome)),
				deleteCluster: (spec, state) =>
					(cluster as unknown as ProviderLike).delete({
						...callBase(
							`${spec.zone}/${spec.cluster}`,
							`operator/cluster/${spec.zone}/${spec.cluster}`,
						),
						olds: toDomainProps("Cluster", spec),
						output: state?.output,
					}).pipe(Effect.map(() => outcome({}))),
			};
			return Layer.succeed(Bridge, service);
		}),
	) as unknown as Layer.Layer<Bridge, never, never>;

