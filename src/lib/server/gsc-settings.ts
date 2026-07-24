/**
 * GSC-004 — Latence de consolidation GSC, réglable sans redéploiement.
 *
 * L'acceptation « rendre la période finale configurable selon la latence GSC » exige
 * qu'un humain puisse décaler la « dernière semaine complète » sans repasser par
 * Vercel (où une variable d'env n'est relue qu'au redéploiement). Comme JOB-006, le
 * réglage vit dans `system_settings` (clé `gsc.latency_days`), le code le relit à
 * chaque usage, et rien n'exige de déployer.
 *
 * ZÉRO DDL : `system_settings` existe déjà (JOB-006). Table vide → défaut du code
 * (`GSC_LATENCY_DAYS`) ; appliquer le DDL ne change RIEN, c'est écrire la clé qui
 * change un comportement.
 *
 * TOLÉRANT de bout en bout, pour la même raison qu'aux limites de file : une valeur
 * corrompue qui ferait LEVER décalerait toute la collecte en silence. Le pire cas est
 * de tourner au défaut documenté (3 jours).
 */
import { sql } from 'drizzle-orm';
import type { AppDb } from './db/types.js';
import { GSC_LATENCY_DAYS } from './collectors/gsc-collector-state.js';
import { toDbTimestamp } from './timestamps.js';
import { log } from './log.js';

const logger = log('gsc-settings');

/** Clé portant la latence GSC dans `system_settings`. */
export const GSC_LATENCY_KEY = 'gsc.latency_days';

/**
 * Valide une latence brute (texte de la base, ou JSON `{"latencyDays":N}`) → un entier
 * de jours >= 0. Toute valeur illisible, négative ou non finie retombe sur le défaut
 * du code. PURE → testable sans base.
 */
export function resolveLatencyDays(raw: string | null | undefined): number {
	if (raw === null || raw === undefined || raw === '') return GSC_LATENCY_DAYS;
	let value: unknown = raw;
	try {
		const parsed: unknown = JSON.parse(raw);
		// Accepte soit un nombre nu (`"5"`), soit `{ latencyDays: 5 }`.
		value =
			parsed && typeof parsed === 'object'
				? (parsed as { latencyDays?: unknown }).latencyDays
				: parsed;
	} catch {
		// `raw` n'est pas du JSON : on tente le nombre nu tel quel.
		value = raw;
	}
	const days = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(days) || days < 0) return GSC_LATENCY_DAYS;
	return Math.floor(days);
}

/**
 * Lit la latence GSC en base. Clé absente, JSON cassé, table vide ou absente → défaut
 * du code. Ne lève jamais.
 */
export async function loadGscLatencyDays(db: AppDb): Promise<number> {
	try {
		const res = await db.execute(sql`
			SELECT value FROM "seostats"."system_settings" WHERE key = ${GSC_LATENCY_KEY}
		`);
		const row = (res.rows ?? [])[0] as unknown as { value: string } | undefined;
		return resolveLatencyDays(row?.value ?? null);
	} catch (err) {
		logger.warn('latence GSC illisible (défaut du code appliqué)', {
			error: err instanceof Error ? err.message : String(err)
		});
		return GSC_LATENCY_DAYS;
	}
}

/**
 * Écrit la latence GSC. Réservé à l'outillage/exploitation (jamais l'app) : un réglage
 * de collecte est une décision, elle se prend à la main. `updated_at` au format DB,
 * jamais en ISO (piège `timestamps.ts`).
 */
export async function saveGscLatencyDays(input: {
	db: AppDb;
	days: number;
	now?: Date | string;
}): Promise<void> {
	const nowDb = toDbTimestamp(input.now ?? new Date());
	await input.db.execute(sql`
		INSERT INTO "seostats"."system_settings" (key, value, description, updated_at)
		VALUES (
			${GSC_LATENCY_KEY},
			${JSON.stringify({ latencyDays: Math.max(0, Math.floor(input.days)) })},
			${'Latence de consolidation GSC (jours) — GSC-004, période finale configurable.'},
			${nowDb}
		)
		ON CONFLICT (key) DO UPDATE
		   SET value = EXCLUDED.value,
		       description = EXCLUDED.description,
		       updated_at = EXCLUDED.updated_at
	`);
}
