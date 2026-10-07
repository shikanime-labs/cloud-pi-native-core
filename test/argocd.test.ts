import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  appProjectName,
  groupPaths,
  purgeActions,
  renderEnvironmentValues,
  sweepActions,
  upsertAction,
  valuesFilePath,
} from "../src/argocd/values.ts";

describe("valuesFilePath", () => {
  it("derives the console's three-segment values path", () => {
    expect(valuesFilePath("Project 1", "cluster-1", "dev")).toBe(
      "Project 1/cluster-1/dev/values.yaml",
    );
  });
});

describe("appProjectName", () => {
  it("hashes the environment name with HMAC-SHA256('') truncated to 4 hex chars", () => {
    expect(appProjectName("project-1", "dev")).toBe("project-1-dev-6293");
    expect(appProjectName("project-1", "prod")).toBe("project-1-prod-c626");
    expect(appProjectName("project-1", "staging")).toBe(
      "project-1-staging-41a5",
    );
    expect(appProjectName("project-1", "integration")).toBe(
      "project-1-integration-4a09",
    );
  });
});

describe("groupPaths", () => {
  it("maps all nine OIDC group path keys", () => {
    expect(groupPaths("project-1", "dev")).toEqual({
      roGroup: "/project-1/console/dev/RO",
      rwGroup: "/project-1/console/dev/RW",
      consoleAdminGroup: "/console/admin",
      platformAdminGroup: "/console/admin",
      platformReadonlyGroup: "/console/readonly",
      platformSecurityGroup: "/console/security",
      projectAdminGroup: "/project-1/console/admin",
      projectDevopsGroup: "/project-1/console/devops",
      projectDevelopperGroup: "/project-1/console/developer",
      projectSecurityGroup: "/project-1/console/security",
    });
  });
});

describe("renderEnvironmentValues", () => {
  it("renders the AppProject name and the nine group paths as YAML", () => {
    const document = parse(renderEnvironmentValues("project-1", "dev"));
    expect(document).toEqual({
      argocd: { project: "project-1-dev-6293" },
      environment: groupPaths("project-1", "dev"),
    });
  });
});

describe("purgeActions", () => {
  const projectName = "Project 1";

  it("deletes leftover values files not in the needed set", () => {
    const existing = [
      "Project 1/cluster-1/dev/values.yaml",
      "Project 1/cluster-2/prod/values.yaml",
      "Project 1/README.md",
    ];
    const needed = ["Project 1/cluster-1/dev/values.yaml"];
    expect(purgeActions(existing, needed, projectName)).toEqual([
      { action: "delete", filePath: "Project 1/cluster-2/prod/values.yaml" },
    ]);
  });

  it("keeps files outside the project prefix", () => {
    expect(purgeActions(["Other/values.yaml"], [], projectName)).toEqual([]);
  });

  it("keeps non-values files under the project prefix", () => {
    expect(
      purgeActions(["Project 1/cluster-1/dev/notes.txt"], [], projectName),
    ).toEqual([]);
  });

  it("returns nothing when the old and new sets match", () => {
    const paths = ["Project 1/cluster-1/dev/values.yaml"];
    expect(purgeActions(paths, paths, projectName)).toEqual([]);
  });
});

describe("sweepActions", () => {
  it("deletes every values file under the project prefix on project delete", () => {
    expect(
      sweepActions(
        [
          "Project 1/cluster-1/dev/values.yaml",
          "Project 1/cluster-2/prod/values.yaml",
          "Project 1/README.md",
          "Other/values.yaml",
        ],
        "Project 1",
      ),
    ).toEqual([
      { action: "delete", filePath: "Project 1/cluster-1/dev/values.yaml" },
      { action: "delete", filePath: "Project 1/cluster-2/prod/values.yaml" },
    ]);
  });
});

describe("upsertAction", () => {
  const content = "environment:\n  roGroup: /p/console/dev/RO\n";

  it("returns null on identical content (no-op commit detection)", () => {
    expect(
      upsertAction(content, "p/cluster/dev/values.yaml", content),
    ).toBeNull();
  });

  it("creates when the file does not exist", () => {
    expect(
      upsertAction(undefined, "p/cluster/dev/values.yaml", content),
    ).toEqual({
      action: "create",
      filePath: "p/cluster/dev/values.yaml",
      content,
    });
  });

  it("updates when the content differs", () => {
    expect(upsertAction("old", "p/cluster/dev/values.yaml", content)).toEqual({
      action: "update",
      filePath: "p/cluster/dev/values.yaml",
      content,
    });
  });
});
