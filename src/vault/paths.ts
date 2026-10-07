/**
 * Name, path, and policy generators shared by every `Cpn.Vault` resource.
 * Mirrors console `vault.service.ts` / `vault.utils.ts` exactly: same
 * policy names, group names, mount names, and KV secret paths, so the
 * Alchemy resources reconcile against console-provisioned Vault state.
 */

export const PROJECT_SCOPES = [
  "admin",
  "devops",
  "developer",
  "readonly",
  "security",
] as const;
export type ProjectScope = (typeof PROJECT_SCOPES)[number];

export type PolicyName =
  | `app--${string}--admin`
  | `tech--${string}--ro`
  | `project--${string}--${ProjectScope}`;

// ---- mounts ----

export const projectMountName = (slug: string): string => slug;

export const zoneMountName = (zone: string): string => `zone-${zone}`;

// ---- policies ----

export const appAdminPolicyName = (slug: string): PolicyName =>
  `app--${slug}--admin`;

export const techReadOnlyPolicyName = (slug: string): PolicyName =>
  `tech--${slug}--ro`;

export const zoneTechReadOnlyPolicyName = (zone: string): PolicyName =>
  `tech--${zoneMountName(zone)}--ro`;

export const projectPolicyName = (
  slug: string,
  scope: ProjectScope,
): PolicyName => `project--${slug}--${scope}`;

/** All ACL policies a project owns, in `ProjectPolicies` reconcile order. */
export const projectPolicyNames = (slug: string): readonly PolicyName[] => [
  appAdminPolicyName(slug),
  techReadOnlyPolicyName(slug),
  projectPolicyName(slug, "devops"),
  projectPolicyName(slug, "developer"),
  projectPolicyName(slug, "readonly"),
  projectPolicyName(slug, "security"),
];

/** HCL policy document for one project ACL policy. */
export const renderProjectPolicy = (
  name: PolicyName,
  slug: string,
  options?: { readonly robotSecretPath?: string; readonly kvName?: string },
): string => {
  if (name === appAdminPolicyName(slug)) {
    return `path "${slug}/*" { capabilities = ["create", "read", "update", "delete", "list"] }`;
  }
  if (name === techReadOnlyPolicyName(slug)) {
    const robotSecretPath =
      options?.robotSecretPath ?? defaultRobotSecretPath(slug);
    const kvName = options?.kvName ?? "kv";
    return `path "${kvName}/data/${robotSecretPath}" { capabilities = ["read"] }`;
  }
  const scope = name.startsWith(`project--${slug}--`)
    ? name.slice(`project--${slug}--`.length)
    : undefined;
  if (scope === "devops") {
    return [
      `path "${slug}/data/*" { capabilities = ["create", "read", "update", "delete", "list"] }`,
      `path "${slug}/metadata/*" { capabilities = ["read", "list"] }`,
      `path "${slug}/delete/*" { capabilities = ["update"] }`,
      `path "${slug}/undelete/*" { capabilities = ["update"] }`,
      `path "${slug}/destroy/*" { capabilities = ["update"] }`,
    ].join("\n");
  }
  if (scope === "developer" || scope === "readonly") {
    return `path "${slug}/data/*" { capabilities = ["list"] }`;
  }
  if (scope === "security") {
    return [
      `path "${slug}/metadata/*" { capabilities = ["list"] }`,
      `path "transit/keys/${slug}/*" { capabilities = ["list"] }`,
    ].join("\n");
  }
  throw new Error(
    `renderProjectPolicy: unknown policy name '${name}' for slug '${slug}'`,
  );
};

const defaultRobotSecretPath = (slug: string): string =>
  `${slug}/REGISTRY/ro-robot`;

// ---- identity groups ----

export const projectGroupName = (slug: string, scope: ProjectScope): string =>
  `project-${slug}-${scope}`;

/** Default `/<slug>/console/<scope>` group-path suffixes per scope. */
export const DEFAULT_GROUP_PATH_SUFFIXES: Readonly<
  Record<ProjectScope, string>
> = {
  admin: "/console/admin",
  devops: "/console/devops",
  developer: "/console/developer",
  readonly: "/console/readonly",
  security: "/console/security",
};

/**
 * Resolve the Keycloak group paths aliasing one project identity group.
 *
 * Console semantics: a raw suffix string (admin plugin config, else project
 * plugin config, else the scope default) may be a comma-separated
 * multi-path list. Each entry is trimmed, empties dropped, and prefixed
 * with `/<slug>`; entries that already carry a leading `/` are treated as
 * suffixes under the project path (console `generateProjectRoleGroupPaths`
 * concatenates `/${slug}` + suffix verbatim).
 */
export const resolveGroupAliasPaths = (
  slug: string,
  scope: ProjectScope,
  rawSuffixes: string | undefined,
): readonly string[] => {
  const raw = rawSuffixes ?? DEFAULT_GROUP_PATH_SUFFIXES[scope];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => (p.startsWith("/") ? `/${slug}${p}` : `/${slug}/${p}`));
};

/**
 * Apply admin > project config precedence for one scope's group-path
 * suffix: admin plugin value wins; project plugin value is the fallback;
 * `undefined` falls back to the scope default inside
 * {@link resolveGroupAliasPaths}.
 */
export const resolveGroupPathSuffix = (
  adminValue: string | undefined,
  projectValue: string | undefined,
): string | undefined => adminValue ?? projectValue;

// ---- approles ----

/** AppRole role name for a project (equals the mount name). */
export const projectAppRoleName = (slug: string): string => slug;

/** AppRole role name for a zone (equals the zone mount name). */
export const zoneAppRoleName = (zone: string): string => zoneMountName(zone);

/** The fixed AppRole body the console applies to every role it manages. */
export const appRoleBody = (
  policies: readonly string[],
): {
  readonly token_type: "batch";
  readonly token_ttl: "0";
  readonly token_max_ttl: "0";
  readonly token_num_uses: "0";
  readonly secret_id_ttl: "0";
  readonly secret_id_num_uses: "0";
  readonly token_policies: readonly string[];
} => ({
  token_type: "batch",
  token_ttl: "0",
  token_max_ttl: "0",
  token_num_uses: "0",
  secret_id_ttl: "0",
  secret_id_num_uses: "0",
  token_policies: policies,
});

// ---- KV secret paths (console vault.utils.ts, projectRootDir-relative) ----

export const projectPath = (projectRootDir: string, slug: string): string =>
  `${projectRootDir}/${slug}`;

export const sonarqubeCredPath = (
  projectRootDir: string,
  slug: string,
): string => `${projectPath(projectRootDir, slug)}/SONAR`;

export const gitlabMirrorCredPath = (
  projectRootDir: string,
  slug: string,
  repoName: string,
): string => `${projectPath(projectRootDir, slug)}/${repoName}-mirror`;

export const techReadOnlyCredPath = (
  projectRootDir: string,
  slug: string,
): string => `${projectPath(projectRootDir, slug)}/tech/GITLAB_MIRROR`;

export const secretGroupPath = (
  projectRootDir: string,
  slug: string,
  group: string,
): string => `${projectPath(projectRootDir, slug)}/${group}`;

export const gitlabGroupSecretPath = (
  projectRootDir: string,
  slug: string,
): string => secretGroupPath(projectRootDir, slug, "GITLAB");

export const registryGroupSecretPath = (
  projectRootDir: string,
  slug: string,
): string => secretGroupPath(projectRootDir, slug, "REGISTRY");
