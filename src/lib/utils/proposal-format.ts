/**
 * DASH-004/005 — Présentation de l'inbox : libellés des findings et des propositions.
 *
 * Même raison d'être que `job-format.ts`, et mêmes règles : ce module vit dans
 * `utils/` (donc importable par les pages ET par le serveur ET par la CLI à venir),
 * parce que plusieurs lecteurs rendront le même vocabulaire. Deux tables de
 * traduction pour un même mot finissent toujours par diverger — un `invalidated`
 * affiché « invalide » ici et « rejeté » là ferait décider à côté.
 *
 * Aucune dépendance à `$lib/server` : ces valeurs sont du texte, pas des secrets.
 * Les formats de date/durée ne sont PAS redéfinis ici — ils vivent dans
 * `job-format.ts` (`formatDbTimestamp`, `formatRelative`, `formatDuration`), et
 * l'inbox les importe de là : les horodatages sont les mêmes colonnes, au même
 * format DB, et deux lectures d'un même instant selon la page est exactement la
 * famille de bug qui a déjà coûté un correctif transverse.
 */

// ── Propositions ────────────────────────────────────────────────────

/** Ce que l'action FAIT, en clair — pas son identifiant technique. */
export const ACTION_LABEL: Record<string, string> = {
	report_generate: 'générer un rapport',
	indexnow_submit: 'soumettre à IndexNow',
	brief_create: 'créer un brief',
	refresh_plan: 'plan de refresh (brouillon)',
	meta_rewrite: 'réécrire title & meta',
	content_refresh: 'rafraîchir le contenu',
	internal_link_add: 'ajouter un lien interne',
	redirect_301: 'redirection 301',
	canonical_set: 'poser une canonical',
	deindex: 'désindexer',
	content_delete: 'supprimer le contenu'
};

/**
 * Niveau d'autorisation (§12.1) : ce qu'il autorise, et surtout QUI peut
 * l'accorder. L'acceptation DASH-004 exige que « l'action proposée indique son
 * niveau d'autorisation » — un `L3` nu ne l'indique pas, il le nomme.
 */
export const LEVEL_LABEL: Record<string, string> = {
	L0: 'L0 · observation',
	L1: 'L1 · opération réversible',
	L2: 'L2 · brouillon',
	L3: 'L3 · publication externe',
	L4: 'L4 · sensible / destructif'
};

/** Qui peut accorder ce niveau (§12.2) — dit à l'écran, pas déduit par le lecteur. */
export const LEVEL_APPROVER: Record<string, string> = {
	L0: 'agent, policy ou humain',
	L1: 'agent, policy ou humain',
	L2: 'agent, policy ou humain',
	L3: 'policy explicite ou humain — jamais un agent',
	L4: 'humain uniquement, une par une'
};

/** Risque intrinsèque de l'ACTION (pas la gravité du problème). */
export const RISK_LABEL: Record<string, string> = {
	low: 'faible',
	medium: 'moyen',
	high: 'élevé',
	// `null` en base : ne pas savoir n'est pas savoir que c'est faible.
	inconnu: 'inconnu'
};

/** Statut d'une proposition, en clair. */
export const PROPOSAL_STATUS_LABEL: Record<string, string> = {
	proposed: 'à décider',
	changes_requested: 'révision demandée',
	// Distinct de « rejetée » : personne n'a dit non, c'est le payload qui a bougé
	// sous l'approbation.
	invalidated: 'approbation tombée',
	approved: 'approuvée',
	rejected: 'rejetée',
	executing: 'en exécution',
	executed: 'exécutée',
	failed: 'exécution échouée',
	superseded: 'remplacée',
	expired: 'expirée'
};

// ── Findings ────────────────────────────────────────────────────────

/** Statut d'un finding (§10.1), en clair. Pas de `new` : il est transitoire, un
 *  finding naît directement `open` (cf. `FINDING_STATUSES`). */
export const FINDING_STATUS_LABEL: Record<string, string> = {
	open: 'ouvert',
	acknowledged: 'pris en compte',
	planned: 'planifié',
	in_progress: 'en cours',
	snoozed: 'en veille',
	resolved: 'résolu',
	dismissed: 'écarté',
	reopened: 'rouvert'
};

/** Sévérité d'un finding. */
export const SEVERITY_LABEL: Record<string, string> = {
	info: 'info',
	low: 'faible',
	medium: 'moyenne',
	high: 'haute',
	critical: 'critique'
};

/** Type de finding (§10.4), en clair — les 20 du catalogue `FINDING_TYPES`. */
export const FINDING_TYPE_LABEL: Record<string, string> = {
	keyword_opportunity: 'opportunité de mot-clé',
	keyword_decline: 'mot-clé en recul',
	new_query: 'nouvelle requête',
	lost_query: 'requête perdue',
	ctr_gap: 'CTR en dessous de l’attendu',
	content_decay: 'contenu qui décline',
	target_url_mismatch: 'mauvaise URL positionnée',
	cannibalization: 'cannibalisation',
	index_drop: 'perte d’indexation',
	crawled_not_indexed: 'crawlée, non indexée',
	discovered_not_indexed: 'découverte, non indexée',
	canonical_conflict: 'conflit de canonical',
	sitemap_anomaly: 'anomalie de sitemap',
	redirect_in_sitemap: 'redirection dans le sitemap',
	soft_404: 'soft 404',
	traffic_anomaly: 'anomalie de trafic',
	conversion_drop: 'chute de conversion',
	review_pending_sla: 'avis sans réponse (SLA)',
	negative_review: 'avis négatif',
	integration_stale: 'intégration périmée'
};

/** Événement du journal d'un finding (§7.7), en clair. */
export const FINDING_EVENT_LABEL: Record<string, string> = {
	created: 'détecté',
	aggravated: 'aggravé',
	improved: 'amélioré',
	agent_comment: 'commentaire',
	validated: 'validé',
	rejected: 'écarté',
	snoozed: 'mis en veille',
	unsnoozed: 'sorti de veille',
	reopened: 'rouvert',
	resolved: 'résolu'
};

// ── Petits formats propres à l'inbox ────────────────────────────────

/**
 * `a1b2c3d4…` — un hash de payload se montre, mais ne se lit pas en entier.
 *
 * Il est AFFICHÉ parce que l'acceptation « chaque approbation est liée au hash
 * exact » n'est vérifiable par un humain que s'il peut comparer ce qu'il a
 * approuvé à ce qui a été enregistré. Tronqué à 12 caractères : assez pour
 * distinguer deux versions, trop court pour être recopié à la main (ce qu'on ne
 * veut pas encourager — c'est la machine qui le renvoie).
 */
export function shortHash(hash: string | null | undefined, length = 12): string {
	if (!hash) return '—';
	return hash.length <= length ? hash : `${hash.slice(0, length)}…`;
}

/**
 * Priorité d'un finding en classe d'affichage : le seuil 60 n'est pas décoratif,
 * c'est celui du producteur (`PROPOSER_DEFAULTS.minPriority`) et de la CLI
 * (`findings list --min-priority 60`). Au-dessus, un finding est proposable ; en
 * dessous, il ne le sera jamais — l'écran doit le dire, sinon on attend une
 * proposition qui ne viendra pas.
 */
export function priorityBand(score: number): 'haute' | 'moyenne' | 'basse' {
	if (score >= 80) return 'haute';
	if (score >= 60) return 'moyenne';
	return 'basse';
}

/** Rend un JSON stocké en `text` lisible à l'écran, sans jamais jeter. */
export function prettyJson(raw: string | null | undefined): string | null {
	if (!raw) return null;
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		// Une valeur illisible s'AFFICHE telle quelle : la masquer ferait croire à
		// une absence de donnée là où il y a une donnée corrompue.
		return raw;
	}
}
