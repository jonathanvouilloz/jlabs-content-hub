import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types.js';
import { slugify } from '$lib/utils/slugify.js';
import { createProjectProjection } from '$lib/server/project-creation.js';
import { projectCreationDependencies } from '$lib/server/project-creation-db.js';

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const slug = slugify(String(data.get('slug') ?? '') || name);
		if (!name || !slug) return fail(400, { error: 'Le nom du projet est requis.', name });
		try {
			const result = await createProjectProjection({
				name,
				slug,
				description: String(data.get('description') ?? '') || null,
				color: String(data.get('color') ?? '') || null,
				image: String(data.get('image') ?? '') || null
			}, projectCreationDependencies);
			throw redirect(303, `/projects/${result.slug}`);
		} catch (error) {
			if (error && typeof error === 'object' && 'status' in error && 'location' in error) throw error;
			return fail(503, { error: error instanceof Error ? error.message : 'Création impossible.', name });
		}
	}
};
