/**
 * Pure Keycloak group-path and membership derivations mirroring the console's
 * keycloak.utils.ts / keycloak.service.ts: same tree shape, same orphan rules,
 * so resources reconcile against console-provisioned Keycloak state.
 */

export const CONSOLE_GROUP_NAME = "console";
export const ENV_READ_ONLY_GROUP_NAME = "RO";
export const ENV_READ_WRITE_GROUP_NAME = "RW";

/**
 * Role-group suffixes the console seeds for every project. `security` arrives
 * through the security plugin's seeded role but lands in the same create list.
 */
export const SEEDED_ROLE_SUFFIXES = [
  "admin",
  "devops",
  "developer",
  "readonly",
  "security",
] as const;
export type SeededRoleSuffix = (typeof SEEDED_ROLE_SUFFIXES)[number];

export const splitGroupPath = (path: string): readonly string[] =>
  path.split("/").filter((part) => part.length > 0);

export const joinGroupPath = (...parts: readonly string[]): string =>
  `/${parts.flatMap(splitGroupPath).join("/")}`;

export const isNonEmptyGroupPath = (
  value: string | undefined,
): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const toGroupPath = (value: string | undefined): string | undefined => {
  if (!isNonEmptyGroupPath(value)) return undefined;
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
};

export const projectGroupPath = (slug: string): string => `/${slug}`;

export const consoleGroupPath = (slug: string): string =>
  joinGroupPath(projectGroupPath(slug), CONSOLE_GROUP_NAME);

export const roleGroupPath = (slug: string, suffix: string): string =>
  joinGroupPath(consoleGroupPath(slug), suffix);

export const envGroupPaths = (
  slug: string,
  envName: string,
): { readonly ro: string; readonly rw: string } => ({
  ro: joinGroupPath(consoleGroupPath(slug), envName, ENV_READ_ONLY_GROUP_NAME),
  rw: joinGroupPath(consoleGroupPath(slug), envName, ENV_READ_WRITE_GROUP_NAME),
});

/** Console toRoleRelativeGroupPath: strip the console-group prefix from an absolute oidcGroup. */
export const roleRelativeGroupPath = (
  oidcGroup: string,
  consoleGroup: string,
): string => oidcGroup.replace(consoleGroup, "");

export const desiredProjectMembers = (
  ownerEmail: string,
  memberEmails: readonly string[],
): ReadonlySet<string> => new Set([ownerEmail, ...memberEmails]);

export interface EnvironmentMembersSpec {
  readonly name: string;
  readonly roUserEmails: readonly string[];
  readonly rwUserEmails: readonly string[];
}

/** The owner holds every environment permission (console getUserPermissions). */
export const desiredEnvGroupMembers = (
  ownerEmail: string,
  environment: EnvironmentMembersSpec,
): {
  readonly ro: ReadonlySet<string>;
  readonly rw: ReadonlySet<string>;
} => ({
  ro: new Set([ownerEmail, ...environment.roUserEmails]),
  rw: new Set([ownerEmail, ...environment.rwUserEmails]),
});

export const desiredEmailSet = (
  emails: readonly string[],
): ReadonlySet<string> => new Set(emails);

export const additionSet = (
  current: ReadonlySet<string>,
  desired: ReadonlySet<string>,
): ReadonlySet<string> =>
  new Set([...desired].filter((email) => !current.has(email)));

export const evictionSet = (
  current: ReadonlySet<string>,
  desired: ReadonlySet<string>,
): ReadonlySet<string> =>
  new Set([...current].filter((email) => !desired.has(email)));

export interface GroupSummary {
  readonly id: string;
  readonly name: string;
  readonly subGroups: readonly { readonly name: string }[];
}

export const isOwnedProjectGroup = (group: GroupSummary): boolean =>
  group.subGroups.some((sub) => sub.name === CONSOLE_GROUP_NAME);

/** Top-level group not matching a current slug AND carrying a console subgroup. */
export const findOrphanTopGroups = (
  topGroups: readonly GroupSummary[],
  currentSlugs: ReadonlySet<string>,
): readonly GroupSummary[] =>
  topGroups.filter(
    (group) => !currentSlugs.has(group.name) && isOwnedProjectGroup(group),
  );

export const isEnvironmentGroup = (group: GroupSummary): boolean =>
  group.subGroups.some(
    (sub) =>
      sub.name === ENV_READ_ONLY_GROUP_NAME ||
      sub.name === ENV_READ_WRITE_GROUP_NAME,
  );

/** Console children shaped like an environment group whose name no longer matches. */
export const findOrphanEnvGroups = (
  consoleChildren: readonly GroupSummary[],
  envNames: ReadonlySet<string>,
): readonly GroupSummary[] =>
  consoleChildren.filter(
    (group) => isEnvironmentGroup(group) && !envNames.has(group.name),
  );
