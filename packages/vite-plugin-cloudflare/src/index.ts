import * as vite from 'vite';
import { createMiddleware } from '@hattip/adapter-node';
import {
	Miniflare,
	Response as MiniflareResponse,
	kUnsafeEphemeralUniqueKey,
} from 'miniflare';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { createCloudflareEnvironment } from './cloudflare-environment';
import type { FetchFunctionOptions } from 'vite/module-runner';
import type {
	CloudflareEnvironmentOptions,
	CloudflareDevEnvironment,
} from './cloudflare-environment';
import { UNKNOWN_HOST } from './shared';
const runnerPath = fileURLToPath(import.meta.resolve('./runner/index.js'));

export function cloudflare<
	T extends Record<string, CloudflareEnvironmentOptions>,
>({
	workers,
	entryWorker,
}: {
	workers: T;
	entryWorker?: keyof T;
}): vite.Plugin {
	let resolvedConfig: vite.ResolvedConfig;

	return {
		name: 'vite-plugin-cloudflare',
		config() {
			return {
				environments: Object.fromEntries(
					Object.entries(workers).map(([name, options]) => {
						return [name, createCloudflareEnvironment(options)];
					}),
				),
			};
		},
		configResolved(viteConfig) {
			resolvedConfig = viteConfig;
		},
		async configureServer(viteDevServer) {
			const miniflare = new Miniflare({
				workers: Object.entries(workers).map(([name, options]) => {
					const miniflareOptions = unstable_getMiniflareWorkerOptions(
						path.resolve(
							resolvedConfig.root,
							options.wranglerConfig ?? './wrangler.toml',
						),
					);

					const { ratelimits, ...workerOptions } =
						miniflareOptions.workerOptions;

					return {
						...workerOptions,
						name,
						modulesRoot: '/',
						modules: [
							{
								type: 'ESModule',
								path: runnerPath,
							},
						],
						unsafeEvalBinding: '__VITE_UNSAFE_EVAL__',
						bindings: {
							...workerOptions.bindings,
							__VITE_ROOT__: resolvedConfig.root,
						},
						serviceBindings: {
							...workerOptions.serviceBindings,
							__VITE_FETCH_MODULE__: async (request) => {
								const args = (await request.json()) as [
									string,
									string,
									FetchFunctionOptions,
								];

								const devEnvironment = viteDevServer.environments[
									name
								] as CloudflareDevEnvironment;

								try {
									const result = await devEnvironment.fetchModule(...args);

									return new MiniflareResponse(JSON.stringify(result));
								} catch (error) {
									// TODO: check error handling
									const result = {
										externalize: args[0],
										type: 'builtin',
									} satisfies vite.FetchResult;

									return new MiniflareResponse(JSON.stringify(result));
								}
							},
						},
					};
				}),
			});

			await Promise.all(
				Object.keys(workers).map(async (name) => {
					const worker = await miniflare.getWorker(name);

					return (
						viteDevServer.environments[name] as CloudflareDevEnvironment
					).initRunner(worker);
				}),
			);

			const middleware =
				entryWorker &&
				createMiddleware(
					(context) => {
						return (
							viteDevServer.environments[
								entryWorker as string
							] as CloudflareDevEnvironment
						).dispatchFetch(context.request);
					},
					{ alwaysCallNext: false },
				);

			return () => {
				viteDevServer.middlewares.use((req, res, next) => {
					req.url = req.originalUrl;

					if (!middleware) {
						next();
						return;
					}

					middleware(req, res, next);
				});
			};
		},
	};
}
