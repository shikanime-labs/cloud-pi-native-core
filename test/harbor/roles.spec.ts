import { describe, expect, it } from "vitest";
import {
  isRegistryConflict,
  isRetentionDuplicate,
} from "../../src/harbor/conflict.ts";
import {
  defaultGroupPaths,
  HARBOR_ROLE_DEVELOPER,
  HARBOR_ROLE_GUEST,
  HARBOR_ROLE_PROJECT_ADMIN,
  harborRoleByGroup,
  robotFullName,
} from "../../src/harbor/roles.ts";

describe("isRegistryConflict", () => {
  it("treats a bare 409 as conflict (project create duplicate)", () => {
    expect(isRegistryConflict({ status: 409, body: "" })).toBe(true);
    expect(isRegistryConflict({ status: 409, body: null })).toBe(true);
  });

  it("treats 400 with body code CONFLICT as conflict (robot create duplicate)", () => {
    const body = JSON.stringify({
      errors: [{ code: "CONFLICT", message: "robot already exists" }],
    });
    expect(isRegistryConflict({ status: 400, body })).toBe(true);
  });

  it("does NOT treat 400 BAD_REQUEST without CONFLICT code as conflict", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "BAD_REQUEST",
          message: "project already has retention policy",
        },
      ],
    });
    expect(isRegistryConflict({ status: 400, body })).toBe(false);
  });

  it("does not treat other statuses or malformed bodies as conflict", () => {
    expect(isRegistryConflict({ status: 404, body: "" })).toBe(false);
    expect(isRegistryConflict({ status: 500, body: "boom" })).toBe(false);
    expect(isRegistryConflict({ status: 400, body: "not json" })).toBe(false);
    expect(
      isRegistryConflict({ status: 400, body: JSON.stringify({ errors: [] }) }),
    ).toBe(false);
  });
});

describe("isRetentionDuplicate", () => {
  it("identifies the 400 'already has retention policy' duplicate", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "BAD_REQUEST",
          message:
            "failed to add retention policy: project already has retention policy",
        },
      ],
    });
    expect(isRetentionDuplicate({ status: 400, body })).toBe(true);
  });

  it("rejects other 400s", () => {
    expect(
      isRetentionDuplicate({
        status: 400,
        body: JSON.stringify({ errors: [{ code: "CONFLICT", message: "" }] }),
      }),
    ).toBe(false);
    expect(isRetentionDuplicate({ status: 409, body: "" })).toBe(false);
  });
});

describe("harborRoleByGroup", () => {
  it("maps project /{slug}/console/admin to DEVELOPER (2), NOT PROJECT_ADMIN", () => {
    const mapping = harborRoleByGroup(defaultGroupPaths("demo"));
    expect(mapping.get("/demo/console/admin")).toBe(HARBOR_ROLE_DEVELOPER);
    expect(mapping.get("/demo/console/admin")).not.toBe(
      HARBOR_ROLE_PROJECT_ADMIN,
    );
  });

  it("collapses guest, developer, maintainer and platform-guest to GUEST (3)", () => {
    const mapping = harborRoleByGroup(defaultGroupPaths("demo"));
    expect(mapping.get("/demo/console/security")).toBe(HARBOR_ROLE_GUEST);
    expect(mapping.get("/demo/console/readonly")).toBe(HARBOR_ROLE_GUEST);
    expect(mapping.get("/demo/console/developer")).toBe(HARBOR_ROLE_GUEST);
    expect(mapping.get("/demo/console/devops")).toBe(HARBOR_ROLE_GUEST);
    expect(mapping.get("/console/security")).toBe(HARBOR_ROLE_GUEST);
    expect(mapping.get("/console/readonly")).toBe(HARBOR_ROLE_GUEST);
  });

  it("gives PROJECT_ADMIN only to platform /console/admin", () => {
    const mapping = harborRoleByGroup(defaultGroupPaths("demo"));
    expect(mapping.get("/console/admin")).toBe(HARBOR_ROLE_PROJECT_ADMIN);
  });
});

describe("robotFullName", () => {
  it("derives robot$<slug>+<name>", () => {
    expect(robotFullName("demo", "ro-robot")).toBe("robot$demo+ro-robot");
    expect(robotFullName("demo", "rw-robot")).toBe("robot$demo+rw-robot");
    expect(robotFullName("demo", "project-robot")).toBe(
      "robot$demo+project-robot",
    );
  });
});
