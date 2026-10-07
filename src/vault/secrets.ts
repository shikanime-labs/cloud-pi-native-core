import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { VaultClient } from "./client.ts";
import { isNotFound } from "./credentials.ts";
import {
  gitlabGroupSecretPath,
  gitlabMirrorCredPath,
  registryGroupSecretPath,
  sonarqubeCredPath,
  techReadOnlyCredPath,
} from "./paths.ts";

/**
 * One KV-v2 secret under a project's root dir, written to a project or
 * zone mount. Covers the console's secret inventory: SonarQube creds
 * (`<root>/<slug>/SONAR`), GitLab mirror creds per repo
 * (`<root>/<slug>/<repo>-mirror`), tech read-only creds
 * (`<root>/<slug>/tech/GITLAB_MIRROR`), and the GITLAB / REGISTRY group
 * secrets (`<root>/<slug>/GITLAB`, `<root>/<slug>/REGISTRY`).
 */
export interface SecretProps {
  /** Mount to write to (project slug or `zone-<zone>`). */
  readonly mount: string;
  /** Console `projectsRootDir` prefix (e.g. `projects`). */
  readonly projectRootDir: string;
  readonly slug: string;
  /** Fully-resolved secret path under the mount. */
  readonly path: string;
  /** Secret payload — string-to-string, exactly what KV-v2 stores. */
  readonly data: Readonly<Record<string, string>>;
}

export interface Secret extends Resource<
  "Cpn.Vault.Secret",
  SecretProps,
  { readonly path: string }
> {}

export const Secret = Resource<Secret>("Cpn.Vault.Secret");

export const SecretProvider = () =>
  Provider.effect(
    Secret,
    Effect.gen(function* () {
      const client = yield* VaultClient;
      return Secret.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn("Cpn.Vault.Secret/read")(function* ({ olds }) {
          const existing = yield* client.readKvSecret(olds.mount, olds.path);
          return existing === undefined ? undefined : { path: olds.path };
        }),
        reconcile: Effect.fn("Cpn.Vault.Secret/reconcile")(function* ({
          news,
          output,
        }) {
          if (output?.path === news.path) {
            const existing = yield* client.readKvSecret(news.mount, news.path);
            if (existing !== undefined) return { path: news.path };
          }
          yield* client.writeKvSecret(news.mount, news.path, news.data);
          return { path: news.path };
        }),
        delete: Effect.fn("Cpn.Vault.Secret/delete")(function* ({ olds }) {
          yield* client
            .deleteKvSecret(olds.mount, olds.path)
            .pipe(
              Effect.catchAll((error) =>
                isNotFound(error) ? Effect.void : Effect.fail(error),
              ),
            );
        }),
      });
    }),
  );

// ---- path helper shortcuts (bind slug+root, leave repo/group free) ----

export const sonarqubeCreds = (projectRootDir: string, slug: string) => ({
  path: sonarqubeCredPath(projectRootDir, slug),
});

export const gitlabMirrorCreds = (
  projectRootDir: string,
  slug: string,
  repoName: string,
) => ({
  path: gitlabMirrorCredPath(projectRootDir, slug, repoName),
});

export const techReadOnlyCreds = (projectRootDir: string, slug: string) => ({
  path: techReadOnlyCredPath(projectRootDir, slug),
});

export const gitlabGroupSecret = (projectRootDir: string, slug: string) => ({
  path: gitlabGroupSecretPath(projectRootDir, slug),
});

export const registryGroupSecret = (projectRootDir: string, slug: string) => ({
  path: registryGroupSecretPath(projectRootDir, slug),
});
