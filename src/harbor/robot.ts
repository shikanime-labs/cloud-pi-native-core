import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as api from "./api.ts";
import { HarborHttpError } from "./client.ts";
import {
	kindAccess,
	kindName,
	type RobotKind,
	robotFullName,
} from "./roles.ts";

export interface RobotProps {
	/** Console project slug — the Harbor project the robot lives in. */
	readonly slug: string;
	/** Which console robot to manage: `ro`, `rw`, or the opt-in `project` robot. */
	readonly kind: RobotKind;
	/** Harbor project id (from Cpn.Harbor.Project output). */
	readonly projectId: number;
	/** Robot credential lifetime in days. */
	readonly durationDays: number;
	/**
	 * Only the `project` robot is opt-in: when false the resource manages
	 * nothing (Harbor's publishProjectRobot maps to specificallyEnabled).
	 */
	readonly specificallyEnabled?: boolean;
	/**
	 * Bump to rotate: the robot is deleted and recreated, minting a fresh
	 * secret. Rotation never happens implicitly on a create conflict.
	 */
	readonly secretVersion?: number;
}

export interface Robot
	extends Resource<
		"Cpn.Harbor.Robot",
		RobotProps,
		{
			readonly robotId: number;
			readonly name: string;
			readonly fullName: string;
			/**
			 * Reference to the robot's secret — the secret value NEVER appears
			 * inline; consumers resolve it from the secret store.
			 */
			readonly secretRef: string;
		}
	> {}

/**
 * A Harbor project robot. Create-duplicate is a 400 body-code CONFLICT and
 * this resource NEVER rotates on it — the racing run owns the robot and
 * its secret. Rotation happens only by bumping `secretVersion`, the
 * explicit path.
 */
export const Robot = Resource<Robot>("Cpn.Harbor.Robot");

const secretRefOf = (slug: string, name: string) =>
	`harbor://robot/${slug}/${name}`;

const disabledRobot = { robotId: -1, name: "", fullName: "", secretRef: "" };

const isEnabled = (news: RobotProps) =>
	news.kind !== "project" || news.specificallyEnabled === true;

const findRobot = (projectId: number, fullName: string) =>
	Effect.map(api.listProjectRobots(projectId), (robots) =>
		robots.find((robot) => robot.name === fullName),
	);

export const RobotProvider = () =>
	Provider.succeed(Robot, {
		stables: ["robotId"],
		read: ({ olds }) =>
			Effect.gen(function* () {
				if (olds !== undefined && !isEnabled(olds)) return undefined;
				const slug = olds?.slug ?? "";
				const kind = olds?.kind ?? "ro";
				const name = kindName(kind);
				const fullName = robotFullName(slug, name);
				const observed = yield* findRobot(olds?.projectId ?? -1, fullName);
				if (observed === undefined) return undefined;
				return {
					robotId: observed.id,
					name,
					fullName: observed.name,
					secretRef: secretRefOf(slug, name),
				};
			}),
		reconcile: ({ news, olds, output }) =>
			Effect.gen(function* () {
				// The project robot only exists when specifically enabled.
				if (!isEnabled(news)) {
					if (output !== undefined && output.robotId !== -1) {
						yield* api.deleteRobot(output.robotId);
					}
					return disabledRobot;
				}
				const name = kindName(news.kind);
				const fullName = robotFullName(news.slug, name);
				const secretRef = secretRefOf(news.slug, name);

				// Observe — the live robot, found by full name `robot$<slug>+<name>`.
				let observed = yield* findRobot(news.projectId, fullName);

				// Explicit rotation — secretVersion bumped past the version that
				// created the live robot: delete, then fall through to create.
				// This is the ONLY rotation path.
				if (
					observed !== undefined &&
					(news.secretVersion ?? 1) > (olds?.secretVersion ?? 1)
				) {
					yield* api.deleteRobot(observed.id);
					observed = undefined;
				}

				// Ensure — create only when missing. On the 400 CONFLICT duplicate
				// the racing run owns the robot and its secret: adopt the raced
				// robot, never rotate client-side.
				if (observed === undefined) {
					const created = yield* api
						.createRobot({
							name,
							durationDays: news.durationDays,
							description: "robot for ci builds",
							namespace: news.slug,
							access: kindAccess(news.kind),
						})
						.pipe(
							Effect.catchIf(
								(error): error is api.HarborRobotConflict =>
									error instanceof api.HarborRobotConflict,
								() =>
									Effect.gen(function* () {
										const raced = yield* findRobot(news.projectId, fullName);
										if (raced === undefined) {
											return yield* Effect.fail(
												new HarborHttpError({
													status: 400,
													method: "POST",
													path: "robots",
													body: `robot ${fullName} not found after CONFLICT race`,
												}),
											);
										}
										return { id: raced.id, name: raced.name, secret: "" };
									}),
							),
						);
					return {
						robotId: created.id,
						name,
						fullName: created.name,
						secretRef,
					};
				}

				// Sync — robots have no mutable props short of rotation.
				return {
					robotId: observed.id,
					name,
					fullName: observed.name,
					secretRef,
				};
			}),
		delete: ({ output }) =>
			Effect.gen(function* () {
				if (output.robotId === -1) return;
				yield* api.deleteRobot(output.robotId);
			}),
	});
