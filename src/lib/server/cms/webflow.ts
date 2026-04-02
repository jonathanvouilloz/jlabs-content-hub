import type {
	CmsAdapter,
	CmsCollection,
	CmsConnectionConfig,
	CmsField,
	CmsItemData,
	CmsPublishResult,
	CmsSite
} from './types.js';

const BASE_URL = 'https://api.webflow.com/v2';

async function webflowFetch(path: string, token: string, options: RequestInit = {}) {
	const res = await fetch(`${BASE_URL}${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			...options.headers
		}
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Webflow API ${res.status}: ${body}`);
	}

	return res.json();
}

export class WebflowAdapter implements CmsAdapter {
	async listSites(apiToken: string): Promise<CmsSite[]> {
		const data = await webflowFetch('/sites', apiToken);
		return (data.sites ?? []).map((s: { id: string; displayName: string; shortName: string }) => ({
			id: s.id,
			name: s.displayName || s.shortName
		}));
	}

	async listCollections(apiToken: string, siteId: string): Promise<CmsCollection[]> {
		const data = await webflowFetch(`/sites/${siteId}/collections`, apiToken);
		return (data.collections ?? []).map(
			(c: { id: string; displayName: string; slug: string }) => ({
				id: c.id,
				name: c.displayName,
				slug: c.slug
			})
		);
	}

	async getCollectionFields(apiToken: string, collectionId: string): Promise<CmsField[]> {
		const data = await webflowFetch(`/collections/${collectionId}`, apiToken);
		return (data.fields ?? []).map(
			(f: { slug: string; displayName: string; type: string; isRequired: boolean }) => ({
				slug: f.slug,
				name: f.displayName,
				type: f.type,
				required: f.isRequired ?? false
			})
		);
	}

	async publish(
		config: CmsConnectionConfig,
		apiToken: string,
		data: CmsItemData
	): Promise<CmsPublishResult> {
		const fieldData: Record<string, unknown> = {};

		for (const mapping of config.fieldMappings) {
			const value = this.resolveField(mapping.hubField, data);
			if (value !== undefined) {
				if (mapping.transform === 'html' && mapping.hubField === 'body') {
					fieldData[mapping.cmsField] = data.bodyHtml;
				} else {
					fieldData[mapping.cmsField] = value;
				}
			}
		}

		// Webflow requires 'name' and 'slug'
		if (!fieldData['name']) fieldData['name'] = data.title;
		if (!fieldData['slug']) fieldData['slug'] = data.slug;

		// Create + publish in one step via /items/live
		const res = await webflowFetch(
			`/collections/${config.collectionId}/items/live`,
			apiToken,
			{
				method: 'POST',
				body: JSON.stringify({ fieldData })
			}
		);

		const itemId: string = res.id;
		if (!itemId) {
			return { success: false, error: 'No item ID returned from Webflow' };
		}

		return { success: true, itemId };
	}

	private resolveField(hubField: string, data: CmsItemData): unknown {
		switch (hubField) {
			case 'title':
				return data.title;
			case 'slug':
				return data.slug;
			case 'body':
				return data.bodyHtml;
			case 'description':
				return data.metaDescription ?? data.frontmatter['description'];
			case 'metaTitle':
				return data.metaTitle;
			case 'metaDescription':
				return data.metaDescription;
			case 'author':
				return data.frontmatter['author'];
			case 'category':
				return data.frontmatter['category'];
			case 'tags':
				return data.tags?.join(', ');
			case 'pubDate':
				return data.frontmatter['pubDate'];
			case 'image.src': {
				const img = data.frontmatter['image'] as { src?: string } | undefined;
				return img?.src;
			}
			case 'image.alt': {
				const img = data.frontmatter['image'] as { alt?: string } | undefined;
				return img?.alt;
			}
			case 'schema': {
				const raw = data.schema ?? (data.frontmatter['schema'] as string);
				if (!raw) return undefined;
				// Strip <script> tags — keep only the JSON content
				return raw
					.replace(/<script[^>]*>/gi, '')
					.replace(/<\/script>/gi, '')
					.trim();
			}
			default:
				return data.frontmatter[hubField];
		}
	}
}
