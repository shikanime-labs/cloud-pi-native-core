import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { splitGroupPath } from "./paths.ts";

/**
 * Every Keycloak HTTP operation fails with this error; `status` is the HTTP
 * status code (0 for transport failures and configuration errors), so callers
 * implement the console's 404-skip / 409-log / else-throw convention.
 */
export class KeycloakError extends Data.TaggedError("KeycloakError")<{
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly message: string;
}> {
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
}

export const isKeycloakNotFound = (error: unknown): boolean =>
  error instanceof KeycloakError && error.isNotFound;

export const isKeycloakConflict = (error: unknown): boolean =>
  error instanceof KeycloakError && error.isConflict;

/** Resolved Keycloak connection: base URL, project realm, admin-cli credentials. */
export interface KeycloakConnection {
  readonly baseUrl: string;
  readonly realm: string;
  readonly adminClientId: string;
  readonly adminUser: string;
  readonly adminPassword: string;
}

/**
 * Credentials tag for Keycloak. The service holds an *effect* so nothing is
 * resolved until the first API call — building provider layers never requires
 * a configured realm (the lazy-Credentials pattern shared across services).
 */
export interface KeycloakCredentialsService {
  readonly resolve: Effect.Effect<KeycloakConnection, KeycloakError>;
}

export class Credentials extends Context.Tag("Cpn.Keycloak.Credentials")<
  Credentials,
  KeycloakCredentialsService
>() {}

export const credentialsStatic = (
  connection: KeycloakConnection,
): Layer.Layer<Credentials> =>
  Layer.effect(
    Credentials,
    Effect.map(Effect.cached(Effect.succeed(connection)), (resolve) => ({
      resolve,
    })),
  );

export const credentialsLayer = (
  resolve: Effect.Effect<KeycloakConnection, KeycloakError>,
): Layer.Layer<Credentials> =>
  Layer.effect(
    Credentials,
    Effect.map(Effect.cached(resolve), (cached) => ({ resolve: cached })),
  );

export const credentialsUnavailable: Layer.Layer<Credentials> = Layer.succeed(
  Credentials,
  {
    resolve: Effect.fail(
      new KeycloakError({
        status: 0,
        method: "CONFIG",
        path: "Cpn.Keycloak.Credentials",
        message: "Keycloak credentials not provided (pass a Credentials layer)",
      }),
    ),
  },
);

// ---- wire types (only fields the resources rely on) ----

export interface GroupRepresentation {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface UserRepresentation {
  readonly id: string;
  readonly email?: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const parseError = (label: string, expected: string): KeycloakError =>
  new KeycloakError({
    status: 0,
    method: "PARSE",
    path: label,
    message: `Keycloak response for '${label}' is not ${expected}`,
  });

/** Parse-don't-validate boundary: narrow a group to id/name/path or throw. */
export const parseGroup = (
  value: unknown,
  label: string,
): GroupRepresentation => {
  if (!isRecord(value)) throw parseError(label, "an object");
  const id = readString(value, "id");
  const name = readString(value, "name");
  const path = readString(value, "path");
  if (id === undefined || name === undefined || path === undefined) {
    throw parseError(label, "a group with string id/name/path");
  }
  return { id, name, path };
};

/** Parse-don't-validate boundary: narrow a user to id (+optional email). */
export const parseUser = (
  value: unknown,
  label: string,
): UserRepresentation => {
  if (!isRecord(value)) throw parseError(label, "an object");
  const id = readString(value, "id");
  if (id === undefined) throw parseError(label, "a user with a string id");
  const email = readString(value, "email");
  return email === undefined ? { id } : { id, email };
};

export interface GroupListOptions {
  readonly first?: number;
  readonly max?: number;
}

/**
 * Minimal Keycloak Admin REST client over `/admin/realms/{realm}/*` — the
 * group, subgroup, and member operations the resources need. Auth is the
 * admin-cli password grant against the master realm, cached and re-run once
 * on expiry, matching the console's KeycloakClientService.
 */
export interface KeycloakClientService {
  readonly getRootGroups: (
    options?: GroupListOptions,
  ) => Effect.Effect<GroupRepresentation[], KeycloakError>;
  readonly getSubGroups: (
    parentId: string,
    options?: GroupListOptions,
  ) => Effect.Effect<GroupRepresentation[], KeycloakError>;
  readonly getGroupByPath: (
    path: string,
  ) => Effect.Effect<GroupRepresentation | undefined, KeycloakError>;
  readonly getOrCreateGroupByPath: (
    path: string,
  ) => Effect.Effect<GroupRepresentation, KeycloakError>;
  readonly getGroupMembers: (
    groupId: string,
  ) => Effect.Effect<UserRepresentation[], KeycloakError>;
  readonly getUserByEmail: (
    email: string,
  ) => Effect.Effect<UserRepresentation | undefined, KeycloakError>;
  readonly addUserToGroup: (
    userId: string,
    groupId: string,
  ) => Effect.Effect<void, KeycloakError>;
  readonly removeUserFromGroup: (
    userId: string,
    groupId: string,
  ) => Effect.Effect<void, KeycloakError>;
  /** Keycloak 26 fails on deleting a group with subgroups: children-first. */
  readonly deleteGroupTree: (
    groupId: string,
  ) => Effect.Effect<void, KeycloakError>;
}

export class KeycloakClient extends Context.Tag("Cpn.Keycloak.KeycloakClient")<
  KeycloakClient,
  KeycloakClientService
>() {}

const PAGE_SIZE = 100;

const MASTER_TOKEN_PATH = "realms/master/protocol/openid-connect/token";

export const KeycloakClientLive: Layer.Layer<
  KeycloakClient,
  never,
  Credentials
> = Layer.effect(
  KeycloakClient,
  Effect.gen(function* () {
    const credentials = yield* Credentials;

    let cachedToken: string | undefined;

    const authenticate: Effect.Effect<void, KeycloakError> = Effect.gen(
      function* () {
        const connection = yield* credentials.resolve;
        const body = new URLSearchParams({
          client_id: connection.adminClientId,
          grant_type: "password",
          username: connection.adminUser,
          password: connection.adminPassword,
        });
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(new URL(MASTER_TOKEN_PATH, connection.baseUrl).toString(), {
              method: "POST",
              signal,
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: body.toString(),
            }),
          catch: (cause) =>
            new KeycloakError({
              status: 0,
              method: "POST",
              path: MASTER_TOKEN_PATH,
              message: `Keycloak token request failed: ${String(cause)}`,
            }),
        });
        if (!response.ok) {
          return yield* new KeycloakError({
            status: response.status,
            method: "POST",
            path: MASTER_TOKEN_PATH,
            message: `Keycloak authentication failed (${response.status})`,
          });
        }
        const raw: unknown = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) =>
            new KeycloakError({
              status: 0,
              method: "POST",
              path: MASTER_TOKEN_PATH,
              message: `Keycloak token body unreadable: ${String(cause)}`,
            }),
        });
        if (!isRecord(raw)) {
          return yield* new KeycloakError({
            status: 0,
            method: "POST",
            path: MASTER_TOKEN_PATH,
            message: "Keycloak token response is not an object",
          });
        }
        const accessToken = readString(raw, "access_token");
        if (accessToken === undefined) {
          return yield* new KeycloakError({
            status: 0,
            method: "POST",
            path: MASTER_TOKEN_PATH,
            message: "Keycloak token response has no access_token string",
          });
        }
        cachedToken = accessToken;
      },
    );

    const fetchOnce = (
      method: string,
      path: string,
      bearer: string,
      body: string | undefined,
    ): Effect.Effect<Response, KeycloakError> =>
      Effect.gen(function* () {
        const connection = yield* credentials.resolve;
        return yield* Effect.tryPromise({
          try: (signal) =>
            fetch(
              new URL(
                `admin/realms/${connection.realm}/${path}`,
                connection.baseUrl,
              ).toString(),
              {
                method,
                signal,
                headers: {
                  authorization: `Bearer ${bearer}`,
                  ...(body === undefined
                    ? {}
                    : { "content-type": "application/json" }),
                },
                body,
              },
            ),
          catch: (cause) =>
            new KeycloakError({
              status: 0,
              method,
              path,
              message: `Keycloak request failed: ${String(cause)}`,
            }),
        });
      });

    /**
     * One request with a single auth retry: an expired token (401) clears
     * the cache, re-authenticates, and tries exactly once more.
     */
    const send = (
      method: string,
      path: string,
      body: string | undefined,
    ): Effect.Effect<Response, KeycloakError> =>
      Effect.gen(function* () {
        if (cachedToken === undefined) yield* authenticate;
        const first = yield* fetchOnce(
          method,
          path,
          cachedToken === undefined ? "" : cachedToken,
          body,
        );
        if (first.status !== 401) return first;
        cachedToken = undefined;
        yield* authenticate;
        return yield* fetchOnce(
          method,
          path,
          cachedToken === undefined ? "" : cachedToken,
          body,
        );
      });

    const failStatus = (
      response: Response,
      method: string,
      path: string,
    ): Effect.Effect<never, KeycloakError> =>
      new KeycloakError({
        status: response.status,
        method,
        path,
        message: `Keycloak ${method} ${path} -> ${response.status}`,
      });

    const requestVoid = (
      method: string,
      path: string,
      body?: string,
    ): Effect.Effect<void, KeycloakError> =>
      Effect.gen(function* () {
        const response = yield* send(method, path, body);
        if (response.status >= 400) {
          return yield* failStatus(response, method, path);
        }
      });

    const requestJson = <A>(
      method: string,
      path: string,
      decode: (raw: unknown) => A,
    ): Effect.Effect<A, KeycloakError> =>
      Effect.gen(function* () {
        const response = yield* send(method, path, undefined);
        if (response.status >= 400) {
          return yield* failStatus(response, method, path);
        }
        const raw: unknown = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) =>
            new KeycloakError({
              status: 0,
              method,
              path,
              message: `Keycloak response unreadable: ${String(cause)}`,
            }),
        });
        return decode(raw);
      });

    const parseGroupArray = (label: string) => (raw: unknown) => {
      if (!Array.isArray(raw)) throw parseError(label, "an array");
      return raw.map((group) => parseGroup(group, label));
    };

    const listGroups = (
      label: string,
      path: string,
      options?: GroupListOptions,
    ): Effect.Effect<GroupRepresentation[], KeycloakError> =>
      requestJson(
        "GET",
        `${path}?first=${options?.first ?? 0}&max=${options?.max ?? PAGE_SIZE}`,
        parseGroupArray(label),
      );

    const getRootGroupByName = (
      name: string,
    ): Effect.Effect<GroupRepresentation | undefined, KeycloakError> =>
      Effect.map(listGroups("groups", "groups"), (groups) =>
        groups.find((group) => group.name === name),
      );

    const getSubGroupByName = (
      parentId: string,
      name: string,
    ): Effect.Effect<GroupRepresentation | undefined, KeycloakError> =>
      Effect.map(
        listGroups(
          `groups/${parentId}/children`,
          `groups/${parentId}/children`,
        ),
        (groups) => groups.find((group) => group.name === name),
      );

    const tolerateConflict = (
      effect: Effect.Effect<void, KeycloakError>,
    ): Effect.Effect<void, KeycloakError> =>
      Effect.catchAll(effect, (error) =>
        isKeycloakConflict(error) ? Effect.void : Effect.fail(error),
      );

    /** Idempotent create, console `ensure`: on a 409 race, reload wins. */
    const createAndReload = (
      create: Effect.Effect<void, KeycloakError>,
      reload: Effect.Effect<GroupRepresentation | undefined, KeycloakError>,
      label: string,
    ): Effect.Effect<GroupRepresentation, KeycloakError> =>
      Effect.gen(function* () {
        yield* tolerateConflict(create);
        const reloaded = yield* reload;
        if (reloaded === undefined) {
          return yield* new KeycloakError({
            status: 0,
            method: "ENSURE",
            path: label,
            message: `Keycloak group '${label}' could not be fetched back after creation`,
          });
        }
        return reloaded;
      });

    const createRootGroup = (
      name: string,
    ): Effect.Effect<GroupRepresentation, KeycloakError> =>
      createAndReload(
        requestVoid("POST", "groups", JSON.stringify({ name })),
        getRootGroupByName(name),
        name,
      );

    const createSubGroup = (
      parentId: string,
      name: string,
    ): Effect.Effect<GroupRepresentation, KeycloakError> =>
      createAndReload(
        requestVoid(
          "POST",
          `groups/${parentId}/children`,
          JSON.stringify({ name }),
        ),
        getSubGroupByName(parentId, name),
        `${parentId}/children/${name}`,
      );

    const getGroupByPathRec = (
      path: string,
    ): Effect.Effect<GroupRepresentation | undefined, KeycloakError> =>
      Effect.gen(function* () {
        const parts = splitGroupPath(path);
        let current: GroupRepresentation | undefined = undefined;
        for (const part of parts) {
          current =
            current === undefined
              ? yield* getRootGroupByName(part)
              : yield* getSubGroupByName(current.id, part);
          if (current === undefined) return undefined;
        }
        return current;
      });

    const deleteGroupTreeRec = (
      groupId: string,
    ): Effect.Effect<void, KeycloakError> =>
      Effect.gen(function* () {
        const children = yield* listGroups(
          `groups/${groupId}/children`,
          `groups/${groupId}/children`,
        );
        for (const child of children) {
          yield* deleteGroupTreeRec(child.id);
        }
        yield* requestVoid("DELETE", `groups/${groupId}`).pipe(
          Effect.catchAll((error) =>
            isKeycloakNotFound(error) ? Effect.void : Effect.fail(error),
          ),
        );
      });

    return {
      getRootGroups: (options) => listGroups("groups", "groups", options),
      getSubGroups: (parentId, options) =>
        listGroups(
          `groups/${parentId}/children`,
          `groups/${parentId}/children`,
          options,
        ),
      getGroupByPath: getGroupByPathRec,
      getOrCreateGroupByPath: (path) =>
        Effect.gen(function* () {
          const existing = yield* getGroupByPathRec(path);
          if (existing !== undefined) return existing;
          const parts = splitGroupPath(path);
          const root = parts[0];
          if (root === undefined) {
            return yield* new KeycloakError({
              status: 0,
              method: "ENSURE",
              path,
              message: `Invalid group path: "${path}"`,
            });
          }
          const rootExisting = yield* getRootGroupByName(root);
          let current: GroupRepresentation =
            rootExisting !== undefined
              ? rootExisting
              : yield* createRootGroup(root);
          for (const part of parts.slice(1)) {
            const child = yield* getSubGroupByName(current.id, part);
            current =
              child !== undefined
                ? child
                : yield* createSubGroup(current.id, part);
          }
          return current;
        }),
      getGroupMembers: (groupId) =>
        requestJson("GET", `groups/${groupId}/members`, (raw) => {
          if (!Array.isArray(raw)) {
            throw parseError(`groups/${groupId}/members`, "an array");
          }
          return raw.map((member) =>
            parseUser(member, `groups/${groupId}/members`),
          );
        }),
      getUserByEmail: (email) =>
        Effect.map(
          requestJson(
            "GET",
            `users?email=${encodeURIComponent(email)}&exact=true&max=1`,
            (raw) => {
              if (!Array.isArray(raw)) throw parseError("users", "an array");
              return raw.map((user) => parseUser(user, "users"));
            },
          ),
          (users) => users[0],
        ),
      addUserToGroup: (userId, groupId) =>
        requestVoid("PUT", `users/${userId}/groups/${groupId}`),
      removeUserFromGroup: (userId, groupId) =>
        requestVoid("DELETE", `users/${userId}/groups/${groupId}`),
      deleteGroupTree: deleteGroupTreeRec,
    };
  }),
);
