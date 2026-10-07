import { Resource, type Resource as ResourceT } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { isNexusNotFound, NexusClient, type NexusRole } from "./client.js";
import { computePlatformRoles } from "./roles.js";

export interface PlatformRolesProps {
  /** Every project contributing privileges to the platform roles. */
  readonly projects: ReadonlyArray<{
    readonly slug: string;
    readonly npm: boolean;
  }>;
  /** Admin-level platform group-path overrides (comma-separated paths). */
  readonly writeGroupPaths?: string;
  readonly readGroupPaths?: string;
}

export type PlatformRoles = ResourceT<
  "Cpn.Nexus.PlatformRoles",
  PlatformRolesProps,
  {
    readonly roleIds: ReadonlyArray<string>;
  }
>;

export const PlatformRoles = Resource<PlatformRoles>("Cpn.Nexus.PlatformRoles");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseRole = (data: unknown, roleId: string): NexusRole => {
  if (!isRecord(data)) {
    throw new Error(`nexus: role "${roleId}" response is not an object`);
  }
  const privileges = data.privileges;
  if (
    typeof data.id !== "string" ||
    typeof data.name !== "string" ||
    !Array.isArray(privileges)
  ) {
    throw new Error(`nexus: role "${roleId}" is missing id/name/privileges`);
  }
  const parsed: string[] = [];
  for (const privilege of privileges) {
    if (typeof privilege !== "string") {
      throw new Error(
        `nexus: role "${roleId}" privileges contains a non-string`,
      );
    }
    parsed.push(privilege);
  }
  return { id: data.id, name: data.name, privileges: parsed };
};

export const PlatformRolesProvider = () =>
  Provider.effect(
    PlatformRoles,
    Effect.gen(function* () {
      const nexus = yield* NexusClient;

      const getRole = (id: string) =>
        nexus(`security/roles/${id}`).pipe(
          Effect.catchIf(isNexusNotFound, () => Effect.succeed(undefined)),
          Effect.map((data) =>
            data === undefined ? undefined : parseRole(data, id),
          ),
        );

      return {
        // Platform roles are re-aggregated on EVERY project upsert/delete —
        // reconcile runs per plan, and each run unions privileges across ALL
        // projects, so any project change converges the platform roles.
        reconcile: Effect.fn("Cpn.Nexus.PlatformRoles/reconcile")(function* ({
          news,
        }: {
          news: PlatformRolesProps;
        }) {
          const { roles } = computePlatformRoles(news);
          for (const role of roles) {
            const observed = yield* getRole(role.id);
            const body = {
              id: role.id,
              name: role.id,
              description: `Platform role for OIDC group ${role.id}`,
              privileges: [...role.privileges],
            };
            if (observed === undefined) {
              yield* nexus("security/roles", { method: "POST", body });
            } else if (
              observed.privileges.length !== role.privileges.length ||
              observed.privileges.some((p) => !role.privileges.includes(p))
            ) {
              yield* nexus(`security/roles/${role.id}`, {
                method: "PUT",
                body,
              });
            }
          }
          return { roleIds: roles.map((role) => role.id) };
        }),
        delete: Effect.fn("Cpn.Nexus.PlatformRoles/delete")(function* ({
          olds,
        }: {
          olds: PlatformRolesProps;
        }) {
          for (const role of computePlatformRoles(olds).roles) {
            yield* nexus(`security/roles/${role.id}`, {
              method: "DELETE",
            }).pipe(Effect.catchIf(isNexusNotFound, () => Effect.void));
          }
        }),
      };
    }),
  );
