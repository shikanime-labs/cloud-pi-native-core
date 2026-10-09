import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { type GenericKind, K8s } from "kubernetes-fluent-client";
import { WatchPhase } from "kubernetes-fluent-client";
import type { KubernetesObject } from "kubernetes-fluent-client/dist/types.js";
import type { BridgeService, Phase } from "./bridge.ts";
import { type CpnKindName, CpnKinds } from "./kinds.ts";
import {
	AdminRoleSpecSchema,
	ClusterSpecSchema,
	ProjectSpecSchema,
	toDomainProps,
	ZoneSpecSchema,
} from "./spec.ts";

/**
 * Watch loop: one Watcher per CRD kind, retrying forever (resyncFailureMax
 * unset = unlimited). Events decode against the kind's spec schema; the
 * per-key queue deduplicates concurrent events for one resource and
 * serializes its reconciles. Failures surface by patching the CR status
 * subresource, never by killing the watch.
 */

export interface WatchLoopService {
	/** Start all four watchers; resolves once every watch has connected. */
	readonly start: () => Effect.Effect<void>;
}

export class WatchLoop extends Context.Service<WatchLoop, WatchLoopService>()(
	"cpn.operator.WatchLoop",
) {}

export interface WatchEvent {
	readonly kind: CpnKindName;
	readonly name: string;
	readonly namespace: string;
	readonly generation: number | undefined;
	readonly deletionTimestamp: string | undefined;
	readonly finalizers: readonly string[] | undefined;
	readonly observedGeneration: number | undefined;
	readonly appliedSpec: unknown;
	readonly attributes: Record<string, unknown> | undefined;
	readonly spec: unknown;
}

const API_VERSION = "cpn.shikanime.studio/v1alpha1";
export const FINALIZER = "cpn.shikanime.studio/operator";

const kindName = (kind: string | undefined): CpnKindName | undefined =>
	kind === "Project" ||
	kind === "AdminRole" ||
	kind === "Zone" ||
	kind === "Cluster"
		? kind
		: undefined;

/** Decode a raw watch payload into a typed event; undefined = not ours. */
export const decodeWatchEvent = (obj: {
	kind?: string;
	apiVersion?: string;
	metadata?: {
		name?: string;
		namespace?: string;
		generation?: number;
		deletionTimestamp?: string;
		finalizers?: string[];
	};
	status?: {
		observedGeneration?: number;
		appliedSpec?: unknown;
		attributes?: Record<string, unknown>;
	};
	spec?: unknown;
}): WatchEvent | undefined => {
	if (obj.apiVersion !== API_VERSION) return undefined;
	const kind = kindName(obj.kind);
	if (kind === undefined || obj.metadata?.name === undefined) return undefined;
	return {
		kind,
		name: obj.metadata.name,
		namespace: obj.metadata.namespace ?? "default",
		generation: obj.metadata.generation,
		deletionTimestamp: obj.metadata.deletionTimestamp,
		finalizers: obj.metadata.finalizers,
		observedGeneration: obj.status?.observedGeneration,
		appliedSpec: obj.status?.appliedSpec,
		attributes: obj.status?.attributes,
		spec: obj.spec ?? {},
	};
};

const specSchemas = {
	Project: ProjectSpecSchema,
	AdminRole: AdminRoleSpecSchema,
	Zone: ZoneSpecSchema,
	Cluster: ClusterSpecSchema,
} as const;

export const decodeSpec = (
	kind: CpnKindName,
	spec: unknown,
): { success: true; value: unknown } | { success: false; message: string } => {
	const result = Schema.decodeUnknownResult(specSchemas[kind])(spec);
	if (result._tag === "Failure") {
		return { success: false, message: String(result.failure).slice(0, 300) };
	}
	return { success: true, value: result.success };
};

/** Status write: KFC PatchStatus on the CR (subresource = no new generation). */
const patchStatus = (
	kind: CpnKindName,
	namespace: string,
	name: string,
	status: Record<string, unknown>,
): Effect.Effect<void> =>
	Effect.tryPromise({
		try: () =>
			(
				K8s(CpnKinds[kind] as abstract new () => GenericKind).InNamespace(
					namespace,
				) as never as {
					PatchStatus: (resource: object) => Promise<unknown>;
				}
			).PatchStatus({ metadata: { name }, status }),
		catch: (cause) =>
			new Error(`cpn operator: status patch failed: ${String(cause)}`),
	}).pipe(Effect.asVoid, Effect.catch(() => Effect.void));

/** Metadata write (finalizer add/remove): JSON patch on the CR. */
const patchFinalizer = (
	kind: CpnKindName,
	namespace: string,
	name: string,
	add: boolean,
): Effect.Effect<void> =>
	Effect.tryPromise({
		try: () =>
			(
				K8s(CpnKinds[kind] as abstract new () => GenericKind).InNamespace(
					namespace,
				) as never as {
					Patch: (
						operations: readonly {
							readonly op: string;
							readonly path: string;
							readonly value?: unknown;
						}[],
					) => Promise<unknown>;
				}
			).Patch([
				{
					op: add ? "add" : "remove",
					path: "/metadata/finalizers",
					...(add ? { value: [FINALIZER] } : {}),
				},
			]),
		catch: (cause) =>
			new Error(`cpn operator: finalizer patch failed: ${String(cause)}`),
	}).pipe(Effect.asVoid, Effect.catch(() => Effect.void));

/**
 * Per-resource serialized queue: while a run for a key is in flight, new
 * offers replace the queued latest; when the run finishes, the latest (if
 * any) runs next. Runs for one key never overlap; distinct keys run
 * concurrently. ponytail: unbounded key set — fine at fleet CR counts;
 * LRU if CR counts explode.
 */
export class ResourceQueue {
	private readonly pending = new Map<string, WatchEvent>();
	private readonly running = new Map<string, Promise<void>>();

	private readonly run: (event: WatchEvent) => Promise<void>;

	constructor(run: (event: WatchEvent) => Promise<void>) {
		this.run = run;
	}

	offer(event: WatchEvent): void {
		const key = `${event.kind}/${event.namespace}/${event.name}`;
		if (this.running.has(key)) {
			this.pending.set(key, event);
			return;
		}
		this.start(key, event);
	}

	private start(key: string, event: WatchEvent): void {
		const run = this.run(event)
			.catch(() => undefined)
			.finally(() => {
				this.running.delete(key);
				const next = this.pending.get(key);
				this.pending.delete(key);
				if (next !== undefined) {
					this.start(key, next);
				}
			});
		this.running.set(key, run);
	}

	/** Resolves when the in-flight run for `key` settles (test seam). */
	idle(key: string): Promise<void> {
		return this.running.get(key) ?? Promise.resolve();
	}
}

const normalizePhase = (phase: string): Phase =>
	phase === "Ready" || phase === "Progressing" ? phase : "Failed";

const reconcileOf = (
	bridge: BridgeService,
	kind: CpnKindName,
): ((
	spec: unknown,
	state: { olds: unknown; output: unknown } | undefined,
) => Effect.Effect<
	{
		readonly phase: string;
		readonly attributes: Record<string, unknown>;
		readonly message?: string;
	},
	unknown
>) => {
	switch (kind) {
		case "Project":
			return (spec, state) => bridge.reconcileProject(spec as never, state as never);
		case "AdminRole":
			return (spec, state) =>
				bridge.reconcileAdminRole(spec as never, state as never);
		case "Zone":
			return (spec, state) => bridge.reconcileZone(spec as never, state as never);
		case "Cluster":
			return (spec, state) =>
				bridge.reconcileCluster(spec as never, state as never);
	}
};

const deleteOf = (
	bridge: BridgeService,
	kind: CpnKindName,
): ((spec: unknown, state: unknown) => Effect.Effect<unknown, unknown>) => {
	switch (kind) {
		case "Project":
			return (spec, state) => bridge.deleteProject(spec as never, state as never);
		case "AdminRole":
			return (spec, state) =>
				bridge.deleteAdminRole(spec as never, state as never);
		case "Zone":
			return (spec, state) => bridge.deleteZone(spec as never, state as never);
		case "Cluster":
			return (spec, state) =>
				bridge.deleteCluster(spec as never, state as never);
	}
};

/** Re-decode the stored appliedSpec through the kind schema → domain olds. */
const toStoredState = (
	kind: CpnKindName,
	appliedSpec: unknown,
	attributes: Record<string, unknown> | undefined,
): { olds: unknown; output: unknown } | undefined => {
	const decoded = decodeSpec(kind, appliedSpec);
	if (!decoded.success) return undefined;
	return {
		olds: toDomainProps(kind, decoded.value),
		output: attributes,
	};
};

/**
 * One event through the pipeline: generation filter, finalizer handling,
 * schema decode, bridge dispatch, status patch.
 */
export const handleEvent = (
	bridge: BridgeService,
	event: WatchEvent,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const { kind, namespace, name } = event;
		if (event.deletionTimestamp !== undefined) {
			// Deleting: drive provider delete, then release the finalizer.
			const decoded = decodeSpec(kind, event.spec);
			if (!decoded.success) {
				// Undecodable spec at deletion — cannot drive provider delete;
				// release so the API server can collect the CR.
				yield* patchFinalizer(kind, namespace, name, false);
				return;
			}
			const stored =
				event.appliedSpec === undefined
					? undefined
					: toStoredState(kind, event.appliedSpec, event.attributes);
			const ok = yield* Effect.matchCauseEffect(
				deleteOf(bridge, kind)(decoded.value, stored),
				{
					onSuccess: () => Effect.succeed(true),
					onFailure: () => Effect.succeed(false),
				},
			);
			if (ok) {
				yield* patchFinalizer(kind, namespace, name, false);
			} else {
				yield* patchStatus(kind, namespace, name, {
					phase: "Failed",
					message: "delete failed; finalizer retained",
				});
			}
			return;
		}
		// Our own PatchStatus echo: status writes never bump generation,
		// so an observed generation equal to the current one is ours — skip.
		if (
			event.generation !== undefined &&
			event.observedGeneration === event.generation
		) {
			return;
		}
		const decoded = decodeSpec(kind, event.spec);
		if (!decoded.success) {
			yield* patchStatus(kind, namespace, name, {
				phase: "Failed",
				message: decoded.message,
			});
			return;
		}
		// Ensure the finalizer before the first status write so deletes
		// cannot race past us. The echo re-enters with the finalizer set.
		if (event.finalizers === undefined || !event.finalizers.includes(FINALIZER)) {
			yield* patchFinalizer(kind, namespace, name, true);
			return;
		}
		const olds =
			event.appliedSpec === undefined
				? undefined
				: toStoredState(kind, event.appliedSpec, event.attributes);
		const outcome = yield* Effect.matchCauseEffect(
			reconcileOf(bridge, kind)(decoded.value, olds),
			{
				onSuccess: (o) => Effect.succeed(o),
				onFailure: (cause) =>
					Effect.succeed({
						phase: "Failed" as const,
						attributes: {} as Record<string, unknown>,
						message: String(cause).slice(0, 300),
					}),
			},
		);
		yield* patchStatus(kind, namespace, name, {
			observedGeneration: event.generation,
			phase: normalizePhase(outcome.phase),
			appliedSpec: decoded.value,
			attributes: outcome.attributes,
			...(outcome.message === undefined ? {} : { message: outcome.message }),
		});
	});

export const WatchLoopLive = (bridge: BridgeService): Layer.Layer<WatchLoop> =>
	Layer.effect(
		WatchLoop,
		Effect.succeed({
			start: () =>
				Effect.promise(async () => {
					const queue = new ResourceQueue((event) =>
						Effect.runPromise(handleEvent(bridge, event)).catch(
							() => undefined,
						),
					);
					const watchers: Promise<unknown>[] = [];
					for (const kind of Object.keys(CpnKinds) as CpnKindName[]) {
						const watcher = K8s(
							CpnKinds[kind] as abstract new () => GenericKind,
						).Watch((obj: KubernetesObject, phase: WatchPhase) => {
							void phase;
							const event = decodeWatchEvent(obj as never);
							if (event === undefined) return;
							queue.offer(event);
						});
						watchers.push(watcher.start());
					}
					await Promise.all(watchers);
				}),
		}),
	);
