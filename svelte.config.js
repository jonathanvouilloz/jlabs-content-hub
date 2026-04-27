import adapter from '@sveltejs/adapter-vercel';
import { relative, sep } from 'node:path';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// defaults to rune mode for the project, execept for `node_modules`. Can be removed in svelte 6.
		runes: ({ filename }) => {
			const relativePath = relative(import.meta.dirname, filename);
			const pathSegments = relativePath.toLowerCase().split(sep);
			const isExternalLibrary = pathSegments.includes('node_modules');

			return isExternalLibrary ? undefined : true;
		}
	},
	kit: {
		adapter: adapter(),
		csrf: {
			// Disabled: every /api/* route enforces its own auth (Bearer API key via validateApiKey,
			// or Better Auth session via locals.user). Better Auth handles CSRF for /api/auth/*.
			// Required so server-to-server multipart POSTs (e.g. /publish-hub uploading to /api/blob/upload)
			// are not rejected by SvelteKit's default same-origin form check.
			checkOrigin: false
		}
	}
};

export default config;
