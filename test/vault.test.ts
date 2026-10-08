import { describe, expect, it } from "vitest";
import {
  appAdminPolicyName,
  appRoleBody,
  DEFAULT_GROUP_PATH_SUFFIXES,
  clusterSecretPath,
  gitlabGroupSecretPath,
  gitlabMirrorCredPath,
  projectGroupName,
  projectMountName,
  projectPolicyName,
  projectPolicyNames,
  registryGroupSecretPath,
  renderProjectPolicy,
  resolveGroupAliasPaths,
  resolveGroupPathSuffix,
  sonarqubeCredPath,
  techReadOnlyCredPath,
  techReadOnlyPolicyName,
  zoneAppRoleName,
  zoneMountName,
  zoneTechReadOnlyPolicyName,
} from "../src/vault/paths.ts";

describe("mount names", () => {
  it("project mount name is the bare slug", () => {
    expect(projectMountName("cpged")).toBe("cpged");
  });
  it("zone mount name is zone-prefixed", () => {
    expect(zoneMountName("scw1")).toBe("zone-scw1");
  });
});

describe("policy names", () => {
  it("renders the console policy name scheme", () => {
    expect(appAdminPolicyName("cpged")).toBe("app--cpged--admin");
    expect(techReadOnlyPolicyName("cpged")).toBe("tech--cpged--ro");
    expect(projectPolicyName("cpged", "devops")).toBe("project--cpged--devops");
    expect(zoneTechReadOnlyPolicyName("scw1")).toBe("tech--zone-scw1--ro");
  });
  it("enumerates all six project policies", () => {
    expect(projectPolicyNames("cpged")).toEqual([
      "app--cpged--admin",
      "tech--cpged--ro",
      "project--cpged--devops",
      "project--cpged--developer",
      "project--cpged--readonly",
      "project--cpged--security",
    ]);
  });
});

describe("HCL policy rendering", () => {
  it("app admin: full CRUD+list on the mount root", () => {
    expect(renderProjectPolicy("app--cpged--admin", "cpged")).toBe(
      'path "cpged/*" { capabilities = ["create", "read", "update", "delete", "list"] }',
    );
  });
  it("tech ro: single read grant on the platform kv robot secret", () => {
    expect(renderProjectPolicy("tech--cpged--ro", "cpged")).toBe(
      'path "kv/data/cpged/REGISTRY/ro-robot" { capabilities = ["read"] }',
    );
  });
  it("tech ro honors custom kv mount and robot path", () => {
    expect(
      renderProjectPolicy("tech--cpged--ro", "cpged", {
        kvName: "platform",
        robotSecretPath: "cpged/REGISTRY/custom-robot",
      }),
    ).toBe(
      'path "platform/data/cpged/REGISTRY/custom-robot" { capabilities = ["read"] }',
    );
  });
  it("devops: KV-v2 full surface", () => {
    expect(renderProjectPolicy("project--cpged--devops", "cpged")).toBe(
      [
        'path "cpged/data/*" { capabilities = ["create", "read", "update", "delete", "list"] }',
        'path "cpged/metadata/*" { capabilities = ["read", "list"] }',
        'path "cpged/delete/*" { capabilities = ["update"] }',
        'path "cpged/undelete/*" { capabilities = ["update"] }',
        'path "cpged/destroy/*" { capabilities = ["update"] }',
      ].join("\n"),
    );
  });
  it("developer and readonly: list-only", () => {
    const expected = 'path "cpged/data/*" { capabilities = ["list"] }';
    expect(renderProjectPolicy("project--cpged--developer", "cpged")).toBe(
      expected,
    );
    expect(renderProjectPolicy("project--cpged--readonly", "cpged")).toBe(
      expected,
    );
  });
  it("security: metadata + transit keys listing", () => {
    expect(renderProjectPolicy("project--cpged--security", "cpged")).toBe(
      [
        'path "cpged/metadata/*" { capabilities = ["list"] }',
        'path "transit/keys/cpged/*" { capabilities = ["list"] }',
      ].join("\n"),
    );
  });
});

describe("identity groups", () => {
  it("group name is project-<slug>-<scope>", () => {
    expect(projectGroupName("cpged", "devops")).toBe("project-cpged-devops");
  });
  it("default alias path is /<slug>/console/<scope>", () => {
    expect(resolveGroupAliasPaths("cpged", "devops", undefined)).toEqual([
      "/cpged/console/devops",
    ]);
    expect(DEFAULT_GROUP_PATH_SUFFIXES.admin).toBe("/console/admin");
  });
  it("admin config beats project config", () => {
    expect(resolveGroupPathSuffix("/custom/admin", "/custom/project")).toBe(
      "/custom/admin",
    );
    expect(resolveGroupPathSuffix(undefined, "/custom/project")).toBe(
      "/custom/project",
    );
    expect(resolveGroupPathSuffix(undefined, undefined)).toBeUndefined();
  });
  it("comma-separated multi-path config yields multiple aliases", () => {
    expect(
      resolveGroupAliasPaths(
        "cpged",
        "admin",
        "/console/admin,/teams/cpged-maintainers",
      ),
    ).toEqual(["/cpged/console/admin", "/cpged/teams/cpged-maintainers"]);
  });
  it("entries are trimmed and empties dropped", () => {
    expect(resolveGroupAliasPaths("cpged", "devops", " /a , ,/b ")).toEqual([
      "/cpged/a",
      "/cpged/b",
    ]);
  });
  it("suffix without leading slash is still scoped under /<slug>", () => {
    expect(resolveGroupAliasPaths("cpged", "devops", "teams/devops")).toEqual([
      "/cpged/teams/devops",
    ]);
  });
});

describe("approles", () => {
  it("role names follow the mount names", () => {
    expect(zoneAppRoleName("scw1")).toBe("zone-scw1");
  });
  it("body is batch tokens, all-zero ttl/uses, wired policies", () => {
    expect(appRoleBody(["tech--cpged--ro", "app--cpged--admin"])).toEqual({
      token_type: "batch",
      token_ttl: "0",
      token_max_ttl: "0",
      token_num_uses: "0",
      secret_id_ttl: "0",
      secret_id_num_uses: "0",
      token_policies: ["tech--cpged--ro", "app--cpged--admin"],
    });
  });
});

describe("KV secret paths", () => {
  it("matches console vault.utils.ts generators", () => {
    expect(sonarqubeCredPath("projects", "cpged")).toBe("projects/cpged/SONAR");
    expect(gitlabMirrorCredPath("projects", "cpged", "api")).toBe(
      "projects/cpged/api-mirror",
    );
    expect(techReadOnlyCredPath("projects", "cpged")).toBe(
      "projects/cpged/tech/GITLAB_MIRROR",
    );
    expect(gitlabGroupSecretPath("projects", "cpged")).toBe(
      "projects/cpged/GITLAB",
    );
    expect(registryGroupSecretPath("projects", "cpged")).toBe(
      "projects/cpged/REGISTRY",
    );
  });
  it("cluster secret lives on the zone mount under clusters/", () => {
    expect(clusterSecretPath("cluster-1")).toBe(
      "clusters/cluster-1/argocd-cluster-secret",
    );
  });
});
