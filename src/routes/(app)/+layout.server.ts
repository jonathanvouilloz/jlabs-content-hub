import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(303, '/login');
	}

	const allProjects = await db
		.select({
			id: projects.id,
			name: projects.name,
			slug: projects.slug,
			color: projects.color
		})
		.from(projects)
		.where(eq(projects.archived, false))
		.orderBy(projects.name);

	return {
		user: locals.user,
		sidebarProjects: allProjects
	};
};
