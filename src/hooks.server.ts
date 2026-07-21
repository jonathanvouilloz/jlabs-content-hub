import { auth } from '$lib/server/auth.js';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { building } from '$app/environment';
// Effet de bord : valide la config runtime au chargement du serveur (GOV-003).
import '$lib/server/config.js';

export async function handle({ event, resolve }) {
	const session = await auth.api.getSession({
		headers: event.request.headers
	});

	if (session) {
		event.locals.user = session.user as App.Locals['user'];
		event.locals.session = session.session as App.Locals['session'];
	}

	// Skip Better Auth handler for our custom OAuth routes (Google, LinkedIn)
	if (event.url.pathname.startsWith('/api/auth/google') || event.url.pathname.startsWith('/api/auth/linkedin')) {
		return resolve(event);
	}

	return svelteKitHandler({ event, resolve, auth, building });
}
