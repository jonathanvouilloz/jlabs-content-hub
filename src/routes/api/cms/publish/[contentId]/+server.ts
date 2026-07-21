import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { contents, cmsConnections, statusHistory } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/crypto.js';
import { getAdapter } from '$lib/server/cms/index.js';
import { parseFrontmatter, renderMarkdown } from '$lib/utils/content.js';
import { createId } from '$lib/server/utils.js';
import type { CmsConnectionConfig } from '$lib/server/cms/types.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Load content
	const content = await db
		.select()
		.from(contents)
		.where(eq(contents.id, params.contentId))
		.then((r) => r[0]);

	if (!content) {
		return json({ error: 'Content not found' }, { status: 404 });
	}

	if (content.type !== 'article') {
		return json({ error: 'Only articles can be published to CMS' }, { status: 400 });
	}

	if (content.cmsItemId) {
		return json({ error: 'Content already published to CMS' }, { status: 409 });
	}

	// Load CMS connection for this project
	const connection = await db
		.select()
		.from(cmsConnections)
		.where(eq(cmsConnections.projectId, content.projectId))
		.then((r) => r[0]);

	if (!connection) {
		return json({ error: 'No CMS connection for this project' }, { status: 404 });
	}

	// Prepare data
	const { data: frontmatter, content: markdownBody } = parseFrontmatter(content.body);
	const bodyHtml = renderMarkdown(markdownBody);
	const config: CmsConnectionConfig = JSON.parse(connection.config);
	const apiToken = decrypt(connection.apiToken);

	const adapter = getAdapter(connection.cmsType);

	try {
		const result = await adapter.publish(config, apiToken, {
			title: content.title,
			slug: content.slug,
			bodyHtml,
			metaTitle: (frontmatter.metaTitle as string) ?? content.title,
			metaDescription: (frontmatter.description as string) ?? (frontmatter.metaDescription as string),
			tags: content.tags ? content.tags.split(',').map((t: string) => t.trim()) : undefined,
			schema: frontmatter.schema as string,
			frontmatter
		});

		if (!result.success) {
			return json({ error: result.error ?? 'CMS publish failed' }, { status: 502 });
		}

		const now = new Date().toISOString();
		const previousStatus = content.status;

		await db
			.update(contents)
			.set({
				cmsItemId: result.itemId,
				status: 'published',
				publishedAt: content.publishedAt ?? now,
				updatedAt: now
			})
			.where(eq(contents.id, content.id));

		if (previousStatus !== 'published') {
			await db.insert(statusHistory).values({
				id: createId(),
				contentId: content.id,
				fromStatus: previousStatus,
				toStatus: 'published',
				changedBy: 'cms-publish'
			});
		}

		return json({ ok: true, data: { itemId: result.itemId } });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 502 });
	}
};
