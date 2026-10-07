import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { SonarqubeClient } from "./client.ts";
import {
	findUserByLogin,
	rotateToken,
} from "./reconcile.ts";
import {
	ciTokenName,
	robotEmail,
	robotLogin,
	ROBOT_PERMISSIONS,
	roleGroupPaths,
	permissionsForRole,
	projectKey,
	PROJECT_ROLES,
} from "./paths.ts";

/**
 * CI-token secret payload written to Vault by {@link ProjectPermissions}:
 * exactly the console's `SonarqubeUserSecret` shape.
 */
export interface SonarqubeUserSecret {
	readonly SONAR_USERNAME: string;
	readonly SONAR_PASSWORD: string;
	readonly SONAR_TOKEN: string;
}

/** Password generator the reconciler uses for a new robot user. */
export type PasswordGenerator = () => string;

const RANDOM_PASSWORD_CHARS =
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@-_#*";

/** Default password generator: 30 chars, console alphabet. */
export const generateRandomPassword: PasswordGenerator = () => {
	const values = new Uint32Array(30);
	crypto.getRandomValues(values);
	return Array.from(values, (x) => RANDOM_PASSWORD_CHARS[x % RANDOM_PASSWORD_CHARS.length] ?? "x")
		.join("");
};

/**
 * Grants the per-role Keycloak groups (from oidc paths
 * `/{slug}/console/{suffix}`) their permission sets on one SonarQube
 * project, plus the CI robot user (login = slug) with its `scan`
 * permission and rotated token stored via the Vault secret path
 * (accepted as a prop — composed by the caller with a path helper, no
 * cross-import).
 *
 * Console semantics: user sync is search-by-login (`users/search?q=`),
 * the robot email is rewritten to `<slug>@cloud-pi-native.fr` when it
 * drifts, and the token rotates (revoke + generate) whenever the vault
 * secret is missing. Password and email are only pushed on drift.
 */
export interface ProjectPermissionsProps {
	/** Console project slug — robot login and group-path prefix. */
	readonly slug: string;
	/** Repository `internalRepoName` the SonarQube project covers. */
	readonly repository: string;
	/**
	 * Fully-resolved Vault secret path for the CI credentials — compose
	 * with a path helper at the call site.
	 */
	readonly vaultSecretPath: string;
	/**
	 * Existing secret payload, read by the caller from Vault; when
	 * `undefined` the token is rotated and the new secret returned.
	 */
	readonly existingSecret?: SonarqubeUserSecret | undefined;
	/** Password generator override (tests). */
	readonly passwordGenerator?: PasswordGenerator | undefined;
	/** Raw role-suffix overrides per role (comma-separated multi-paths). */
	readonly roleSuffixes?: Readonly<
		Partial<Record<(typeof PROJECT_ROLES)[number], string>>
	>;
}

export interface ProjectPermissions
	extends Resource<
		"Cpn.Sonarqube.ProjectPermissions",
		ProjectPermissionsProps,
		{
			readonly secret: SonarqubeUserSecret;
		}
	> {}

export const ProjectPermissions = Resource<ProjectPermissions>(
	"Cpn.Sonarqube.ProjectPermissions",
);

/**
 * The secret the reconciler hands back for the caller to write to
 * Vault — `vaultSecretPath` plus the payload. The caller owns the
 * Vault write (no cross-import).
 */
export interface ProjectPermissionsResult {
	readonly vaultSecretPath: string;
	readonly secret: SonarqubeUserSecret;
}

export const ProjectPermissionsProvider = () =>
	Provider.effect(
		ProjectPermissions,
		Effect.gen(function* () {
			const client = yield* SonarqubeClient;
			return ProjectPermissions.Provider.of({
				list: () => Effect.succeed([]),
				read: Effect.fn("Cpn.Sonarqube.ProjectPermissions/read")(function* () {
					// Grant state is not readable through the SonarQube API
					// (add-only endpoints); the secret is owned by the caller's
					// Vault resource. Always re-apply.
					return undefined;
				}),
				reconcile: Effect.fn(
					"Cpn.Sonarqube.ProjectPermissions/reconcile",
				)(function* ({ news, output }) {
					const login = robotLogin(news.slug);
					const key = projectKey(news.slug, news.repository);

					// Ensure robot user (search-by-login, create when missing).
					const existingUser = yield* findUserByLogin(client, login);
					let password: string | undefined;
					const email = robotEmail(news.slug);
					const updateBody: {
						login: string;
						email?: string;
						password?: string;
					} = { login };
					if (existingUser === undefined) {
						password = (news.passwordGenerator ?? generateRandomPassword)();
						yield* client.createUser({
							login,
							name: login,
							email,
							password,
						});
					} else if (
					existingUser.email !== undefined &&
					existingUser.email !== email &&
					existingUser.email.length > 0
				) {
						// #2510: legacy robots carry the owner's real email, which
						// collides with the owner's SSO login — rewrite on drift,
						// never push a blank email (a blank would erase the value).
						updateBody.email = email;
					}

					// Rotate token when the vault secret is missing.
					let secret: SonarqubeUserSecret | undefined =
						news.existingSecret ?? output?.secret;
					if (secret === undefined) {
						const token = yield* rotateToken(client, login);
						password ??= (news.passwordGenerator ?? generateRandomPassword)();
						secret = {
							SONAR_USERNAME: login,
							SONAR_PASSWORD: password,
							SONAR_TOKEN: token.token,
						};
						// A regenerated password must reach the robot account, or
						// the stored secret would lie (console parity).
						updateBody.password = password;
					}
					if (updateBody.email !== undefined || updateBody.password !== undefined) {
						yield* client.updateUser(updateBody);
					}

					// Robot permissions on the project.
					yield* Effect.all(
						ROBOT_PERMISSIONS.map((permission) =>
							client.addUserPermission({ projectKey: key, permission, login }),
						),
					);

					// Per-role group permissions.
					yield* Effect.all(
						PROJECT_ROLES.flatMap((role) =>
							roleGroupPaths(news.slug, role, news.roleSuffixes?.[role]).flatMap(
								(groupName) =>
									permissionsForRole(role).map((permission) =>
										client.addGroupPermission({
											projectKey: key,
											permission,
											groupName,
										}),
									),
							),
						),
					);

					return { secret };
				}),
				delete: Effect.fn(
					"Cpn.Sonarqube.ProjectPermissions/delete",
				)(function* () {
					// Grants die with the SonarQube project; the robot user and
					// vault secret are owned by their own resources.
				}),
			});
		}),
	);
