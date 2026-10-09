/**
 * Console API service entrypoint.
 *
 * Run: pnpm exec tsx src/api/server.ts   (PORT, default 8080)
 *
 * Runtime note: alchemy beta peers on effect ^4 while this repo pins 3.22.2,
 * so booting against real services fails until the effect major lands —
 * test/api/* runs alchemy-free and covers the HTTP/MCP/OpenAPI surfaces.
 */

import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { HttpRouter } from "effect/http";
import * as Layer from "effect/Layer";
import { alchemyDeployer } from "./deployer.ts";
import { localProjectStore } from "./handlers.ts";
import { routerLayer } from "./router.ts";

const ServerLive = HttpRouter.serve(
	// ponytail: local store + alchemy deployer swap for the database +
	// authenticated store in pass two, behind the same interfaces.
	routerLayer(localProjectStore(), alchemyDeployer()),
).pipe(
	Layer.provide(
		NodeHttpServer.layer(createServer, {
			port: Number(process.env.PORT ?? 8080),
		}),
	),
);

// ponytail: platform-node types NodeHttpServer.layer as Layer<any, …>
// (upstream), so runMain-style R=never is unreachable — erase here.
const runLayer = Layer.launch(ServerLive) as unknown as Effect.Effect<void>;
void Effect.runPromise(runLayer);
