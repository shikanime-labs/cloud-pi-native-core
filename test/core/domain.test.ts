import { describe, expect, it } from "vitest";
import {
  AdminRoleSchema,
  ClusterSchema,
  EnvironmentSchema,
  ProjectMemberSchema,
  ProjectRoleSchema,
  ProjectSchema,
  StageSchema,
  ZoneSchema,
  grantPermissions,
  hasPermission,
  revokePermissions,
  roleGroupPath,
} from "../../src/core/index.js";

const project = {
  slug: "dso",
  name: "Cloud Pi Native",
  description: "console extraction",
  owner: "owner@example.fr",
  status: "created",
  roles: [
    {
      name: "admin",
      permissions: 896n,
      position: 0,
      oidcGroup: "admin",
      type: "managed",
    },
  ],
  members: [{ email: "dev@example.fr", roleIds: ["role-uuid-1"] }],
};

describe("roleGroupPath", () => {
  it("derives /<slug>/console/<suffix>", () => {
    expect(roleGroupPath("dso", "admin")).toBe("/dso/console/admin");
    expect(roleGroupPath("dso", "devops")).toBe("/dso/console/devops");
  });

  it("keeps nested suffixes verbatim", () => {
    expect(roleGroupPath("dso", "plugin/security")).toBe(
      "/dso/console/plugin/security",
    );
  });
});

describe("permission bitmasks", () => {
  const read = 1n;
  const write = 2n;
  const admin = 4n;

  it("grants, checks, revokes", () => {
    const perms = grantPermissions(0n, read, write);
    expect(perms).toBe(3n);
    expect(hasPermission(perms, read)).toBe(true);
    expect(hasPermission(perms, admin)).toBe(false);
    const revoked = revokePermissions(perms, write, admin);
    expect(revoked).toBe(1n);
  });

  it("stays BigInt beyond 2^53 (no Number rounding)", () => {
    const high = 1n << 64n;
    const perms = grantPermissions(0n, high);
    expect(perms).toBe(18446744073709551616n);
    expect(hasPermission(perms, high)).toBe(true);
    expect(hasPermission(revokePermissions(perms, high), high)).toBe(false);
  });
});

describe("zod round-trips", () => {
  it("Project parses and re-serializes", () => {
    const parsed = ProjectSchema.parse(project);
    expect(parsed).toEqual(project);
    expect(parsed.roles[0]?.permissions).toBe(896n);
  });

  it("rejects bad owner email and bad status", () => {
    expect(() => ProjectSchema.parse({ ...project, owner: "not-an-email" })).toThrow();
    expect(() => ProjectSchema.parse({ ...project, status: "unknown" })).toThrow();
  });

  it("rejects a member carrying both email and userId", () => {
    expect(() =>
      ProjectMemberSchema.parse({
        email: "a@example.fr",
        userId: "user-1",
        roleIds: [],
      }),
    ).toThrow();
  });

  it("accepts a userId-only member", () => {
    const member = { userId: "user-1", roleIds: ["r1"] };
    expect(ProjectMemberSchema.parse(member)).toEqual(member);
  });

  it("Zone caps slug at 10 chars", () => {
    const zone = { slug: "platform", label: "Platform", argocdUrl: "https://argo.example.fr" };
    expect(ZoneSchema.parse(zone)).toEqual(zone);
    expect(() => ZoneSchema.parse({ ...zone, slug: "0123456789A" })).toThrow();
  });

  it("Cluster parses privacy enum", () => {
    const cluster = {
      label: "c1",
      privacy: "dedicated",
      secretName: "kube-c1",
      zoneId: "zone-1",
      cpu: 8,
      gpu: 0,
      memory: 32,
    };
    expect(ClusterSchema.parse(cluster)).toEqual(cluster);
    expect(() => ClusterSchema.parse({ ...cluster, privacy: "shared" })).toThrow();
  });

  it("Stage parses", () => {
    const stage = { name: "prod" };
    expect(StageSchema.parse(stage)).toEqual(stage);
  });

  it("Environment caps name at 11 chars", () => {
    const env = {
      name: "prod-eu-west",
      projectId: "p1",
      clusterId: "c1",
      stageId: "s1",
      quota: { memory: 1, cpu: 1, gpu: 0 },
      autosync: true,
    };
    expect(() => EnvironmentSchema.parse(env)).toThrow(); // 12 chars
    expect(EnvironmentSchema.parse({ ...env, name: "prod-eu-w" })).toEqual({
      ...env,
      name: "prod-eu-w",
    });
  });

  it("ProjectRole / AdminRole parse bigint permissions", () => {
    const role = {
      name: "devops",
      permissions: 2n ** 64n,
      position: 1,
      oidcGroup: "devops",
      type: "managed",
    };
    expect(ProjectRoleSchema.parse(role)).toEqual(role);
    expect(AdminRoleSchema.parse({ ...role, oidcGroup: "/admin" })).toEqual({
      ...role,
      oidcGroup: "/admin",
    });
    expect(() => ProjectRoleSchema.parse({ ...role, permissions: 896 })).toThrow();
  });
});
