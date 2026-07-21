import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { contents, statusHistory } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createId } from '$lib/server/utils.js';
import { parseLinkedInBatch, buildFinalText } from '$lib/utils/linkedin.js';
import { parseFrontmatter } from '$lib/utils/content.js';
import type { RequestHandler } from './$types';

interface PostSelection {
	day: string;
	selectedHook: 'main' | 'A' | 'B' | 'custom';
	customHook?: string;
	editedBody?: string;
	plannedDate: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = await request.json();
	const { batchContentId, posts } = body as { batchContentId: string; posts: PostSelection[] };

	if (!batchContentId || !posts || posts.length === 0) {
		return json({ error: 'Missing batchContentId or posts' }, { status: 400 });
	}

	// Load the batch content
	const batch = await db.select().from(contents).where(eq(contents.id, batchContentId)).then((r) => r[0]);
	if (!batch || batch.type !== 'linkedin') {
		return json({ error: 'Batch content not found' }, { status: 404 });
	}

	// Parse the batch
	const { content: markdownBody } = parseFrontmatter(batch.body);
	const parsedPosts = parseLinkedInBatch(markdownBody);

	if (parsedPosts.length === 0) {
		return json({ error: 'Could not parse batch content' }, { status: 400 });
	}

	const createdIds: string[] = [];
	const now = new Date().toISOString();

	for (const selection of posts) {
		const parsed = parsedPosts.find((p) => p.day === selection.day);
		if (!parsed) continue;

		// Build final text
		let finalText: string;
		if (selection.editedBody) {
			finalText = selection.editedBody;
		} else {
			finalText = buildFinalText(parsed, selection.selectedHook, selection.customHook);
		}

		const id = createId();
		const slug = `linkedin-${batch.slug}-${selection.day}`;
		const title = `LinkedIn ${selection.day.charAt(0).toUpperCase() + selection.day.slice(1)} — ${parsed.title}`;

		await db.insert(contents).values({
			id,
			projectId: batch.projectId,
			type: 'linkedin',
			title,
			slug,
			body: finalText,
			status: 'approved',
			plannedDate: selection.plannedDate ? new Date(selection.plannedDate).toISOString() : null,
			tags: batch.tags,
			createdAt: now,
			updatedAt: now
		});

		await db.insert(statusHistory).values({
			id: createId(),
			contentId: id,
			fromStatus: null,
			toStatus: 'approved',
			changedBy: 'linkedin-split'
		});

		createdIds.push(id);
	}

	// Delete the batch
	await db.delete(statusHistory).where(eq(statusHistory.contentId, batchContentId));
	await db.delete(contents).where(eq(contents.id, batchContentId));

	return json({ ok: true, data: { createdIds } });
};
