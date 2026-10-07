import * as Effect from "effect/Effect";
import type {
  HarborMember,
  HarborProject,
  HarborQuota,
  HarborRobot,
  HarborRobotCreated,
} from "./client.ts";
import {
  decodeHarborMembers,
  decodeHarborProject,
  decodeHarborQuotas,
  decodeHarborRobot,
  decodeHarborRobotCreated,
  HarborClient,
  HarborHttpError,
  readJsonBody,
} from "./client.ts";
import { isRegistryConflict, isRetentionDuplicate } from "./conflict.ts";

// ---------------------------------------------------------------------------
// Typed Harbor API operations over HarborClient. Each returns decoded
// domain objects; conflicts are surfaced via Either-free tagged errors so
// reconcilers can branch on them without try/catch noise.
// ---------------------------------------------------------------------------

const nameHeaders = { "X-Is-Resource-Name": "true" };

export class HarborProjectNotFound extends Error {
  constructor(name: string) {
    super(`Harbor project not found (${name})`);
  }
}

/**
 * Read a project by name; undefined when Harbor 404s.
 */
export const getProject = (
  name: string,
): Effect.Effect<HarborProject | undefined, HarborHttpError, HarborClient> =>
  Effect.gen(function* () {
    const client = yield* HarborClient;
    const response = yield* client.request(
      `projects/${encodeURIComponent(name)}`,
      {
        headers: nameHeaders,
      },
    );
    if (response.status === 404) return undefined;
    if (response.status >= 400) {
      return yield* failWith(response, "GET", `projects/${name}`);
    }
    return decodeHarborProject(
      yield* Effect.promise(() => readJsonBody(response)),
    );
  });

const failWith = (
  response: Response,
  method: string,
  path: string,
): Effect.Effect<never, HarborHttpError> =>
  Effect.flatMap(
    Effect.promise(async () => {
      const body = await response.text().catch(() => "");
      return { status: response.status, body } as const;
    }),
    (errorResponse) =>
      Effect.fail(
        new HarborHttpError({
          status: errorResponse.status,
          method,
          path,
          body: errorResponse.body,
        }),
      ),
  );

/**
 * Harbor robot create duplicate — the racing run owns the robot and its
 * secret; this client NEVER rotates on conflict.
 */
export class HarborRobotConflict extends Error {
  readonly name: string;
  constructor(name: string) {
    super(`Harbor robot already exists (${name})`);
    this.name = name;
  }
}

export const listProjectRobots = (
  projectId: number,
): Effect.Effect<HarborRobot[], HarborHttpError, HarborClient> =>
  Effect.gen(function* () {
    const client = yield* HarborClient;
    const robots: HarborRobot[] = [];
    for (let page = 1; ; page++) {
      const response = yield* client.request(
        `robots?page=${page}&page_size=100&q=${encodeURIComponent(`Level=project,ProjectID=${projectId}`)}`,
      );
      if (response.status >= 400) {
        return yield* failWith(response, "GET", "robots");
      }
      const body = yield* Effect.promise(() => readJsonBody(response));
      if (!Array.isArray(body)) return robots;
      for (const item of body) {
        const robot = decodeHarborRobot(item);
        if (robot !== undefined) robots.push(robot);
      }
      if (body.length < 100) return robots;
    }
  });

export interface RobotCreate {
  readonly name: string;
  readonly durationDays: number;
  readonly description: string;
  readonly namespace: string;
  readonly access: ReadonlyArray<{ resource: string; action: string }>;
}

export const createRobot = (
  body: RobotCreate,
): Effect.Effect<
  HarborRobotCreated,
  HarborRobotConflict | HarborHttpError,
  HarborClient
> =>
  Effect.gen(function* () {
    const client = yield* HarborClient;
    const response = yield* client.request("robots", {
      method: "POST",
      body: JSON.stringify({
        name: body.name,
        duration: body.durationDays,
        description: body.description,
        disable: false,
        level: "project",
        permissions: [
          {
            namespace: body.namespace,
            kind: "project",
            access: body.access,
          },
        ],
      }),
    });
    if (response.status >= 400) {
      const errorBody = yield* Effect.promise(async () => ({
        status: response.status,
        body: await response.text().catch(() => ""),
      }));
      if (isRegistryConflict(errorBody)) {
        // The raced robot belongs to the concurrent run that owns its
        // secret — never rotate here; rotation is the explicit path.
        return yield* Effect.fail(new HarborRobotConflict(body.name));
      }
      return yield* Effect.fail(
        new HarborHttpError({
          status: response.status,
          method: "POST",
          path: "robots",
          body: errorBody.body,
        }),
      );
    }
    const created = decodeHarborRobotCreated(
      yield* Effect.promise(() => readJsonBody(response)),
    );
    if (created === undefined) {
      return yield* Effect.fail(
        new HarborHttpError({
          status: response.status,
          method: "POST",
          path: "robots",
          body: "undecodable robot create response",
        }),
      );
    }
    return created;
  });

export const deleteRobot = (
  robotId: number,
): Effect.Effect<void, HarborHttpError, HarborClient> =>
  Effect.gen(function* () {
    const client = yield* HarborClient;
    const response = yield* client.request(
      `robots/${encodeURIComponent(String(robotId))}`,
      { method: "DELETE" },
    );
    if (response.status >= 400 && response.status !== 404) {
      return yield* failWith(response, "DELETE", `robots/${robotId}`);
    }
  });

export const getGroupMembers = (
  projectName: string,
): Effect.Effect<HarborMember[], HarborHttpError, HarborClient> =>
  Effect.gen(function* () {
    const client = yield* HarborClient;
    const response = yield* client.request(
      `projects/${encodeURIComponent(projectName)}/members`,
      {
        headers: nameHeaders,
      },
    );
    if (response.status >= 400) {
      return yield* failWith(
        response,
        "GET",
        `projects/${projectName}/members`,
      );
    }
    return (
      decodeHarborMembers(
        yield* Effect.promise(() => readJsonBody(response)),
      ) ?? []
    );
  });

export const putGroupMember = (
  projectName: string,
  groupName: string,
  roleId: number,
): Effect.Effect<void, HarborHttpError, HarborClient> =>
  Effect.gen(function* () {
    const client = yield* HarborClient;
    const response = yield* client.request(
      `projects/${encodeURIComponent(projectName)}/members`,
      {
        method: "POST",
        headers: nameHeaders,
        body: JSON.stringify({
          role_id: roleId,
          member_group: { group_name: groupName, group_type: 3 },
        }),
      },
    );
    if (response.status >= 400) {
      return yield* failWith(
        response,
        "POST",
        `projects/${projectName}/members`,
      );
    }
  });

export const deleteGroupMember = (
  projectName: string,
  memberId: number,
): Effect.Effect<void, HarborHttpError, HarborClient> =>
  Effect.gen(function* () {
    const client = yield* HarborClient;
    const response = yield* client.request(
      `projects/${encodeURIComponent(projectName)}/members/${encodeURIComponent(String(memberId))}`,
      { method: "DELETE", headers: nameHeaders },
    );
    if (response.status >= 400 && response.status !== 404) {
      return yield* failWith(
        response,
        "DELETE",
        `projects/${projectName}/members/${memberId}`,
      );
    }
  });

export const listQuotas = (
  projectId: number,
): Effect.Effect<HarborQuota[], HarborHttpError, HarborClient> =>
  Effect.gen(function* () {
    const client = yield* HarborClient;
    const response = yield* client.request(
      `quotas?reference_id=${encodeURIComponent(String(projectId))}`,
    );
    if (response.status >= 400) {
      return yield* failWith(response, "GET", "quotas");
    }
    return (
      decodeHarborQuotas(yield* Effect.promise(() => readJsonBody(response))) ??
      []
    );
  });

export const updateQuota = (
  projectId: number,
  storageLimit: number,
): Effect.Effect<void, HarborHttpError, HarborClient> =>
  Effect.gen(function* () {
    const client = yield* HarborClient;
    const response = yield* client.request(
      `quotas/${encodeURIComponent(String(projectId))}`,
      {
        method: "PUT",
        body: JSON.stringify({ hard: { storage: storageLimit } }),
      },
    );
    if (response.status >= 400) {
      return yield* failWith(response, "PUT", `quotas/${projectId}`);
    }
  });

export interface RetentionRule {
  readonly template: string;
  readonly count: number;
}

export interface RetentionPolicy {
  readonly algorithm: "or" | "and";
  readonly scope: { readonly level: "project"; readonly ref: number };
  readonly rules: readonly RetentionRule[];
  readonly trigger: {
    readonly kind: "Schedule";
    readonly settings: { readonly cron?: string };
    readonly references: readonly unknown[];
  };
}

/**
 * Plain read-then-create idempotent write of a project's single retention
 * policy — Harbor allows exactly one per project, and a duplicate create
 * answers 400 BAD_REQUEST "already has retention policy". No ensure()
 * wrapper: the duplicate signal is message-identified, not a conflict.
 */
export const putRetention = (
  projectName: string,
  policy: RetentionPolicy,
): Effect.Effect<void, HarborHttpError, HarborClient> =>
  Effect.gen(function* () {
    const retentionId = yield* getRetentionId(projectName);
    if (retentionId === null) {
      const client = yield* HarborClient;
      const response = yield* client.request("retentions", {
        method: "POST",
        body: JSON.stringify(toHarborRetentionPolicy(policy)),
      });
      if (response.status >= 400) {
        const errorBody = yield* Effect.promise(async () => ({
          status: response.status,
          body: await response.text().catch(() => ""),
        }));
        // A racing sync created the policy between our read and create;
        // fall through to PUT the desired policy on the raced id.
        if (!isRetentionDuplicate(errorBody)) {
          return yield* Effect.fail(
            new HarborHttpError({
              status: response.status,
              method: "POST",
              path: "retentions",
              body: errorBody.body,
            }),
          );
        }
        const raced = yield* getRetentionId(projectName);
        if (raced === null) {
          return yield* Effect.fail(
            new HarborHttpError({
              status: response.status,
              method: "POST",
              path: "retentions",
              body: errorBody.body,
            }),
          );
        }
        return yield* updateRetention(raced, policy);
      }
      return;
    }
    return yield* updateRetention(retentionId, policy);
  });

const getRetentionId = (
  projectName: string,
): Effect.Effect<number | null, HarborHttpError, HarborClient> =>
  Effect.map(
    getProject(projectName),
    (project) => project?.retentionId ?? null,
  );

const updateRetention = (retentionId: number, policy: RetentionPolicy) =>
  Effect.gen(function* () {
    const client = yield* HarborClient;
    const response = yield* client.request(
      `retentions/${encodeURIComponent(String(retentionId))}`,
      {
        method: "PUT",
        body: JSON.stringify(toHarborRetentionPolicy(policy)),
      },
    );
    if (response.status >= 400) {
      return yield* failWith(response, "PUT", `retentions/${retentionId}`);
    }
  });

const toHarborRetentionPolicy = (policy: RetentionPolicy) => ({
  algorithm: policy.algorithm,
  scope: policy.scope,
  rules: policy.rules.map((rule) => ({
    disabled: false,
    action: "retain",
    template: rule.template,
    params: { [rule.template]: rule.count },
    tag_selectors: [
      { kind: "doublestar", decoration: "matches", pattern: "**" },
    ],
    scope_selectors: {
      repository: [
        { kind: "doublestar", decoration: "repoMatches", pattern: "**" },
      ],
    },
  })),
  trigger: policy.trigger,
});
