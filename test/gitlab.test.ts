import { describe, expect, it } from "vitest";
import {
  ACCESS_LEVEL_DEVELOPER,
  ACCESS_LEVEL_GUEST,
  ACCESS_LEVEL_MAINTAINER,
  ACCESS_LEVEL_OWNER,
  ACCESS_LEVEL_REPORTER,
  adminRoleFlag,
  daysAgoFromNow,
  defaultRoleGroupPaths,
  generateAccessLevelMapping,
  generateAdminRoleMapping,
  generateProjectRoleGroupPaths,
  generateUsername,
  generateUsernameCandidates,
  isMirrorTokenExpiring,
  isOwnedUser,
  mirrorRobotTokenName,
  mirrorTokenExpiryDate,
  mirrorTriggerVariables,
  parseGroupPaths,
  pluginManagedTopics,
  projectGroupFullPath,
  shouldRemoveMember,
  systemManagedTopics,
} from "../src/gitlab/utils.ts";

describe("parseGroupPaths / generateProjectRoleGroupPaths", () => {
  it("splits comma-separated multi-path suffix lists, trimming and dropping empties", () => {
    expect(parseGroupPaths("/console/admin, /console/devops,,")).toEqual([
      "/console/admin",
      "/console/devops",
    ]);
  });

  it("expands suffixes into fully-qualified project role group paths", () => {
    expect(
      generateProjectRoleGroupPaths("cpged", "/console/admin,/console/devops"),
    ).toEqual(["/cpged/console/admin", "/cpged/console/devops"]);
  });

  it("defaults mirror the console plugin constants", () => {
    expect(defaultRoleGroupPaths("cpged")).toEqual({
      reporter: ["/cpged/console/readonly", "/cpged/console/security"],
      developer: ["/cpged/console/developer"],
      maintainer: ["/cpged/console/admin", "/cpged/console/devops"],
    });
  });
});

describe("generateAccessLevelMapping", () => {
  const roles = [
    { id: "admin", oidcGroup: "/cpged/console/admin" },
    { id: "devops", oidcGroup: "/cpged/console/devops" },
    { id: "developer", oidcGroup: "/cpged/console/developer" },
    { id: "readonly", oidcGroup: "/cpged/console/readonly" },
    { id: "security", oidcGroup: "/cpged/console/security" },
    { id: "unmapped", oidcGroup: "/elsewhere" },
  ];
  const paths = defaultRoleGroupPaths("cpged");

  it("maps maintainer suffixes /console/admin,/console/devops to MAINTAINER(40)", () => {
    const mapping = generateAccessLevelMapping(
      roles,
      [{ userId: "u1", roleIds: ["admin"] }],
      paths,
    );
    expect(mapping.get("u1")).toBe(ACCESS_LEVEL_MAINTAINER);
    const mapping2 = generateAccessLevelMapping(
      roles,
      [{ userId: "u1", roleIds: ["devops"] }],
      paths,
    );
    expect(mapping2.get("u1")).toBe(ACCESS_LEVEL_MAINTAINER);
  });

  it("maps developer suffix /console/developer to DEVELOPER(30)", () => {
    const mapping = generateAccessLevelMapping(
      roles,
      [{ userId: "u1", roleIds: ["developer"] }],
      paths,
    );
    expect(mapping.get("u1")).toBe(ACCESS_LEVEL_DEVELOPER);
  });

  it("maps reporter suffixes /console/readonly,/console/security to REPORTER(20)", () => {
    for (const roleId of ["readonly", "security"]) {
      const mapping = generateAccessLevelMapping(
        roles,
        [{ userId: "u1", roleIds: [roleId] }],
        paths,
      );
      expect(mapping.get("u1")).toBe(ACCESS_LEVEL_REPORTER);
    }
  });

  it("falls back to GUEST(10) when no role group matches", () => {
    const mapping = generateAccessLevelMapping(
      roles,
      [
        { userId: "u1", roleIds: ["unmapped"] },
        { userId: "u2", roleIds: [] },
      ],
      paths,
    );
    expect(mapping.get("u1")).toBe(ACCESS_LEVEL_GUEST);
    expect(mapping.get("u2")).toBe(ACCESS_LEVEL_GUEST);
  });

  it("takes the HIGHEST level across a member's roleIds", () => {
    const mapping = generateAccessLevelMapping(
      roles,
      [{ userId: "u1", roleIds: ["readonly", "developer", "devops"] }],
      paths,
    );
    expect(mapping.get("u1")).toBe(ACCESS_LEVEL_MAINTAINER);
    const lower = generateAccessLevelMapping(
      roles,
      [{ userId: "u1", roleIds: ["readonly", "developer"] }],
      paths,
    );
    expect(lower.get("u1")).toBe(ACCESS_LEVEL_DEVELOPER);
  });

  it("honors overridden suffix sets (admin>project override chain)", () => {
    const overridden = {
      reporter: generateProjectRoleGroupPaths("cpged", "/console/custom-ro"),
      developer: generateProjectRoleGroupPaths("cpged", "/console/dev"),
      maintainer: generateProjectRoleGroupPaths("cpged", "/console/custom-ma"),
    };
    const mapping = generateAccessLevelMapping(
      [
        { id: "r", oidcGroup: "/cpged/console/custom-ro" },
        { id: "d", oidcGroup: "/cpged/console/dev" },
        { id: "m", oidcGroup: "/cpged/console/custom-ma" },
        { id: "old", oidcGroup: "/cpged/console/admin" },
      ],
      [{ userId: "u1", roleIds: ["r", "d", "m", "old"] }],
      overridden,
    );
    // old default path no longer maps → only the overrides count
    expect(mapping.get("u1")).toBe(ACCESS_LEVEL_MAINTAINER);
    const fallback = generateAccessLevelMapping(
      [{ id: "old", oidcGroup: "/cpged/console/admin" }],
      [{ userId: "u2", roleIds: ["old"] }],
      overridden,
    );
    expect(fallback.get("u2")).toBe(ACCESS_LEVEL_GUEST);
  });

  it("handles role ids absent from the roles list (removed roles)", () => {
    const mapping = generateAccessLevelMapping(
      roles,
      [{ userId: "u1", roleIds: ["ghost"] }],
      paths,
    );
    expect(mapping.get("u1")).toBe(ACCESS_LEVEL_GUEST);
  });

  it("NO_ACCESS(0) never appears; a desired 0 means remove", () => {
    expect(shouldRemoveMember(0)).toBe(true);
    expect(shouldRemoveMember(ACCESS_LEVEL_GUEST)).toBe(false);
  });
});

describe("owner handling", () => {
  it("OWNER is 50 — distinct from MAINTAINER and above every tier", () => {
    expect(ACCESS_LEVEL_OWNER).toBe(50);
    expect(ACCESS_LEVEL_OWNER).toBeGreaterThan(ACCESS_LEVEL_MAINTAINER);
  });
});

describe("generateUsername", () => {
  it("derives the username from the email local part, stripping non-\\w-", () => {
    expect(generateUsername("jean.dupont+work@x.fr")).toBe("jeandupontwork");
    expect(generateUsername("a.b@c.d")).toBe("ab");
    expect(generateUsername("already-clean_1-x@y.z")).toBe("already-clean_1-x");
  });

  it("candidates are the username plus _1.._3", () => {
    expect(generateUsernameCandidates("jean@x.fr")).toEqual([
      "jean",
      "jean_1",
      "jean_2",
      "jean_3",
    ]);
  });
});

describe("adminRoleFlag / generateAdminRoleMapping", () => {
  it("empty resolved role ids → undefined (flag untouched)", () => {
    expect(adminRoleFlag({ adminRoleIds: ["x"] }, [])).toBeUndefined();
  });

  it("member → true, non-member → false", () => {
    expect(adminRoleFlag({ adminRoleIds: ["x"] }, ["y", "x"])).toBe(true);
    expect(adminRoleFlag({ adminRoleIds: ["z"] }, ["y", "x"])).toBe(false);
  });

  it("resolves admin/auditor role ids from oidc group paths, deduped", () => {
    const roles = [
      { id: "admin-id", oidcGroup: "/console/admin" },
      { id: "readonly-id", oidcGroup: "/console/readonly" },
      { id: "security-id", oidcGroup: "/console/security" },
    ];
    expect(
      generateAdminRoleMapping(
        roles,
        ["/console/admin"],
        ["/console/readonly", "/console/security"],
      ),
    ).toEqual({
      adminRoleIds: ["admin-id"],
      auditorRoleIds: ["readonly-id", "security-id"],
    });
    expect(
      generateAdminRoleMapping(
        [{ id: "r", oidcGroup: "/console/readonly" }],
        ["/none"],
        ["/console/readonly", "/console/readonly"],
      ),
    ).toEqual({ adminRoleIds: [], auditorRoleIds: ["r"] });
  });
});

describe("mirror robot rotation", () => {
  const now = new Date("2026-10-07T12:00:00Z");

  it("rotates when age is STRICTLY past the threshold", () => {
    expect(isMirrorTokenExpiring("2026-10-06T12:00:00Z", 1, now)).toBe(false); // exactly 1 day: not past
    expect(isMirrorTokenExpiring("2026-10-05T11:59:00Z", 1, now)).toBe(true); // > 1 day
    expect(isMirrorTokenExpiring(undefined, 1, now)).toBe(false); // missing time
  });

  it("threshold must be below expiry: expiry date derives from expirationDays", () => {
    expect(mirrorTokenExpiryDate(30, now)).toBe("2026-11-06");
    expect(mirrorRobotTokenName("cpged")).toBe("cpged-bot");
  });
});

describe("mirror trigger variables", () => {
  it("derives SYNC_ALL / GIT_BRANCH_DEPLOY / PROJECT_NAME", () => {
    expect(
      mirrorTriggerVariables({
        projectSlug: "cpged",
        targetRepo: "api",
        syncAllBranches: false,
        branchName: "release/1.2",
      }),
    ).toEqual({
      SYNC_ALL: "false",
      GIT_BRANCH_DEPLOY: "release/1.2",
      PROJECT_NAME: "api",
    });
  });

  it("a full sync sends an EMPTY GIT_BRANCH_DEPLOY and stringified SYNC_ALL", () => {
    expect(
      mirrorTriggerVariables({
        projectSlug: "cpged",
        targetRepo: "api",
        syncAllBranches: true,
      }),
    ).toEqual({ SYNC_ALL: "true", GIT_BRANCH_DEPLOY: "", PROJECT_NAME: "api" });
  });

  it("refuses the system repos mirror and infra-apps", () => {
    expect(() =>
      mirrorTriggerVariables({
        projectSlug: "cpged",
        targetRepo: "mirror",
        syncAllBranches: true,
      }),
    ).toThrow();
    expect(() =>
      mirrorTriggerVariables({
        projectSlug: "cpged",
        targetRepo: "infra-apps",
        syncAllBranches: false,
        branchName: "main",
      }),
    ).toThrow();
  });
});

describe("topics / ownership / paths", () => {
  const now = new Date("2026-10-07T12:00:00Z");

  it("user repos are plugin-managed; system repos plugin+system managed", () => {
    expect(pluginManagedTopics()).toEqual(["plugin-managed"]);
    expect(systemManagedTopics()).toEqual(["plugin-managed", "system-managed"]);
  });

  it("group bots are owned users excluded from orphan purge", () => {
    expect(isOwnedUser("group_123_bot")).toBe(true);
    expect(isOwnedUser("jean")).toBe(false);
  });

  it("project subgroup full path is {root}/{slug}", () => {
    expect(projectGroupFullPath("projects", "cpged")).toBe("projects/cpged");
  });

  it("daysAgoFromNow floors to whole days", () => {
    expect(daysAgoFromNow(new Date("2026-10-06T13:00:00Z"), now)).toBe(0);
    expect(daysAgoFromNow(new Date("2026-10-05T12:00:00Z"), now)).toBe(2);
  });
});
