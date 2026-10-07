import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { ArgocdGitClient } from "./git-client.ts";
import {
  deleteCommitMessage,
  purgeActions,
  renderEnvironmentValues,
  sweepActions,
  syncCommitMessage,
  upsertAction,
  valuesFilePath,
} from "./values.ts";

export interface ProjectEnvironment {
  zoneSlug: string;
  clusterLabel: string;
  environmentName: string;
}

export interface ProjectEnvironmentsProps {
  projectName: string;
  projectSlug: string;
  zoneSlugs: string[];
  environments: ProjectEnvironment[];
}

export interface ProjectEnvironments extends Resource<
  "Cpn.Argocd.ProjectEnvironments",
  ProjectEnvironmentsProps,
  {
    filePaths: string[];
    committed: boolean;
  }
> {}

export const ProjectEnvironments = Resource<ProjectEnvironments>(
  "Cpn.Argocd.ProjectEnvironments",
);

export const ProjectEnvironmentsProvider = Provider.effect(
  ProjectEnvironments,
  Effect.gen(function* () {
    const git = yield* ArgocdGitClient;
    return {
      reconcile: Effect.fn(function* ({
        news,
      }: {
        news: ProjectEnvironmentsProps;
      }) {
        const filePaths: string[] = [];
        let committed = false;
        for (const zoneSlug of news.zoneSlugs) {
          const zoneEnvironments = news.environments.filter(
            (env) => env.zoneSlug === zoneSlug,
          );
          const needed = zoneEnvironments.map((env) =>
            valuesFilePath(
              news.projectName,
              env.clusterLabel,
              env.environmentName,
            ),
          );
          const existingPaths = yield* git.listTree(
            zoneSlug,
            `${news.projectName}/`,
          );
          const deletes = purgeActions(existingPaths, needed, news.projectName);
          const upserts = [];
          for (const [index, env] of zoneEnvironments.entries()) {
            const filePath = needed[index];
            if (filePath === undefined) continue;
            const existing = yield* git.readFile(zoneSlug, filePath);
            const action = upsertAction(
              existing,
              filePath,
              renderEnvironmentValues(news.projectSlug, env.environmentName),
            );
            if (action !== null) upserts.push(action);
          }
          const actions = [...upserts, ...deletes];
          filePaths.push(...needed);
          if (actions.length === 0) continue;
          yield* git.commit(
            zoneSlug,
            syncCommitMessage(news.projectSlug),
            actions,
          );
          committed = true;
        }
        return {
          filePaths,
          committed,
        } satisfies ProjectEnvironments["Attributes"];
      }),

      delete: Effect.fn(function* ({
        olds,
      }: {
        olds: ProjectEnvironmentsProps;
      }) {
        for (const zoneSlug of olds.zoneSlugs) {
          const existingPaths = yield* git.listTree(
            zoneSlug,
            `${olds.projectName}/`,
          );
          const actions = sweepActions(existingPaths, olds.projectName);
          if (actions.length === 0) continue;
          yield* git.commit(
            zoneSlug,
            deleteCommitMessage(olds.projectSlug),
            actions,
          );
        }
      }),
    };
  }),
);
