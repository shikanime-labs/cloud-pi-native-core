import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { GitlabClient, type GitlabGroup } from "./client.ts";
import { GitlabError, isAlreadyTaken } from "./credentials.ts";
import {
  GROUP_ROOT_CUSTOM_ATTRIBUTE_KEY,
  MANAGED_BY_CONSOLE_CUSTOM_ATTRIBUTE_KEY,
  PROJECT_GROUP_CUSTOM_ATTRIBUTE_KEY,
  projectGroupFullPath,
} from "./utils.ts";

/**
 * Cpn.Gitlab.ProjectGroup — the console's per-project subgroup
 * `{root}/{slug}` (and the `{root}` group itself via the root variant,
 * slug omitted).
 *
 * Console semantics:
 * - the root group is created (name=path) when missing and tagged
 *   `cpn_managed_by_console=true` + `cpn_projects_root_dir=true`;
 * - each project gets ONE subgroup `{root}/{slug}` — NO role subgroups:
 *   members map directly onto it via `Cpn.Gitlab.GroupMembers`;
 * - a create that answers "already taken" is a race — reload and adopt
 *   (the console's `ensure` collision convention);
 * - the project subgroup is tagged `cpn_managed_by_console=true` +
 *   `cpn_project_slug=<slug>`;
 * - delete removes the project subgroup (404 tolerated); the root group
 *   is never deleted.
 */
export interface ProjectGroupProps {
  /** Root group path — the console's `projectRootDir` (e.g. `projects`). */
  readonly rootGroupPath: string;
  /** Console project slug; omit for the root-group variant. */
  readonly slug?: string | undefined;
}

export interface ProjectGroupAttrs {
  readonly groupId: number;
  readonly fullPath: string;
  readonly isRoot: boolean;
}

export interface ProjectGroup extends Resource<
  "Cpn.Gitlab.ProjectGroup",
  ProjectGroupProps,
  ProjectGroupAttrs
> {}

export const ProjectGroup = Resource<ProjectGroup>("Cpn.Gitlab.ProjectGroup");

const customAttributes = (
  slug: string | undefined,
): Record<string, string> => ({
  [MANAGED_BY_CONSOLE_CUSTOM_ATTRIBUTE_KEY]: "true",
  ...(slug === undefined
    ? { [GROUP_ROOT_CUSTOM_ATTRIBUTE_KEY]: "true" }
    : { [PROJECT_GROUP_CUSTOM_ATTRIBUTE_KEY]: slug }),
});

const isGitlabError = (error: unknown): error is GitlabError =>
  error instanceof GitlabError;

/**
 * Resolve-or-create a group by full path: every missing segment is created
 * root-first (first segment as a root group, the rest as subgroups); a
 * create answering "already taken" is a race — reload and adopt.
 */
export const resolveGroupPath = (
  fullPath: string,
): Effect.Effect<GitlabGroup, GitlabError | Error, GitlabClient> =>
  Effect.gen(function* () {
    const client = yield* GitlabClient;
    const segments = fullPath.split("/").filter(Boolean);
    let parent: GitlabGroup | undefined;
    let current: GitlabGroup | undefined;
    for (const [index, segment] of segments.entries()) {
      const pathSoFar = segments.slice(0, index + 1).join("/");
      const observed = yield* client.showGroupByPath(pathSoFar);
      if (observed !== undefined) {
        parent = observed;
        current = observed;
        continue;
      }
      const create =
        parent === undefined
          ? client.createRootGroup(segment)
          : client.createSubGroup(parent.id, segment);
      const created = yield* create.pipe(
        Effect.catchIf(isGitlabError, (error) =>
          isAlreadyTaken(error)
            ? client
                .showGroupByPath(pathSoFar)
                .pipe(
                  Effect.flatMap((adopted) =>
                    adopted === undefined
                      ? Effect.fail(error)
                      : Effect.succeed(adopted),
                  ),
                )
            : Effect.fail(error),
        ),
      );
      parent = created;
      current = created;
    }
    if (current === undefined) {
      return yield* Effect.fail(
        new Error(`Invalid GitLab group path: ${fullPath}`),
      );
    }
    return current;
  });

export const ProjectGroupProvider = () =>
  Provider.effect(
    ProjectGroup,
    Effect.gen(function* () {
      return ProjectGroup.Provider.of({
        list: () => Effect.succeed([]),
        reconcile: Effect.fn("Cpn.Gitlab.ProjectGroup/reconcile")(function* ({
          news,
        }) {
          const fullPath =
            news.slug === undefined
              ? news.rootGroupPath
              : projectGroupFullPath(news.rootGroupPath, news.slug);
          const group = yield* resolveGroupPath(fullPath);
          const client = yield* GitlabClient;
          for (const [key, value] of Object.entries(
            customAttributes(news.slug),
          )) {
            yield* client.upsertGroupCustomAttribute(group.id, key, value);
          }
          return {
            groupId: group.id,
            fullPath: group.fullPath,
            isRoot: news.slug === undefined,
          };
        }),
        read: Effect.fn("Cpn.Gitlab.ProjectGroup/read")(function* ({ olds }) {
          const client = yield* GitlabClient;
          const fullPath =
            olds.slug === undefined
              ? olds.rootGroupPath
              : projectGroupFullPath(olds.rootGroupPath, olds.slug);
          const observed = yield* client.showGroupByPath(fullPath);
          if (observed === undefined) return undefined;
          return {
            groupId: observed.id,
            fullPath: observed.fullPath,
            isRoot: olds.slug === undefined,
          };
        }),
        delete: Effect.fn("Cpn.Gitlab.ProjectGroup/delete")(function* ({
          olds,
        }) {
          const client = yield* GitlabClient;
          if (olds.slug === undefined) return; // never delete the root group
          const fullPath = projectGroupFullPath(olds.rootGroupPath, olds.slug);
          const observed = yield* client.showGroupByPath(fullPath);
          if (observed === undefined) return;
          yield* client.deleteGroup(observed.id);
        }),
      });
    }),
  );
