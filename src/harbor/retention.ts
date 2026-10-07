import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as api from "./api.ts";

export interface RetentionProps {
  /** Console project slug — the Harbor project the policy scopes to. */
  readonly slug: string;
  /** Harbor project id (from Cpn.Harbor.Project output). */
  readonly projectId: number;
  /** Retention rule template. */
  readonly template:
    | "always"
    | "latestPulledK"
    | "latestPushedK"
    | "nDaysSinceLastPull"
    | "nDaysSinceLastPush";
  /** Retained artifact count for template rules. */
  readonly count: number;
  /** Schedule cron, six-field Harbor format. */
  readonly cron: string;
}

export interface Retention extends Resource<
  "Cpn.Harbor.Retention",
  RetentionProps,
  {
    readonly retentionId: number | null;
  }
> {}

/**
 * The project's single retention policy. Harbor allows exactly one policy
 * per project; a duplicate create answers 400 BAD_REQUEST with a message —
 * so this is a plain read-then-create idempotent write (api.putRetention),
 * never the shared ensure() collision wrapper.
 */
export const Retention = Resource<Retention>("Cpn.Harbor.Retention");

export const RetentionProvider = () =>
  Provider.succeed(Retention, {
    read: ({ olds }) =>
      Effect.gen(function* () {
        const project = yield* api.getProject(olds?.slug ?? "");
        return { retentionId: project?.retentionId ?? null };
      }),
    reconcile: ({ news }) =>
      Effect.gen(function* () {
        // Plain idempotent method: read retention id, create when missing
        // (400 "already has retention policy" falls through), always end
        // with a PUT of the desired policy.
        yield* api.putRetention(news.slug, {
          algorithm: "or",
          scope: { level: "project", ref: news.projectId },
          rules: [{ template: news.template, count: news.count }],
          trigger: {
            kind: "Schedule",
            settings: { cron: news.cron },
            references: [],
          },
        });
        const project = yield* api.getProject(news.slug);
        return { retentionId: project?.retentionId ?? null };
      }),
    delete: () => Effect.void,
  });
