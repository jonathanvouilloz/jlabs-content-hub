import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
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
	accessToken: text('access_token').notNull().unique(),
	archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
	gmbLocationId: text('gmb_location_id'),
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

export const gmbSettings = sqliteTable('gmb_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

