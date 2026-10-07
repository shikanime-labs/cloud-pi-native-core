import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as api from "./api.ts";
import {
  HarborClient,
  HarborHttpError,
  type HarborProject,
  readJsonBody,
} from "./client.ts";
import { isRegistryConflict } from "./conflict.ts";

export interface ProjectProps {
  /** Harbor project name — the console project slug. */
  readonly name: string;
  /** Storage quota in bytes; -1 means unlimited. */
  readonly storageLimit: number;
}

export interface Project extends Resource<
  "Cpn.Harbor.Project",
  ProjectProps,
  {
    readonly projectId: number;
    readonly name: string;
    readonly storageLimit: number;
    readonly retentionId: number | null;
  }
> {}

/**
 * A Harbor project with its storage quota. Duplicate create is a real HTTP
 * 409 with no body — the reconciler reloads by name and converges.
 */
export const Project = Resource<Project>("Cpn.Harbor.Project");

const decodeProject = (body: unknown): HarborProject | undefined => {
  const schema = Schema.Struct({
    project_id: Schema.Number,
    name: Schema.String,
    metadata: Schema.optional(
      Schema.Struct({
        retention_id: Schema.optional(
          Schema.Union(Schema.Number, Schema.String),
        ),
      }),
    ),
  });
  const parsed = Schema.decodeUnknownEither(schema)(body);
  if (parsed._tag !== "Right") return undefined;
  const retentionId = Number(parsed.right.metadata?.retention_id);
  return {
    projectId: parsed.right.project_id,
    name: parsed.right.name,
    retentionId: Number.isFinite(retentionId) ? retentionId : null,
  };
};

const readProject = (name: string) =>
  Effect.gen(function* () {
    const client = yield* HarborClient;
    const response = yield* client.request(
      `projects/${encodeURIComponent(name)}`,
      {
        headers: { "X-Is-Resource-Name": "true" },
      },
    );
    if (response.status === 404) return undefined;
    if (response.status >= 400) {
      return yield* apiFail(response, "GET", `projects/${name}`);
    }
    return decodeProject(yield* Effect.promise(() => readJsonBody(response)));
  });

const apiFail = (
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

const ensureQuota = (projectId: number, storageLimit: number) =>
  Effect.gen(function* () {
    const quotas = yield* api.listQuotas(projectId);
    const current = quotas.find((quota) => quota.refId === projectId);
    if (current?.storage !== storageLimit) {
      yield* api.updateQuota(projectId, storageLimit);
    }
  });

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    read: ({ olds, output }) =>
      Effect.gen(function* () {
        const observed = yield* readProject(olds?.name ?? output?.name ?? "");
        if (observed === undefined) return undefined;
        return {
          projectId: observed.projectId,
          name: observed.name,
          storageLimit: olds?.storageLimit ?? output?.storageLimit ?? -1,
          retentionId: observed.retentionId,
        };
      }),
    reconcile: ({ news }) =>
      Effect.gen(function* () {
        // Observe — cached projectId is a hint; Harbor is authoritative.
        let current = yield* readProject(news.name);

        // Ensure — create when missing; a 409 bare is a name race with a
        // concurrent run: reload by name and converge.
        if (current === undefined) {
          const client = yield* HarborClient;
          const response = yield* client.request("projects", {
            method: "POST",
            body: JSON.stringify({
              project_name: news.name,
              metadata: { auto_scan: "true" },
              storage_limit: news.storageLimit,
            }),
          });
          if (response.status >= 400) {
            const errorBody = yield* Effect.promise(async () => ({
              status: response.status,
              body: await response.text().catch(() => ""),
            }));
            if (!isRegistryConflict(errorBody)) {
              return yield* Effect.fail(
                new HarborHttpError({
                  status: response.status,
                  method: "POST",
                  path: "projects",
                  body: errorBody.body,
                }),
              );
            }
          }
          current = yield* readProject(news.name);
          if (current === undefined) {
            return yield* Effect.fail(
              new HarborHttpError({
                status: 409,
                method: "POST",
                path: "projects",
                body: `project ${news.name} not found after 409 race`,
              }),
            );
          }
        }

        // Sync — quota converges to the desired storage limit.
        yield* ensureQuota(current.projectId, news.storageLimit);

        return {
          projectId: current.projectId,
          name: current.name,
          storageLimit: news.storageLimit,
          retentionId: current.retentionId,
        };
      }),
    delete: ({ output }) =>
      Effect.gen(function* () {
        const observed = yield* readProject(output.name);
        if (observed === undefined) return;
        const client = yield* HarborClient;
        const response = yield* client.request(
          `projects/${encodeURIComponent(output.name)}`,
          {
            method: "DELETE",
            headers: { "X-Is-Resource-Name": "true" },
          },
        );
        if (response.status >= 400 && response.status !== 404) {
          return yield* apiFail(response, "DELETE", `projects/${output.name}`);
        }
      }),
  });
