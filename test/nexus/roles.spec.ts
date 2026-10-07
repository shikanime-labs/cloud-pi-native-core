import { describe, expect, it } from "vitest";
import {
  cleanupOrder,
  computePlatformRoles,
  computeProjectRoles,
  groupPrivilegeName,
  mavenHostedPrivilegeName,
  npmGroupPrivilegeName,
  npmHostedPrivilegeName,
  projectReadPrivileges,
  projectWritePrivileges,
  roleId,
} from "../../src/nexus/roles.js";

const writePriv = (slug: string, npm: boolean) => [
  mavenHostedPrivilegeName(slug, "release"),
  mavenHostedPrivilegeName(slug, "snapshot"),
  groupPrivilegeName(slug),
  ...(npm ? [npmHostedPrivilegeName(slug), npmGroupPrivilegeName(slug)] : []),
];

const readPriv = (slug: string, npm: boolean) =>
  writePriv(slug, npm).map((name) => `${name}-ro`);

const roleById = (
  roles: ReadonlyArray<{ id: string; privileges: ReadonlyArray<string> }>,
): Map<string, { id: string; privileges: ReadonlyArray<string> }> =>
  new Map(roles.map((r) => [r.id, r]));

describe("suffix → privilege mapping", () => {
  it("maps default write suffixes to full privileges and read suffixes to read privileges", () => {
    const { roles } = computeProjectRoles({ slug: "apollo", npm: false });
    const byId = roleById(roles);

    // Default write suffixes /console/admin,/console/devops → /apollo/console/...
    expect(byId.get(roleId("/apollo/console/admin"))?.privileges).toEqual(
      projectWritePrivileges("apollo", false),
    );
    expect(byId.get(roleId("/apollo/console/devops"))?.privileges).toEqual(
      projectWritePrivileges("apollo", false),
    );
    // Default read suffixes /console/developer,/console/readonly
    expect(byId.get(roleId("/apollo/console/developer"))?.privileges).toEqual(
      projectReadPrivileges("apollo", false),
    );
    expect(byId.get(roleId("/apollo/console/readonly"))?.privileges).toEqual(
      projectReadPrivileges("apollo", false),
    );
  });

  it("gives write roles the full privilege set and read roles only read privileges", () => {
    const { roles } = computeProjectRoles({ slug: "apollo", npm: true });
    const byId = roleById(roles);
    const admin = byId.get(roleId("/apollo/console/admin"));
    const developer = byId.get(roleId("/apollo/console/developer"));
    if (admin === undefined || developer === undefined)
      throw new Error("missing roles");
    for (const privilege of writePriv("apollo", true)) {
      expect(admin.privileges).toContain(privilege);
    }
    expect(admin.privileges).not.toContain(
      `${npmGroupPrivilegeName("apollo")}-ro`,
    );
    for (const privilege of readPriv("apollo", true)) {
      expect(developer.privileges).toContain(privilege);
    }
    expect(developer.privileges).not.toContain(npmGroupPrivilegeName("apollo"));
  });

  it("admin overrides win over project overrides, which win over defaults", () => {
    // project override
    const projectOnly = computeProjectRoles({
      slug: "apollo",
      npm: false,
      writeSuffixes: "/leads",
    });
    const projectIds = projectOnly.roles.map((r) => r.id);
    expect(projectIds).toContain(roleId("/apollo/leads"));
    expect(projectIds).not.toContain(roleId("/apollo/console/admin"));

    // admin override beats project override
    const withAdmin = computeProjectRoles({
      slug: "apollo",
      npm: false,
      writeSuffixes: "/leads",
      adminWriteSuffixes: "/console/admin",
    });
    const adminIds = withAdmin.roles.map((r) => r.id);
    expect(adminIds).toContain(roleId("/apollo/console/admin"));
    expect(adminIds).not.toContain(roleId("/apollo/leads"));
  });

  it("a group path mapped by both write and read suffixes resolves to write", () => {
    const { roles } = computeProjectRoles({
      slug: "apollo",
      npm: false,
      writeSuffixes: "/shared",
      readSuffixes: "/shared",
    });
    const byId = roleById(roles);
    expect(byId.get(roleId("/apollo/shared"))?.privileges).toEqual(
      projectWritePrivileges("apollo", false),
    );
  });

  it("npm toggles the npm privileges inside every role", () => {
    const without = computeProjectRoles({ slug: "apollo", npm: false });
    const withNpm = computeProjectRoles({ slug: "apollo", npm: true });
    const writeRoleIds = ["apollo/console/admin", "apollo/console/devops"].map(
      (id) => id.replaceAll("/", "-"),
    );
    for (const role of withNpm.roles) {
      const isWriteRole = writeRoleIds.includes(role.id);
      expect(role.privileges).toContain(
        isWriteRole
          ? npmHostedPrivilegeName("apollo")
          : `${npmHostedPrivilegeName("apollo")}-ro`,
      );
    }
    for (const role of without.roles) {
      expect(role.privileges).not.toContain(npmHostedPrivilegeName("apollo"));
      expect(role.privileges).not.toContain(
        `${npmHostedPrivilegeName("apollo")}-ro`,
      );
    }
  });
});

describe("platform-role aggregation", () => {
  it("unions privileges across ALL projects", () => {
    const { roles } = computePlatformRoles({
      projects: [
        { slug: "apollo", npm: false },
        { slug: "borealis", npm: true },
      ],
    });
    const byId = roleById(roles);
    const admin = byId.get(roleId("/console/admin"));
    if (admin === undefined) throw new Error("missing console-admin");

    const expectedWrite = new Set([
      ...writePriv("apollo", false),
      ...writePriv("borealis", true),
    ]);
    expect(new Set(admin.privileges)).toEqual(expectedWrite);

    const readonly = byId.get(roleId("/console/readonly"));
    const security = byId.get(roleId("/console/security"));
    if (readonly === undefined || security === undefined)
      throw new Error("missing read roles");
    const expectedRead = new Set([
      ...readPriv("apollo", false),
      ...readPriv("borealis", true),
    ]);
    expect(new Set(readonly.privileges)).toEqual(expectedRead);
    expect(new Set(security.privileges)).toEqual(expectedRead);
  });

  it("removing a project removes its privileges from the union (re-aggregation)", () => {
    const before = computePlatformRoles({
      projects: [
        { slug: "apollo", npm: false },
        { slug: "borealis", npm: false },
      ],
    });
    const after = computePlatformRoles({
      projects: [{ slug: "apollo", npm: false }],
    });
    const adminBefore = roleById(before.roles).get(roleId("/console/admin"));
    const adminAfter = roleById(after.roles).get(roleId("/console/admin"));
    if (adminBefore === undefined || adminAfter === undefined)
      throw new Error("missing roles");
    expect(adminBefore.privileges).toContain(groupPrivilegeName("borealis"));
    expect(adminAfter.privileges).not.toContain(groupPrivilegeName("borealis"));
  });

  it("no projects yields empty-privilege roles that still exist", () => {
    const { roles } = computePlatformRoles({ projects: [] });
    expect(roles.map((r) => r.id).sort()).toEqual([
      roleId("/console/admin"),
      roleId("/console/readonly"),
      roleId("/console/security"),
    ]);
    for (const role of roles) expect(role.privileges).toEqual([]);
  });
});

describe("cleanup ordering", () => {
  it("deletes roles and privileges before repositories, group repo before hosted", () => {
    const steps = cleanupOrder("apollo", true);
    const kinds = steps.map((s) => s.kind);

    // roles first
    expect(kinds.indexOf("role")).toBe(0);
    // every role/privilege step precedes every repository step
    const firstRepo = kinds.indexOf("repository");
    for (const [i, step] of steps.entries()) {
      if (step.kind !== "repository" && i > firstRepo) {
        throw new Error(
          `non-repository step "${step.name}" after repositories began`,
        );
      }
    }
    const groupIndex = steps.findIndex(
      (s) => s.name === "apollo-repository-group",
    );
    const releaseIndex = steps.findIndex(
      (s) => s.name === "apollo-maven-release",
    );
    const snapshotIndex = steps.findIndex(
      (s) => s.name === "apollo-maven-snapshot",
    );
    const npmGroupIndex = steps.findIndex((s) => s.name === "apollo-npm-group");
    const npmHostedIndex = steps.findIndex((s) => s.name === "apollo-npm");
    expect(groupIndex).toBeLessThan(releaseIndex);
    expect(groupIndex).toBeLessThan(snapshotIndex);
    expect(npmGroupIndex).toBeLessThan(npmHostedIndex);
  });

  it("omits npm repos when not specificallyEnabled", () => {
    const names = cleanupOrder("apollo", false).map((s) => s.name);
    expect(names).not.toContain("apollo-npm");
    expect(names).not.toContain("apollo-npm-group");
    expect(names).not.toContain(npmHostedPrivilegeName("apollo"));
  });

  it("project role ids appear in cleanup (they are deleted with privileges)", () => {
    const names = cleanupOrder("apollo", false).map((s) => s.name);
    expect(names).toContain(roleId("/apollo/console/admin"));
    expect(names).toContain(roleId("/apollo/console/developer"));
  });
});
