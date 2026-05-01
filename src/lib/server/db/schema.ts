import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
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
		githubSynced: integer('github_synced', { mode: 'boolean' }).notNull().default(false),
		githubPath: text('github_path'),
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

