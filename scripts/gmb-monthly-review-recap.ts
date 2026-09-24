import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import {
	renderMonthlyReviewRecapMarkdown,
	stripGoogleTranslation,
	type MonthlyReviewRecap
} from '../src/lib/server/reviews/monthly-review-recap.js';

neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent (.env).');

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
	const equals = args.find((arg) => arg.startsWith(`--${name}=`));
	if (equals) return equals.slice(name.length + 3);
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : undefined;
};
const month = option('month');
const slug = option('project') ?? 'barberconcept';
const allowOpenMonth = args.includes('--allow-open-month');
if (!month || !/^\d{4}-\d{2}$/.test(month)) throw new Error('Usage : --month YYYY-MM [--project slug] [--allow-open-month] [--output fichier.md]');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const project = await pool.query<{
	id: string;
	name: string;
	client_email: string | null;
}>(
	'select id, name, client_email from seostats.projects where slug=$1 limit 1',
	[slug]
).then((result) => result.rows[0]);
if (!project) throw new Error(`Projet introuvable : ${slug}`);
if (!project.client_email) throw new Error(`Email client absent pour ${slug}.`);

const period = await pool.query<{
	start_at: string;
	end_at: string;
	closed: boolean;
}>(
	`select
		(($1 || '-01')::timestamp at time zone 'Europe/Zurich')::text as start_at,
		((($1 || '-01')::timestamp + interval '1 month') at time zone 'Europe/Zurich')::text as end_at,
		(now() >= ((($1 || '-01')::timestamp + interval '1 month') at time zone 'Europe/Zurich')) as closed`,
	[month]
).then((result) => result.rows[0]);
if (!period) throw new Error('Période impossible à résoudre.');
if (!period.closed && !allowOpenMonth) {
	throw new Error(`Le mois ${month} n'est pas encore clos en Europe/Zurich. Relancer après minuit local ou utiliser --allow-open-month pour un preview non envoyable.`);
}

const locationHealth = await pool.query<{
	gmb_location_id: string;
	label: string;
	last_sync_at: string | null;
	last_sync_status: string | null;
}>(
	`select gmb_location_id, label, last_sync_at, last_sync_status
	 from seostats.project_gmb_locations where project_id=$1 order by label`,
	[project.id]
).then((result) => result.rows);
if (locationHealth.length !== 6) throw new Error(`Périmètre GMB inattendu : ${locationHealth.length}/6 fiches.`);
if (locationHealth.some((location) => location.last_sync_status !== 'success' || !location.last_sync_at)) {
	throw new Error('Au moins une fiche GMB n’a pas de synchronisation réussie exploitable.');
}
if (period.closed && locationHealth.some((location) => location.last_sync_at! < period.end_at.replace('T', ' ').replace('Z', ''))) {
	throw new Error(`La synchronisation finale de ${month} doit être postérieure à la clôture locale.`);
}

const runningCollector = await pool.query<{ count: number }>(
	`select count(*)::int count from seostats.jobs
	 where project_id=$1 and type='collect:gmb_reviews' and status='running'
	   and (lease_until is null or lease_until::timestamp > (now() at time zone 'UTC'))`,
	[project.id]
).then((result) => result.rows[0]?.count ?? 0);
if (runningCollector > 0) throw new Error('Collecte GMB concurrente : génération annulée.');

type ReviewRow = {
	review_id: string;
	author_name: string;
	location_label: string;
	rating: number;
	comment: string | null;
	create_time: string;
	mentioned_employees: string | null;
	last_seen_at: string | null;
	location_last_sync_at: string;
	replied_at: string | null;
	remote_reply_at: string | null;
};
const reviews = await pool.query<ReviewRow>(
	`select r.review_id, r.author_name, r.location_label, r.rating, r.comment, r.create_time,
	        r.mentioned_employees, r.last_seen_at, l.last_sync_at as location_last_sync_at,
	        r.replied_at, r.remote_reply_at
	 from seostats.gmb_reviews r
	 join seostats.project_gmb_locations l
	   on l.project_id=r.project_id and l.gmb_location_id=r.location_id
	 where r.project_id=$1
	   and r.create_time::timestamptz >= $2::timestamptz
	   and r.create_time::timestamptz < $3::timestamptz
	 order by r.create_time::timestamptz, r.review_id`,
	[project.id, period.start_at, period.end_at]
).then((result) => result.rows);

const history = await pool.query<{ period_month: string; reviews: number; average: number }>(
	`select to_char(create_time::timestamptz at time zone 'Europe/Zurich','YYYY-MM') as period_month,
	        count(*)::int reviews, avg(rating)::float average
	 from seostats.gmb_reviews
	 where project_id=$1
	   and create_time::timestamptz >= date_trunc('year', $2::timestamptz)
	   and create_time::timestamptz < $2::timestamptz
	 group by 1 order by 1`,
	[project.id, period.end_at]
).then((result) => result.rows);

const monthNames = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const monthIndex = Number(month.slice(5, 7)) - 1;
const periodLabel = monthNames[monthIndex];
const salon = (label: string): string => {
	if (label.includes('Cornavin')) return 'Cornavin';
	if (label.includes('Eaux Vives')) return 'Eaux-Vives';
	if (label.includes('Jonction')) return 'Jonction';
	if (label.includes('Lausanne')) return 'Lausanne';
	if (label.includes('Rive')) return 'Rive';
	if (label.includes('Sion')) return 'Sion';
	return label;
};
const visible = (review: ReviewRow): boolean => review.last_seen_at !== null && review.last_seen_at >= review.location_last_sync_at;
const date = (iso: string): string => new Intl.DateTimeFormat('fr-CH', {
	day: '2-digit',
	month: '2-digit',
	timeZone: 'Europe/Zurich'
}).format(new Date(iso));
const excerpt = (comment: string | null): string | null => {
	if (!comment?.trim()) return null;
	return stripGoogleTranslation(comment).replace(/\s+/g, ' ').trim();
};
type Mention = { name: string; sentiment: 'positive' | 'neutral' | 'negative' };
const mentions = (review: ReviewRow): Mention[] | null => review.mentioned_employees === null
	? null
	: JSON.parse(review.mentioned_employees) as Mention[];

const ratingCounts: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
for (const review of reviews) ratingCounts[review.rating as 1 | 2 | 3 | 4 | 5] += 1;
const locationMap = new Map<string, { reviews: number; ratingSum: number; mentions: number }>();
const employeeMap = new Map<string, {
	mentions: number;
	deleted: number;
	visible: number;
	positive: number;
	neutral: number;
	negative: number;
	locations: Map<string, number>;
	annex: MonthlyReviewRecap['annex'][number]['mentions'];
}>();
let reviewsWithMentions = 0;
let mentionItems = 0;
for (const review of reviews) {
	const location = salon(review.location_label);
	const reviewMentions = mentions(review);
	const locationEntry = locationMap.get(location) ?? { reviews: 0, ratingSum: 0, mentions: 0 };
	locationEntry.reviews += 1;
	locationEntry.ratingSum += review.rating;
	locationEntry.mentions += reviewMentions?.length ?? 0;
	locationMap.set(location, locationEntry);
	if (reviewMentions && reviewMentions.length > 0) reviewsWithMentions += 1;
	for (const mention of reviewMentions ?? []) {
		mentionItems += 1;
		const employee = employeeMap.get(mention.name) ?? {
			mentions: 0,
			deleted: 0,
			visible: 0,
			positive: 0,
			neutral: 0,
			negative: 0,
			locations: new Map<string, number>(),
			annex: []
		};
		employee.mentions += 1;
		if (visible(review)) employee.visible += 1;
		else employee.deleted += 1;
		employee[mention.sentiment] += 1;
		employee.locations.set(location, (employee.locations.get(location) ?? 0) + 1);
		employee.annex.push({
			date: date(review.create_time),
			author: review.author_name,
			rating: review.rating,
			excerpt: excerpt(review.comment) ?? 'sans texte',
			deleted: !visible(review),
			sentiment: mention.sentiment
		});
		employeeMap.set(mention.name, employee);
	}
}

const employees = [...employeeMap.entries()]
	.map(([name, employee]) => ({
		name,
		salons: employee.locations.size === 1
			? [...employee.locations.keys()][0]
			: [...employee.locations.entries()].map(([location, count]) => `${location} (${count})`).join(' + '),
		mentions: employee.mentions,
		deleted: employee.deleted,
		visible: employee.visible,
		positive: employee.positive,
		neutral: employee.neutral,
		negative: employee.negative
	}))
	.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name, 'fr'));
const deletedReviews = reviews.filter((review) => !visible(review));
const visibleReviews = reviews.filter(visible);
const pendingReviews = visibleReviews.filter((review) => review.replied_at === null && review.remote_reply_at === null);
const divergentReviews = visibleReviews.filter((review) => review.replied_at !== null && review.remote_reply_at === null);
const unresolvedReviews = reviews.filter((review) => mentions(review) === null);
const latestSync = locationHealth.map((location) => location.last_sync_at!).sort().at(-1)!;
const latestSyncInstant = new Date(`${latestSync.replace(' ', 'T')}Z`);
const latestSyncLabel = new Intl.DateTimeFormat('fr-CH', {
	dateStyle: 'short',
	timeStyle: 'short',
	timeZone: 'Europe/Zurich'
}).format(latestSyncInstant);

const report: MonthlyReviewRecap = {
	projectName: project.name,
	periodKey: month,
	periodLabel,
	recipient: project.client_email,
	generatedDate: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(new Date()),
	timezone: 'Europe/Zurich',
	sourceSyncedAt: `${latestSyncLabel} (Europe/Zurich)`,
	summary: {
		reviews: reviews.length,
		average: reviews.length > 0 ? reviews.reduce((total, review) => total + review.rating, 0) / reviews.length : 0,
		ratingCounts,
		reviewsWithMentions,
		mentionItems,
		collaborators: employees.length,
		deletedReviews: deletedReviews.length
	},
	history: history.map((row) => ({
		label: monthNames[Number(row.period_month.slice(5, 7)) - 1].replace(/^./, (letter) => letter.toUpperCase()),
		reviews: row.reviews,
		average: row.average
	})),
	locations: [...locationMap.entries()]
		.map(([name, value]) => ({ salon: name, reviews: value.reviews, average: value.ratingSum / value.reviews, mentions: value.mentions }))
		.sort((a, b) => b.reviews - a.reviews || a.salon.localeCompare(b.salon, 'fr')),
	employees,
	negativeReviews: reviews.filter((review) => review.rating <= 3).map((review) => ({
		date: date(review.create_time),
		salon: salon(review.location_label),
		rating: review.rating,
		author: review.author_name,
		excerpt: excerpt(review.comment) ?? 'Avis sans commentaire.',
		visible: visible(review),
		analysis: visible(review)
			? review.remote_reply_at ? 'Cet avis est encore en ligne et a reçu une réponse.' : 'Cet avis est encore en ligne et demande un traitement humain.'
			: 'Cet avis n’est plus en ligne au moment de la synchronisation finale.'
	})),
	deletedReviews: deletedReviews.map((review) => ({
		date: date(review.create_time),
		salon: salon(review.location_label),
		author: review.author_name,
		rating: review.rating,
		employees: (mentions(review) ?? []).map((mention) => mention.name)
	})),
	replyCoverage: {
		visibleReviews: visibleReviews.length,
		remotelyAnswered: visibleReviews.filter((review) => review.remote_reply_at !== null).length,
		pending: pendingReviews.length,
		divergent: divergentReviews.length
	},
	arbitrations: unresolvedReviews.map((review) => ({
		title: `${review.author_name} — mention non attribuée`,
		body: `Avis ${visible(review) ? 'visible' : 'supprimé'} du ${date(review.create_time)} à ${salon(review.location_label)} : « ${excerpt(review.comment) ?? 'sans texte'} ». Aucun alias n'a été attribué sans validation.`
	})),
	annex: [...employeeMap.entries()]
		.map(([employee, value]) => ({ salon: [...value.locations.keys()].join(' + '), employee, mentions: value.annex }))
		.sort((a, b) => a.salon.localeCompare(b.salon, 'fr') || a.employee.localeCompare(b.employee, 'fr')),
	noMentionReviews: reviews
		.filter((review) => (mentions(review)?.length ?? 0) === 0)
		.map((review) => ({
			date: date(review.create_time),
			salon: salon(review.location_label),
			author: review.author_name,
			rating: review.rating,
			excerpt: excerpt(review.comment),
			deleted: !visible(review)
		})),
	methodNote: period.closed
		? 'Période complète calculée en heure locale Europe/Zurich, après pagination intégrale des six fiches. Le tableau historique est recalculé avec la même règle depuis la source actuelle ; il corrige donc les chiffres du mail de juillet, qui utilisait la date UTC.'
		: 'PREVIEW PROVISOIRE : le mois n’est pas clos. Période calculée en heure locale Europe/Zurich après pagination intégrale des six fiches ; ne pas envoyer ce fichier. Le tableau historique est recalculé avec la même règle depuis la source actuelle ; il corrige donc les chiffres du mail de juillet, qui utilisait la date UTC.'
};

const markdown = renderMonthlyReviewRecapMarkdown(report);
const home = process.env.USERPROFILE ?? process.env.HOME;
if (!home) throw new Error('Dossier utilisateur introuvable.');
const defaultName = `${month}-email-client${period.closed ? '' : '.provisional'}.md`;
const output = option('output') ?? join(home, 'noyau', 'cerveau', '10-Projets', slug, 'recaps', defaultName);
mkdirSync(join(output, '..'), { recursive: true });
if (existsSync(output)) {
	const existing = readFileSync(output, 'utf8');
	if (existing !== markdown) throw new Error(`Artefact immuable déjà présent et différent : ${output}. Choisir un nouveau --output (RC suivante).`);
	console.log(`NO-OP : artefact identique déjà présent — ${output}`);
} else {
	writeFileSync(output, markdown, 'utf8');
	console.log(`Artefact écrit : ${output}`);
}
console.log(JSON.stringify({
	month,
	closed: period.closed,
	reviews: reviews.length,
	visible: visibleReviews.length,
	deleted: deletedReviews.length,
	mentions: mentionItems,
	unresolved: unresolvedReviews.length,
	pending: pendingReviews.length,
	remoteAnswered: report.replyCoverage.remotelyAnswered,
	divergent: divergentReviews.length,
	recipient: project.client_email,
	output
}));
await pool.end();
