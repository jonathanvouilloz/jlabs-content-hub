import { auth } from '$lib/server/auth.js';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { building } from '$app/environment';

export async function handle({ event, resolve }) {
	const session = await auth.api.getSession({
		headers: event.request.headers
	});

	if (session) {
		event.locals.user = session.user as App.Locals['user'];
		event.locals.session = session.session as App.Locals['session'];
	}

	return svelteKitHandler({ event, resolve, auth, building });
}
