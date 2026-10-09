/**
 * Shared project operations — the HTTP handlers and the MCP tools call the
 * same four functions, so the two surfaces cannot drift.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectProps } from "@cpn/core/src/composite/derive.ts";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";
import type * as Schema from "effect/Schema";
import {
	api,
	type CreateProjectSchema,
	type Deployer,
	NotFound,
	type ProjectStore,
} from "./contract.ts";

export const summaryFrom = (slug: string) => ({
	slug,
	name: slug,
	status: "created" as const,
});

export const propsFrom = (
	body: Schema.Schema.Type<typeof CreateProjectSchema>,
): ProjectProps => ({
	...body,
	roles: body.roles.map((role) => ({
		...role,
		permissions: BigInt(role.permissions),
	})),
	members: body.members.map((member) => ({
		email: member.email,
		roleIds: [...member.roleIds],
	})),
	environments: body.environments.map((environment) => ({
		...environment,
		roUserEmails: [...environment.roUserEmails],
		rwUserEmails: [...environment.rwUserEmails],
	})),
});

export const listProjects = (store: ProjectStore) =>
	store.list().pipe(Effect.map((slugs) => slugs.map(summaryFrom)));

export const createProject = (
	store: ProjectStore,
	deployer: Deployer,
	body: Schema.Schema.Type<typeof CreateProjectSchema>,
) =>
	Effect.gen(function* () {
		yield* deployer.deploy(propsFrom(body));
		yield* store.add(body.slug);
		return { slug: body.slug, name: body.name, status: "created" as const };
	});

export const getProject = (store: ProjectStore, projectId: string) =>
	store.has(projectId).pipe(
		Effect.filterOrFail(
			(found) => found,
			() => new NotFound({ message: `project ${projectId} not found` }),
		),
		Effect.map(() => summaryFrom(projectId)),
	);

export const deleteProject = (
	store: ProjectStore,
	deployer: Deployer,
	projectId: string,
) =>
	Effect.gen(function* () {
		// Delete needs only the resource declared; olds come from state.
		yield* deployer.destroy(projectId);
		yield* store.remove(projectId);
	});

export const projectHandlers = (store: ProjectStore, deployer: Deployer) =>
	HttpApiBuilder.group(api, "projects", (handlers) =>
		handlers
			.handle("listProjects", () => listProjects(store))
			.handle("createProject", ({ payload }) =>
				createProject(store, deployer, payload),
			)
			.handle("getProject", ({ params }) => getProject(store, params.projectId))
			.handle("deleteProject", ({ params }) =>
				deleteProject(store, deployer, params.projectId),
			),
	);

/**
 * Local store over alchemy's state dir: deploy writes the stage directory,
 * so listing is a readdir and add is a no-op. ponytail: replace with the
 * database in pass two.
 */
export const localProjectStore = (
	rootDir: string = join(process.cwd(), ".alchemy", "state"),
): ProjectStore => {
	const names = (): Promise<string[]> =>
		readdir(rootDir).catch((): string[] => []);
	return {
		list: () => Effect.promise(names),
		has: (slug) =>
			Effect.map(Effect.promise(names), (all) => all.includes(slug)),
		add: () => Effect.void,
		remove: (slug) =>
			Effect.promise(() =>
				rm(join(rootDir, slug), { recursive: true, force: true }),
			),
	};
};
