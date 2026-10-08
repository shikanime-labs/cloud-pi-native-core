/**
 * Pure composite derivations — the alchemy-free half of src/composite.
 *
 * Runtime imports come only from other alchemy-free leaf modules
 * (vault/paths, nexus/roles); every prop-shape import is `import type`
 * and erased at runtime, so tests can load this file without importing
 * alchemy (whose AlchemyContext pulls `effect/FileSystem`, unavailable
 * in effect 3.22.2). The resource/provider halves (project.ts,
 * admin-role.ts, provider.ts) import from here.
 */

import type { GitClient, ProjectEnvironmentsProps } from "../argocd/index.ts";
import type {
	AdminRoleSpec,
	ProjectMemberSpec,
	ProjectRoleSpec,
} from "../core/spec.ts";
import type {
	GitlabConnection,
	GroupMembersProps,
	MirrorRobotProps,
	ProjectGroupProps,
	RepositoryProps,
	UserProps,
} from "../gitlab/index.ts";
import type {
	GroupMembersProps as HarborGroupMembersProps,
	ProjectProps as HarborProjectProps,
	RobotProps as HarborRobotProps,
	RetentionProps,
} from "../harbor/index.ts";
import type {
	AdminRoleGroupProps,
	KeycloakConnection,
	ProjectGroupsProps,
} from "../keycloak/index.ts";
import type {
	GroupRepoProps,
	MavenReposProps,
	NexusConfig,
	ProjectRolesProps,
} from "../nexus/index.ts";
import { mavenHostedRepoName } from "../nexus/roles.ts";
import type { SonarqubeConnection } from "../sonarqube/credentials.ts";
import type {
	ClusterPrivacy,
	PermissionTemplateProps,
	ProjectPermissionsProps,
	ProjectProps as SonarProjectProps,
} from "../sonarqube/index.ts";
import type {
	IdentityGroupProps,
	ProjectAppRoleProps,
	ProjectPoliciesProps,
	SecretProps,
	VaultConnection,
} from "../vault/index.ts";
import {
	gitlabMirrorCredPath,
	PROJECT_SCOPES,
	projectPolicyName,
	registryGroupSecretPath,
	sonarqubeCredPath,
} from "../vault/paths.ts";

// ---------------------------------------------------------------------------
// Cpn.Project props — the composite's public desired state.
// ---------------------------------------------------------------------------

/** One environment: Keycloak RO/RW groups plus its ArgoCD placement. */
export interface ProjectEnvironmentSpec {
	/** Keycloak env group name and the ArgoCD environment name. */
	readonly name: string;
	/** ArgoCD zone the environment lives in. */
	readonly zoneSlug: string;
	/** ArgoCD cluster label the environment targets. */
	readonly clusterLabel: string;
	/** Emails holding read-only access to the environment groups. */
	readonly roUserEmails: readonly string[];
	/** Emails holding read-write access to the environment groups. */
	readonly rwUserEmails: readonly string[];
}

/** Harbor retention policy; defaults follow the console's weekly sweep. */
export interface ProjectRetentionSpec {
	readonly template: RetentionProps["template"];
	readonly count: number;
	readonly cron: string;
}

export interface ProjectProps {
	/** THE join key every child resource keys on. */
	readonly slug: string;
	readonly name: string;
	readonly description: string;
	/** Owner email — Keycloak top-group member and GitLab OWNER. */
	readonly owner: string;
	/** Core-domain roles; `oidcGroup` is the suffix under `/{slug}/console/`. */
	readonly roles: readonly ProjectRoleSpec[];
	/**
	 * Core-domain members. Email-keyed members fan out to every service;
	 * userId-keyed members keep their id for GitLab memberships but cannot
	 * be mirrored without an email — noted as a gap in docs/usage.md.
	 */
	readonly members: readonly ProjectMemberSpec[];
	readonly environments: readonly ProjectEnvironmentSpec[];
	/** GitLab root group path (console `projectsRootDir`); default `projects`. */
	readonly projectRootDir?: string | undefined;
	/** Primary repository name; default `{slug}-app`. */
	readonly repositoryName?: string | undefined;
	/** External repo URL mirrored by the primary repository. */
	readonly externalRepoUrl?: string | undefined;
	/** SonarQube visibility driver; default `dedicated`. */
	readonly clusterPrivacy?: ClusterPrivacy | undefined;
	/** Nexus npm repos; default false. */
	readonly npm?: boolean | undefined;
	/** Harbor storage quota in bytes; default 10 GiB. */
	readonly storageLimitBytes?: number | undefined;
	/** Harbor robot credential lifetime in days; default 30. */
	readonly robotDurationDays?: number | undefined;
	/** GitLab mirror token lifetime in days; default 90. */
	readonly mirrorTokenExpirationDays?: number | undefined;
	/** Mirror token rotation threshold in days; default 70. */
	readonly mirrorRotationThresholdDays?: number | undefined;
	/** Harbor retention policy; default 10 images since last push, weekly. */
	readonly retention?: ProjectRetentionSpec | undefined;
}

// ---------------------------------------------------------------------------
// Child derivation — pure mapping from composite props to child props.
// Threaded fields (groupId, projectId, repo path, robot secret, sonar
// secret) are filled during reconcile; everything static is derived here.
// ---------------------------------------------------------------------------

const emailLocal = (email: string): string => email.split("@")[0] ?? email;

const DEFAULT_STORAGE_LIMIT = 10 * 1024 * 1024 * 1024;
const DEFAULT_RETENTION: ProjectRetentionSpec = {
	template: "nDaysSinceLastPush",
	count: 10,
	cron: "0 0 0 * * 0",
};

/** Static child props, keyed by child kind. Threaded fields are omitted. */
export interface ProjectChildProps {
	readonly keycloakGroups: ProjectGroupsProps;
	readonly gitlabRootGroup: ProjectGroupProps;
	readonly gitlabProjectGroup: ProjectGroupProps;
	readonly gitlabUsers: readonly UserProps[];
	readonly gitlabRepository: Omit<RepositoryProps, "groupId" | "groupFullPath">;
	readonly gitlabMirrorRobot: Omit<MirrorRobotProps, "groupId">;
	readonly gitlabGroupMembers: Omit<
		GroupMembersProps,
		"groupId" | "gitlabUserIds" | "ownerGitlabUserId"
	>;
	readonly sonarProject: Omit<SonarProjectProps, "repository">;
	readonly sonarPermissions: Omit<ProjectPermissionsProps, "repository">;
	readonly sonarTemplate: PermissionTemplateProps;
	readonly harborProject: HarborProjectProps;
	readonly harborRobots: Readonly<
		Record<"ro" | "rw", Omit<HarborRobotProps, "projectId">>
	>;
	readonly harborRetention: Omit<RetentionProps, "projectId">;
	readonly harborGroupMembers: HarborGroupMembersProps;
	readonly nexusMavenRepos: MavenReposProps;
	readonly nexusGroupRepo: GroupRepoProps;
	readonly nexusProjectRoles: ProjectRolesProps;
	readonly vaultMount: { readonly slug: string };
	readonly vaultPolicies: ProjectPoliciesProps;
	readonly vaultAppRole: ProjectAppRoleProps;
	readonly vaultSecrets: readonly Omit<SecretProps, "data">[];
	readonly vaultIdentityGroups: readonly IdentityGroupProps[];
	readonly argocdEnvironments: ProjectEnvironmentsProps;
}

export const deriveProjectChildProps = (
	props: ProjectProps,
): ProjectChildProps => {
	const slug = props.slug;
	const projectRootDir = props.projectRootDir ?? "projects";
	const repositoryName = props.repositoryName ?? `${slug}-app`;
	const memberEmails = props.members.flatMap((member) =>
		member.email !== undefined ? [member.email] : [],
	);
	const userEmails = [...new Set([props.owner, ...memberEmails])];
	return {
		keycloakGroups: {
			slug,
			ownerEmail: props.owner,
			memberEmails: userEmails,
			roleSuffixes: props.roles.map((role) => role.oidcGroup),
			environments: props.environments.map((environment) => ({
				name: environment.name,
				roUserEmails: [...environment.roUserEmails],
				rwUserEmails: [...environment.rwUserEmails],
			})),
		},
		gitlabRootGroup: { rootGroupPath: projectRootDir },
		gitlabProjectGroup: { rootGroupPath: projectRootDir, slug },
		gitlabUsers: userEmails.map((email) => ({
			email,
			name: emailLocal(email),
			cpnUserId: email,
		})),
		gitlabRepository: {
			name: repositoryName,
			kind: "user",
			externalRepoUrl: props.externalRepoUrl,
			description: props.description,
		},
		gitlabMirrorRobot: {
			slug,
			expirationDays: props.mirrorTokenExpirationDays ?? 90,
			rotationThresholdDays: props.mirrorRotationThresholdDays ?? 70,
		},
		gitlabGroupMembers: {
			slug,
			roles: props.roles.map((role) => ({
				id: role.name,
				oidcGroup: `/${slug}/console/${role.oidcGroup}`,
			})),
			memberships: props.members.map((member) => ({
				userId: member.email ?? member.userId,
				roleIds: [...member.roleIds],
			})),
		},
		sonarProject: { slug, clusterPrivacy: props.clusterPrivacy },
		sonarPermissions: {
			slug,
			vaultSecretPath: sonarqubeCredPath(projectRootDir, slug),
		},
		sonarTemplate: { slug },
		harborProject: {
			name: slug,
			storageLimit: props.storageLimitBytes ?? DEFAULT_STORAGE_LIMIT,
		},
		harborRobots: {
			ro: { slug, kind: "ro", durationDays: props.robotDurationDays ?? 30 },
			rw: { slug, kind: "rw", durationDays: props.robotDurationDays ?? 30 },
		},
		harborRetention: {
			slug,
			template: props.retention?.template ?? DEFAULT_RETENTION.template,
			count: props.retention?.count ?? DEFAULT_RETENTION.count,
			cron: props.retention?.cron ?? DEFAULT_RETENTION.cron,
		},
		harborGroupMembers: { slug },
		nexusMavenRepos: { slug },
		nexusGroupRepo: {
			slug,
			members: [
				mavenHostedRepoName(slug, "release"),
				mavenHostedRepoName(slug, "snapshot"),
			],
		},
		nexusProjectRoles: { slug, npm: props.npm ?? false },
		vaultMount: { slug },
		vaultPolicies: { slug },
		vaultAppRole: { slug },
		vaultSecrets: [
			{
				mount: slug,
				projectRootDir,
				slug,
				path: gitlabMirrorCredPath(projectRootDir, slug, repositoryName),
			},
			{
				mount: slug,
				projectRootDir,
				slug,
				path: sonarqubeCredPath(projectRootDir, slug),
			},
			{
				mount: slug,
				projectRootDir,
				slug,
				path: registryGroupSecretPath(projectRootDir, slug),
			},
		],
		vaultIdentityGroups: PROJECT_SCOPES.map((scope) => ({
			slug,
			scope,
			policies: [projectPolicyName(slug, scope)],
		})),
		argocdEnvironments: {
			projectName: props.name,
			projectSlug: slug,
			zoneSlugs: [...new Set(props.environments.map((env) => env.zoneSlug))],
			environments: props.environments.map((environment) => ({
				zoneSlug: environment.zoneSlug,
				clusterLabel: environment.clusterLabel,
				environmentName: environment.name,
			})),
		},
	};
};

// ---------------------------------------------------------------------------
// Child order — single source of truth. reconcile walks projectCreateOrder,
// delete walks projectDeleteOrder (the exact reverse).
// ---------------------------------------------------------------------------

export const projectCreateOrder = [
	"keycloakGroups",
	"gitlabRootGroup",
	"gitlabProjectGroup",
	"gitlabUsers",
	"gitlabRepository",
	"gitlabMirrorRobot",
	"gitlabGroupMembers",
	"sonarProject",
	"sonarPermissions",
	"sonarTemplate",
	"harborProject",
	"harborRobots",
	"harborRetention",
	"harborGroupMembers",
	"nexusMavenRepos",
	"nexusGroupRepo",
	"nexusProjectRoles",
	"vaultMount",
	"vaultPolicies",
	"vaultAppRole",
	"vaultSecrets",
	"vaultIdentityGroups",
	"argocdEnvironments",
] as const satisfies readonly string[];

export type ProjectChildKind = (typeof projectCreateOrder)[number];

export const projectDeleteOrder: readonly ProjectChildKind[] = [
	...projectCreateOrder,
].reverse();

// ---------------------------------------------------------------------------
// Cpn.AdminRole props + child derivation.
// ---------------------------------------------------------------------------

export interface AdminRoleProps {
	/** Core-domain AdminRole; `oidcGroup` is an absolute platform path. */
	readonly role: AdminRoleSpec;
	/** Emails of users holding this admin role. */
	readonly userEmails: readonly string[];
}

/** Static child props; the group path derives straight from the role. */
export const deriveAdminRoleChildProps = (
	props: AdminRoleProps,
): { readonly keycloakGroup: AdminRoleGroupProps } => ({
	keycloakGroup: {
		groupPath: props.role.oidcGroup,
		userEmails: props.userEmails,
	},
});

export const adminRoleCreateOrder = [
	"keycloakGroup",
] as const satisfies readonly string[];

export type AdminRoleChildKind = (typeof adminRoleCreateOrder)[number];

// ---------------------------------------------------------------------------
// Cpn.Zone props + child derivation. The zone's whole service footprint is
// Vault-side (docs/audit/vault.md): KV mount `zone-<slug>`, tech-readonly
// policy, AppRole. `label`/`argocdUrl` are console-DB metadata no service
// child consumes, so they stay out of the props (see domain-remap.md).
// ---------------------------------------------------------------------------

/** Core-domain zone; `slug` keys every Vault child name. */
export interface ZoneProps {
	/** Zone slug (console: unique, ≤10 chars) — THE join key. */
	readonly slug: string;
}

/** Static child props; every Vault child keys on the zone slug alone. */
export interface ZoneChildProps {
	readonly vaultMount: { readonly zone: string };
	readonly vaultPolicy: { readonly zone: string };
	readonly vaultAppRole: { readonly zone: string };
}

export const deriveZoneChildProps = (props: ZoneProps): ZoneChildProps => ({
	vaultMount: { zone: props.slug },
	vaultPolicy: { zone: props.slug },
	vaultAppRole: { zone: props.slug },
});

export const zoneCreateOrder = [
	"vaultMount",
	"vaultPolicy",
	"vaultAppRole",
] as const satisfies readonly string[];

export type ZoneChildKind = (typeof zoneCreateOrder)[number];

export const zoneDeleteOrder: readonly ZoneChildKind[] = [
	...zoneCreateOrder,
].reverse();

// ---------------------------------------------------------------------------
// CpnProvider config — one field per service client. Pure shape: the
// connection types are imported type-only, so tests can check the shape
// without loading alchemy.
// ---------------------------------------------------------------------------

/** One config object, one field per service. `argocd` is the GitClient. */
export interface CpnProviderConfig {
	readonly keycloak?: KeycloakConnection | undefined;
	readonly gitlab?: GitlabConnection | undefined;
	readonly sonarqube?: SonarqubeConnection | undefined;
	readonly vault?: VaultConnection | undefined;
	readonly nexus?: NexusConfig | undefined;
	readonly harbor?:
		| {
				readonly url: string;
				readonly username: string;
				readonly password: string;
		  }
		| undefined;
	readonly argocd?: GitClient | undefined;
}
