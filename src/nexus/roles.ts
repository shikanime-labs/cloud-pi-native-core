/**
 * Nexus naming and role-mapping rules, extracted from the console's
 * `nexus.service.ts` / `nexus.constants.ts`.
 *
 * Repo names per audit: `{slug}-maven-release`, `{slug}-maven-snapshot`,
 * `{slug}-npm`, group `{slug}-repository-group`.
 */

/** Write-policy applied to the Maven release repo (immutable releases). */
export const MAVEN_RELEASE_WRITE_POLICY = "allow_once";
/** Write-policy applied to the Maven snapshot and npm repos. */
export const MAVEN_SNAPSHOT_WRITE_POLICY = "allow";
export const NPM_WRITE_POLICY = "allow";

export const DEFAULT_WRITE_GROUP_PATH_SUFFIXES =
  "/console/admin,/console/devops";
export const DEFAULT_READ_GROUP_PATH_SUFFIXES =
  "/console/developer,/console/readonly";

/** Platform roles aggregate privileges across ALL projects. */
export const PLATFORM_ROLES = [
  "console-admin",
  "console-readonly",
  "console-security",
] as const;

export const DEFAULT_PLATFORM_WRITE_GROUP_PATHS = "/console/admin";
export const DEFAULT_PLATFORM_READ_GROUP_PATHS =
  "/console/readonly,/console/security";

export type MavenRepoKind = "release" | "snapshot";

export const mavenHostedRepoName = (
  slug: string,
  kind: MavenRepoKind,
): string => `${slug}-maven-${kind}`;

export const npmHostedRepoName = (slug: string): string => `${slug}-npm`;

export const npmGroupRepoName = (slug: string): string => `${slug}-npm-group`;

export const groupRepoName = (slug: string): string =>
  `${slug}-repository-group`;

export const mavenHostedPrivilegeName = (
  slug: string,
  kind: MavenRepoKind,
): string => `${slug}-maven-${kind}-privilege`;

export const npmHostedPrivilegeName = (slug: string): string =>
  `${slug}-npm-privilege`;

export const npmGroupPrivilegeName = (slug: string): string =>
  `${slug}-npm-group-privilege`;

export const groupPrivilegeName = (slug: string): string =>
  `${slug}-group-privilege`;

const readonly = (name: string): string => `${name}-ro`;

export const projectWritePrivileges = (
  slug: string,
  npm: boolean,
): ReadonlyArray<string> => {
  const write = [
    mavenHostedPrivilegeName(slug, "release"),
    mavenHostedPrivilegeName(slug, "snapshot"),
    groupPrivilegeName(slug),
  ];
  if (npm)
    write.push(npmHostedPrivilegeName(slug), npmGroupPrivilegeName(slug));
  return write;
};

export const projectReadPrivileges = (
  slug: string,
  npm: boolean,
): ReadonlyArray<string> => {
  const read = [
    readonly(mavenHostedPrivilegeName(slug, "release")),
    readonly(mavenHostedPrivilegeName(slug, "snapshot")),
    readonly(groupPrivilegeName(slug)),
  ];
  if (npm)
    read.push(
      readonly(npmHostedPrivilegeName(slug)),
      readonly(npmGroupPrivilegeName(slug)),
    );
  return read;
};

/**
 * Parse a comma-separated group-path list, trimming and dropping empties.
 * `" /a/b , ,/c "` → `["/a/b", "/c"]`.
 */
export const parseGroupPaths = (raw: string): ReadonlyArray<string> =>
  raw
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path.length > 0);

/** `/{slug}{suffix}` — suffix keeps its leading slash, so no extra `/`. */
export const projectGroupPaths = (
  slug: string,
  suffixes: ReadonlyArray<string>,
): ReadonlyArray<string> => suffixes.map((suffix) => `/${slug}${suffix}`);

/** `/a/b/c` → `a-b-c` (Nexus role ids forbid `/`). */
export const roleId = (groupPath: string): string => {
  const trimmed = groupPath.trim();
  const withoutLeadingSlash = trimmed.startsWith("/")
    ? trimmed.slice(1)
    : trimmed;
  return withoutLeadingSlash.replaceAll("/", "-");
};

export interface ProjectRoleInputs {
  readonly slug: string;
  readonly npm: boolean;
  /** Project-level overrides for the suffix lists. */
  readonly writeSuffixes?: string;
  readonly readSuffixes?: string;
  /** Admin-level overrides; when set they win over the project values. */
  readonly adminWriteSuffixes?: string;
  readonly adminReadSuffixes?: string;
}

export interface ProjectRoles {
  /** role id → privileges. */
  readonly roles: ReadonlyArray<{
    id: string;
    privileges: ReadonlyArray<string>;
  }>;
}

/**
 * Suffix→privilege mapping with precedence: admin overrides > project
 * overrides > defaults. A group path mapped by both a write and a read
 * suffix resolves to the WRITE privilege set (write wins, matching the
 * console's role-upsert order).
 */
export const computeProjectRoles = (
  inputs: ProjectRoleInputs,
): ProjectRoles => {
  const writeSuffixes = parseGroupPaths(
    inputs.adminWriteSuffixes ??
      inputs.writeSuffixes ??
      DEFAULT_WRITE_GROUP_PATH_SUFFIXES,
  );
  const readSuffixes = parseGroupPaths(
    inputs.adminReadSuffixes ??
      inputs.readSuffixes ??
      DEFAULT_READ_GROUP_PATH_SUFFIXES,
  );

  const byId = new Map<string, ReadonlyArray<string>>();
  for (const path of projectGroupPaths(inputs.slug, readSuffixes)) {
    byId.set(roleId(path), projectReadPrivileges(inputs.slug, inputs.npm));
  }
  for (const path of projectGroupPaths(inputs.slug, writeSuffixes)) {
    byId.set(roleId(path), projectWritePrivileges(inputs.slug, inputs.npm));
  }
  return {
    roles: [...byId.entries()].map(([id, privileges]) => ({ id, privileges })),
  };
};

export interface PlatformRoleInputs {
  /**
   * Every project's privilege contribution. Even projects with no repos
   * contribute (their roles exist but grant nothing).
   */
  readonly projects: ReadonlyArray<{ slug: string; npm: boolean }>;
  readonly writeGroupPaths?: string;
  readonly readGroupPaths?: string;
}

export interface PlatformRoles {
  readonly roles: ReadonlyArray<{
    id: string;
    privileges: ReadonlyArray<string>;
  }>;
}

/**
 * Platform-role aggregation: privileges UNION across all projects, then
 * mapped onto platform group paths. `console-admin` gets the full write
 * union, `console-readonly`/`console-security` the read union.
 */
export const computePlatformRoles = (
  inputs: PlatformRoleInputs,
): PlatformRoles => {
  const write = new Set<string>();
  const read = new Set<string>();
  for (const project of inputs.projects) {
    for (const privilege of projectWritePrivileges(project.slug, project.npm))
      write.add(privilege);
    for (const privilege of projectReadPrivileges(project.slug, project.npm))
      read.add(privilege);
  }

  const writePaths = parseGroupPaths(
    inputs.writeGroupPaths ?? DEFAULT_PLATFORM_WRITE_GROUP_PATHS,
  );
  const readPaths = parseGroupPaths(
    inputs.readGroupPaths ?? DEFAULT_PLATFORM_READ_GROUP_PATHS,
  );

  const byId = new Map<string, ReadonlyArray<string>>();
  for (const path of readPaths) byId.set(roleId(path), [...read]);
  for (const path of writePaths) byId.set(roleId(path), [...write]);
  return {
    roles: [...byId.entries()].map(([id, privileges]) => ({ id, privileges })),
  };
};

/**
 * Cleanup ordering: roles and privileges are deleted BEFORE the repositories
 * they reference, and group repos BEFORE the hosted repos they aggregate
 * (Nexus 500s on deleting a repo still referenced by a group). Returns the
 * unit's full teardown sequence for a project slug — the resources split
 * this order among themselves and the engine's reverse-dependency destroy
 * keeps the invariant.
 */
export interface CleanupStep {
  readonly kind: "role" | "privilege" | "repository";
  readonly name: string;
}

export const cleanupOrder = (
  slug: string,
  npm: boolean,
): ReadonlyArray<CleanupStep> => {
  const steps: CleanupStep[] = [
    ...computeProjectRoles({ slug, npm }).roles.map((role) => ({
      kind: "role" as const,
      name: role.id,
    })),
    ...projectReadPrivileges(slug, npm).map((name) => ({
      kind: "privilege" as const,
      name,
    })),
    ...projectWritePrivileges(slug, npm).map((name) => ({
      kind: "privilege" as const,
      name,
    })),
    { kind: "repository", name: groupRepoName(slug) },
    { kind: "repository", name: mavenHostedRepoName(slug, "release") },
    { kind: "repository", name: mavenHostedRepoName(slug, "snapshot") },
  ];
  if (npm) {
    steps.push(
      { kind: "repository", name: npmGroupRepoName(slug) },
      { kind: "repository", name: npmHostedRepoName(slug) },
    );
  }
  return steps;
};
