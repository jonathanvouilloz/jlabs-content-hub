/**
 * DASH-003 — Preuve du cockpit projet (sur Neon).
 *
 * Les règles pures (états de panneau, ordre total de la timeline, couverture) sont couvertes
 * par vitest (`project-cockpit-state.test.ts`, 18 tests). Ce qui ne peut PAS se prouver en
 * vitest, et se prouve ici contre la vraie base :
 *
 *   A. **L'invariant anti-divergence** : la carte de santé du cockpit est IDENTIQUE, champ par
 *      champ, à celle que l'accueil affiche pour le même projet et la même fenêtre. C'est la
 *      raison d'être du module — deux définitions de « projet à risque » finiraient par se
 *      contredire, et personne ne saurait laquelle croire ;
 *   B. acceptation « un provider désactivé n'est pas présenté comme une erreur » : une
 *      intégration sentinelle DÉSACTIVÉE et porteuse d'un code d'erreur rend `inactive`, pas
 *      `broken` ; la même, activée, rend `broken`. Deux scènes, deux verdicts ;
 *   C. acceptation « les décisions passées sont accessibles depuis la timeline » — et le cas
 *      qui casse les implémentations naïves : une décision prise sur une proposition **sans
 *      finding** apparaît quand même (elle n'a AUCUNE ligne dans `finding_events`) ;
 *   D. acceptation « chaque métrique affiche période, fraîcheur et source » : aucun panneau
 *      rendu n'a de trio incomplet, et un domaine sans donnée porte `period: null` — jamais
 *      une plage inventée ;
 *   E. les compteurs du cockpit sont ceux de l'accueil, et leurs liens portent bien le projet ;
 *   F. la timeline est STABLE d'un appel à l'autre (ordre total) et dit ce qu'elle coupe.
 *
 * ZÉRO appel réseau : tout est en base.
 *
 * Isolation. Rien n'est créé qu'on ne puisse nommer et supprimer : un provider d'intégration
 * sentinelle (`__test_dash003`) et une proposition sentinelle (`action_type` préfixé
 * `__test_dash003:`). AUCUN projet n'est créé (la FK cross-schéma `projects.slug →
 * core.entities.slug` appartient à `invoices`). Nettoyage ENFANTS D'ABORD dans un `finally` :
 * proposal_approvals → action_proposals → project_integrations. Un Ctrl-C SAUTE ce nettoyage :
 * vérifier alors le provider `__test_dash003` et les `action_type` `__test_dash003:%`.
 *
 * Lancer : npx tsx scripts/dash-003-project-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { loadProjectCockpit } from '../src/lib/server/project-cockpit.js';
import { loadHomeCockpit } from '../src/lib/server/home.js';
import { createId } from '../src/lib/server/utils.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}
function section(title: string): void {
	console.log('');
	console.log(title);
}

const SENTINEL_PROVIDER = '__test_dash003';
const SENTINEL_ACTION = '__test_dash003:decision-sans-finding';
const WINDOW_DAYS = 7;
/** Heure FIXE : la fraîcheur et les fenêtres doivent être rejouables à l'identique. */
const NOW = new Date('2026-07-25T12:00:00Z');

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(q);
	return Number((res.rows?.[0] as { n: number }).n);
}
async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
	const res = await db.execute(q);
	return (res.rows ?? []) as unknown as T[];
}

async function cleanup(): Promise<void> {
	// ENFANTS D'ABORD : les approbations référencent les propositions.
	await db.execute(sql`
		DELETE FROM "seostats"."proposal_approvals"
		 WHERE proposal_id IN (
			SELECT id FROM "seostats"."action_proposals" WHERE action_type LIKE ${SENTINEL_ACTION + '%'}
		 )
	`);
	await db.execute(sql`
		DELETE FROM "seostats"."action_proposals" WHERE action_type LIKE ${SENTINEL_ACTION + '%'}
	`);
	await db.execute(sql`
		DELETE FROM "seostats"."project_integrations" WHERE provider = ${SENTINEL_PROVIDER}
	`);
}

async function upsertSentinelIntegration(projectId: string, over: {
	enabled: boolean;
	status: string;
	healthStatus: string;
	lastErrorCode: string | null;
}): Promise<void> {
	await db.execute(sql`
		DELETE FROM "seostats"."project_integrations"
		 WHERE project_id = ${projectId} AND provider = ${SENTINEL_PROVIDER}
	`);
	await db.insert(schema.projectIntegrations).values({
		id: createId(),
		projectId,
		provider: SENTINEL_PROVIDER,
		resourceKey: '',
		enabled: over.enabled,
		status: over.status,
		healthStatus: over.healthStatus,
		lastErrorCode: over.lastErrorCode,
		lastSuccessAt: null
	});
}

/** Le verdict que `derivePanelState` rendrait pour l'intégration sentinelle. */
function verdictForSentinel(cockpit: Awaited<ReturnType<typeof loadProjectCockpit>>) {
	const i = cockpit?.integrations.find((x) => x.provider === SENTINEL_PROVIDER) ?? null;
	return i;
}

async function main(): Promise<void> {
	const projRes = await rows<{ id: string; slug: string; name: string }>(sql`
		SELECT id, slug, name FROM "seostats"."projects"
		 WHERE archived = false ORDER BY slug LIMIT 1
	`);
	const proj = projRes[0];
	if (!proj) {
		console.error('Aucun projet actif. Abandon.');
		process.exitCode = 1;
		return;
	}
	console.log(`Projet sentinelle : ${proj.slug} (${proj.id})`);

	const base = {
		integrations: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."project_integrations"`),
		proposals: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."action_proposals"`),
		approvals: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."proposal_approvals"`),
		findings: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`),
		events: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."finding_events"`)
	};
	console.log(
		`Baseline : ${base.integrations} intégrations · ${base.proposals} propositions · ` +
			`${base.approvals} approbations · ${base.findings} findings · ${base.events} events`
	);

	try {
		await cleanup();

		// ── A ───────────────────────────────────────────────────────
		section('A. INVARIANT — la carte du cockpit EST celle de l’accueil');
		const [home, cockpit] = await Promise.all([
			loadHomeCockpit({ db, now: NOW, windowDays: WINDOW_DAYS }),
			loadProjectCockpit({ db, projectSlug: proj.slug, now: NOW, windowDays: WINDOW_DAYS })
		]);
		if (!cockpit) {
			console.error('Cockpit introuvable pour un projet actif. Abandon.');
			process.exitCode = 1;
			return;
		}
		const homeCard = home.projects.find((c) => c.slug === proj.slug) ?? null;
		check(
			'la carte est rendue par les deux écrans',
			homeCard !== null && cockpit.card !== null,
			`accueil=${homeCard ? 'oui' : 'non'} · cockpit=${cockpit.card ? 'oui' : 'non'}`
		);
		check(
			'…et elle est IDENTIQUE champ par champ (état, axes, fraîcheur, compteurs)',
			JSON.stringify(homeCard) === JSON.stringify(cockpit.card),
			`état=${cockpit.card?.state} · pipeline=${cockpit.card?.pipeline.state} · signal=${cockpit.card?.signal.state}`
		);
		check(
			'la fenêtre annoncée est celle qui a servi à compter',
			cockpit.windowDays === WINDOW_DAYS && cockpit.sinceDb === home.sinceDb,
			`${cockpit.windowDays} j · depuis ${cockpit.sinceDb}`
		);

		// ── B ───────────────────────────────────────────────────────
		section('B. ACCEPTATION — un provider désactivé n’est pas une erreur');
		// La scène qui piège : intégration ÉTEINTE, mais porteuse d'un code d'erreur ancien.
		await upsertSentinelIntegration(proj.id, {
			enabled: false,
			status: 'error',
			healthStatus: 'down',
			lastErrorCode: 'invalid_grant'
		});
		const offCockpit = await loadProjectCockpit({
			db,
			projectSlug: proj.slug,
			now: NOW,
			windowDays: WINDOW_DAYS
		});
		const off = verdictForSentinel(offCockpit);
		check(
			'l’intégration désactivée est bien lue depuis la base',
			off !== null && off.enabled === false && off.status === 'error',
			`enabled=${off?.enabled} · status=${off?.status} · code=${off?.lastErrorCode}`
		);
		// Le verdict de panneau se vérifie sur la donnée que le module rend : un panneau bâti
		// sur cette intégration serait `inactive`. On le prouve en passant par la même fonction
		// que l'écran (pas une reproduction locale de la règle).
		const { derivePanelState } = await import('../src/lib/server/project-cockpit-state.js');
		const offVerdict = derivePanelState({
			integration: off,
			freshness: { state: 'never', ageHours: null, lastSuccessAt: null },
			hasData: false,
			label: 'Sentinelle'
		});
		check(
			'désactivée + code d’erreur ⇒ `inactive`, jamais `broken`',
			offVerdict.state === 'inactive',
			`${offVerdict.state} — « ${offVerdict.note} »`
		);

		// Contre-épreuve : la MÊME intégration, activée.
		await upsertSentinelIntegration(proj.id, {
			enabled: true,
			status: 'error',
			healthStatus: 'down',
			lastErrorCode: 'invalid_grant'
		});
		const onCockpit = await loadProjectCockpit({
			db,
			projectSlug: proj.slug,
			now: NOW,
			windowDays: WINDOW_DAYS
		});
		const onVerdict = derivePanelState({
			integration: verdictForSentinel(onCockpit),
			freshness: { state: 'never', ageHours: null, lastSuccessAt: null },
			hasData: false,
			label: 'Sentinelle'
		});
		check(
			'CONTRE-ÉPREUVE : la même, activée ⇒ `broken` avec son code',
			onVerdict.state === 'broken' && onVerdict.note.includes('invalid_grant'),
			`${onVerdict.state} — « ${onVerdict.note} »`
		);
		// …et l'axe PIPELINE du projet le voit aussi : une intégration cassée casse la collecte.
		check(
			'et le projet passe en collecte cassée (l’axe pipeline, pas le signal)',
			onCockpit?.card?.pipeline.state === 'broken' && onCockpit?.card?.signal.state === 'unknown',
			`pipeline=${onCockpit?.card?.pipeline.state} · signal=${onCockpit?.card?.signal.state}`
		);
		await db.execute(sql`
			DELETE FROM "seostats"."project_integrations" WHERE provider = ${SENTINEL_PROVIDER}
		`);

		// ── C ───────────────────────────────────────────────────────
		section('C. ACCEPTATION — une décision SANS finding est quand même dans la timeline');
		// Le cas qui casse les implémentations naïves : `proposals.ts` n'écrit son
		// `finding_event` que `if (p.findingId)`. Une proposition issue d'un rapport n'en a
		// pas, donc la lire depuis `finding_events` la rendrait invisible ; la lire depuis
		// `proposal_approvals` manquerait tous les rejets.
		const proposalId = createId();
		await db.insert(schema.actionProposals).values({
			id: proposalId,
			projectId: proj.id,
			findingId: null,
			actionType: SENTINEL_ACTION,
			target: 'https://sentinelle-dash003.test/page',
			rationale: 'preuve DASH-003',
			riskLevel: 'low',
			requiredApprovalLevel: 'L2',
			proposedBy: 'agent',
			payloadJson: '{}',
			payloadHash: 'sentinel',
			status: 'rejected'
		});
		const withDecision = await loadProjectCockpit({
			db,
			projectSlug: proj.slug,
			now: NOW,
			windowDays: WINDOW_DAYS,
			timelineLimit: 200
		});
		const decisionEntry = withDecision?.timeline.entries.find((e) => e.id === proposalId) ?? null;
		const eventsForProposal = await scalar(sql`
			SELECT count(*)::int AS n FROM "seostats"."finding_events"
			 WHERE payload_json LIKE ${'%' + proposalId + '%'}
		`);
		check(
			'la proposition rejetée n’a AUCUNE ligne de journal au finding',
			eventsForProposal === 0,
			`${eventsForProposal} finding_event`
		);
		check(
			'…et elle apparaît pourtant dans la timeline, avec son niveau d’autorisation',
			decisionEntry !== null &&
				decisionEntry.kind === 'decision' &&
				decisionEntry.approvalLevel === 'L2',
			decisionEntry ? `« ${decisionEntry.title} » · ${decisionEntry.approvalLevel}` : 'absente'
		);
		check(
			'et son lien mène à la proposition',
			decisionEntry?.href === `/inbox/proposals/${proposalId}`,
			decisionEntry?.href ?? 'aucun'
		);

		// ── D ───────────────────────────────────────────────────────
		section('D. ACCEPTATION — période, fraîcheur et source sur CHAQUE panneau');
		const panels = withDecision?.panels ?? [];
		check('des panneaux sont rendus', panels.length > 0, `${panels.length} panneaux`);
		check(
			'aucun panneau sans source ni fraîcheur',
			panels.every((p) => p.provenance.source.length > 0 && typeof p.provenance.freshness.state === 'string'),
			panels.map((p) => `${p.key}:${p.provenance.source}`).join(' · ')
		);
		check(
			'un domaine sans donnée porte `period: null`, jamais une plage inventée',
			panels.every((p) => p.provenance.period === null || p.provenance.period.label.includes('→')),
			panels.map((p) => `${p.key}=${p.provenance.period?.label ?? 'null'}`).join(' · ')
		);
		check(
			'aucun panneau n’a de fraîcheur « 0 h » là où rien n’a été collecté',
			panels.every(
				(p) => p.provenance.freshness.state !== 'never' || p.provenance.freshness.ageHours === null
			),
			panels.map((p) => `${p.key}:${p.provenance.freshness.state}`).join(' · ')
		);

		// ── E ───────────────────────────────────────────────────────
		section('E. Les compteurs du cockpit sont ceux de l’accueil, et portent le projet');
		check(
			'compteurs identiques à ceux de la carte',
			JSON.stringify(withDecision?.counters) === JSON.stringify(withDecision?.card?.counters ?? []),
			`${withDecision?.counters.length ?? 0} compteurs`
		);
		const linked = (withDecision?.counters ?? []).filter((c) => c.href);
		check(
			'chaque compteur qui a un lien porte le slug du projet',
			linked.length > 0 && linked.every((c) => c.href!.includes(`project=${proj.slug}`) || c.href!.includes(`/projects/${proj.slug}/`)),
			linked.map((c) => c.href).join(' · ') || 'aucun lien'
		);

		// ── F ───────────────────────────────────────────────────────
		section('F. La timeline est STABLE, et sa troncature se dit');
		const again = await loadProjectCockpit({
			db,
			projectSlug: proj.slug,
			now: NOW,
			windowDays: WINDOW_DAYS,
			timelineLimit: 200
		});
		check(
			'deux appels rendent le MÊME ordre (ordre total, pas un hasard de tri)',
			JSON.stringify(withDecision?.timeline.entries.map((e) => e.kind + e.id)) ===
				JSON.stringify(again?.timeline.entries.map((e) => e.kind + e.id)),
			`${again?.timeline.entries.length} entrées`
		);
		const capped = await loadProjectCockpit({
			db,
			projectSlug: proj.slug,
			now: NOW,
			windowDays: WINDOW_DAYS,
			timelineLimit: 1
		});
		const total = withDecision?.timeline.entries.length ?? 0;
		check(
			'un plafond bas rend 1 entrée ET annonce ce qu’il coupe',
			capped?.timeline.entries.length === Math.min(1, total) &&
				(capped?.timeline.truncated ?? 0) === Math.max(0, total - 1),
			`${capped?.timeline.entries.length} affichée(s), ${capped?.timeline.truncated} coupée(s)`
		);

		// ── G ───────────────────────────────────────────────────────
		section('G. Un slug inconnu ne rend pas une page vide, il rend `null`');
		// Une page « vide mais 200 » se lirait comme « ce projet n'a rien » au lieu de
		// « ce projet n'existe pas » — la route en fait un 404.
		const missing = await loadProjectCockpit({ db, projectSlug: '__inexistant__', now: NOW });
		check('slug inconnu ⇒ null', missing === null, String(missing));
	} finally {
		await cleanup();
	}

	section('H. Base rendue à l’identique');
	const post = {
		integrations: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."project_integrations"`),
		proposals: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."action_proposals"`),
		approvals: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."proposal_approvals"`),
		findings: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`),
		events: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."finding_events"`)
	};
	for (const key of Object.keys(base) as (keyof typeof base)[]) {
		check(`${key} inchangé`, base[key] === post[key], `${base[key]} → ${post[key]}`);
	}

	section(failures === 0 ? '✅ Toutes les vérifications passent.' : `❌ ${failures} échec(s).`);
	if (failures > 0) process.exitCode = 1;
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => pool.end());
