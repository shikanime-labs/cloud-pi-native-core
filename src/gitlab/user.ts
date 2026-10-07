import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { GitlabClient, type GitlabUser } from "./client.ts";
import { type GitlabError, isAlreadyTaken } from "./credentials.ts";
import {
	generateUsername,
	MANAGED_BY_CONSOLE_CUSTOM_ATTRIBUTE_KEY,
	USER_ID_CUSTOM_ATTRIBUTE_KEY,
} from "./utils.ts";

/**
 * Cpn.Gitlab.User — a console user mirrored onto the GitLab instance.
 *
 * Console semantics:
 * - search-by-email first; create when missing;
 * - username = email local part with every char outside `[A-Za-z0-9_-]`
 *   stripped;
 * - create body: externUid=email, provider `openid_connect`,
 *   forceRandomPassword, projectsLimit 0, canCreateGroup false,
 *   skipConfirmation;
 * - a 409 username-taken on create is NORMAL (GitLab auto-provisions via
 *   OIDC — the email index race): tolerate + refetch by email;
 * - the instance admin/auditor flags are authoritative from the adminRole
 *   oidcGroup paths: member → true, non-member → false, empty/unresolved
 *   → undefined (flag untouched);
 * - tagged `cpn_managed_by_console=true` + `cpn_user_id=<id>`;
 * - never deleted — mirrored identity, not owned infrastructure.
 */
export interface UserProps {
	/** Email — identity, externUid and lookup key. */
	readonly email: string;
	/** Display name (console generateName from firstName+lastName). */
	readonly name: string;
	/** Console user id — the `cpn_user_id` custom attribute value. */
	readonly cpnUserId: string;
	/**
	 * Instance admin flag, resolved from the adminRole oidcGroup paths:
	 * member → true, non-member → false, empty → undefined (untouched).
	 */
	readonly admin?: boolean | undefined;
	/** Instance auditor flag — same resolution as `admin`. */
	readonly auditor?: boolean | undefined;
}

export interface UserAttrs {
	readonly userId: number;
	readonly username: string;
	readonly name: string;
	readonly email: string;
}

export interface User
	extends Resource<"Cpn.Gitlab.User", UserProps, UserAttrs> {}

export const User = Resource<User>("Cpn.Gitlab.User");

const tagUser = (
	userId: number,
	cpnUserId: string,
): Effect.Effect<void, GitlabError, GitlabClient> =>
	Effect.gen(function* () {
		const client = yield* GitlabClient;
		yield* client.upsertUserCustomAttribute(
			userId,
			USER_ID_CUSTOM_ATTRIBUTE_KEY,
			cpnUserId,
		);
		yield* client.upsertUserCustomAttribute(
			userId,
			MANAGED_BY_CONSOLE_CUSTOM_ATTRIBUTE_KEY,
			"true",
		);
	});

/**
 * Body sent on user CREATE — the console's pinned flags. `admin`/`auditor`
 * only appear when the role resolution produced a defined value.
 */
const createBody = (news: UserProps): Record<string, unknown> => ({
	email: news.email,
	username: generateUsername(news.email),
	name: news.name,
	...(news.admin === undefined ? {} : { admin: news.admin }),
	...(news.auditor === undefined ? {} : { auditor: news.auditor }),
	extern_uid: news.email,
	provider: "openid_connect",
	force_random_password: true,
	projects_limit: 0,
	can_create_group: false,
	skip_confirmation: true,
});

/**
 * Body sent on user EDIT — only fields with a defined desired value. The
 * console's diff check compares each desired field against the live user;
 * a name that already matches is skipped.
 */
const editBody = (
	news: UserProps,
	existing: GitlabUser,
): Record<string, unknown> => ({
	...(news.admin === undefined ? {} : { admin: news.admin }),
	...(news.auditor === undefined ? {} : { auditor: news.auditor }),
	...(news.name === existing.name ? {} : { name: news.name }),
});

const needsEdit = (body: Record<string, unknown>): boolean =>
	Object.keys(body).length > 0;

export const UserProvider = () =>
	Provider.effect(
		User,
		Effect.gen(function* () {
			return User.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Gitlab.User/read")(function* ({ olds }) {
					const client = yield* GitlabClient;
					const found = yield* client.listUsersByEmail(olds.email);
					const user = found[0];
					if (user === undefined) return undefined;
					return {
						userId: user.id,
						username: user.username,
						name: user.name,
						email: user.email,
					};
				}),
				reconcile: Effect.fn("Cpn.Gitlab.User/reconcile")(function* ({ news }) {
					const client = yield* GitlabClient;
					// Observe — search by email.
					const found = yield* client.listUsersByEmail(news.email);
					const existing = found[0];
					// Ensure — create when missing; a username-taken 409 is NORMAL
					// (OIDC auto-provision race): tolerate + refetch by email.
					if (existing === undefined) {
						const created = yield* client.createUser(createBody(news)).pipe(
							Effect.catchIf(isAlreadyTaken, () =>
								Effect.gen(function* () {
									const refetched = yield* client.listUsersByEmail(news.email);
									const raced = refetched[0];
									if (raced === undefined) {
										return yield* Effect.fail(
											new Error(
												`GitLab user not found after 409 race: ${news.email}`,
											),
										);
									}
									return raced;
								}),
							),
						);
						yield* tagUser(created.id, news.cpnUserId);
						return {
							userId: created.id,
							username: created.username,
							name: created.name,
							email: created.email,
						};
					}
					// Sync — converge editable flags + name, then custom attributes.
					const body = editBody(news, existing);
					if (needsEdit(body)) {
						yield* client.editUser(existing.id, body);
					}
					yield* tagUser(existing.id, news.cpnUserId);
					return {
						userId: existing.id,
						username: existing.username,
						name: existing.name,
						email: existing.email,
					};
				}),
				delete: Effect.fn("Cpn.Gitlab.User/delete")(function* () {
					// Mirrored identity, not owned infrastructure — the console
					// never deletes users with a project.
				}),
			});
		}),
	);
