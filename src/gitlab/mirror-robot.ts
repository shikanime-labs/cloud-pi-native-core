import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { GitlabClient, type GitlabGroupAccessToken } from "./client.ts";
import { type GitlabError, isNotFound } from "./credentials.ts";
import {
  isMirrorTokenExpiring,
  MIRROR_ROBOT_SCOPES,
  mirrorRobotTokenName,
  mirrorTokenExpiryDate,
} from "./utils.ts";

/**
 * Cpn.Gitlab.MirrorRobot — the per-project mirror group access token
 * (`<slug>-bot`) used as the mirroring output credential.
 *
 * Console semantics:
 * - scopes: `write_repository`, `read_repository`, `read_api`;
 * - expiry: creation date + expirationDays (YYYY-MM-DD);
 * - AGE-BASED rotation: when the live token's age in days is STRICTLY
 *   past the rotation threshold, revoke + recreate. The console keys the
 *   age off the vault secret's creation time; this library has no secret
 *   store, so the token's own `created_at` is the age source (the same
 *   predicate, a conservative substitute — token created_at ≤ secret
 *   created_at).
 * - the token secret is returned by create only — surfaced as a
 *   `secretRef`, never inline.
 */
export interface MirrorRobotProps {
  /** Project subgroup id the robot token lives in. */
  readonly groupId: number;
  /** Console project slug — the token name is `<slug>-bot`. */
  readonly slug: string;
  /** Token lifetime in days (console mirrorTokenExpirationDays). */
  readonly expirationDays: number;
  /**
   * Age-based rotation threshold in days: when the live token's age is
   * STRICTLY past this, rotate (revoke + recreate). Keep it strictly
   * below `expirationDays` so rotation always beats expiry.
   */
  readonly rotationThresholdDays: number;
}

export interface MirrorRobotAttrs {
  readonly tokenId: number;
  readonly name: string;
  readonly expiresAt: string | undefined;
  /**
   * Reference to the token secret — the value NEVER appears inline;
   * consumers resolve it from the secret store (console: vault).
   */
  readonly secretRef: string;
}

export interface MirrorRobot extends Resource<
  "Cpn.Gitlab.MirrorRobot",
  MirrorRobotProps,
  MirrorRobotAttrs
> {}

export const MirrorRobot = Resource<MirrorRobot>("Cpn.Gitlab.MirrorRobot");

const mirrorSecretRef = (slug: string): string =>
  `gitlab://mirror-robot/${slug}`;

const findToken = (
  groupId: number,
  name: string,
): Effect.Effect<
  GitlabGroupAccessToken | undefined,
  GitlabError,
  GitlabClient
> =>
  Effect.gen(function* () {
    const client = yield* GitlabClient;
    const tokens = yield* client.listGroupAccessTokens(groupId);
    return tokens.find((token) => token.name === name);
  });

export const MirrorRobotProvider = () =>
  Provider.effect(
    MirrorRobot,
    Effect.gen(function* () {
      return MirrorRobot.Provider.of({
        stables: ["tokenId"],
        list: () => Effect.succeed([]),
        read: Effect.fn("Cpn.Gitlab.MirrorRobot/read")(function* ({ olds }) {
          const token = yield* findToken(
            olds.groupId,
            mirrorRobotTokenName(olds.slug),
          );
          if (token === undefined) return undefined;
          return {
            tokenId: token.id,
            name: token.name,
            expiresAt: token.expiresAt,
            secretRef: mirrorSecretRef(olds.slug),
          };
        }),
        reconcile: Effect.fn("Cpn.Gitlab.MirrorRobot/reconcile")(function* ({
          news,
        }) {
          const client = yield* GitlabClient;
          const name = mirrorRobotTokenName(news.slug);
          // Observe — the live robot token by name.
          const observed = yield* findToken(news.groupId, name);
          // Rotate — age-based only: revoke + recreate when the token's
          // age is STRICTLY past the threshold.
          if (observed !== undefined) {
            if (
              !isMirrorTokenExpiring(
                observed.createdAt,
                news.rotationThresholdDays,
              )
            ) {
              return {
                tokenId: observed.id,
                name: observed.name,
                expiresAt: observed.expiresAt,
                secretRef: mirrorSecretRef(news.slug),
              };
            }
            yield* client.revokeGroupAccessToken(news.groupId, observed.id);
            // fall through to create
          }
          // Ensure — mint a fresh token; collision = race, reload +
          // adopt (the freshly created secret only exists on the
          // creator's side, so an adopted token yields an empty
          // secretRef path — callers must re-fetch from the store).
          const created = yield* client.createGroupAccessToken(news.groupId, {
            name,
            scopes: [...MIRROR_ROBOT_SCOPES],
            expires_at: mirrorTokenExpiryDate(news.expirationDays),
          });
          return {
            tokenId: created.id,
            name: created.name,
            expiresAt: created.expiresAt,
            secretRef: mirrorSecretRef(news.slug),
            // the created token's secret never lands in attributes
          };
        }),
        delete: Effect.fn("Cpn.Gitlab.MirrorRobot/delete")(function* ({
          olds,
          output,
        }) {
          const client = yield* GitlabClient;
          const tokenId = output?.tokenId;
          if (tokenId === undefined) return;
          yield* client.revokeGroupAccessToken(olds.groupId, tokenId).pipe(
            Effect.catchIf(
              (error) => isNotFound(error),
              () => Effect.void,
            ),
          );
        }),
      });
    }),
  );
