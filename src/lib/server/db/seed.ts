import { db } from './index.js';
import { contentTypes } from './schema.js';
import { createId } from '../utils.js';

const SEED_TYPES = [
	{ slug: 'article', label: 'Article de blog', icon: 'file-text' }
];

export async function seedContentTypes(): Promise<void> {
	for (const type of SEED_TYPES) {
		await db
			.insert(contentTypes)
			.values({ id: createId(), ...type })
			.onConflictDoNothing();
	}
}
