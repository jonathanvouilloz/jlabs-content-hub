/**
 * AGT-000 — Helpers PURS du producteur de propositions (SPEC §7.8/§11/§12).
 *
 * Zéro dépendance db/`$env`/crypto (seuls `finding-state.ts` et le TYPE
 * `ApprovalLevel`, purs eux aussi) → testables en isolation par vitest. Comme
 * `canonicalPolicyConfig` (DATA-007), la SÉRIALISATION canonique vit ici et le
 * HASH se calcule dans la couche IO : le module reste sans crypto.
 *
 * Ce module transforme un FAIT (un finding, établi par arithmétique) en ACTION
 * recommandée. SPEC §3.3 : les détecteurs calculent, les agents proposent. La
 * structure de la proposition — quel type d'action, quel niveau d'approbation,
 * quelle cible — est DÉTERMINISTE et ne passe par aucun modèle : c'est le seul
 * moyen que le niveau d'autorisation lui-même ne soit pas négociable (§12.2 :
 * « un agent ne peut pas s'auto-accorder un scope supérieur »).
 *
 * Invariant central — LE PAYLOAD EST STABLE DANS LE TEMPS. `createProposal`
 * dédup sur `payload_hash` : tout ce qui bouge d'une semaine à l'autre
 * (position à la décimale, impressions, `last_seen_at`, `occurrence_count`)
 * est BANNI du payload, sinon chaque run produirait un hash neuf, donc une
 * proposition neuve, et l'inbox doublerait de volume toutes les semaines sans
 * qu'aucune garde ne s'en aperçoive. Les chiffres du moment vivent dans le
 * `rationale`/`expected_impact` (non hashés) et dans `input_hashes_json`.
 */
import { isActiveStatus, parseFindingFingerprint } from './finding-state.js';
import type { ApprovalLevel } from './proposal-state.js';

/** Version du producteur, portée par les propositions et les `agent_runs`. */
export const PROPOSER_VERSION = 'finding-proposer@1';

/** Version du schéma de `payload_json` — dans le payload, donc DANS le hash. */
export const PROPOSAL_PAYLOAD_SCHEMA_VERSION = 1;

// ── Catalogue fermé des actions (SPEC §12.1) ────────────────────────

/**
 * Types d'action qu'une proposition peut porter. Catalogue FERMÉ : un type
 * absent d'ici n'a pas de niveau d'approbation, donc ne peut pas être proposé.
 * C'est volontaire — un `action_type` libre laisserait entrer une action dont
 * personne n'a décidé du niveau de validation.
 */
export const PROPOSAL_ACTION_TYPES = [
	'report_generate',
	'indexnow_submit',
	'brief_create',
	'refresh_plan',
	'meta_rewrite',
	'content_refresh',
	'internal_link_add',
	'redirect_301',
	'canonical_set',
	'deindex',
	'content_delete'
] as const;
export type ProposalActionType = (typeof PROPOSAL_ACTION_TYPES)[number];

/**
 * Niveau d'approbation requis par action (SPEC §12.1), table FIGÉE :
 *   L0 observation · L1 opération réversible · L2 brouillon ·
 *   L3 publication externe · L4 sensible/destructif.
 * Les libellés de la SPEC sont repris tels quels : « plan de refresh » y est
 * explicitement L2, « modification contenu » L3, « 301, canonical, suppression,
 * désindexation » L4. Rien n'est dérivé dynamiquement : un niveau calculé serait
 * un niveau négociable.
 */
export const APPROVAL_LEVEL_BY_ACTION: Record<ProposalActionType, ApprovalLevel> = {
	report_generate: 'L0',
	indexnow_submit: 'L1',
	brief_create: 'L2',
	refresh_plan: 'L2',
	meta_rewrite: 'L3',
	content_refresh: 'L3',
	internal_link_add: 'L3',
	redirect_301: 'L4',
	canonical_set: 'L4',
	deindex: 'L4',
	content_delete: 'L4'
};

/** Skill chargé d'exécuter l'action, quand il y en a un (sinon `null`). */
export const SKILL_BY_ACTION: Record<ProposalActionType, string | null> = {
	report_generate: null,
	indexnow_submit: null,
	brief_create: 'seo-brief',
	refresh_plan: 'seo-refresh',
	meta_rewrite: 'seo-refresh',
	content_refresh: 'seo-refresh',
	internal_link_add: 'seo-enrich',
	redirect_301: null,
	canonical_set: null,
	deindex: null,
	content_delete: null
};

/**
 * Niveau d'approbation d'une action. Refus par défaut : un type inconnu rend
 * `null` (donc aucune proposition) plutôt qu'un niveau permissif — la même
 * discipline que `canActorApprove`, qui refuse tout acteur/niveau inconnu.
 */
export function deriveApprovalLevel(actionType: string): ApprovalLevel | null {
	return APPROVAL_LEVEL_BY_ACTION[actionType as ProposalActionType] ?? null;
}

/** Vrai si l'action est du ressort exclusif d'un humain (L4, §12.2). */
export function isHumanOnlyAction(actionType: string): boolean {
	return deriveApprovalLevel(actionType) === 'L4';
}

// ── Risque intrinsèque ──────────────────────────────────────────────

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const RISK_BY_LEVEL: Record<ApprovalLevel, RiskLevel> = {
	L0: 'low',
	L1: 'low',
	L2: 'low',
	L3: 'medium',
	L4: 'high'
};

/**
 * Risque d'une action. Il vient de CE QUE L'ACTION FAIT (son niveau), pas de la
 * gravité du problème : un finding critique ne rend pas plus risqué de rédiger
 * un brouillon. La seule modulation retenue est celle qui a un sens réel —
 * **toucher une page qui reçoit déjà des clics expose un acquis**. Réécrire le
 * title d'une page à 0 clic ne peut rien faire perdre ; le réécrire sur une page
 * qui en fait 40 par semaine, si.
 */
export function deriveRiskLevel(
	actionType: string,
	context?: { existingClicks?: number | null; riskyClicksThreshold?: number } | null
): RiskLevel {
	const level = deriveApprovalLevel(actionType);
	if (!level) return 'high'; // inconnu → traité comme le plus risqué, jamais banalisé
	const base = RISK_BY_LEVEL[level];

	const clicks = context?.existingClicks;
	const threshold = context?.riskyClicksThreshold ?? PROPOSER_DEFAULTS.riskyClicksThreshold;
	const touchesPublished = level === 'L3' || level === 'L4';
	if (!touchesPublished) return base;
	if (typeof clicks !== 'number' || !Number.isFinite(clicks) || clicks < threshold) return base;

	return base === 'medium' ? 'high' : base;
}

// ── Configuration (défauts < projection projet < overrides) ─────────

export interface ProposerConfig {
	/**
	 * Priorité minimale d'un finding pour mériter une proposition. Aligné sur la
	 * CLI cible (`findings list --min-priority 60`, SPEC §11.2).
	 */
	minPriority: number;
	/**
	 * Propositions écrites par projet et par run. Volontairement bas : avec les
	 * 50 findings d'un premier passage sur un gros projet, un producteur sans
	 * plafond ferait naître l'inbox de propositions déjà inutilisable — le même
	 * défaut qu'on subit déjà sur l'inbox de findings.
	 */
	maxProposals: number;
	/**
	 * Position au-delà de laquelle réécrire le snippet ne suffit plus : sous ce
	 * seuil la page est vue et c'est le CTR qui pèche (→ `meta_rewrite`), au-delà
	 * il faut d'abord gagner des places (→ `refresh_plan`).
	 */
	metaRewriteMaxPosition: number;
	/** Clics hebdomadaires à partir desquels une page publiée devient un acquis à protéger. */
	riskyClicksThreshold: number;
}

export const PROPOSER_DEFAULTS: ProposerConfig = {
	minPriority: 60,
	maxProposals: 10,
	metaRewriteMaxPosition: 10,
	riskyClicksThreshold: 10
};

/**
 * Fusionne des overrides projet aux défauts. Même idiome tolérant que
 * `resolveThresholds`/`resolveLifecycleConfig` : une valeur non finie ou absurde
 * retombe sur le défaut. Un override corrompu ne doit pas faire produire zéro
 * proposition en silence — ni, à l'inverse, en produire mille.
 *
 * `minPriority` accepte 0 (proposer sur tout est un choix légitime) ; les autres
 * exigent au moins 1, car 0 y signifierait « ne rien faire » sans le dire.
 */
export function resolveProposerConfig(overrides?: Partial<ProposerConfig> | null): ProposerConfig {
	const out = { ...PROPOSER_DEFAULTS };
	if (!overrides) return out;
	for (const key of Object.keys(PROPOSER_DEFAULTS) as (keyof ProposerConfig)[]) {
		const value = overrides[key];
		if (typeof value !== 'number' || !Number.isFinite(value)) continue;
		const min = key === 'minPriority' ? 0 : 1;
		const rounded = key === 'metaRewriteMaxPosition' ? value : Math.floor(value);
		if (rounded < min) continue;
		out[key] = rounded;
	}
	return out;
}

// ── Lecture tolérante des signaux d'un finding ──────────────────────

/** Le finding tel que le producteur le lit (sous-ensemble des colonnes). */
export interface ProposableFinding {
	id: string;
	type: string;
	fingerprint: string;
	entityType: string;
	entityKey: string;
	title: string;
	status: string;
	severity: string;
	priorityScore: number;
	confidenceScore: number;
	impactEstimateJson?: string | null;
	evidenceJson?: string | null;
	recommendedSkill?: string | null;
}

/** Mesures extraites des preuves d'un finding. `null` = absente, jamais inventée. */
export interface FindingSignals {
	/** Cible de l'action (la page), lue dans le fingerprint. */
	page: string | null;
	query: string | null;
	position: number | null;
	clicks: number | null;
	impressions: number | null;
	ctr: number | null;
	gainEstimate: number | null;
}

function readNumber(source: Record<string, unknown> | null, key: string): number | null {
	const v = source?.[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Extrait les mesures utiles des preuves. **Ne calcule rien** : SPEC §3.3,
 * « un agent ne fabrique jamais une métrique manquante ». Un blob illisible rend
 * des `null` — le finding ne produira alors pas d'action plutôt qu'une action
 * fondée sur une valeur devinée.
 */
export function readFindingSignals(finding: ProposableFinding): FindingSignals {
	const parsedFp = parseFindingFingerprint(finding.fingerprint);
	const evidence = parseJsonObject(finding.evidenceJson);
	const metrics = (evidence?.metrics as Record<string, unknown> | undefined) ?? null;
	const impact = parseJsonObject(finding.impactEstimateJson);

	return {
		page: parsedFp.discriminators[0] || null,
		query: finding.entityKey || parsedFp.entityKey || null,
		position: readNumber(metrics, 'position'),
		clicks: readNumber(metrics, 'clicks'),
		impressions: readNumber(metrics, 'impressions'),
		ctr: readNumber(metrics, 'ctr'),
		gainEstimate:
			readNumber(metrics, 'gainEstimate') ?? readNumber(impact, 'gainEstimateClicksPerWeek')
	};
}

// ── Choix de l'action (déterministe, par type de finding) ───────────

export interface ActionChoice {
	actionType: ProposalActionType;
	/** Pourquoi CETTE action plutôt qu'une autre — journalisé, pas décoratif. */
	selectionReason: string;
}

/**
 * Traduit un finding en actions recommandées. Table figée par type de finding :
 * un type INCONNU rend un tableau vide, jamais une action par défaut — proposer
 * « rafraîchir le contenu » face à un problème qu'on ne sait pas lire serait une
 * recommandation sans source, exactement ce que l'indicateur « recommandations
 * agentiques sans source = 0 » interdit.
 *
 * `keyword_opportunity` rend UNE action, choisie par la position : la page est
 * déjà vue (→ le snippet est le problème) ou elle ne l'est pas assez (→ il faut
 * d'abord gagner des places). Proposer les deux ne dirait rien de plus et
 * doublerait l'inbox.
 */
export function mapFindingToActions(
	finding: ProposableFinding,
	signals: FindingSignals,
	config: ProposerConfig
): ActionChoice[] {
	if (finding.type !== 'keyword_opportunity') return [];
	// Sans cible ni position, l'action n'est pas adressable : on préfère ne rien
	// proposer plutôt que proposer « quelque part ».
	if (!signals.page || signals.position === null) return [];

	if (signals.position <= config.metaRewriteMaxPosition) {
		return [
			{
				actionType: 'meta_rewrite',
				selectionReason:
					`position ${signals.position.toFixed(1)} ≤ ${config.metaRewriteMaxPosition} : ` +
					`la page est déjà servie, c'est le snippet qui ne convertit pas`
			}
		];
	}
	return [
		{
			actionType: 'refresh_plan',
			selectionReason:
				`position ${signals.position.toFixed(1)} > ${config.metaRewriteMaxPosition} : ` +
				`réécrire le snippet ne suffit pas, il faut d'abord gagner des places`
		}
	];
}

// ── Payload canonique (STABLE — c'est lui qui est hashé) ────────────

/**
 * Payload d'une proposition. **Aucun champ volatil** : ni date, ni compteur, ni
 * mesure hebdomadaire. Deux runs à un mois d'écart sur le même problème et la
 * même action produisent le MÊME payload, donc le même hash, donc UNE seule
 * proposition. Les chiffres du moment vivent dans `rationale`/`expected_impact`
 * (non hashés, rafraîchis à chaque run) et dans `input_hashes_json`.
 */
export interface ProposalPayload {
	schema_version: number;
	action: ProposalActionType;
	proposer: string;
	finding_ids: string[];
	finding_type: string;
	finding_fingerprint: string;
	target: string | null;
	query: string | null;
	skill: string | null;
}

/**
 * Construit le payload stable d'une action. `finding_ids` est un tableau (et non
 * un scalaire) parce que le regroupement de findings corrélés — la suite du
 * chantier agentique — devra pouvoir en porter plusieurs sans changer de schéma.
 */
export function buildProposalPayload(input: {
	finding: ProposableFinding;
	signals: FindingSignals;
	choice: ActionChoice;
}): ProposalPayload {
	const { finding, signals, choice } = input;
	return {
		schema_version: PROPOSAL_PAYLOAD_SCHEMA_VERSION,
		action: choice.actionType,
		proposer: PROPOSER_VERSION,
		finding_ids: [finding.id],
		finding_type: finding.type,
		finding_fingerprint: finding.fingerprint,
		target: signals.page,
		query: signals.query,
		skill: SKILL_BY_ACTION[choice.actionType]
	};
}

/**
 * Sérialisation DÉTERMINISTE du payload (ordre de champs figé, `undefined`
 * normalisé). C'est cette chaîne que la couche IO hashe — même discipline que
 * `canonicalPolicyConfig`. NE PAS réordonner les champs sans invalider tous les
 * hash existants, donc toutes les approbations qui s'y rattachent.
 */
export function canonicalProposalPayload(payload: ProposalPayload): string {
	return JSON.stringify({
		schema_version: payload.schema_version,
		action: payload.action,
		proposer: payload.proposer,
		finding_ids: [...payload.finding_ids].sort(),
		finding_type: payload.finding_type,
		finding_fingerprint: payload.finding_fingerprint,
		target: payload.target ?? null,
		query: payload.query ?? null,
		skill: payload.skill ?? null
	});
}

/**
 * Signature des ENTRÉES qui ont produit la proposition — volatile par nature,
 * et c'est pour ça qu'elle est SÉPARÉE du payload. Hashée dans
 * `input_hashes_json`, elle dit « voici l'état des mesures ce jour-là » sans
 * jamais peser sur la dédup.
 */
export function canonicalInputSignature(input: {
	finding: ProposableFinding;
	signals: FindingSignals;
}): string {
	const { finding, signals } = input;
	return JSON.stringify([
		finding.id,
		finding.fingerprint,
		finding.priorityScore,
		finding.confidenceScore,
		finding.severity,
		signals.position ?? null,
		signals.clicks ?? null,
		signals.impressions ?? null,
		signals.ctr ?? null,
		signals.gainEstimate ?? null
	]);
}

// ── Textes lisibles (NON hashés, rafraîchis à chaque run) ───────────

/** Cause lisible de la proposition : le fait, puis l'action qu'il appelle. */
export function buildRationale(input: {
	finding: ProposableFinding;
	signals: FindingSignals;
	choice: ActionChoice;
}): string {
	const { finding, signals, choice } = input;
	const bits: string[] = [];
	if (signals.query) bits.push(`« ${signals.query} »`);
	if (signals.impressions !== null) bits.push(`${signals.impressions} impressions`);
	if (signals.position !== null) bits.push(`position ${signals.position.toFixed(1)}`);
	if (signals.ctr !== null) bits.push(`CTR ${(signals.ctr * 100).toFixed(2)}%`);
	if (signals.clicks !== null) bits.push(`${signals.clicks} clics actuels`);
	return (
		`${finding.title} — ${bits.join(' · ')}. ` +
		`Action retenue : ${choice.actionType} (${choice.selectionReason}). ` +
		`Priorité ${finding.priorityScore}/100, confiance ${finding.confidenceScore}/100.`
	);
}

/**
 * Impact attendu. Repris de l'estimation du DÉTECTEUR, jamais recalculé ici :
 * la mesure appartient à qui l'a établie. Sans estimation, on le dit.
 */
export function buildExpectedImpact(signals: FindingSignals): string {
	if (signals.gainEstimate === null) {
		return 'impact non estimé par le détecteur';
	}
	return `~${signals.gainEstimate} clics/semaine récupérables (estimation du détecteur)`;
}

// ── Sélection des findings proposables ──────────────────────────────

export interface ProposableSelection {
	/** TOUS les findings éligibles, triés, AVANT plafond. */
	matched: ProposableFinding[];
	/** Ceux effectivement retenus (tronqués à `maxProposals`). */
	selected: ProposableFinding[];
	/** Écartés parce que leur statut les sort de l'inbox (veille, dismiss, résolu). */
	excludedByStatus: number;
	/** Écartés parce que sous `minPriority`. */
	excludedByPriority: number;
	/** Vrai si le plafond a mordu — jamais une troncature silencieuse. */
	truncated: boolean;
}

/**
 * Filtre et ordonne les findings à proposer. Deux gardes :
 *   - **statut** : seuls les findings ACTIFS (`isActiveStatus`) sont proposables.
 *     Proposer une action sur un finding en veille romprait la promesse de
 *     silence du snooze ; en proposer une sur un `dismissed` ressusciterait par
 *     la bande ce qu'un humain a écarté à vie (décisions produit FIND-003).
 *   - **priorité** : sous `minPriority`, on ne propose pas — l'inbox de
 *     propositions doit rester une liste de décisions, pas un déversoir.
 *
 * `matched` (complet) est exposé À CÔTÉ de `selected` (tronqué) : la leçon
 * FIND-003 — rien ne doit jamais raisonner sur une liste tronquée.
 * Tri déterministe (priorité ↓, puis fingerprint) : rejouable à l'identique.
 */
export function selectProposableFindings(
	all: ProposableFinding[],
	config: ProposerConfig
): ProposableSelection {
	const matched: ProposableFinding[] = [];
	let excludedByStatus = 0;
	let excludedByPriority = 0;

	for (const f of all) {
		if (!isActiveStatus(f.status)) {
			excludedByStatus += 1;
			continue;
		}
		if (f.priorityScore < config.minPriority) {
			excludedByPriority += 1;
			continue;
		}
		matched.push(f);
	}

	matched.sort((a, b) => {
		if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
		return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0;
	});

	const cap = Math.max(0, Math.floor(config.maxProposals));
	return {
		matched,
		selected: matched.slice(0, cap),
		excludedByStatus,
		excludedByPriority,
		truncated: matched.length > cap
	};
}

// ── Supersession (une seule proposition vivante par finding+action) ──

/** Une proposition déjà en base, telle que le producteur la relit. */
export interface ExistingProposal {
	id: string;
	actionType: string;
	payloadHash: string;
	status: string;
}

export interface SupersessionDecision {
	/** Propositions à passer `superseded` : même action, payload devenu obsolète. */
	supersede: string[];
	/**
	 * Propositions APPROUVÉES dont le payload ne reflète plus la réalité. Elles ne
	 * sont **pas** touchées : les périmer effacerait une décision humaine, et les
	 * laisser filer sans le dire ferait exécuter une action sur un état périmé. On
	 * les REMONTE, un humain tranche.
	 */
	staleApproved: string[];
}

/**
 * Décide du sort des propositions existantes face à un nouveau payload pour la
 * même action. Une seule proposition doit rester vivante par (finding, action) :
 * deux propositions concurrentes sur la même page feraient approuver deux fois
 * la même intention, avec des contenus différents.
 *
 * Seules les propositions encore OUVERTES (`proposed`, `invalidated`) sont
 * périmées. Tout ce qui est engagé (`approved`, `executing`, `executed`) ou déjà
 * clos (`rejected`, `superseded`, `expired`) est laissé intact : une machine ne
 * réécrit pas une décision prise.
 */
export function decideSupersession(input: {
	existing: ExistingProposal[];
	actionType: string;
	nextPayloadHash: string;
}): SupersessionDecision {
	const supersede: string[] = [];
	const staleApproved: string[] = [];

	for (const p of input.existing) {
		if (p.actionType !== input.actionType) continue;
		if (p.payloadHash === input.nextPayloadHash) continue; // c'est la même : l'upsert s'en charge

		if (p.status === 'proposed' || p.status === 'invalidated') {
			supersede.push(p.id);
		} else if (p.status === 'approved') {
			staleApproved.push(p.id);
		}
	}

	return { supersede, staleApproved };
}

// ── Auto-approbation (bornée par le niveau ET par la policy) ────────

export interface AutoApprovalDecision {
	allowed: boolean;
	reason: string;
}

/**
 * Décide si le producteur peut approuver SA PROPRE proposition. Trois gardes
 * cumulatives, dans cet ordre :
 *   1. le niveau — un agent ne dépasse jamais L2 (§12.2). C'est la garde qui
 *      compte : `approveProposal` la re-vérifie côté IO via `canActorApprove`,
 *      et lèvera même si celle-ci était contournée ;
 *   2. la policy projet doit être en `guarded_auto` — `draft_only`/`manual`
 *      n'autorisent aucun geste autonome (DATA-007) ;
 *   3. le kill switch, qui bloque les envois sans bloquer quoi que ce soit d'autre.
 *
 * Refus par défaut : sans policy connue, rien ne part tout seul. C'est l'état de
 * TOUS les projets aujourd'hui — et donc l'état attendu de ce lot.
 */
export function decideAutoApproval(input: {
	approvalLevel: ApprovalLevel;
	policyMode?: string | null;
	killSwitch?: boolean | null;
}): AutoApprovalDecision {
	if (input.approvalLevel !== 'L0' && input.approvalLevel !== 'L1' && input.approvalLevel !== 'L2') {
		return {
			allowed: false,
			reason: `niveau ${input.approvalLevel} : hors de portée d'un agent (§12.2)`
		};
	}
	if (!input.policyMode) {
		return { allowed: false, reason: 'aucune policy projet : refus par défaut' };
	}
	if (input.policyMode !== 'guarded_auto') {
		return { allowed: false, reason: `mode ${input.policyMode} : jamais d'action autonome` };
	}
	if (input.killSwitch) {
		return { allowed: false, reason: 'kill switch actif' };
	}
	return { allowed: true, reason: `niveau ${input.approvalLevel} sous policy guarded_auto` };
}
