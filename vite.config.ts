import adapter from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Pinned to Vercel rather than adapter-auto: auto resolves the adapter by installing
			// it mid-build, so the deployed build isn't the one reproducible locally.
			//
			// No `runtime` or `regions` on purpose — the Node serverless default is what
			// postgres.js needs (edge has no TCP sockets), and Vercel's default region `iad1`
			// already colocates with the Neon database in us-east-1. Set them if that changes.
			adapter: adapter(),

			typescript: {
				config: (config) => {
					config.include.push('../drizzle.config.ts');
				}
			}
		})
	]
});
