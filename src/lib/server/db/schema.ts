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
		// JOB-003 — nature du dernier échec : 'retryable'|'quota'|'auth'|'permanent'.
		// C'est elle qui décide du sort du job (retry / report / dead-letter immédiat).
		lastErrorClass: text('last_error_class'),
		// Reports pour cause de quota provider (429). Compteur SÉPARÉ de `attempts` :
		// un 429 rend sa tentative (le job n'a rien fait de mal) mais reste borné ici,
		// sinon un provider mort ferait boucler le job sans fin.
		deferrals: integer('deferrals').notNull().default(0),
		// Reprises manuelles depuis la dead-letter (miroir de `findings.reopen_count`).
		requeuedCount: integer('requeued_count').notNull().default(0),
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
		index('idx_jobs_lease').on(table.leaseUntil),
		// JOB-003 : listing de la dead-letter — index PARTIEL, la console ne scanne
		// jamais toute la file pour afficher les jobs morts.
		index('idx_jobs_dead')
			.on(table.finishedAt)
			.where(sql`status = 'dead'`)
	]
);

// ── DATA-004 — Modèle d'observations (SPEC §7.5) ────────────────────
//
// Une observation = un FAIT collecté (jamais une interprétation → ça, c'est un
// finding, DATA-005). Chaque table porte le contrat commun §7.5 : project_id,
// provider, période/date, dimensions, métriques, run_id (traçabilité jusqu'au
// run qui l'a collectée), fetched_at (date de collecte), schema_version, et un
// payload_json BRUT BORNÉ (séparé des colonnes normalisées). L'unique d'upsert
// (projet + dimensions + période) garantit que deux collectes identiques ne
// dupliquent pas. Un index (projet, période/date) couvre les fenêtres 7/28/90 j.
//
// Cinq tables sont ancrées sur une source vivante à migrer (gsc_query_page,
// gsc_page, gmb_insight, keyword_rank, index) ; cinq préfigurent un collecteur à
// venir (sitemap, plausible, backlink, ai_visibility, gmb_review). expand étant
// additif, les secondes s'élargiront sans rupture quand leur provider arrivera.

// 1. GSC query×page×device (← gsc_query_page_data, 73k). Période hebdo.
export const gscQueryPageObservations = seostats.table(
	'gsc_query_page_observations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id), // nullable — run collecteur
		provider: text('provider').notNull().default('gsc'),
		schemaVersion: integer('schema_version').notNull().default(1),
		periodStart: text('period_start').notNull(),
		periodEnd: text('period_end').notNull(),
		query: text('query').notNull(),
		page: text('page').notNull(),
		device: text('device').notNull().default(''),
		clicks: integer('clicks').notNull().default(0),
		impressions: integer('impressions').notNull().default(0),
		ctr: doublePrecision('ctr').notNull().default(0),
		position: doublePrecision('position').notNull().default(0),
		payloadJson: text('payload_json'),
		fetchedAt: text('fetched_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('gsc_qp_obs_unique').on(
			table.projectId,
			table.periodStart,
			table.query,
			table.page,
			table.device
		),
		index('idx_gsc_qp_obs_project_period').on(table.projectId, table.periodStart),
		index('idx_gsc_qp_obs_project_query').on(table.projectId, table.query),
		index('idx_gsc_qp_obs_project_page').on(table.projectId, table.page)
	]
);

// 2. GSC agrégat page×device (← agrégation GSC page-level). Période hebdo.
export const gscPageObservations = seostats.table(
	'gsc_page_observations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id),
		provider: text('provider').notNull().default('gsc'),
		schemaVersion: integer('schema_version').notNull().default(1),
		periodStart: text('period_start').notNull(),
		periodEnd: text('period_end').notNull(),
		page: text('page').notNull(),
		device: text('device').notNull().default(''),
		clicks: integer('clicks').notNull().default(0),
		impressions: integer('impressions').notNull().default(0),
		ctr: doublePrecision('ctr').notNull().default(0),
		position: doublePrecision('position').notNull().default(0),
		payloadJson: text('payload_json'),
		fetchedAt: text('fetched_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('gsc_page_obs_unique').on(
			table.projectId,
			table.periodStart,
			table.page,
			table.device
		),
		index('idx_gsc_page_obs_project_period').on(table.projectId, table.periodStart),
		index('idx_gsc_page_obs_project_page').on(table.projectId, table.page)
	]
);

// 3. Indexation / URL Inspection (← IDX, coverageState). Date-grained.
export const indexObservations = seostats.table(
	'index_observations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id),
		provider: text('provider').notNull().default('indexing'),
		schemaVersion: integer('schema_version').notNull().default(1),
		observedDate: text('observed_date').notNull(),
		url: text('url').notNull(),
		coverageState: text('coverage_state'), // indexed | crawled-not-indexed | discovered… (GSC)
		verdict: text('verdict'), // PASS | NEUTRAL | FAIL
		indexingState: text('indexing_state'),
		robotsState: text('robots_state'),
		googleCanonical: text('google_canonical'),
		userCanonical: text('user_canonical'),
		lastCrawlAt: text('last_crawl_at'),
		payloadJson: text('payload_json'),
		fetchedAt: text('fetched_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('index_obs_unique').on(table.projectId, table.url, table.observedDate),
		index('idx_index_obs_project_date').on(table.projectId, table.observedDate),
		index('idx_index_obs_project_coverage').on(table.projectId, table.coverageState)
	]
);

// 4. Sitemap (← collecteur à venir). Date-grained.
export const sitemapObservations = seostats.table(
	'sitemap_observations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id),
		provider: text('provider').notNull().default('gsc'),
		schemaVersion: integer('schema_version').notNull().default(1),
		observedDate: text('observed_date').notNull(),
		sitemapUrl: text('sitemap_url').notNull(),
		submittedUrls: integer('submitted_urls').notNull().default(0),
		indexedUrls: integer('indexed_urls').notNull().default(0),
		errors: integer('errors').notNull().default(0),
		warnings: integer('warnings').notNull().default(0),
		isPending: boolean('is_pending').notNull().default(false),
		lastSubmittedAt: text('last_submitted_at'),
		lastDownloadedAt: text('last_downloaded_at'),
		payloadJson: text('payload_json'),
		fetchedAt: text('fetched_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('sitemap_obs_unique').on(table.projectId, table.sitemapUrl, table.observedDate),
		index('idx_sitemap_obs_project_date').on(table.projectId, table.observedDate)
	]
);

// 4-bis. IDX-001 — Inventaire sitemap PAR URL. Date-grained.
//
// `sitemap_observations` (ci-dessus) porte le PAR-FICHIER, à la forme de l'API Sitemaps de
// GSC (submitted/indexed/errors/warnings/pending). IDX-001 lit le XML et a besoin d'autre
// chose : l'inventaire des URLs déclarées, avec `lastmod`, locale (`hreflang`) et canonical
// ATTENDU. Aucune table existante ne porte ce grain, et le `payload_json` d'une observation
// est plafonné à 32 Ko (`MAX_OBSERVATION_PAYLOAD_BYTES`) — un inventaire n'y tient pas.
//
// Snapshot COMPLET par date, et non un journal de changements : le diff de deux dates devient
// une fonction PURE de deux listes (`diffInventories`), donc « reproductible et lié à deux
// snapshots » au sens littéral de l'acceptation IDX-001. Un journal cumulé, lui, ne se rejoue
// pas — il faudrait le replier depuis l'origine et espérer n'avoir rien perdu.
//
// ⚠️ L'unique porte `url_normalized`, PAS `url` : sans ça, `…/page` et `…/page#a` créeraient
// deux lignes pour une seule page, et le diff inventerait un ajout à chaque run. `url` garde
// la forme exacte déclarée par le site (trace), `url_normalized` sert la comparaison.
export const sitemapUrlObservations = seostats.table(
	'sitemap_url_observations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id),
		provider: text('provider').notNull().default('gsc'),
		schemaVersion: integer('schema_version').notNull().default(1),
		observedDate: text('observed_date').notNull(),
		/** Le fichier sitemap qui déclare cette URL (traçabilité : quel enfant l'a apportée). */
		sitemapUrl: text('sitemap_url').notNull(),
		/** `<loc>` tel qu'écrit par le site. */
		url: text('url').notNull(),
		/** Forme canonique de comparaison — porte l'unique. */
		urlNormalized: text('url_normalized').notNull(),
		/** `<lastmod>` tel quel ; `null` si absent (« absent » ≠ « jamais modifié »). */
		lastmod: text('lastmod'),
		/** `hreflang` de l'alternate ; `null` pour une entrée principale. */
		locale: text('locale'),
		/** Canonical attendu par le site — confronté au `google_canonical` d'IDX-002. */
		expectedCanonical: text('expected_canonical'),
		/** Vrai si l'entrée vient d'un `<xhtml:link rel="alternate">` (pas une page nouvelle). */
		isAlternate: boolean('is_alternate').notNull().default(false),
		payloadJson: text('payload_json'),
		fetchedAt: text('fetched_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('sitemap_url_obs_unique').on(table.projectId, table.urlNormalized, table.observedDate),
		index('idx_sitemap_url_obs_project_date').on(table.projectId, table.observedDate),
		index('idx_sitemap_url_obs_project_url').on(table.projectId, table.urlNormalized)
	]
);

// 5. Analytics page (Plausible, ← collecteur à venir). Période.
export const plausiblePageObservations = seostats.table(
	'plausible_page_observations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id),
		provider: text('provider').notNull().default('plausible'),
		schemaVersion: integer('schema_version').notNull().default(1),
		periodStart: text('period_start').notNull(),
		periodEnd: text('period_end').notNull(),
		page: text('page').notNull(),
		visitors: integer('visitors').notNull().default(0),
		pageviews: integer('pageviews').notNull().default(0),
		bounceRate: doublePrecision('bounce_rate').notNull().default(0),
		visitDuration: doublePrecision('visit_duration').notNull().default(0),
		payloadJson: text('payload_json'),
		fetchedAt: text('fetched_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('plausible_page_obs_unique').on(table.projectId, table.periodStart, table.page),
		index('idx_plausible_page_obs_project_period').on(table.projectId, table.periodStart),
		index('idx_plausible_page_obs_project_page').on(table.projectId, table.page)
	]
);

// 6. Positions mot-clé (← epic 23 / DataForSEO). Date-grained.
export const keywordRankObservations = seostats.table(
	'keyword_rank_observations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id),
		provider: text('provider').notNull().default('gsc'),
		schemaVersion: integer('schema_version').notNull().default(1),
		observedDate: text('observed_date').notNull(),
		keyword: text('keyword').notNull(),
		device: text('device').notNull().default(''),
		page: text('page'), // URL qui ranke (nullable)
		position: doublePrecision('position').notNull().default(0),
		clicks: integer('clicks'),
		impressions: integer('impressions'),
		ctr: doublePrecision('ctr'),
		payloadJson: text('payload_json'),
		fetchedAt: text('fetched_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('keyword_rank_obs_unique').on(
			table.projectId,
			table.keyword,
			table.device,
			table.observedDate
		),
		index('idx_keyword_rank_obs_project_date').on(table.projectId, table.observedDate),
		index('idx_keyword_rank_obs_project_keyword').on(table.projectId, table.keyword)
	]
);

// 7. Backlinks (← seo_reports backlink / DataForSEO). Date-grained.
export const backlinkObservations = seostats.table(
	'backlink_observations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id),
		provider: text('provider').notNull().default('dataforseo'),
		schemaVersion: integer('schema_version').notNull().default(1),
		observedDate: text('observed_date').notNull(),
		sourceUrl: text('source_url').notNull(),
		targetUrl: text('target_url').notNull(),
		anchor: text('anchor'),
		dofollow: boolean('dofollow'),
		spamScore: integer('spam_score'),
		domainRating: doublePrecision('domain_rating'),
		firstSeenAt: text('first_seen_at'),
		lastSeenAt: text('last_seen_at'),
		payloadJson: text('payload_json'),
		fetchedAt: text('fetched_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('backlink_obs_unique').on(
			table.projectId,
			table.sourceUrl,
			table.targetUrl,
			table.observedDate
		),
		index('idx_backlink_obs_project_date').on(table.projectId, table.observedDate)
	]
);

// 8. Visibilité IA / GEO (← seo_reports ai_visibility). Date-grained.
export const aiVisibilityObservations = seostats.table(
	'ai_visibility_observations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id),
		provider: text('provider').notNull().default('ai'),
		schemaVersion: integer('schema_version').notNull().default(1),
		observedDate: text('observed_date').notNull(),
		engine: text('engine').notNull(), // claude | aio | chatgpt | perplexity | gemini
		promptHash: text('prompt_hash').notNull(),
		promptText: text('prompt_text'),
		cited: boolean('cited').notNull().default(false),
		score: integer('score'),
		position: doublePrecision('position'),
		payloadJson: text('payload_json'),
		fetchedAt: text('fetched_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('ai_visibility_obs_unique').on(
			table.projectId,
			table.engine,
			table.promptHash,
			table.observedDate
		),
		index('idx_ai_visibility_obs_project_date').on(table.projectId, table.observedDate),
		index('idx_ai_visibility_obs_project_engine').on(table.projectId, table.engine)
	]
);

// 9. Avis GMB comme observation d'état (← gmb_reviews). Recouvre l'existant
// `gmb_reviews` (conservé) : ici on capture l'état dérivé daté pour la série
// temporelle réputation, sans dupliquer le texte de l'avis (→ payload/finding).
export const gmbReviewObservations = seostats.table(
	'gmb_review_observations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id),
		provider: text('provider').notNull().default('gmb'),
		schemaVersion: integer('schema_version').notNull().default(1),
		observedDate: text('observed_date').notNull(),
		locationId: text('location_id').notNull(),
		reviewId: text('review_id').notNull(),
		rating: integer('rating'),
		sentiment: text('sentiment'), // positive | neutral | negative
		hasReply: boolean('has_reply').notNull().default(false),
		replyLatencyHours: integer('reply_latency_hours'),
		payloadJson: text('payload_json'),
		fetchedAt: text('fetched_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('gmb_review_obs_unique').on(table.projectId, table.reviewId, table.observedDate),
		index('idx_gmb_review_obs_project_date').on(table.projectId, table.observedDate),
		index('idx_gmb_review_obs_project_location').on(table.projectId, table.locationId)
	]
);

// 10. Métriques Performance GMB (← gmb_insights_daily). 1 row/(location,date,metric).
export const gmbInsightObservations = seostats.table(
	'gmb_insight_observations',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id),
		provider: text('provider').notNull().default('gmb'),
		schemaVersion: integer('schema_version').notNull().default(1),
		observedDate: text('observed_date').notNull(),
		locationId: text('location_id').notNull(),
		metric: text('metric').notNull(), // BUSINESS_IMPRESSIONS_* | WEBSITE_CLICKS | CALL_CLICKS | …
		value: integer('value').notNull().default(0),
		payloadJson: text('payload_json'),
		fetchedAt: text('fetched_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('gmb_insight_obs_unique').on(
			table.projectId,
			table.locationId,
			table.observedDate,
			table.metric
		),
		index('idx_gmb_insight_obs_project_date').on(table.projectId, table.observedDate),
		index('idx_gmb_insight_obs_location_date').on(table.locationId, table.observedDate)
	]
);

// ── DATA-005 — Findings & journal de décisions (SPEC §7.6/§7.7) ──────
//
// Un finding = une INTERPRÉTATION déterministe persistante (jamais un fait brut →
// ça, c'est une observation, DATA-004). C'est la primitive centrale du produit
// (SPEC §1542). Le `fingerprint` (projet + type + entité + discriminants) est
// STABLE : le même problème détecté deux semaines de suite conserve le même
// finding (unique project_id + fingerprint), on incrémente `occurrence_count` et
// on rafraîchit `last_seen_at` — jamais de doublon hebdomadaire.
//
// Les PREUVES vivent dans `evidence_json` sous forme de POINTEURS (ids
// d'observations, queries, pages), jamais recopiées en texte libre : pas de FK
// dure vers une observation. Politique de suppression (acceptation DATA-005) : les
// observations forment une série append-only jamais supprimée ; les références
// souples d'evidence_json ne cascadent donc pas. `run_id` (nullable) trace le run
// détecteur, cohérent avec les observations.
export const findings = seostats.table(
	'findings',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id), // nullable — run détecteur
		fingerprint: text('fingerprint').notNull(), // clé stable de dédup (miroir de l'unique)
		type: text('type').notNull(), // catalogue SPEC §10.4 (keyword_opportunity, ctr_gap, …)
		entityType: text('entity_type').notNull(), // 'project'|'query'|'page'|'review'|'integration'
		entityKey: text('entity_key').notNull().default(''), // l'URL/query/id concernée (vide si projet)
		title: text('title').notNull(),
		status: text('status').notNull().default('open'), // §7.6+reopened : open|acknowledged|planned|in_progress|resolved|dismissed|snoozed|reopened
		severity: text('severity').notNull().default('info'), // info|low|medium|high|critical
		priorityScore: integer('priority_score').notNull().default(0), // 0–100 (barème §10.2)
		confidenceScore: integer('confidence_score').notNull().default(0), // 0–100
		impactEstimateJson: text('impact_estimate_json'), // estimation d'impact (non secret)
		evidenceJson: text('evidence_json'), // POINTEURS vers observations, pas de texte libre
		detectorVersion: text('detector_version'),
		recommendedSkill: text('recommended_skill'),
		occurrenceCount: integer('occurrence_count').notNull().default(1),
		firstSeenAt: text('first_seen_at').notNull().default(nowText),
		lastSeenAt: text('last_seen_at').notNull().default(nowText),
		resolutionReason: text('resolution_reason'),
		resolvedAt: text('resolved_at'),
		// ── FIND-003 — cycle de vie (auto-résolution, snooze, réouverture) ──
		snoozedUntil: text('snoozed_until'), // échéance de la veille (format DB, cf. timestamps.ts)
		snoozeReason: text('snooze_reason'), // cause de la mise en veille
		consecutiveMisses: integer('consecutive_misses').notNull().default(0), // fenêtres consécutives sans match
		reopenCount: integer('reopen_count').notNull().default(0), // récidives (signal qualité FIND-010)
		dismissalCategory: text('dismissal_category'), // false_positive|wont_fix|by_design|duplicate
		createdAt: text('created_at').notNull().default(nowText),
		updatedAt: text('updated_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('findings_fingerprint_unique').on(table.projectId, table.fingerprint), // dédup
		index('idx_findings_project_status').on(table.projectId, table.status),
		index('idx_findings_project_severity').on(table.projectId, table.severity),
		index('idx_findings_status').on(table.status), // inbox cross-projet
		// Expiration de veille : index PARTIEL — la passe ne scanne jamais toute la table.
		index('idx_findings_snoozed_until')
			.on(table.snoozedUntil)
			.where(sql`status = 'snoozed'`)
	]
);

// Journal APPEND-ONLY des changements d'un finding (SPEC §7.7). Toute transition
// (statut ou sévérité) porte un `event_type`, une `reason` (cause) et un `actor`
// (auteur) → acceptation DATA-005 « toute transition possède un événement, une
// cause et un auteur ». Jamais d'update/delete : uniquement des insertions.
export const findingEvents = seostats.table(
	'finding_events',
	{
		id: text('id').primaryKey(),
		findingId: text('finding_id')
			.notNull()
			.references(() => findings.id),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id), // index/requêtes cross-projet directs
		eventType: text('event_type').notNull(), // created|aggravated|improved|agent_comment|validated|rejected|snoozed|reopened|resolved
		fromStatus: text('from_status'),
		toStatus: text('to_status'),
		reason: text('reason'), // cause de la transition
		actor: text('actor').notNull().default('system'), // schedule|user|agent|system|detector
		payloadJson: text('payload_json'),
		createdAt: text('created_at').notNull().default(nowText)
	},
	(table) => [
		index('idx_finding_events_finding').on(table.findingId),
		index('idx_finding_events_project_created').on(table.projectId, table.createdAt)
	]
);

// ── DATA-006 — Propositions, approbations & agent runs (SPEC §7.8/§7.9/§12) ──
//
// La couche décision→action de la chaîne SPEC §88 :
//   observations → detectors → findings → agent analysis → PROPOSALS → APPROVAL
//   → execution → verification.
// Une proposition = une action recommandée (jamais une mutation → ça, c'est une
// exécution). L'exécution/vérification ne sont PAS de nouvelles tables : elles se
// rattachent à la proposition via `execution_job_id` (→ jobs) et `verification_status`.
//
// Invariants d'autorisation (SPEC §12.2), portés par le module pur proposal-state.ts :
//   - une approbation est liée au HASH exact de la proposition (payload_hash) ;
//     toute modification du payload invalide l'approbation ;
//   - un agent ne peut pas s'auto-accorder un niveau supérieur (L4 = humain seul).

// Proposition d'action (SPEC §7.8). `payload_hash` (hash canonique de payload_json)
// est ce à quoi une approbation se lie. Statuts = 7 de §7.8 + `invalidated`
// (payload modifié après approbation) + `expired`. `execution_job_id` pointe la
// queue durable `jobs` (pas de table d'exécution séparée).
export const actionProposals = seostats.table(
	'action_proposals',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		findingId: text('finding_id').references(() => findings.id), // nullable (proposition depuis rapport)
		actionType: text('action_type').notNull(),
		target: text('target'),
		rationale: text('rationale'),
		expectedImpact: text('expected_impact'),
		riskLevel: text('risk_level'), // low|medium|high (risque intrinsèque)
		requiredApprovalLevel: text('required_approval_level').notNull().default('L2'), // L0..L4 (§12.1)
		proposedBy: text('proposed_by').notNull().default('agent'),
		payloadJson: text('payload_json'),
		payloadHash: text('payload_hash').notNull(), // hash canonique de payload_json (lie l'approbation)
		inputHashesJson: text('input_hashes_json'), // hashes des inputs (traçabilité/idempotence)
		status: text('status').notNull().default('proposed'), // proposed|approved|rejected|executing|executed|failed|superseded|invalidated|expired
		approvedBy: text('approved_by'), // dénormalisé (§7.8) ; l'entité d'approbation vit dans proposal_approvals
		approvedAt: text('approved_at'),
		executionJobId: text('execution_job_id').references(() => jobs.id), // nullable → queue durable
		verificationStatus: text('verification_status'), // pending|passed|failed|skipped
		createdAt: text('created_at').notNull().default(nowText),
		updatedAt: text('updated_at').notNull().default(nowText)
	},
	(table) => [
		// Idempotence : re-proposition identique (finding+action+payload) ne duplique pas.
		uniqueIndex('action_proposals_idem_unique').on(
			table.projectId,
			table.findingId,
			table.actionType,
			table.payloadHash
		),
		index('idx_action_proposals_project_status').on(table.projectId, table.status),
		index('idx_action_proposals_finding').on(table.findingId),
		index('idx_action_proposals_status').on(table.status) // inbox cross-projet
	]
);

// Approbation = entité dédiée (SPEC §12.2/§12.3/§14.3). Porte le HASH lié
// (`approved_payload_hash`), l'auteur + périmètre, la méthode, un token à usage
// unique (Telegram §14.3) + expiration, et son propre statut. Une approbation
// n'est valide que si son hash == payload_hash courant ET non expirée
// (proposal-state.isApprovalValid). L'approbation de lot conserve le hash de
// chaque proposition (§12.3) : 1 ligne par proposition, jamais un scope global.
export const proposalApprovals = seostats.table(
	'proposal_approvals',
	{
		id: text('id').primaryKey(),
		proposalId: text('proposal_id')
			.notNull()
			.references(() => actionProposals.id),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		approvedPayloadHash: text('approved_payload_hash').notNull(), // hash lié (§12.2)
		approverType: text('approver_type').notNull().default('user'), // user|agent|policy
		approverId: text('approver_id'),
		scopeJson: text('scope_json'), // périmètre : projet|action|durée|ressources (§5.3)
		method: text('method').notNull().default('ui'), // ui|telegram|policy
		token: text('token'), // one-time (Telegram §14.3), nullable
		tokenUsedAt: text('token_used_at'),
		expiresAt: text('expires_at'),
		status: text('status').notNull().default('active'), // active|consumed|expired|revoked|invalidated
		createdAt: text('created_at').notNull().default(nowText)
	},
	(table) => [
		index('idx_proposal_approvals_proposal').on(table.proposalId),
		index('idx_proposal_approvals_project_status').on(table.projectId, table.status),
		uniqueIndex('proposal_approvals_token_unique').on(table.token) // NULLs distincts en Postgres
	]
);

// Journal d'invocation d'un agent LLM (SPEC §7.9) : modèle/version, skill, inputs
// + hashes, findings lus, sortie produite (proposition ou rapport), tokens/coût/
// durée, résultat/erreurs, et la validation humaine associée. Distinct de
// `monitoring_runs` (orchestration collecteur) : ici c'est le raisonnement agent.
export const agentRuns = seostats.table(
	'agent_runs',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		runId: text('run_id').references(() => monitoringRuns.id), // nullable — run orchestrateur parent
		proposalId: text('proposal_id').references(() => actionProposals.id), // nullable — proposition produite
		humanValidationRef: text('human_validation_ref').references(() => proposalApprovals.id), // nullable
		agent: text('agent').notNull(),
		agentVersion: text('agent_version'),
		skill: text('skill'),
		model: text('model'),
		inputHashesJson: text('input_hashes_json'),
		findingsReadJson: text('findings_read_json'), // ids de findings lus (sources)
		outputType: text('output_type'), // proposal|report
		outputRef: text('output_ref'),
		tokensInput: integer('tokens_input'),
		tokensOutput: integer('tokens_output'),
		costJson: text('cost_json'), // coût agrégé (non secret)
		durationMs: integer('duration_ms'),
		status: text('status').notNull().default('running'), // running|succeeded|failed
		resultJson: text('result_json'),
		errorCode: text('error_code'),
		errorMessage: text('error_message'),
		createdAt: text('created_at').notNull().default(nowText),
		finishedAt: text('finished_at')
	},
	(table) => [
		index('idx_agent_runs_project_status').on(table.projectId, table.status),
		index('idx_agent_runs_proposal').on(table.proposalId),
		index('idx_agent_runs_run').on(table.runId)
	]
);

// ── DATA-007 — Politiques d'avis & d'automatisation (SPEC §7.10) ─────
//
// Une policy gouverne le comportement d'automatisation des réponses aux avis (et
// autres actions cadencées) pour un projet, éventuellement affiné par localisation.
// Elle est VERSIONNÉE (même modèle que project_projections) : on ne modifie jamais
// une policy en place — on en promeut une nouvelle version, l'ancienne passe
// `superseded`. Cela garantit qu'« aucune ancienne proposition ne profite
// silencieusement d'une nouvelle policy » : une proposition/approbation référence
// la version effective au moment où elle a été évaluée.
//
// Invariants portés par le module pur policy-state.ts :
//   - le `kill_switch` bloque les ENVOIS sans bloquer la synchronisation
//     (evaluatePolicyGates : syncAllowed ignore le kill switch) ;
//   - `draft_only`/`manual` n'autorisent jamais l'envoi autonome ; seul
//     `guarded_auto` envoie, et uniquement les avis éligibles (canAutoSendReview).
//
// `scope_key` = `location_id ?? '*'` : rend le partial-unique « une seule policy
// courante par scope » robuste face aux NULL (Postgres traite les NULL comme
// distincts, ce qui casserait l'unicité de la policy projet-wide).
export const reviewAutomationPolicies = seostats.table(
	'review_automation_policies',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		locationId: text('location_id'), // nullable = policy projet-wide (toutes localisations)
		scopeKey: text('scope_key').notNull(), // location_id ?? '*' (robustesse NULL du unique current)
		version: integer('version').notNull().default(1),
		policyHash: text('policy_hash').notNull(), // hash canonique de la config → dédup re-promotion identique
		mode: text('mode').notNull().default('draft_only'), // draft_only|guarded_auto|manual (§7.10)
		syncEnabled: boolean('sync_enabled').notNull().default(true), // sync des avis (indépendante du kill switch)
		autoGenerationEnabled: boolean('auto_generation_enabled').notNull().default(false),
		killSwitch: boolean('kill_switch').notNull().default(false), // bloque les ENVOIS, jamais la sync
		minRatingForAutoSend: integer('min_rating_for_auto_send'), // note minimale pour envoi auto (ex. 5)
		sendDelayMinutes: integer('send_delay_minutes'), // délai avant envoi
		jitterMinutes: integer('jitter_minutes'), // jitter aléatoire ajouté au délai
		sendWindowsJson: text('send_windows_json'), // plages horaires autorisées (JSON borné)
		defaultLanguage: text('default_language'),
		signature: text('signature'),
		escalationCategoriesJson: text('escalation_categories_json'), // catégories nécessitant validation (JSON borné)
		maxSendsPerRun: integer('max_sends_per_run'), // nombre max d'envois par run
		status: text('status').notNull().default('current'), // current|superseded
		promotedBy: text('promoted_by'), // dénormalisé ; le détail vit dans policy_promotions
		promotedAt: text('promoted_at'),
		createdAt: text('created_at').notNull().default(nowText)
	},
	(table) => [
		// Chaque version d'un scope est unique ; l'historique se lit par version croissante.
		uniqueIndex('review_automation_policies_version_unique').on(
			table.projectId,
			table.scopeKey,
			table.version
		),
		// Une seule policy courante par scope (projet + localisation ou projet-wide).
		uniqueIndex('review_automation_policies_one_current')
			.on(table.projectId, table.scopeKey)
			.where(sql`status = 'current'`),
		index('idx_review_automation_policies_project_status').on(table.projectId, table.status)
	]
);

// Journal APPEND-ONLY des promotions de policy (BACKLOG DATA-007 « tracer toute
// promotion »). Une ligne par transition de version : ancienne→nouvelle version,
// ancien→nouveau mode, nature (create|mode_change|kill_switch|config_change),
// auteur et cause. Jamais d'update/delete → la policy effective à toute date se
// reconstruit depuis ce journal (« la policy effective est visible dans l'audit »).
export const policyPromotions = seostats.table(
	'policy_promotions',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		policyId: text('policy_id') // la nouvelle version créée
			.notNull()
			.references(() => reviewAutomationPolicies.id),
		fromPolicyId: text('from_policy_id').references(() => reviewAutomationPolicies.id), // version précédente (nullable = 1re)
		scopeKey: text('scope_key').notNull(),
		fromVersion: integer('from_version'), // nullable = création
		toVersion: integer('to_version').notNull(),
		fromMode: text('from_mode'),
		toMode: text('to_mode').notNull(),
		kind: text('kind').notNull(), // create|mode_change|kill_switch|config_change
		actor: text('actor').notNull(), // qui a promu (user|agent|policy|system…)
		reason: text('reason'), // cause de la promotion
		createdAt: text('created_at').notNull().default(nowText)
	},
	(table) => [
		index('idx_policy_promotions_policy').on(table.policyId),
		index('idx_policy_promotions_project_scope').on(table.projectId, table.scopeKey)
	]
);

// ── DATA-008 — Rétention, agrégation & purge (SPEC §7.11) ───────────
//
// Politique validée (§7.11) : observations détaillées = 24 mois ; agrégats,
// findings, décisions, approbations, audit et rapports = sans limite ; payloads
// techniques volumineux & logs de debug = 90 jours. La rétention est CONFIGURABLE
// par type de donnée (table dédiée). La purge est un job versionné, observable
// (dry-run) et reprenable. Invariants portés par le module pur retention-state.ts :
//   - une donnée protégée / à rétention infinie n'est JAMAIS purgée (isPurgeable) ;
//   - une suppression d'audit exige L4 (assertPurgeAuthorized) ;
//   - on agrège semaine/mois/année AVANT de purger le détail (derivePeriod).

// Politique de rétention par type de donnée (SPEC §7.11). `retention_days` NULL =
// sans limite (protégée). `protected` = jamais purgeable quel que soit l'âge.
// `requires_l4` = la purge exige une validation L4 (audit).
export const retentionPolicies = seostats.table(
	'retention_policies',
	{
		id: text('id').primaryKey(),
		dataType: text('data_type').notNull(), // ex. gsc_query_page_observation, debug_payload, audit_action…
		category: text('category').notNull(), // detail|aggregate|audit|report|debug
		retentionDays: integer('retention_days'), // NULL = sans limite
		aggregateBeforePurge: boolean('aggregate_before_purge').notNull().default(false),
		requiresL4: boolean('requires_l4').notNull().default(false),
		protected: boolean('protected').notNull().default(false), // jamais purgeable
		sourceTable: text('source_table'), // table physique concernée (pour le runner)
		timestampColumn: text('timestamp_column'), // colonne d'âge (fetched_at, period_end…)
		description: text('description'),
		active: boolean('active').notNull().default(true),
		createdAt: text('created_at').notNull().default(nowText),
		updatedAt: text('updated_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('retention_policies_data_type_unique').on(table.dataType),
		index('idx_retention_policies_category').on(table.category)
	]
);

// Agrégat d'observations roulé au grain semaine/mois/année AVANT purge du détail
// (SPEC §7.11 : « agréger semaine/mois/année avant purge », agrégats conservés sans
// limite). Générique par `source` + `dimensions_hash` (le tuple de dimensions varie
// par source : query+page, métrique, keyword+device). Idempotent : re-agréger une
// même période ne duplique pas (unique projet+source+grain+période+dimensions).
export const observationAggregates = seostats.table(
	'observation_aggregates',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		source: text('source').notNull(), // gsc_query_page|gsc_page|gmb_insight|keyword_rank…
		grain: text('grain').notNull(), // week|month|year
		periodStart: text('period_start').notNull(),
		periodEnd: text('period_end').notNull(),
		dimensionsHash: text('dimensions_hash').notNull(), // hash du tuple de dimensions (dédup)
		dimensionsJson: text('dimensions_json'), // valeurs des dimensions (borné)
		metricsJson: text('metrics_json'), // métriques agrégées (borné) — flexible par source
		sampleCount: integer('sample_count').notNull().default(0), // nb d'observations agrégées
		computedAt: text('computed_at').notNull().default(nowText)
	},
	(table) => [
		uniqueIndex('observation_aggregates_unique').on(
			table.projectId,
			table.source,
			table.grain,
			table.periodStart,
			table.dimensionsHash
		),
		index('idx_observation_aggregates_source_grain').on(table.projectId, table.source, table.grain)
	]
);

// Run de purge (SPEC §7.11 : job versionné, observable, reprenable). `dry_run` =
// annonce sans supprimer (acceptation : « le dry-run annonce exactement lignes et
// périodes touchées »). `plan_json`/`metrics_json` = observabilité. `checkpoint_json`
// = dernier (data_type, période) traité → reprise sans double effet (les agrégats
// s'upsert et les deletes par cutoff sont idempotents ; le checkpoint évite le
// re-scan). `approval_ref` → l'approbation L4 quand un audit est purgé.
export const purgeRuns = seostats.table(
	'purge_runs',
	{
		id: text('id').primaryKey(),
		status: text('status').notNull().default('planned'), // planned|running|completed|failed|aborted
		dryRun: boolean('dry_run').notNull().default(true),
		triggeredBy: text('triggered_by'), // user|schedule|agent
		approvalRef: text('approval_ref').references(() => proposalApprovals.id), // L4 pour purge d'audit
		policyVersion: integer('policy_version'), // version du set de politiques appliqué
		planJson: text('plan_json'), // lignes/périodes par data_type (dry-run)
		metricsJson: text('metrics_json'), // rows_aggregated/rows_deleted par data_type
		checkpointJson: text('checkpoint_json'), // reprise : dernier (data_type, période) traité
		errorMessage: text('error_message'),
		startedAt: text('started_at'),
		finishedAt: text('finished_at'),
		createdAt: text('created_at').notNull().default(nowText)
	},
	(table) => [index('idx_purge_runs_status').on(table.status)]
);

// ── JOB-002 — Bail, tentatives et effets externes (SPEC §6.2) ────────
//
// JOB-001 avait posé la réclamation atomique ; il y manquait la mémoire de ce
// qui a été TENTÉ et la garantie qu'une reprise ne rejoue pas un effet externe.
// Deux tables additives, aucune colonne ajoutée à `jobs` (heartbeat_at,
// lease_owner, lease_until et attempts y existent depuis DATA-003).

// Journal APPEND-ONLY des tentatives : 1 ligne par réclamation. `jobs` ne porte
// qu'un compteur `attempts` et un `last_error_*` ÉCRASÉ à chaque reprise — donc
// rien qui permette de dire « la tentative #1 a été abandonnée à 09:07 parce que
// son worker est mort, la #2 a réussi ». C'est cette table qui le dit, et c'est
// elle que JOB-003 (reprise manuelle conservant l'historique) et JOB-007
// (console d'exploitation) liront.
//
// PAS d'unique sur (job_id, attempt_no) : `releaseJob` REND la tentative
// (attempts - 1, JOB-001), donc un numéro se répète légitimement — et écraser la
// ligne `released` effacerait justement l'historique qu'on cherche à garder.
// Même idiome append-only que `finding_events` / `policy_promotions`.
export const jobAttempts = seostats.table(
	'job_attempts',
	{
		id: text('id').primaryKey(),
		jobId: text('job_id')
			.notNull()
			.references(() => jobs.id),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id), // filtrage cross-projet (JOB-007)
		attemptNo: integer('attempt_no').notNull(), // = jobs.attempts après incrément au claim
		workerId: text('worker_id').notNull(),
		outcome: text('outcome').notNull().default('running'), // running|succeeded|failed|abandoned|released|deferred|requeued|dead
		abandonKind: text('abandon_kind'), // worker_death|lease_stall (null hors abandon)
		errorCode: text('error_code'),
		// JOB-003 — pourquoi CETTE tentative a échoué (retryable|quota|auth|permanent).
		errorClass: text('error_class'),
		errorMessage: text('error_message'),
		heartbeatCount: integer('heartbeat_count').notNull().default(0),
		metadataJson: text('metadata_json'),
		startedAt: text('started_at').notNull().default(nowText),
		finishedAt: text('finished_at'),
		durationMs: integer('duration_ms')
	},
	(table) => [
		index('idx_job_attempts_job').on(table.jobId),
		index('idx_job_attempts_outcome').on(table.outcome)
	]
);

// Registre des EFFETS EXTERNES (outbox « claim-then-apply »). Après reprise d'un
// job mort, le handler re-tourne : cette table garantit qu'un effet déjà appliqué
// n'est jamais rejoué (« deux exécutions ne produisent pas deux effets externes »).
// L'ordre compte — on RÉSERVE la clé d'abord (`pending`), on applique ensuite :
// appliquer avant de réserver laisserait une fenêtre de double effet.
// `status='failed'` reste REPRENABLE (l'effet n'a pas abouti, il doit pouvoir l'être).
// Brique dont IDX-007 (outbox IndexNow) et la publication GMB auront besoin.
export const jobEffects = seostats.table(
	'job_effects',
	{
		id: text('id').primaryKey(),
		jobId: text('job_id')
			.notNull()
			.references(() => jobs.id),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		attemptNo: integer('attempt_no'), // quelle tentative a appliqué l'effet
		effectKey: text('effect_key').notNull(), // identité métier de l'effet (déterministe)
		status: text('status').notNull().default('pending'), // pending|applied|failed
		resultHash: text('result_hash'),
		errorMessage: text('error_message'),
		claimedAt: text('claimed_at').notNull().default(nowText),
		appliedAt: text('applied_at')
	},
	(table) => [
		// Miroir de `jobs_idempotency_unique` : une clé d'effet est unique PAR PROJET.
		uniqueIndex('job_effects_key_unique').on(table.projectId, table.effectKey),
		index('idx_job_effects_job').on(table.jobId)
	]
);

// ── JOB-006 — Configuration système (BACKLOG « limites configurables sans redéploiement ») ──
//
// KV de portée SYSTÈME : ce qui ne se range sous aucun projet. Aujourd'hui les
// plafonds de concurrence et les budgets provider de la file (`job-limits.ts`) ;
// demain les autres boutons d'exploitation.
//
// Pourquoi une table plutôt qu'une variable d'environnement : sur Vercel une variable
// d'env n'est relue qu'au REDÉPLOIEMENT, ce qui ne tient pas l'acceptation « les
// limites sont configurables sans redéploiement ». Pourquoi pas `gmb_settings`, qui est
// pourtant déjà un KV (`key`/`value`) et sert déjà à des clés non-GMB : y ranger les
// quotas GSC ferait mentir son nom à la prochaine lecture.
//
// Les caps PAR PROJET, eux, ne vivent pas ici mais dans `project_projections.payload`
// (calque exact des `schedules` de JOB-005) : c'est la maison du réglage par projet.
//
// `value` est du texte libre (JSON ou scalaire) : la lecture passe par `resolveLimits`,
// qui retombe sur les défauts de code pour toute valeur illisible ou hors bornes — une
// limite corrompue ne doit jamais pouvoir éteindre la file.
export const systemSettings = seostats.table('system_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	description: text('description'),
	updatedAt: text('updated_at').notNull().default(nowText)
});
