import type {
	BlindSpot,
	ReportItem,
	ReportSource,
	SectionKey,
	WeeklyReport
} from './weekly-report-state.js';
import type {
	PublicationReadiness,
	PublicationStatus,
	ReadinessProject
} from './report-publication-state.js';

export const PROJECT_WEEKLY_SNAPSHOT_SCHEMA_VERSION = 1;

export interface ProjectSnapshotSection {
	key: SectionKey;
	title: string;
	available: boolean;
	absenceReason: string | null;
	absenceDetail: string | null;
	items: ReportItem[];
	blindSpots: BlindSpot[];
	note: string | null;
}

export interface ProjectWeeklySnapshot {
	schemaVersion: number;
	eventId: string;
	projectSlug: string;
	periodSlot: string;
	revision: number;
	reportStatus: PublicationStatus;
	reportSchemaVersion: number;
	generatedAt: string;
	period: WeeklyReport['period'];
	readiness: ReadinessProject;
	coverage: BlindSpot[];
	sections: ProjectSnapshotSection[];
}

function sourceKey(source: ReportSource): string {
	switch (source.kind) {
		case 'finding':
		case 'proposal':
			return `${source.kind}:${source.id}`;
		case 'project':
			return `project:${source.slug}`;
		case 'observation':
			return `observation:${source.table}`;
	}
}

/**
 * Projection immuable d'un rapport portefeuille vers un seul projet.
 *
 * Les métriques cross-projet ne sont volontairement pas recopiées : elles ne sauraient pas être
 * attribuées à un projet sans recalcul. Les faits projet portent déjà `projectSlug` et leur preuve.
 */
export function buildProjectWeeklySnapshot(input: {
	report: WeeklyReport;
	readiness: PublicationReadiness;
	periodSlot: string;
	revision: number;
	reportStatus: PublicationStatus;
	projectSlug: string;
}): ProjectWeeklySnapshot {
	const projectReadiness = input.readiness.byProject.find(
		(project) => project.projectSlug === input.projectSlug
	);
	if (!projectReadiness) {
		throw new Error(`Projet « ${input.projectSlug} » absent du rapport ${input.periodSlot}.`);
	}

	const sections = input.report.sections
		.map<ProjectSnapshotSection | null>((section) => {
			if (!section.body.available) {
				return {
					key: section.key,
					title: section.title,
					available: false,
					absenceReason: section.body.reason,
					absenceDetail: section.body.detail,
					items: [],
					blindSpots: [],
					note: null
				};
			}
			const items = section.body.data.items.filter(
				(item) => item.projectSlug === input.projectSlug
			);
			const blindSpots = section.body.data.blindSpots.filter(
				(spot) => spot.projectSlug === input.projectSlug
			);
			if (items.length === 0 && blindSpots.length === 0) return null;
			return {
				key: section.key,
				title: section.title,
				available: true,
				absenceReason: null,
				absenceDetail: null,
				items,
				blindSpots,
				note: section.body.data.note
			};
		})
		.filter((section): section is ProjectSnapshotSection => section !== null);

	return {
		schemaVersion: PROJECT_WEEKLY_SNAPSHOT_SCHEMA_VERSION,
		eventId: `seo-weekly:${input.periodSlot}:r${input.revision}:${input.projectSlug}`,
		projectSlug: input.projectSlug,
		periodSlot: input.periodSlot,
		revision: input.revision,
		reportStatus: input.reportStatus,
		reportSchemaVersion: input.report.schemaVersion,
		generatedAt: input.report.generatedAt,
		period: input.report.period,
		readiness: projectReadiness,
		coverage: input.report.coverage.filter((spot) => spot.projectSlug === input.projectSlug),
		sections
	};
}

function absoluteHref(baseUrl: string, source: ReportSource): string | null {
	const href = source.href;
	if (href === null) return null;
	return new URL(href, `${baseUrl.replace(/\/$/, '')}/`).toString();
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

export function renderProjectWeeklySnapshotMarkdown(
	snapshot: ProjectWeeklySnapshot,
	options: { hubBaseUrl: string }
): string {
	const lines = [
		'---',
		'type: seo-weekly-snapshot',
		`schema_version: ${snapshot.schemaVersion}`,
		`project: ${yamlString(snapshot.projectSlug)}`,
		`event_id: ${yamlString(snapshot.eventId)}`,
		`period_slot: ${yamlString(snapshot.periodSlot)}`,
		`revision: ${snapshot.revision}`,
		`report_status: ${yamlString(snapshot.reportStatus)}`,
		`generated_at: ${yamlString(snapshot.generatedAt)}`,
		'status: needs_review',
		'---',
		'',
		`# Monitoring SEO — ${snapshot.projectSlug} — ${snapshot.periodSlot.slice(0, 10)}`,
		'',
		'> Snapshot daté : les données actuelles restent dans SEO Stats. Ce fichier conserve les',
		'> chiffres qui ont justifié les décisions, sans devenir une seconde base analytique.',
		'',
		'## État du run',
		'',
		`- Rapport portefeuille : **${snapshot.reportStatus}**, révision ${snapshot.revision}`,
		`- Projet : **${snapshot.readiness.state}** (${snapshot.readiness.runStatus ?? 'aucun run'})`,
		`- Run source : ${snapshot.readiness.runId ? `\`${snapshot.readiness.runId}\`` : 'aucun'}`,
		`- Fenêtre : ${snapshot.period.label}`,
		''
	];

	if (snapshot.coverage.length > 0) {
		lines.push('## Réserves de couverture', '');
		for (const spot of snapshot.coverage) lines.push(`- **${spot.reason}** — ${spot.note}`);
		lines.push('');
	}

	for (const section of snapshot.sections) {
		lines.push(`## ${section.title}`, '');
		if (!section.available) {
			lines.push(`> ${section.absenceDetail ?? section.absenceReason ?? 'Donnée indisponible.'}`, '');
			continue;
		}
		for (const item of section.items) {
			const href = absoluteHref(options.hubBaseUrl, item.source);
			lines.push(`### ${item.label}`, '');
			if (item.detail) lines.push(item.detail, '');
			lines.push(`- Priorité / rang : ${item.rank}`);
			lines.push(`- Preuve : \`${sourceKey(item.source)}\`${href ? ` — ${href}` : ''}`, '');
		}
		for (const spot of section.blindSpots) lines.push(`- Réserve : ${spot.note}`);
		if (section.note) lines.push(`> ${section.note}`);
		lines.push('');
	}

	lines.push(
		'## Traitement agent',
		'',
		'- État : `pending`',
		'- Les corrections réversibles et bornées peuvent être préparées automatiquement.',
		'- Toute publication, déploiement production, suppression, dépense ou changement destructif reste soumise à validation.',
		'',
		'## Source',
		'',
		`- Event : \`${snapshot.eventId}\``,
		`- Rapport : ${options.hubBaseUrl.replace(/\/$/, '')}/reports/${encodeURIComponent(snapshot.periodSlot)}`,
		''
	);
	return `${lines.join('\n').trimEnd()}\n`;
}
