import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, projects, statusHistory } from '$lib/server/db/schema.js';
import { createId } from '$lib/server/utils.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { buildGitHubPath, pushFileToGitHub } from '$lib/server/github.js';
import { slugify } from '$lib/utils/slugify.js';
import { parseFrontmatter } from '$lib/utils/content.js';
import { isBatchFormat, parseLinkedInBatch } from '$lib/utils/linkedin.js';
import { suggestDates } from '$lib/utils/linkedin-schedule.js';
import { eq, and, like } from 'drizzle-orm';

export const POST: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const body = await event.request.json();
	const { project_slug, type, title, slug: bodySlug, body: content, planned_date, tags, meta } = body;

	if (!project_slug || !type || !title || !content) {
		return errorResponse('Missing required fields: project_slug, type, title, body', 400);
	}

	const validTypes = ['article', 'linkedin', 'gmb', 'newsletter', 'other'];
	if (!validTypes.includes(type)) {
		return errorResponse(`Invalid content type: ${type}`, 400);
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, project_slug)
	});
	if (!project) {
		return errorResponse('Project not found', 404);
	}

	const slug = bodySlug || slugify(title);
	const upsert = event.url.searchParams.get('upsert') === 'true';

	const existing = await db.query.contents.findFirst({
		where: and(
			eq(contents.projectId, project.id),
			eq(contents.type, type),
			eq(contents.slug, slug)
		)
	});

	if (existing && !upsert) {
		return errorResponse('Content with this slug already exists. Use ?upsert=true to overwrite.', 409);
	}

	const id = existing?.id ?? createId();
	const githubPath = buildGitHubPath(project_slug, type, slug, planned_date);

	if (existing) {
		await db.update(contents).set({
			title,
			body: content,
			plannedDate: planned_date ?? null,
			tags: tags ? JSON.stringify(tags) : null,
			meta: meta ? JSON.stringify(meta) : null,
			githubPath,
			updatedAt: new Date().toISOString()
		}).where(eq(contents.id, id));
	} else {
		const initialStatus = type === 'gmb' ? 'approved' : 'draft';
		const initialChangedBy = type === 'gmb' ? 'api-auto-approve' : 'api';

		await db.insert(contents).values({
			id,
			projectId: project.id,
			type,
			title,
			slug,
			body: content,
			status: initialStatus,
			plannedDate: planned_date ?? null,
			tags: tags ? JSON.stringify(tags) : null,
			meta: meta ? JSON.stringify(meta) : null,
			githubSynced: false,
			githubPath
		});

		await db.insert(statusHistory).values({
			id: createId(),
			contentId: id,
			fromStatus: null,
			toStatus: initialStatus,
			changedBy: initialChangedBy
		});
	}

	// GitHub sync in background
	pushFileToGitHub(githubPath, content, `[${project_slug}] add: ${slug}`).then(async (synced) => {
		await db.update(contents).set({ githubSynced: synced }).where(eq(contents.id, id));
	});

	// Auto-split LinkedIn batch into individual posts
	if (type === 'linkedin') {
		const { content: markdownBody } = parseFrontmatter(content);
		if (isBatchFormat(markdownBody)) {
			const posts = parseLinkedInBatch(markdownBody);
			if (posts.length > 0) {
				const dates = suggestDates();
				const createdIds: string[] = [];

				for (let i = 0; i < posts.length; i++) {
					const post = posts[i];
					const postId = createId();
					const postSlug = `${slug}-${post.day}`;
					const postTitle = post.title;
					const postMeta = JSON.stringify({
						hooks: { main: post.mainHook, A: post.hookA, B: post.hookB },
						strategy: post.strategy,
						articleUrl: post.articleUrl,
						imagePrompt: post.imagePrompt ?? null
					});

					await db.insert(contents).values({
						id: postId,
						projectId: project.id,
						type: 'linkedin',
						title: postTitle,
						slug: postSlug,
						body: post.mainHook,
						status: 'draft',
						plannedDate: dates[i]?.date ? new Date(dates[i].date).toISOString() : null,
						meta: postMeta,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					});

					await db.insert(statusHistory).values({
						id: createId(),
						contentId: postId,
						fromStatus: null,
						toStatus: 'draft',
						changedBy: 'api'
					});

					createdIds.push(postId);
				}

				// Delete the batch content
				await db.delete(statusHistory).where(eq(statusHistory.contentId, id));
				await db.delete(contents).where(eq(contents.id, id));

				return jsonResponse({ ids: createdIds, split: true, count: createdIds.length }, 201);
			}
		}
	}

	// Auto-split GMB calendar (array of posts) into individual posts
	if (type === 'gmb') {
		let parsed: unknown = null;
		try { parsed = JSON.parse(content); } catch { /* not JSON, skip */ }
		if (Array.isArray(parsed) && parsed.length > 0) {
			const posts = parsed as Array<Record<string, unknown>>;
			const createdIds: string[] = [];
			const usedSlugs = new Set<string>();

			for (let i = 0; i < posts.length; i++) {
				const post = posts[i];
				const postId = createId();
				const rawTitle = (post.title as string | undefined) ?? `Post ${i + 1}`;
				let postSlug = `${slug}-${slugify(rawTitle)}`;
				if (usedSlugs.has(postSlug)) postSlug = `${slug}-${i + 1}`;
				usedSlugs.add(postSlug);

				const postBody = JSON.stringify(post);
				const scheduledAt = (post.scheduled_at as string | undefined) ?? null;
				const postMeta = JSON.stringify({
					image_template: post.image_template ?? null,
					image_style: post.image_style ?? null,
					image_text: post.image_text ?? null,
					image_prompt: post.image_prompt ?? null
				});

				await db.insert(contents).values({
					id: postId,
					projectId: project.id,
					type: 'gmb',
					title: rawTitle,
					slug: postSlug,
					body: postBody,
					status: 'approved',
					plannedDate: scheduledAt ?? planned_date ?? null,
					meta: postMeta,
					githubSynced: false,
					githubPath
				});

				await db.insert(statusHistory).values({
					id: createId(),
					contentId: postId,
					fromStatus: null,
					toStatus: 'approved',
					changedBy: 'api-auto-approve'
				});

				createdIds.push(postId);
			}

			// Delete the original batch row (kept on GitHub as backup via pushFileToGitHub above)
			await db.delete(statusHistory).where(eq(statusHistory.contentId, id));
			await db.delete(contents).where(eq(contents.id, id));

			return jsonResponse({ ids: createdIds, split: true, count: createdIds.length }, 201);
		}
	}

	return jsonResponse({ id, slug, github_path: githubPath }, existing ? 200 : 201);
};

export const GET: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const projectSlug = event.url.searchParams.get('project');
	const type = event.url.searchParams.get('type');
	const status = event.url.searchParams.get('status');

	let query = db.select().from(contents);
	const conditions = [];

	if (projectSlug) {
		const project = await db.query.projects.findFirst({
			where: eq(projects.slug, projectSlug)
		});
		if (project) {
			conditions.push(eq(contents.projectId, project.id));
		}
	}
	if (type) conditions.push(eq(contents.type, type));
	if (status) conditions.push(eq(contents.status, status));

	const results = conditions.length > 0
		? await query.where(and(...conditions))
		: await query;

	return jsonResponse(results);
};
