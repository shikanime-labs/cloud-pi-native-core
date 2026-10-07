import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  Credentials,
  type GitlabConnection,
  GitlabError,
} from "./credentials.ts";

// ---------------------------------------------------------------------------
// Wire types (only fields the resources rely on).
// ---------------------------------------------------------------------------

/** A GitLab group — only the fields the resources rely on. */
export interface GitlabGroup {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly fullPath: string;
}

/** A GitLab project (repository), only the fields the resources rely on. */
export interface GitlabProject {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly pathWithNamespace: string;
  readonly topics: readonly string[];
}

/** A GitLab user, only the fields the resources rely on. */
export interface GitlabUser {
  readonly id: number;
  readonly username: string;
  readonly email: string;
  readonly name: string;
}

/** A GitLab group member, only the fields the resources rely on. */
export interface GitlabMember {
  readonly id: number;
  readonly accessLevel: number;
  readonly username: string;
}

/** A GitLab group access token, only the fields the resources rely on. */
export interface GitlabGroupAccessToken {
  readonly id: number;
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string | undefined;
}

/** A freshly minted group access token — the secret appears once, here. */
export interface GitlabGroupAccessTokenCreated extends GitlabGroupAccessToken {
  readonly token: string;
}

// ---------------------------------------------------------------------------
// Response schemas (runtime parsing boundary: parse, don't validate).
// ---------------------------------------------------------------------------

const groupSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  path: Schema.String,
  full_path: Schema.String,
});

const projectSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  path: Schema.String,
  path_with_namespace: Schema.String,
  topics: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
});

const userSchema = Schema.Struct({
  id: Schema.Number,
  username: Schema.String,
  email: Schema.optional(Schema.String),
  name: Schema.String,
});

const memberSchema = Schema.Struct({
  id: Schema.Number,
  access_level: Schema.Number,
  username: Schema.String,
});

const nullableDate = Schema.optionalWith(
  Schema.Union(Schema.String, Schema.Null),
  {
    default: () => null,
  },
);

const groupTokenSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  created_at: Schema.String,
  expires_at: nullableDate,
});

const groupTokenCreatedSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  created_at: Schema.optionalWith(Schema.String, {
    default: () => new Date(0).toISOString(),
  }),
  expires_at: nullableDate,
  token: Schema.String,
});

/** Parse an unknown body, throwing a descriptive {@link GitlabError}. */
const parse = <A, I>(
  schema: Schema.Schema<A, I>,
  body: unknown,
  ctx: { method: string; path: string },
): A => {
  const result = Schema.decodeUnknownEither(schema)(body);
  if (result._tag === "Left") {
    throw new GitlabError({
      status: 0,
      method: ctx.method,
      path: ctx.path,
      message: `Unexpected GitLab response shape: ${String(result.left).slice(0, 200)}`,
      body: null,
    });
  }
  return result.right;
};

const toGroup = (raw: typeof groupSchema.Type): GitlabGroup => ({
  id: raw.id,
  name: raw.name,
  path: raw.path,
  fullPath: raw.full_path,
});

const toProject = (raw: typeof projectSchema.Type): GitlabProject => ({
  id: raw.id,
  name: raw.name,
  path: raw.path,
  pathWithNamespace: raw.path_with_namespace,
  topics: raw.topics,
});

const toUser = (raw: typeof userSchema.Type): GitlabUser => ({
  id: raw.id,
  username: raw.username,
  email: raw.email ?? "",
  name: raw.name,
});

const toMember = (raw: typeof memberSchema.Type): GitlabMember => ({
  id: raw.id,
  accessLevel: raw.access_level,
  username: raw.username,
});

const toToken = (
  raw: typeof groupTokenSchema.Type,
): GitlabGroupAccessToken => ({
  id: raw.id,
  name: raw.name,
  createdAt: raw.created_at,
  expiresAt: raw.expires_at ?? undefined,
});

const toCreatedToken = (
  raw: typeof groupTokenCreatedSchema.Type,
): GitlabGroupAccessTokenCreated => ({
  id: raw.id,
  name: raw.name,
  createdAt: raw.created_at,
  expiresAt: raw.expires_at ?? undefined,
  token: raw.token,
});

// ---------------------------------------------------------------------------
// Client service.
// ---------------------------------------------------------------------------

/**
 * Minimal GitLab REST client over `/api/v4/*`: the group, project, member,
 * user and access-token operations the resources need. All failures are
 * {@link GitlabError} carrying the HTTP status and response body; url and
 * token resolve lazily from the {@link Credentials} service.
 */
export interface GitlabClientService {
  /** Lazily resolved connection (url + token) — safe to call per request. */
  readonly connection: () => Effect.Effect<GitlabConnection, GitlabError>;
  readonly showGroupByPath: (
    fullPath: string,
  ) => Effect.Effect<GitlabGroup | undefined, GitlabError>;
  readonly createSubGroup: (
    parentId: number,
    path: string,
  ) => Effect.Effect<GitlabGroup, GitlabError>;
  readonly createRootGroup: (
    path: string,
  ) => Effect.Effect<GitlabGroup, GitlabError>;
  readonly deleteGroup: (groupId: number) => Effect.Effect<void, GitlabError>;
  readonly upsertGroupCustomAttribute: (
    groupId: number,
    key: string,
    value: string,
  ) => Effect.Effect<void, GitlabError>;
  readonly upsertProjectCustomAttribute: (
    projectId: number,
    key: string,
    value: string,
  ) => Effect.Effect<void, GitlabError>;
  readonly showProjectByPath: (
    fullPath: string,
  ) => Effect.Effect<GitlabProject | undefined, GitlabError>;
  readonly createProject: (
    namespaceId: number,
    path: string,
    options: { readonly ciConfigPath?: string | undefined },
  ) => Effect.Effect<GitlabProject, GitlabError>;
  readonly editProject: (
    projectId: number,
    body: {
      readonly name: string;
      readonly path: string;
      readonly topics: readonly string[];
      readonly description?: string | undefined;
      readonly ciConfigPath: string;
    },
  ) => Effect.Effect<GitlabProject, GitlabError>;
  readonly deleteProject: (
    projectId: number,
    fullPath: string,
  ) => Effect.Effect<void, GitlabError>;
  readonly listGroupProjects: (
    groupId: number,
  ) => Effect.Effect<readonly GitlabProject[], GitlabError>;
  readonly listUsersByEmail: (
    email: string,
  ) => Effect.Effect<readonly GitlabUser[], GitlabError>;
  readonly createUser: (
    body: Record<string, unknown>,
  ) => Effect.Effect<GitlabUser, GitlabError>;
  readonly editUser: (
    userId: number,
    body: Record<string, unknown>,
  ) => Effect.Effect<GitlabUser, GitlabError>;
  readonly upsertUserCustomAttribute: (
    userId: number,
    key: string,
    value: string,
  ) => Effect.Effect<void, GitlabError>;
  readonly listGroupMembers: (
    groupId: number,
  ) => Effect.Effect<readonly GitlabMember[], GitlabError>;
  readonly addGroupMember: (
    groupId: number,
    userId: number,
    accessLevel: number,
  ) => Effect.Effect<void, GitlabError>;
  readonly editGroupMember: (
    groupId: number,
    userId: number,
    accessLevel: number,
  ) => Effect.Effect<void, GitlabError>;
  readonly removeGroupMember: (
    groupId: number,
    userId: number,
  ) => Effect.Effect<void, GitlabError>;
  readonly listGroupAccessTokens: (
    groupId: number,
  ) => Effect.Effect<readonly GitlabGroupAccessToken[], GitlabError>;
  readonly createGroupAccessToken: (
    groupId: number,
    body: Record<string, unknown>,
  ) => Effect.Effect<GitlabGroupAccessTokenCreated, GitlabError>;
  readonly revokeGroupAccessToken: (
    groupId: number,
    tokenId: number,
  ) => Effect.Effect<void, GitlabError>;
}

export class GitlabClient extends Context.Tag("Cpn.Gitlab.GitlabClient")<
  GitlabClient,
  GitlabClientService
>() {}

/** `Effect.tryPromise` mapping any throw onto a {@link GitlabError}. */
const tryPromise = <A>(
  method: string,
  path: string,
  fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, GitlabError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new GitlabError({
        status: 0,
        method,
        path,
        message: `GitLab request failed: ${String(cause)}`,
        body: null,
      }),
  });

const readJsonBody = (response: Response): Promise<unknown> =>
  response.text().then(
    (text) => {
      if (text === "") return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    () => null,
  );

const is404 = (error: GitlabError): boolean => error.status === 404;

/**
 * Build a {@link GitlabClient} layer over {@link Credentials}. The `send`
 * helper performs the fetch, attaches the PRIVATE-TOKEN header, and maps
 * every failure (transport or non-2xx) onto {@link GitlabError}.
 */
export const GitlabClientLive: Layer.Layer<GitlabClient, never, Credentials> =
  Layer.effect(
    GitlabClient,
    Effect.gen(function* () {
      const credentials = yield* Credentials;

      const send = (
        method: string,
        path: string,
        body: unknown | undefined,
      ): Effect.Effect<Response, GitlabError> =>
        Effect.gen(function* () {
          const connection: GitlabConnection = yield* credentials.resolve;
          const response = yield* tryPromise(method, path, (signal) =>
            fetch(new URL(path, `${connection.url}/api/v4/`).toString(), {
              method,
              signal,
              headers: {
                accept: "application/json",
                "private-token": connection.token,
                ...(body === undefined
                  ? {}
                  : { "content-type": "application/json" }),
              },
              body: body === undefined ? undefined : JSON.stringify(body),
            }),
          );
          if (!response.ok) {
            return yield* new GitlabError({
              status: response.status,
              method,
              path,
              message: `GitLab ${method} ${path} -> ${response.status}`,
              body: yield* Effect.promise(() => readJsonBody(response)),
            });
          }
          return response;
        });

      const sendJson = <A, I>(
        method: string,
        path: string,
        body: unknown | undefined,
        schema: Schema.Schema<A, I>,
      ): Effect.Effect<A, GitlabError> =>
        Effect.gen(function* () {
          const response = yield* send(method, path, body);
          return parse(
            schema,
            yield* Effect.promise(() => readJsonBody(response)),
            { method, path },
          );
        });

      // ponytail: offset pagination (`per_page`+`page` until a short
      // page); switch to keyset/cursor pagination if an endpoint rejects it.
      const paginate = <A, I>(
        path: string,
        schema: Schema.Schema<A, I>,
      ): Effect.Effect<readonly A[], GitlabError> =>
        Effect.gen(function* () {
          const out: A[] = [];
          let page = 1;
          for (;;) {
            const separator = path.includes("?") ? "&" : "?";
            const response = yield* send(
              "GET",
              `${path}${separator}per_page=100&page=${page}`,
              undefined,
            );
            const items = parse(
              Schema.Array(schema),
              yield* Effect.promise(() => readJsonBody(response)),
              { method: "GET", path },
            );
            out.push(...items);
            if (items.length < 100) break;
            page += 1;
          }
          return out;
        });

      return {
        connection: () => credentials.resolve,
        showGroupByPath: (fullPath) =>
          sendJson(
            "GET",
            `groups/${encodeURIComponent(fullPath)}`,
            undefined,
            groupSchema,
          )
            .pipe(Effect.map(toGroup))
            .pipe(
              Effect.catchIf(
                (error): error is GitlabError =>
                  error instanceof GitlabError && is404(error),
                () => Effect.succeed(undefined),
              ),
            ),
        createSubGroup: (parentId, path) =>
          sendJson(
            "POST",
            "groups",
            { name: path, path, parent_id: parentId },
            groupSchema,
          ).pipe(Effect.map(toGroup)),
        createRootGroup: (path) =>
          sendJson("POST", "groups", { name: path, path }, groupSchema).pipe(
            Effect.map(toGroup),
          ),
        deleteGroup: (groupId) =>
          Effect.asVoid(
            send("DELETE", `groups/${groupId}`, undefined).pipe(
              Effect.catchIf(
                (error): error is GitlabError =>
                  error instanceof GitlabError && is404(error),
                () => Effect.succeed(undefined),
              ),
            ),
          ),
        upsertGroupCustomAttribute: (groupId, key, value) =>
          Effect.asVoid(
            send("PUT", `groups/${groupId}/custom_attributes/${key}`, {
              value,
            }),
          ),
        upsertProjectCustomAttribute: (projectId, key, value) =>
          Effect.asVoid(
            send("PUT", `projects/${projectId}/custom_attributes/${key}`, {
              value,
            }),
          ),
        showProjectByPath: (fullPath) =>
          sendJson(
            "GET",
            `projects/${encodeURIComponent(fullPath)}`,
            undefined,
            projectSchema,
          )
            .pipe(Effect.map(toProject))
            .pipe(
              Effect.catchIf(
                (error): error is GitlabError =>
                  error instanceof GitlabError && is404(error),
                () => Effect.succeed(undefined),
              ),
            ),
        createProject: (namespaceId, path, options) =>
          sendJson(
            "POST",
            "projects",
            {
              name: path,
              path,
              namespace_id: namespaceId,
              ci_config_path: options.ciConfigPath,
            },
            projectSchema,
          ).pipe(Effect.map(toProject)),
        editProject: (projectId, body) =>
          sendJson("PUT", `projects/${projectId}`, body, projectSchema).pipe(
            Effect.map(toProject),
          ),
        deleteProject: (projectId, fullPath) =>
          // GitLab deletion is async: a first DELETE schedules removal, the
          // second (with the `-deletion_scheduled-` full path) purges it so
          // the same name can be recreated immediately. 404 on either is
          // tolerated — already gone.
          Effect.asVoid(
            Effect.andThen(
              send("DELETE", `projects/${projectId}`, undefined).pipe(
                Effect.catchIf(
                  (error): error is GitlabError =>
                    error instanceof GitlabError && is404(error),
                  () => Effect.succeed(undefined),
                ),
              ),
              send(
                "DELETE",
                `projects/${projectId}?permanently_remove=true&full_path=${encodeURIComponent(`${fullPath}-deletion_scheduled-${projectId}`)}`,
                undefined,
              ).pipe(
                Effect.catchIf(
                  (error): error is GitlabError =>
                    error instanceof GitlabError && is404(error),
                  () => Effect.succeed(undefined),
                ),
              ),
            ),
          ),
        listGroupProjects: (groupId) =>
          Effect.map(
            paginate(`groups/${groupId}/projects`, projectSchema),
            (projects) => projects.map(toProject),
          ),
        listUsersByEmail: (email) =>
          Effect.map(
            paginate(
              `users?search=${encodeURIComponent(email)}&order_by=username`,
              userSchema,
            ),
            (users) => users.map(toUser),
          ),
        createUser: (body) =>
          sendJson("POST", "users", body, userSchema).pipe(Effect.map(toUser)),
        editUser: (userId, body) =>
          sendJson("PUT", `users/${userId}`, body, userSchema).pipe(
            Effect.map(toUser),
          ),
        upsertUserCustomAttribute: (userId, key, value) =>
          Effect.asVoid(
            send("PUT", `users/${userId}/custom_attributes/${key}`, { value }),
          ),
        listGroupMembers: (groupId) =>
          Effect.map(
            paginate(`groups/${groupId}/members`, memberSchema),
            (members) => members.map(toMember),
          ),
        addGroupMember: (groupId, userId, accessLevel) =>
          Effect.asVoid(
            send("POST", `groups/${groupId}/members`, {
              user_id: userId,
              access_level: accessLevel,
            }),
          ),
        editGroupMember: (groupId, userId, accessLevel) =>
          Effect.asVoid(
            send("PUT", `groups/${groupId}/members/${userId}`, {
              access_level: accessLevel,
            }),
          ),
        removeGroupMember: (groupId, userId) =>
          Effect.asVoid(
            send(
              "DELETE",
              `groups/${groupId}/members/${userId}`,
              undefined,
            ).pipe(
              Effect.catchIf(
                (error): error is GitlabError =>
                  error instanceof GitlabError && is404(error),
                () => Effect.succeed(undefined),
              ),
            ),
          ),
        listGroupAccessTokens: (groupId) =>
          Effect.map(
            paginate(`groups/${groupId}/access_tokens`, groupTokenSchema),
            (tokens) => tokens.map(toToken),
          ),
        createGroupAccessToken: (groupId, body) =>
          sendJson(
            "POST",
            `groups/${groupId}/access_tokens`,
            body,
            groupTokenCreatedSchema,
          ).pipe(Effect.map(toCreatedToken)),
        revokeGroupAccessToken: (groupId, tokenId) =>
          Effect.asVoid(
            send(
              "DELETE",
              `groups/${groupId}/access_tokens/${tokenId}`,
              undefined,
            ),
          ),
      };
    }),
  );
