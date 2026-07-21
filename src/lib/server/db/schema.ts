import {
	pgSchema,
	text,
	integer,
	boolean,
	doublePrecision,
	timestamp,
	uniqueIndex,
	index,
	foreignKey
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── Schémas Postgres ───────────────────────────────────────────────
// Base Neon partagée avec invoices. seo-stats vit dans le schéma `seostats`.
export const seostats = pgSchema('seostats');

// `core` est possédé par invoices ; on en déclare ici un MIROIR lecture-seule
// pour que la FK cross-schéma `projects.slug → core.entities.slug` résolve.
// NE JAMAIS modifier cette définition depuis seo-stats (sinon db:push diverge d'invoices).
export const core = pgSchema('core');
export const entities = core.table('entities', {
	slug: text('slug').primaryKey(),
	display_name: text('display_name'),
	created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow()
});

// Défaut des colonnes date « métier » : on garde des colonnes TEXT (le code écrit et
// compare des chaînes ISO), avec un défaut au même format que les données Turso migrées
// (SQLite `datetime('now')` → 'YYYY-MM-DD HH:MM:SS').
const nowText = sql`(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))`;

// ── Better Auth tables ──────────────────────────────────────────────
// Colonnes date en `timestamp` natif (Better Auth-pg manipule des objets Date).

export const user = seostats.table('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: boolean('email_verified').notNull().default(false),
	image: text('image'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const session = seostats.table('session', {
	id: text('id').primaryKey(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	token: text('token').notNull().unique(),
	ipAddress: text('ip_address'),
	userAgent: text('user_agent'),
	userId: text('user_id')
		.notNull()
		.references(() => user.id),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const account = seostats.table('account', {
	id: text('id').primaryKey(),
	accountId: text('account_id').notNull(),
	providerId: text('provider_id').notNull(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id),
	accessToken: text('access_token'),
	refreshToken: text('refresh_token'),
	idToken: text('id_token'),
	accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
	refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
	scope: text('scope'),
	password: text('password'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const verification = seostats.table('verification', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// ── Application tables ──────────────────────────────────────────────

export const projects = seostats.table(
	'projects',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		slug: text('slug').notNull().unique(), // ⟵ POINTEUR NOYAU → FK core.entities
		description: text('description'),
		color: text('color').notNull().default('#00D9A3'),
		image: text('image'),
		accessToken: text('access_token').notNull().unique(),
		archived: boolean('archived').notNull().default(false),
		gmbLocationId: text('gmb_location_id'),
		clientEmail: text('client_email'),
		weeklyDigestEnabled: boolean('weekly_digest_enabled').notNull().default(false),
		createdAt: text('created_at').notNull().default(nowText),
		updatedAt: text('updated_at').notNull().default(nowText)
	},
	(t) => [
		foreignKey({ columns: [t.slug], foreignColumns: [entities.slug], name: 'projects_slug_fk' })
	]
);

export const contents = seostats.table(
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
		createdAt: text('created_at').notNull().default(nowText),
		updatedAt: text('updated_at').notNull().default(nowText)
	},
	(table) => [uniqueIndex('contents_project_type_slug').on(table.projectId, table.type, table.slug)]
);

export const comments = seostats.table('comments', {
	id: text('id').primaryKey(),
	contentId: text('content_id')
		.notNull()
		.references(() => contents.id),
	authorName: text('author_name').notNull(),
	authorEmail: text('author_email').notNull(),
	body: text('body').notNull(),
	createdAt: text('created_at').notNull().default(nowText)
});

export const contentTypes = seostats.table('content_types', {
	id: text('id').primaryKey(),
	slug: text('slug').notNull().unique(),
	label: text('label').notNull(),
	icon: text('icon'),
	createdAt: text('created_at').notNull().default(nowText)
});

export const statusHistory = seostats.table('status_history', {
	id: text('id').primaryKey(),
	contentId: text('content_id')
		.notNull()
		.references(() => contents.id),
	fromStatus: text('from_status'),
	toStatus: text('to_status').notNull(),
	changedBy: text('changed_by').notNull().default('admin'),
	changedAt: text('changed_at').notNull().default(nowText)
});

// ── CMS connections ───────────────────────────────────────────────

export const cmsConnections = seostats.table('cms_connections', {
	id: text('id').primaryKey(),
	projectId: text('project_id')
		.notNull()
		.references(() => projects.id)
		.unique(),
	cmsType: text('cms_type').notNull(),
	config: text('config').notNull(),
	apiToken: text('api_token').notNull(),
	createdAt: text('created_at').notNull().default(nowText),
	updatedAt: text('updated_at').notNull().default(nowText)
});

// ── GMB tables ─────────────────────────────────────────────────────

export const projectGmbLocations = seostats.table(
	'project_gmb_locations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		gmbLocationId: text('gmb_location_id').notNull(),
		label: text('label').notNull(),
		address: text('address'),
		createdAt: text('created_at').notNull().default(nowText)
	},
	(table) => [uniqueIndex('project_gmb_loc_unique').on(table.projectId, table.gmbLocationId)]
);

export const gmbReviews = seostats.table('gmb_reviews', {
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
	createdAt: text('created_at').notNull().default(nowText)
});

export const employeeMentions = seostats.table(
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
		updatedAt: text('updated_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('emp_mentions_unique').on(table.projectId, table.employeeName, table.year, table.month)
	]
);

export const gmbSettings = seostats.table('gmb_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

export const gmbAiReports = seostats.table(
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
		generatedAt: text('generated_at').notNull().default(nowText)
	},
	(table) => [uniqueIndex('gmb_ai_reports_unique').on(table.projectId, table.period)]
);

// Snapshot complet d'une fiche GMB par location.
export const gmbLocationProfiles = seostats.table(
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
		latitude: doublePrecision('latitude'),
		longitude: doublePrecision('longitude'),
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
		syncedAt: text('synced_at').notNull().default(nowText),
		updatedAt: text('updated_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('gmb_loc_profile_unique').on(table.projectId, table.gmbLocationId),
		index('idx_gmb_loc_profile_synced').on(table.syncedAt)
	]
);

// Métriques journalières Business Profile Performance API.
export const gmbInsightsDaily = seostats.table(
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
		fetchedAt: text('fetched_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('gmb_insights_unique').on(table.gmbLocationId, table.date, table.metric),
		index('idx_gmb_insights_proj_date').on(table.projectId, table.date)
	]
);

// Audit log des éditions de fiche GMB depuis le hub.
export const gmbProfileEdits = seostats.table(
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
		success: boolean('success').notNull(),
		errorMessage: text('error_message'),
		changedBy: text('changed_by').notNull().default('admin'),
		changedAt: text('changed_at').notNull().default(nowText)
	},
	(table) => [index('idx_gmb_edits_loc_date').on(table.gmbLocationId, table.changedAt)]
);

export const publishLogs = seostats.table(
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
		success: boolean('success').notNull(),
		gmbPostId: text('gmb_post_id'),
		errorMessage: text('error_message'),
		attemptedAt: text('attempted_at').notNull().default(nowText),
		durationMs: integer('duration_ms'),
		source: text('source').notNull().default('cron')
	},
	(table) => [
		index('idx_publish_logs_project_date').on(table.projectId, table.attemptedAt),
		index('idx_publish_logs_content').on(table.contentId)
	]
);

// ── Project contexts ──────────────────────────────────────────────

export const projectContexts = seostats.table('project_contexts', {
	id: text('id').primaryKey(),
	projectId: text('project_id')
		.notNull()
		.references(() => projects.id)
		.unique(),
	context: text('context').notNull(),
	createdAt: text('created_at').notNull().default(nowText),
	updatedAt: text('updated_at').notNull().default(nowText)
});

// ── LinkedIn tables ───────────────────────────────────────────────

export const linkedinSettings = seostats.table('linkedin_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

// ── Google Indexing API ────────────────────────────────────────────

export const indexingCredentials = seostats.table('indexing_credentials', {
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
	autoSubmitOnPublish: boolean('auto_submit_on_publish').notNull().default(false),
	excludePatterns: text('exclude_patterns'),
	createdAt: text('created_at').notNull().default(nowText),
	updatedAt: text('updated_at').notNull().default(nowText)
});

export const indexingSubmissions = seostats.table('indexing_submissions', {
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
	submittedAt: text('submitted_at').notNull().default(nowText)
});

export const aiJobs = seostats.table(
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
		createdAt: text('created_at').notNull().default(nowText),
		updatedAt: text('updated_at').notNull().default(nowText)
	},
	(table) => [index('idx_ai_jobs_project').on(table.projectId, table.status)]
);

// ── Google Search Console weekly snapshots ─────────────────────────

export const gscSnapshots = seostats.table(
	'gsc_snapshots',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		weekStart: text('week_start').notNull(),
		weekEnd: text('week_end').notNull(),
		fetchedAt: text('fetched_at').notNull().default(nowText),
		status: text('status').notNull().default('pending'),
		totalImpressions: integer('total_impressions').notNull().default(0),
		totalClicks: integer('total_clicks').notNull().default(0),
		avgCtr: doublePrecision('avg_ctr').notNull().default(0),
		avgPosition: doublePrecision('avg_position').notNull().default(0),
		rowCount: integer('row_count').notNull().default(0),
		errorMessage: text('error_message')
	},
	(table) => [uniqueIndex('gsc_snapshots_project_week').on(table.projectId, table.weekStart)]
);

export const gscQueryPageData = seostats.table(
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
		ctr: doublePrecision('ctr').notNull().default(0),
		position: doublePrecision('position').notNull().default(0)
	},
	(table) => [
		index('gsc_qp_project_week').on(table.projectId, table.weekStart),
		index('gsc_qp_project_query').on(table.projectId, table.query),
		index('gsc_qp_project_page').on(table.projectId, table.page)
	]
);

export const gscWeeklyDiffs = seostats.table(
	'gsc_weekly_diffs',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		weekStart: text('week_start').notNull(),
		computedAt: text('computed_at').notNull().default(nowText),
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

export const trackedKeywords = seostats.table(
	'tracked_keywords',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		keyword: text('keyword').notNull(),
		targetUrl: text('target_url'),
		targetPosition: doublePrecision('target_position'),
		archived: boolean('archived').notNull().default(false),
		createdAt: text('created_at').notNull().default(nowText)
	},
	(table) => [uniqueIndex('tracked_keywords_project_keyword').on(table.projectId, table.keyword)]
);

// ── SEO reports (concurrence / backlinks / visibilité IA — pipeline SEO V2) ──

export const seoReports = seostats.table(
	'seo_reports',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		contentId: text('content_id').references(() => contents.id),
		reportType: text('report_type').notNull(), // 'competitor' | 'backlink' | 'ai_visibility' | 'cannibalization'
		target: text('target'), // keyword ciblé ou domaine concurrent
		payload: text('payload').notNull(), // rapport structuré (JSON sérialisé)
		score: integer('score'), // ex: score visibilité IA /100
		createdAt: text('created_at').notNull().default(nowText)
	},
	(table) => [
		index('seo_reports_project_type').on(table.projectId, table.reportType),
		index('seo_reports_content').on(table.contentId)
	]
);

// ── DATA-002 — Intégrations & projections (socle agentique, SPEC §7.1/§7.2) ──

// Unifie (à terme) les intégrations éparses (indexing_credentials, gmb_settings,
// linkedin_settings, cms_connections). `resource_key` discrimine plusieurs
// propriétés/localisations d'un même provider (propriété GSC, gmb_location_id…)
// → unique (project_id, provider, resource_key), zéro collision.
// ⚠️ Les SECRETS ne sont jamais ici : `secret_ref` pointe vers leur emplacement,
// `configuration_json` ne porte que du non-secret (garde `assertNoInlineSecret`).
export const projectIntegrations = seostats.table(
	'project_integrations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		provider: text('provider').notNull(), // 'gsc' | 'gmb' | 'indexing' | 'linkedin' | 'cms' | 'plausible' | 'indexnow'
		resourceKey: text('resource_key').notNull().default(''), // propriété/localisation ; '' si singleton
		enabled: boolean('enabled').notNull().default(false),
		status: text('status').notNull().default('inactive'), // 'inactive' | 'active' | 'error' | 'revoked'
		scopes: text('scopes'), // liste sérialisée des scopes accordés
		configurationJson: text('configuration_json'), // config NON secrète (endpoints, options)
		secretRef: text('secret_ref'), // pointeur vers le secret, jamais le secret lui-même
		lastSuccessAt: text('last_success_at'),
		lastErrorAt: text('last_error_at'),
		lastErrorCode: text('last_error_code'),
		healthStatus: text('health_status').notNull().default('unknown'), // 'healthy' | 'degraded' | 'down' | 'unknown'
		createdAt: text('created_at').notNull().default(nowText),
		updatedAt: text('updated_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('project_integrations_unique').on(table.projectId, table.provider, table.resourceKey),
		index('idx_project_integrations_provider').on(table.provider),
		index('idx_project_integrations_project').on(table.projectId)
	]
);

// Projection de contexte compilée/hashée/versionnée (SPEC §3.2/§7.2).
// Historique : 1 ligne par (project_id, source_hash) → une projection inchangée
// n'est jamais dupliquée ; un nouveau hash = nouvelle version auditée. L'unique
// partiel garantit une seule projection `current` par projet.
export const projectProjections = seostats.table(
	'project_projections',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		schemaVersion: integer('schema_version').notNull().default(1),
		sourceHash: text('source_hash').notNull(),
		payload: text('payload').notNull(), // contexte non secret (slug, domaine, règles de marque…)
		status: text('status').notNull().default('current'), // 'current' | 'stale' | 'invalid'
		validationErrors: text('validation_errors'),
		compiledAt: text('compiled_at'),
		receivedAt: text('received_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('project_projections_hash_unique').on(table.projectId, table.sourceHash),
		uniqueIndex('project_projections_one_current')
			.on(table.projectId)
			.where(sql`status = 'current'`),
		index('idx_project_projections_project_status').on(table.projectId, table.status)
	]
);

// ── DATA-003 — Orchestration : runs, steps & queue durable (SPEC §7.3/§7.4/§6.2) ──

// Run logique de monitoring (SPEC §7.3). Une exécution pour un projet sur une
// période, dédupliquée par `idempotency_key` : deux créations concurrentes avec
// la même clé ne produisent qu'un seul run (unique project_id + idempotency_key).
// `summary_json`/`cost_json` = agrégats non secrets. Le statut se dérive des steps
// (voir classifyRunOutcome) : `partial` = mix succès + échec.
export const monitoringRuns = seostats.table(
	'monitoring_runs',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runType: text('run_type').notNull(), // 'daily' | 'weekly' | 'monthly' | 'manual' | 'post_publish'
		periodStart: text('period_start'),
		periodEnd: text('period_end'),
		status: text('status').notNull().default('queued'), // 'queued'|'running'|'partial'|'success'|'failed'|'cancelled'
		idempotencyKey: text('idempotency_key').notNull(),
		triggeredBy: text('triggered_by').notNull().default('schedule'), // 'schedule'|'user'|'agent'|'webhook'
		startedAt: text('started_at'),
		finishedAt: text('finished_at'),
		summaryJson: text('summary_json'), // agrégat non secret (compteurs succès/skip/échec…)
		costJson: text('cost_json'), // coût agrégé (tokens, appels API…)
		createdAt: text('created_at').notNull().default(nowText),
		updatedAt: text('updated_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('monitoring_runs_idempotency_unique').on(table.projectId, table.idempotencyKey),
		index('idx_monitoring_runs_project_status').on(table.projectId, table.status),
		index('idx_monitoring_runs_status').on(table.status)
	]
);

// Step = une tentative d'une étape d'un run (SPEC §7.4). Unique par
// (run_id, step_type, attempt) : `force` crée un nouvel `attempt` rattaché au même
// run (SPEC §8.3), sans dupliquer la tentative précédente. `lease_owner`/`lease_until`
// = mécanique de bail worker ; `input_hash`/`output_hash` = idempotence/dédup.
export const monitoringSteps = seostats.table(
	'monitoring_steps',
	{
		id: text('id').primaryKey(),
		runId: text('run_id')
			.notNull()
			.references(() => monitoringRuns.id),
		stepType: text('step_type').notNull(),
		provider: text('provider'), // aligné project_integrations.provider ; null si étape non-provider
		status: text('status').notNull().default('queued'), // 'queued'|'running'|'success'|'skipped'|'failed'|'provider_unavailable'
		attempt: integer('attempt').notNull().default(1),
		leaseOwner: text('lease_owner'),
		leaseUntil: text('lease_until'),
		inputHash: text('input_hash'),
		outputHash: text('output_hash'),
		startedAt: text('started_at'),
		finishedAt: text('finished_at'),
		durationMs: integer('duration_ms'),
		errorCode: text('error_code'),
		errorMessage: text('error_message'),
		metadataJson: text('metadata_json')
	},
	(table) => [
		uniqueIndex('monitoring_steps_run_type_attempt_unique').on(table.runId, table.stepType, table.attempt),
		index('idx_monitoring_steps_run').on(table.runId),
		index('idx_monitoring_steps_run_status').on(table.runId, table.status)
	]
);

// Queue de jobs durable (SPEC §6.2 + §8.3). Postgres-only (pas de Redis) : la
// réclamation atomique (`FOR UPDATE SKIP LOCKED`) est l'objet de JOB-001 — ici on
// pose la table, la clé d'idempotence (dédup) et l'index de réclamation vérifié.
// `depends_on` = JSON array d'ids de jobs prérequis (§6.2). `run_id` nullable = le
// run logique que le job matérialise. Dead-letter après `attempts >= max_attempts`.
export const jobs = seostats.table(
	'jobs',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id), // nullable
		type: text('type').notNull(), // discriminant ('ai' pour ex-ai_jobs, step_type sinon)
		status: text('status').notNull().default('queued'), // 'queued'|'running'|'succeeded'|'failed'|'dead'|'cancelled'
		idempotencyKey: text('idempotency_key').notNull(), // ex. weekly:{slug}:{period_end}:{step_type}:{schema_version}
		priority: integer('priority').notNull().default(0),
		payloadJson: text('payload_json'), // charge non secrète du job
		attempts: integer('attempts').notNull().default(0),
		maxAttempts: integer('max_attempts').notNull().default(5),
		availableAt: text('available_at').notNull().default(nowText), // backoff : pas réclamable avant
		leaseOwner: text('lease_owner'),
		leaseUntil: text('lease_until'),
		heartbeatAt: text('heartbeat_at'),
		dependsOn: text('depends_on'), // JSON array d'ids de jobs prérequis
		lastErrorCode: text('last_error_code'),
		lastErrorMessage: text('last_error_message'),
		createdAt: text('created_at').notNull().default(nowText),
		updatedAt: text('updated_at').notNull().default(nowText),
		finishedAt: text('finished_at')
	},
	(table) => [
		uniqueIndex('jobs_idempotency_unique').on(table.projectId, table.idempotencyKey),
		// Index de réclamation (JOB-001 : WHERE status='queued' AND available_at<=now()
		// ORDER BY priority DESC, available_at ASC FOR UPDATE SKIP LOCKED).
		index('idx_jobs_claim').on(table.status, table.availableAt, table.priority),
		index('idx_jobs_project_status').on(table.projectId, table.status),
		index('idx_jobs_lease').on(table.leaseUntil)
	]
);
