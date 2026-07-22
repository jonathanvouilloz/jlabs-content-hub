/**
 * JOB-007 — Présentation de la file de jobs : libellés et formats.
 *
 * Ce module vit dans `utils/` (donc importable par les pages ET par le serveur)
 * parce que trois lecteurs rendent les mêmes données : la console `/jobs`,
 * `scripts/jobs-inspect.ts` en CLI, et les pages serveur. Deux tables de
 * traduction pour un même vocabulaire finiraient par diverger — un `deferred`
 * affiché « reporté » ici et « échoué » là ferait diagnostiquer à côté.
 *
 * Aucune dépendance à `$lib/server` : ces valeurs sont du texte, pas des secrets.
 * Aucune horloge implicite non plus — `formatRelative` reçoit son `now`.
 */

// ── Libellés ────────────────────────────────────────────────────────

/** Issue d'une TENTATIVE, telle que le journal `job_attempts` la nomme. */
export const OUTCOME_LABEL: Record<string, string> = {
	running: 'EN COURS',
	succeeded: 'réussie',
	failed: 'échouée',
	abandoned: 'ABANDONNÉE',
	released: 'relâchée',
	deferred: 'REPORTÉE (quota)',
	requeued: 'RELANCÉE (manuel)',
	cancelled: 'ANNULÉE',
	// JOB-004 — pas une tentative : le job n'a jamais tourné, son prérequis obligatoire
	// ayant échoué pour de bon. C'est le FAIT qui est journalisé, pas un essai.
	skipped: 'SAUTÉE (dépendance)',
	dead: 'DEAD-LETTER'
};

/** Ce que la classe de l'erreur dit du sort réservé au job (JOB-003). */
export const CLASS_LABEL: Record<string, string> = {
	retryable: 'rejouable',
	quota: 'quota provider',
	auth: 'authentification',
	permanent: 'structurel'
};

/** Nature d'un abandon, telle que le reaper l'a constatée (JOB-002). */
export const KIND_LABEL: Record<string, string> = {
	worker_death: 'worker mort',
	lease_stall: 'worker bloqué'
};

/** Cadence de planification (JOB-005), en clair. */
export const CADENCE_LABEL: Record<string, string> = {
	hourly: 'horaire',
	daily: 'quotidien',
	weekly: 'hebdomadaire',
	monthly: 'mensuel'
};

/** Statut du JOB, en clair. */
export const STATUS_LABEL: Record<string, string> = {
	queued: 'en file',
	running: 'en cours',
	succeeded: 'réussi',
	failed: 'échoué',
	dead: 'dead-letter',
	cancelled: 'annulé',
	// Distinct d'`annulé`, qui est une décision humaine : ici personne n'a rien décidé,
	// c'est la conséquence mécanique d'un prérequis perdu.
	skipped: 'ignoré (dépendance)'
};

// ── Formats (colonnes `text`, format DB `YYYY-MM-DD HH:MM:SS`) ──────

/**
 * `2026-07-22 09:02:11` → `22.07 09:02`. On NE passe PAS par `new Date()` : ces
 * colonnes sont des `text` au format DB (cf. `server/timestamps.ts`), et les
 * reparser réintroduirait l'ambiguïté de fuseau que `toDbTimestamp` a fermée.
 *
 * L'heure rendue est donc l'heure **UTC** telle qu'elle est stockée — comme
 * `scripts/jobs-inspect.ts`. C'est délibéré : convertir ici en Europe/Zurich
 * ferait exister deux lectures d'un même instant selon l'outil consulté, et cette
 * famille de bug a déjà coûté un correctif transverse. L'interface DOIT donc
 * afficher « UTC » à côté de ces valeurs.
 */
export function formatDbTimestamp(ts: string | null): string {
	if (!ts) return '—';
	const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(ts);
	if (!m) return ts;
	return `${m[3]}.${m[2]} ${m[4]}:${m[5]}`;
}

/** `09:02:11` — l'heure seule, quand la date est déjà portée par l'en-tête. */
export function formatDbTime(ts: string | null): string {
	if (!ts) return '…';
	const m = /^\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2}:\d{2})/.exec(ts);
	return m ? m[1] : ts;
}

/** Durée en clair : `840 ms`, `12 s`, `4 min 03 s`, `1 h 12 min`. */
export function formatDuration(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
	if (ms < 1000) return `${Math.round(ms)} ms`;
	const totalSec = Math.round(ms / 1000);
	if (totalSec < 60) return `${totalSec} s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min < 60) return `${min} min ${String(sec).padStart(2, '0')} s`;
	return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/**
 * Lit un horodatage DB (`YYYY-MM-DD HH:MM:SS`, écrit en UTC par `toDbTimestamp`)
 * en millisecondes. Le `Z` est ajouté EXPLICITEMENT : sans lui, le moteur JS
 * interpréterait la chaîne dans le fuseau local et l'écart afficherait des heures
 * de décalage — dont deux en été.
 */
export function parseDbTimestamp(ts: string | null): number | null {
	if (!ts) return null;
	const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(ts);
	if (!m) return null;
	const parsed = Date.parse(`${m[1]}T${m[2]}Z`);
	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * JOB-005 — Créneau LOCAL (`2026-07-20T09:00`, Europe/Zurich) → `lun 20.07 09:00`.
 *
 * À la différence de `formatDbTimestamp`, cette valeur n'est PAS un instant UTC :
 * c'est le créneau métier tel qu'il a été planifié. L'interface doit donc afficher
 * les deux — l'écart entre eux est exactement ce que le scheduler existe pour gérer.
 */
export function formatScheduleSlot(slot: string | null): string {
	if (!slot) return '—';
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(slot);
	if (!m) return slot;
	const [, y, mo, d, h, mi] = m;
	const days = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
	// Date nue en UTC : on ne lit que le jour de semaine, aucun fuseau n'intervient.
	const dow = days[new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay()];
	return `${dow} ${d}.${mo} ${h}:${mi}`;
}

/**
 * Écart lisible entre deux horodatages DB : `dans 4 min` / `il y a 2 h`.
 *
 * `now` est INJECTÉ, et c'est l'heure du SERVEUR (passée par la `load`) : lue sur
 * l'horloge du navigateur, la file paraîtrait en avance ou en retard selon la
 * machine qui la regarde.
 */
export function formatRelative(ts: string | null, now: Date | string): string {
	if (!ts) return '—';
	const parsed = parseDbTimestamp(ts);
	const ref = typeof now === 'string' ? parseDbTimestamp(now) : now.getTime();
	if (parsed === null || ref === null) return formatDbTimestamp(ts);
	const deltaMs = parsed - ref;
	const abs = formatDuration(Math.abs(deltaMs));
	return deltaMs >= 0 ? `dans ${abs}` : `il y a ${abs}`;
}
