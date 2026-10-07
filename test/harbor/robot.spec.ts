import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import * as api from "../../src/harbor/api.ts";
import {
  HarborClient,
  type HarborCredentials,
} from "../../src/harbor/client.ts";
import { kindName, robotFullName } from "../../src/harbor/roles.ts";

const makeScriptedClient = (
  responses: Array<{ status: number; body: string }>,
) => {
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  const queue = [...responses];
  const service = {
    get url() {
      return "https://harbor.example.test";
    },
    credentials: () =>
      Effect.succeed<HarborCredentials>({ username: "admin", password: "x" }),
    request: (path: string, init?: RequestInit) =>
      Effect.sync(() => {
        const next = queue.shift();
        if (next === undefined) throw new Error(`unexpected request: ${path}`);
        const raw = init?.body;
        calls.push({
          method: init?.method ?? "GET",
          path,
          body: typeof raw === "string" ? raw : undefined,
        });
        return new Response(next.body === "" ? null : next.body, {
          status: next.status,
          headers: { "Content-Type": "application/json" },
        });
      }),
  };
  return { calls, layer: Layer.succeed(HarborClient, service) };
};

describe("robot name derivation", () => {
  it("derives console robot names per kind", () => {
    expect(kindName("ro")).toBe("ro-robot");
    expect(kindName("rw")).toBe("rw-robot");
    expect(kindName("project")).toBe("project-robot");
  });

  it("full name is robot$<slug>+<name>", () => {
    expect(robotFullName("demo", kindName("ro"))).toBe("robot$demo+ro-robot");
    expect(robotFullName("demo", kindName("rw"))).toBe("robot$demo+rw-robot");
    expect(robotFullName("demo", kindName("project"))).toBe(
      "robot$demo+project-robot",
    );
  });
});

describe("createRobot", () => {
  it("sends the Harbor project-level robot create body", async () => {
    const { calls, layer } = makeScriptedClient([
      {
        status: 201,
        body: JSON.stringify({
          id: 5,
          name: "robot$demo+ro-robot",
          secret: "s3cret",
        }),
      },
    ]);
    const created = await Effect.runPromise(
      Effect.provide(
        api.createRobot({
          name: "ro-robot",
          durationDays: 90,
          description: "robot for ci builds",
          namespace: "demo",
          access: [{ resource: "repository", action: "pull" }],
        }),
        layer,
      ),
    );
    expect(created.id).toBe(5);
    expect(created.secret).toBe("s3cret");
    const sent = JSON.parse(calls[0]?.body ?? "{}");
    expect(sent).toMatchObject({
      name: "ro-robot",
      duration: 90,
      disable: false,
      level: "project",
      permissions: [
        {
          namespace: "demo",
          kind: "project",
          access: [{ resource: "repository", action: "pull" }],
        },
      ],
    });
  });

  it("fails with HarborRobotConflict on 400 body code CONFLICT and never rotates", async () => {
    const { calls, layer } = makeScriptedClient([
      {
        status: 400,
        body: JSON.stringify({
          errors: [
            { code: "CONFLICT", message: "robot account already exists" },
          ],
        }),
      },
    ]);
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        api.createRobot({
          name: "ro-robot",
          durationDays: 90,
          description: "d",
          namespace: "demo",
          access: [],
        }),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const defect = exit.cause;
      expect(String(defect).includes("Harbor robot already exists")).toBe(true);
    }
    // No delete ever issued — the racing run owns the robot.
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });
});
