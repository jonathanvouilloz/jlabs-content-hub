import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const projects = sqliteTable('projects', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	slug: text('slug').notNull().unique(),
	description: text('description'),
	color: text('color').notNull().default('#00D9A3'),
	accessToken: text('access_token').notNull().unique(),
	archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
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
