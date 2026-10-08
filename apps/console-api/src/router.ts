/**
 * Service composition — HTTP API + OpenAPI manifest on one router.
 * Everything here is alchemy-free and testable via HttpLayerRouter
 * .toWebHandler (see test/api/router.test.ts).
 */

import { HttpLayerRouter, OpenApi } from "@effect/platform";
import * as Layer from "effect/Layer";
import type { Deployer, ProjectStore } from "./contract.ts";
import { api } from "./contract.ts";
import { projectHandlers } from "./handlers.ts";

/** The OpenAPI 3.1 manifest derived from the contract — one source of truth. */
export const openApiSpec = OpenApi.fromApi(api);

/** The full application: project routes and /api/openapi.json. */
export const routerLayer = (store: ProjectStore, deployer: Deployer) =>
	HttpLayerRouter.addHttpApi(api, {
		openapiPath: "/api/openapi.json",
	}).pipe(Layer.provide(projectHandlers(store, deployer)));
