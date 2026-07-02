import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ── Better Auth tables ──────────────────────────────────────────────

export const user = sqliteTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
	image: text('image'),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`)
});

export const session = sqliteTable('session', {
	id: text('id').primaryKey(),
	expiresAt: text('expires_at').notNull(),
	token: text('token').notNull().unique(),
	ipAddress: text('ip_address'),
	userAgent: text('user_agent'),
	userId: text('user_id')
		.notNull()
		.references(() => user.id),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`)
});

export const account = sqliteTable('account', {
	id: text('id').primaryKey(),
	accountId: text('account_id').notNull(),
	providerId: text('provider_id').notNull(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id),
	accessToken: text('access_token'),
	refreshToken: text('refresh_token'),
	idToken: text('id_token'),
	accessTokenExpiresAt: text('access_token_expires_at'),
	refreshTokenExpiresAt: text('refresh_token_expires_at'),
	scope: text('scope'),
	password: text('password'),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`)
});

export const verification = sqliteTable('verification', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: text('expires_at').notNull(),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`)
});

// ── Application tables ──────────────────────────────────────────────

export const projects = sqliteTable('projects', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	slug: text('slug').notNull().unique(),
	description: text('description'),
	color: text('color').notNull().default('#00D9A3'),
	image: text('image'),
	accessToken: text('access_token').notNull().unique(),
	archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
	gmbLocationId: text('gmb_location_id'),
	clientEmail: text('client_email'),
	weeklyDigestEnabled: integer('weekly_digest_enabled', { mode: 'boolean' }).notNull().default(false),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`)
});

export const contents = sqliteTable(
	'contents',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		type: text('type').notNull(),
		title: text('title').notNull(),
		slug: text('slug').notNull(),
		body: text('body').notNull(),
		status: text('status').notNull().default('draft'),
		plannedDate: text('planned_date'),
		publishedAt: text('published_at'),
		tags: text('tags'),
		meta: text('meta'),
		gmbPostId: text('gmb_post_id'),
		cmsItemId: text('cms_item_id'),
		createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
		updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`)
	},
	(table) => [uniqueIndex('contents_project_type_slug').on(table.projectId, table.type, table.slug)]
);

export const comments = sqliteTable('comments', {
	id: text('id').primaryKey(),
	contentId: text('content_id')
		.notNull()
		.references(() => contents.id),
	authorName: text('author_name').notNull(),
	authorEmail: text('author_email').notNull(),
	body: text('body').notNull(),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`)
});

export const contentTypes = sqliteTable('content_types', {
	id: text('id').primaryKey(),
	slug: text('slug').notNull().unique(),
	label: text('label').notNull(),
	icon: text('icon'),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`)
});

export const statusHistory = sqliteTable('status_history', {
	id: text('id').primaryKey(),
	contentId: text('content_id')
		.notNull()
		.references(() => contents.id),
	fromStatus: text('from_status'),
	toStatus: text('to_status').notNull(),
	changedBy: text('changed_by').notNull().default('admin'),
	changedAt: text('changed_at').notNull().default(sql`(datetime('now'))`)
});

// ── CMS connections ───────────────────────────────────────────────

export const cmsConnections = sqliteTable('cms_connections', {
	id: text('id').primaryKey(),
	projectId: text('project_id')
		.notNull()
		.references(() => projects.id)
		.unique(),
	cmsType: text('cms_type').notNull(),
	config: text('config').notNull(),
	apiToken: text('api_token').notNull(),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`)
});

// ── GMB tables ─────────────────────────────────────────────────────

export const projectGmbLocations = sqliteTable(
	'project_gmb_locations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		gmbLocationId: text('gmb_location_id').notNull(),
		label: text('label').notNull(),
		address: text('address'),
		createdAt: text('created_at').notNull().default(sql`(datetime('now'))`)
	},
	(table) => [uniqueIndex('project_gmb_loc_unique').on(table.projectId, table.gmbLocationId)]
);

export const gmbReviews = sqliteTable('gmb_reviews', {
	id: text('id').primaryKey(),
	projectId: text('project_id')
		.notNull()
		.references(() => projects.id),
	locationId: text('location_id').notNull(),
	locationLabel: text('location_label').notNull(),
	reviewId: text('review_id').notNull().unique(),
	authorName: text('author_name').notNull(),
	rating: integer('rating').notNull(),
	comment: text('comment').notNull().default(''),
	createTime: text('create_time').notNull(),
	draftReply: text('draft_reply'),
	mentionedEmployees: text('mentioned_employees'),
	repliedAt: text('replied_at'),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`)
});

export const employeeMentions = sqliteTable(
	'employee_mentions',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		employeeName: text('employee_name').notNull(),
		year: integer('year').notNull(),
		month: integer('month').notNull(),
		mentionCount: integer('mention_count').notNull().default(0),
		positiveCount: integer('positive_count').notNull().default(0),
		neutralCount: integer('neutral_count').notNull().default(0),
		negativeCount: integer('negative_count').notNull().default(0),
		updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`)
	},
	(table) => [uniqueIndex('emp_mentions_unique').on(table.projectId, table.employeeName, table.year, table.month)]
);

export const gmbSettings = sqliteTable('gmb_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

export const gmbAiReports = sqliteTable(
	'gmb_ai_reports',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		period: text('period').notNull(),
		model: text('model').notNull(),
		summaryJson: text('summary_json').notNull(),
		inputHash: text('input_hash').notNull(),
		generatedAt: text('generated_at').notNull().default(sql`(datetime('now'))`)
	},
	(table) => [uniqueIndex('gmb_ai_reports_unique').on(table.projectId, table.period)]
);

// Snapshot complet d'une fiche GMB par location.
// Colonnes scalaires pour ce qui est listé/affiché en dashboard,
// JSON blobs pour les structures complexes (hours, services, categories).
export const gmbLocationProfiles = sqliteTable(
	'gmb_location_profiles',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		gmbLocationId: text('gmb_location_id').notNull(),
		title: text('title').notNull(),
		phone: text('phone'),
		websiteUri: text('website_uri'),
		storeCode: text('store_code'),
		primaryCategoryDisplay: text('primary_category_display'),
		primaryCategoryId: text('primary_category_id'),
		formattedAddress: text('formatted_address'),
		latitude: real('latitude'),
		longitude: real('longitude'),
		openStatus: text('open_status'),
		storefrontAddress: text('storefront_address'),
		additionalPhones: text('additional_phones'),
		additionalCategories: text('additional_categories'),
		regularHours: text('regular_hours'),
		specialHours: text('special_hours'),
		serviceItems: text('service_items'),
		profileDescription: text('profile_description'),
		labels: text('labels'),
		attributes: text('attributes'),
		rawPayload: text('raw_payload'),
		etag: text('etag'),
		syncedAt: text('synced_at').notNull().default(sql`(datetime('now'))`),
		updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`)
	},
	(table) => [
		uniqueIndex('gmb_loc_profile_unique').on(table.projectId, table.gmbLocationId),
		index('idx_gmb_loc_profile_synced').on(table.syncedAt)
	]
);

// Métriques journalières Business Profile Performance API.
// Une ligne par (location, date, metric) pour permettre n'importe quelle agrégation.
export const gmbInsightsDaily = sqliteTable(
	'gmb_insights_daily',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		gmbLocationId: text('gmb_location_id').notNull(),
		date: text('date').notNull(),
		metric: text('metric').notNull(),
		value: integer('value').notNull().default(0),
		fetchedAt: text('fetched_at').notNull().default(sql`(datetime('now'))`)
	},
	(table) => [
		uniqueIndex('gmb_insights_unique').on(table.gmbLocationId, table.date, table.metric),
		index('idx_gmb_insights_proj_date').on(table.projectId, table.date)
	]
);

// Audit log des éditions de fiche GMB depuis le hub.
export const gmbProfileEdits = sqliteTable(
	'gmb_profile_edits',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		gmbLocationId: text('gmb_location_id').notNull(),
		section: text('section').notNull(),
		updateMask: text('update_mask'),
		payload: text('payload').notNull(),
		success: integer('success', { mode: 'boolean' }).notNull(),
		errorMessage: text('error_message'),
		changedBy: text('changed_by').notNull().default('admin'),
		changedAt: text('changed_at').notNull().default(sql`(datetime('now'))`)
	},
	(table) => [index('idx_gmb_edits_loc_date').on(table.gmbLocationId, table.changedAt)]
);

export const publishLogs = sqliteTable(
	'publish_logs',
	{
		id: text('id').primaryKey(),
		contentId: text('content_id')
			.notNull()
			.references(() => contents.id),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		channel: text('channel').notNull().default('gmb'),
		locationId: text('location_id'),
		locationLabel: text('location_label'),
		success: integer('success', { mode: 'boolean' }).notNull(),
		gmbPostId: text('gmb_post_id'),
		errorMessage: text('error_message'),
		attemptedAt: text('attempted_at').notNull().default(sql`(datetime('now'))`),
		durationMs: integer('duration_ms'),
		source: text('source').notNull().default('cron')
	},
	(table) => [
		index('idx_publish_logs_project_date').on(table.projectId, table.attemptedAt),
		index('idx_publish_logs_content').on(table.contentId)
	]
);

// ── Project contexts ──────────────────────────────────────────────

export const projectContexts = sqliteTable('project_contexts', {
	id: text('id').primaryKey(),
	projectId: text('project_id')
		.notNull()
		.references(() => projects.id)
		.unique(),
	context: text('context').notNull(),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`)
});

// ── LinkedIn tables ───────────────────────────────────────────────

export const linkedinSettings = sqliteTable('linkedin_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

// ── Google Indexing API ────────────────────────────────────────────

export const indexingCredentials = sqliteTable('indexing_credentials', {
	id: text('id').primaryKey(),
	projectId: text('project_id')
		.notNull()
		.references(() => projects.id)
		.unique(),
	serviceAccountEmail: text('service_account_email').notNull(),
	serviceAccountJson: text('service_account_json').notNull(),
	siteUrl: text('site_url'),
	sitemapUrl: text('sitemap_url'),
	publicUrlTemplate: text('public_url_template'),
	autoSubmitOnPublish: integer('auto_submit_on_publish', { mode: 'boolean' }).notNull().default(false),
	excludePatterns: text('exclude_patterns'),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`)
});

export const indexingSubmissions = sqliteTable('indexing_submissions', {
	id: text('id').primaryKey(),
	projectId: text('project_id')
		.notNull()
		.references(() => projects.id),
	url: text('url').notNull(),
	type: text('type').notNull(),
	status: text('status').notNull(),
	httpStatus: integer('http_status'),
	response: text('response'),
	source: text('source'),
	submittedAt: text('submitted_at').notNull().default(sql`(datetime('now'))`)
});

export const aiJobs = sqliteTable(
	'ai_jobs',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		type: text('type').notNull(),
		status: text('status').notNull().default('pending'),
		result: text('result'),
		error: text('error'),
		createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
		updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`)
	},
	(table) => [index('idx_ai_jobs_project').on(table.projectId, table.status)]
);

// ── Google Search Console weekly snapshots ─────────────────────────

export const gscSnapshots = sqliteTable(
	'gsc_snapshots',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		weekStart: text('week_start').notNull(),
		weekEnd: text('week_end').notNull(),
		fetchedAt: text('fetched_at').notNull().default(sql`(datetime('now'))`),
		status: text('status').notNull().default('pending'),
		totalImpressions: integer('total_impressions').notNull().default(0),
		totalClicks: integer('total_clicks').notNull().default(0),
		avgCtr: real('avg_ctr').notNull().default(0),
		avgPosition: real('avg_position').notNull().default(0),
		rowCount: integer('row_count').notNull().default(0),
		errorMessage: text('error_message')
	},
	(table) => [uniqueIndex('gsc_snapshots_project_week').on(table.projectId, table.weekStart)]
);

export const gscQueryPageData = sqliteTable(
	'gsc_query_page_data',
	{
		id: text('id').primaryKey(),
		snapshotId: text('snapshot_id')
			.notNull()
			.references(() => gscSnapshots.id),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		weekStart: text('week_start').notNull(),
		query: text('query').notNull(),
		page: text('page').notNull(),
		device: text('device').notNull(),
		clicks: integer('clicks').notNull().default(0),
		impressions: integer('impressions').notNull().default(0),
		ctr: real('ctr').notNull().default(0),
		position: real('position').notNull().default(0)
	},
	(table) => [
		index('gsc_qp_project_week').on(table.projectId, table.weekStart),
		index('gsc_qp_project_query').on(table.projectId, table.query),
		index('gsc_qp_project_page').on(table.projectId, table.page)
	]
);

export const gscWeeklyDiffs = sqliteTable(
	'gsc_weekly_diffs',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		weekStart: text('week_start').notNull(),
		computedAt: text('computed_at').notNull().default(sql`(datetime('now'))`),
		kpis: text('kpis').notNull(),
		rising: text('rising').notNull(),
		falling: text('falling').notNull(),
		opportunities: text('opportunities').notNull(),
		newKeywords: text('new_keywords').notNull(),
		lostKeywords: text('lost_keywords').notNull()
	},
	(table) => [uniqueIndex('gsc_diffs_project_week').on(table.projectId, table.weekStart)]
);

// ── Tracked keywords (watchlist positions — epic 23) ────────────────

export const trackedKeywords = sqliteTable(
	'tracked_keywords',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		keyword: text('keyword').notNull(),
		targetUrl: text('target_url'),
		targetPosition: real('target_position'),
		archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
		createdAt: text('created_at').notNull().default(sql`(datetime('now'))`)
	},
	(table) => [uniqueIndex('tracked_keywords_project_keyword').on(table.projectId, table.keyword)]
);

// ── SEO reports (concurrence / backlinks / visibilité IA — pipeline SEO V2) ──
// Un rapport daté attaché à un projet, éventuellement à un article (contentId).
// contentId null = rapport au niveau marque/projet (ex: visibilité IA globale).

export const seoReports = sqliteTable(
	'seo_reports',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		contentId: text('content_id').references(() => contents.id),
		reportType: text('report_type').notNull(), // 'competitor' | 'backlink' | 'ai_visibility'
		target: text('target'), // keyword ciblé ou domaine concurrent
		payload: text('payload').notNull(), // rapport structuré (JSON sérialisé)
		score: integer('score'), // ex: score visibilité IA /100
		createdAt: text('created_at').notNull().default(sql`(datetime('now'))`)
	},
	(table) => [
		index('seo_reports_project_type').on(table.projectId, table.reportType),
		index('seo_reports_content').on(table.contentId)
	]
);

