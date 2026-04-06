import { db } from './index.js';
import { contentTypes, projects, projectGmbLocations } from './schema.js';
import { isNotNull } from 'drizzle-orm';
import { createId } from '../utils.js';

const SEED_TYPES = [
	{ slug: 'article', label: 'Article de blog', icon: 'file-text' },
	{ slug: 'linkedin', label: 'Post LinkedIn', icon: 'linkedin' },
	{ slug: 'gmb', label: 'Post Google My Business', icon: 'map-pin' }
];

export async function seedContentTypes(): Promise<void> {
	for (const type of SEED_TYPES) {
		await db
			.insert(contentTypes)
			.values({ id: createId(), ...type })
			.onConflictDoNothing();
	}
}

/** Migrate legacy projects.gmbLocationId → project_gmb_locations table */
export async function migrateGmbLocations(): Promise<number> {
	const rows = await db
		.select({ id: projects.id, name: projects.name, gmbLocationId: projects.gmbLocationId })
		.from(projects)
		.where(isNotNull(projects.gmbLocationId));

	let migrated = 0;
	for (const row of rows) {
		if (!row.gmbLocationId) continue;
		await db
			.insert(projectGmbLocations)
			.values({
				id: createId(),
				projectId: row.id,
				gmbLocationId: row.gmbLocationId,
				label: row.name
			})
			.onConflictDoNothing();
		migrated++;
	}
	return migrated;
}
