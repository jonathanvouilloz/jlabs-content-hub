export interface CmsFieldMapping {
	hubField: string;
	cmsField: string;
	transform?: 'html' | 'plaintext' | 'none';
}

export interface CmsConnectionConfig {
	siteId: string;
	siteName: string;
	collectionId: string;
	collectionName: string;
	fieldMappings: CmsFieldMapping[];
}

export interface CmsPublishResult {
	success: boolean;
	itemId?: string;
	error?: string;
}

export interface CmsSite {
	id: string;
	name: string;
}

export interface CmsCollection {
	id: string;
	name: string;
	slug: string;
}

export interface CmsField {
	slug: string;
	name: string;
	type: string;
	required: boolean;
}

export interface CmsItemData {
	title: string;
	slug: string;
	bodyHtml: string;
	metaTitle?: string;
	metaDescription?: string;
	tags?: string[];
	schema?: string;
	frontmatter: Record<string, unknown>;
}

export interface CmsAdapter {
	publish(
		config: CmsConnectionConfig,
		apiToken: string,
		data: CmsItemData
	): Promise<CmsPublishResult>;

	listSites(apiToken: string): Promise<CmsSite[]>;

	listCollections(apiToken: string, siteId: string): Promise<CmsCollection[]>;

	getCollectionFields(apiToken: string, collectionId: string): Promise<CmsField[]>;
}
