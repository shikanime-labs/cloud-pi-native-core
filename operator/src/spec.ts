import * as Schema from "effect/Schema";
import type {
	AdminRoleProps,
	ClusterProps,
	ProjectProps,
	ZoneProps,
} from "@cpn/core/src/composite/derive.ts";

/**
 * CRD spec schemas — decoded at the watch boundary (parse, don't validate).
 * Shapes mirror packages/core/src/core/spec.ts (zod) but use effect/Schema
 * since the operator runs inside the effect runtime. `permissions` arrives
 * as a decimal string (CRD JSON has no bigint) and decodes to bigint here.
 */

const permissionsFromString = Schema.BigIntFromString;

export const ProjectSpecSchema = Schema.Struct({
	slug: Schema.String,
	name: Schema.String,
	description: Schema.String,
	owner: Schema.String,
	roles: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			permissions: permissionsFromString,
			position: Schema.Number,
			oidcGroup: Schema.String,
			type: Schema.Union([Schema.Literal("managed"), Schema.Literal("custom")]),
		}),
	),
	members: Schema.Array(
		Schema.Union([
			Schema.Struct({
				email: Schema.String,
				roleIds: Schema.mutable(Schema.Array(Schema.String)),
			}),
			Schema.Struct({
				userId: Schema.String,
				roleIds: Schema.mutable(Schema.Array(Schema.String)),
			}),
		]),
	),
	environments: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			zoneSlug: Schema.String,
			clusterLabel: Schema.String,
			roUserEmails: Schema.Array(Schema.String),
			rwUserEmails: Schema.Array(Schema.String),
		}),
	),
	projectRootDir: Schema.optional(Schema.String),
	repositoryName: Schema.optional(Schema.String),
	externalRepoUrl: Schema.optional(Schema.String),
	clusterPrivacy: Schema.optional(
		Schema.Union([Schema.Literal("public"), Schema.Literal("dedicated")]),
	),
	npm: Schema.optional(Schema.Boolean),
	storageLimitBytes: Schema.optional(Schema.Number),
	robotDurationDays: Schema.optional(Schema.Number),
	mirrorTokenExpirationDays: Schema.optional(Schema.Number),
	mirrorRotationThresholdDays: Schema.optional(Schema.Number),
	retention: Schema.optional(
		Schema.Struct({
			template: Schema.Union([
				Schema.Literal("always"),
				Schema.Literal("latestPulledK"),
				Schema.Literal("latestPushedK"),
				Schema.Literal("nDaysSinceLastPull"),
				Schema.Literal("nDaysSinceLastPush"),
			]),
			count: Schema.Number,
			cron: Schema.String,
		}),
	),
});

export interface ProjectSpecCrd {
	readonly slug: string;
	readonly name: string;
	readonly description: string;
	readonly owner: string;
	readonly roles: readonly {
		readonly name: string;
		readonly permissions: bigint;
		readonly position: number;
		readonly oidcGroup: string;
		readonly type: "managed" | "custom";
	}[];
	readonly members: readonly {
		readonly email?: string | undefined;
		readonly userId?: string | undefined;
		readonly roleIds: string[];
	}[];
	readonly environments: readonly {
		readonly name: string;
		readonly zoneSlug: string;
		readonly clusterLabel: string;
		readonly roUserEmails: readonly string[];
		readonly rwUserEmails: readonly string[];
	}[];
	readonly projectRootDir?: string | undefined;
	readonly repositoryName?: string | undefined;
	readonly externalRepoUrl?: string | undefined;
	readonly clusterPrivacy?: "public" | "dedicated" | undefined;
	readonly npm?: boolean | undefined;
	readonly storageLimitBytes?: number | undefined;
	readonly robotDurationDays?: number | undefined;
	readonly mirrorTokenExpirationDays?: number | undefined;
	readonly mirrorRotationThresholdDays?: number | undefined;
	readonly retention?: {
		readonly template:
			| "always"
			| "latestPulledK"
			| "latestPushedK"
			| "nDaysSinceLastPull"
			| "nDaysSinceLastPush";
		readonly count: number;
		readonly cron: string;
	} | undefined;
}

export const AdminRoleSpecSchema = Schema.Struct({
	role: Schema.Struct({
		name: Schema.String,
		permissions: permissionsFromString,
		position: Schema.Number,
		oidcGroup: Schema.String,
		type: Schema.Union([Schema.Literal("managed"), Schema.Literal("custom")]),
	}),
	userEmails: Schema.Array(Schema.String),
});

export interface AdminRoleSpecCrd {
	readonly role: {
		readonly name: string;
		readonly permissions: bigint;
		readonly position: number;
		readonly oidcGroup: string;
		readonly type: "managed" | "custom";
	};
	readonly userEmails: readonly string[];
}

export const ZoneSpecSchema = Schema.Struct({
	slug: Schema.String,
});

export interface ZoneSpecCrd {
	readonly slug: string;
}

export const ClusterSpecSchema = Schema.Struct({
	zone: Schema.String,
	cluster: Schema.String,
	server: Schema.String,
	config: Schema.String,
	clusterResources: Schema.Boolean,
});

export interface ClusterSpecCrd {
	readonly zone: string;
	readonly cluster: string;
	readonly server: string;
	readonly config: string;
	readonly clusterResources: boolean;
}

/** Status subresource patched back after each reconciliation. */
export interface CpnStatus {
	readonly observedGeneration?: number | undefined;
	readonly phase: "Ready" | "Progressing" | "Failed";
	/** Raw last-applied CRD spec — fed back as `olds` on the next event. */
	readonly appliedSpec?: unknown;
	/** Last reconcile attributes — fed back as `output` (and to delete). */
	readonly attributes?: Record<string, unknown> | undefined;
	readonly reason?: string | undefined;
	readonly message?: string | undefined;
}

/**
 * CRD member (flattened optional keys) → domain member (discriminated
 * union). Neither identity key is a decode-time failure (schema-refined
 * below), so this narrow stays total.
 */
const toDomainMember = (
	member: ProjectSpecCrd["members"][number],
): ProjectProps["members"][number] => {
	if (member.email !== undefined) {
		return { email: member.email, roleIds: [...member.roleIds] };
	}
	if (member.userId !== undefined) {
		return { userId: member.userId, roleIds: [...member.roleIds] };
	}
	throw new Error(
		"cpn operator: CRD Project member carries neither email nor userId",
	);
};

/** Decoded CRD spec → composite domain props, per kind. */
export const toDomainProps = (
	kind: "Project" | "AdminRole" | "Zone" | "Cluster",
	spec: unknown,
): unknown => {
	switch (kind) {
		case "Project": {
			const project = spec as ProjectSpecCrd;
			return {
				slug: project.slug,
				name: project.name,
				description: project.description,
				owner: project.owner,
				roles: project.roles.map((role) => ({ ...role })),
				members: project.members.map(toDomainMember),
				environments: project.environments.map((env) => ({ ...env })),
				projectRootDir: project.projectRootDir,
				repositoryName: project.repositoryName,
				externalRepoUrl: project.externalRepoUrl,
				clusterPrivacy: project.clusterPrivacy,
				npm: project.npm,
				storageLimitBytes: project.storageLimitBytes,
				robotDurationDays: project.robotDurationDays,
				mirrorTokenExpirationDays: project.mirrorTokenExpirationDays,
				mirrorRotationThresholdDays: project.mirrorRotationThresholdDays,
				retention: project.retention,
			};
		}
		case "AdminRole":
			return spec;
		case "Zone":
			return spec;
		case "Cluster":
			return spec;
	}
}
