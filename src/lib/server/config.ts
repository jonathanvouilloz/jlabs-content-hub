/**
 * GOV-003 — Configuration runtime centralisée.
 *
 * Source unique de vérité pour les variables d'environnement : un schéma décrit
 * chaque variable (rôle, exigence, secret), au lieu de les lire dispersées dans
 * ~18 fichiers. Objectifs (SPEC §3.1, §16.2 ; BACKLOG GOV-003) :
 *
 *   - chaque rôle (web, cron, providers…) sait de quoi il a besoin ;
 *   - une variable manquante produit un diagnostic actionnable et NON sensible ;
 *   - aucune valeur secrète n'est jamais journalisée (seule la présence l'est).
 *
 * Politique de démarrage : `validateStartup()` LOG un rapport (présent/absent
 * par rôle) sans jamais throw — on ne veut pas qu'un cold-start serverless
 * tombe sur une variable optionnelle absente. La stricte exigence est appliquée
 * au point d'usage via `requireEnv(name, feature)`, qui échoue proprement quand
 * la fonctionnalité concernée est réellement sollicitée.
 */

import { env } from '$env/dynamic/private';
import { building } from '$app/environment';
import { log } from './log.js';

const logger = log('config');

/** Rôle logique qui consomme la variable (séparation SPEC §6.1). */
export type ConfigRole =
	| 'core' // base de données, socle commun
	| 'auth' // Better Auth + chiffrement des tokens
	| 'google' // OAuth Google (GSC + GMB)
	| 'linkedin' // OAuth LinkedIn
	| 'llm' // synthèse IA (API OpenAI-compatible)
	| 'notifications' // emails Resend
	| 'storage' // Vercel Blob (images GMB)
	| 'cron' // routes planifiées /api/cron/*
	| 'platform'; // injecté par la plateforme (Vercel), jamais à définir soi-même

/**
 * - `boot`    : sans elle l'application ne peut pas fonctionner du tout ;
 * - `feature` : requise uniquement quand la fonctionnalité associée est utilisée ;
 * - `optional`: améliore le comportement mais a un défaut sûr.
 */
export type ConfigRequirement = 'boot' | 'feature' | 'optional';

export interface ConfigVar {
	name: string;
	role: ConfigRole;
	requirement: ConfigRequirement;
	secret: boolean;
	description: string;
}

/** Schéma déclaratif de toutes les variables réellement consommées par le code. */
export const CONFIG_SCHEMA: readonly ConfigVar[] = [
	// core
	{ name: 'DATABASE_URL', role: 'core', requirement: 'boot', secret: true, description: 'URL Postgres Neon (schéma seostats).' },
	// auth
	{ name: 'BETTER_AUTH_SECRET', role: 'auth', requirement: 'boot', secret: true, description: 'Secret de signature des sessions Better Auth.' },
	{ name: 'BETTER_AUTH_URL', role: 'auth', requirement: 'feature', secret: false, description: 'URL canonique de l’app pour Better Auth.' },
	{ name: 'BETTER_AUTH_TRUSTED_ORIGINS', role: 'auth', requirement: 'optional', secret: false, description: 'Origines supplémentaires acceptées (CSV).' },
	{ name: 'ENCRYPTION_KEY', role: 'auth', requirement: 'boot', secret: true, description: 'Clé 32 bytes hex de chiffrement des tokens OAuth stockés.' },
	{ name: 'MACHINE_CREDENTIALS_JSON', role: 'auth', requirement: 'feature', secret: true, description: 'Credentials machine hashés, scopés, expirables et révocables (JSON).' },
	{ name: 'CORE_RECONCILER_URL', role: 'core', requirement: 'feature', secret: false, description: 'Endpoint contrôlé du reconciler core.entities.' },
	{ name: 'CORE_RECONCILER_TOKEN', role: 'core', requirement: 'feature', secret: true, description: 'Bearer serveur vers le reconciler core.' },
	// google
	{ name: 'GOOGLE_CLIENT_ID', role: 'google', requirement: 'feature', secret: false, description: 'Client OAuth Google (GSC + GMB).' },
	{ name: 'GOOGLE_CLIENT_SECRET', role: 'google', requirement: 'feature', secret: true, description: 'Secret OAuth Google.' },
	// linkedin
	{ name: 'LINKEDIN_CLIENT_ID', role: 'linkedin', requirement: 'feature', secret: false, description: 'Client OAuth LinkedIn.' },
	{ name: 'LINKEDIN_CLIENT_SECRET', role: 'linkedin', requirement: 'feature', secret: true, description: 'Secret OAuth LinkedIn.' },
	// llm
	{ name: 'LLM_API_KEY', role: 'llm', requirement: 'feature', secret: true, description: 'Clé API LLM (OpenAI-compatible) pour la synthèse IA.' },
	{ name: 'LLM_BASE_URL', role: 'llm', requirement: 'optional', secret: false, description: 'Base URL LLM (défaut Moonshot).' },
	{ name: 'LLM_MODEL', role: 'llm', requirement: 'optional', secret: false, description: 'Modèle LLM (défaut kimi-k2.6).' },
	// notifications
	{ name: 'RESEND_API_KEY', role: 'notifications', requirement: 'feature', secret: true, description: 'Clé API Resend pour les emails.' },
	{ name: 'FROM_EMAIL', role: 'notifications', requirement: 'feature', secret: false, description: 'Expéditeur des emails (domaine vérifié Resend).' },
	{ name: 'ADMIN_EMAIL', role: 'notifications', requirement: 'feature', secret: false, description: 'Destinataire admin des digests/alertes.' },
	{ name: 'PUBLIC_APP_URL', role: 'notifications', requirement: 'optional', secret: false, description: 'Base URL publique pour les liens dans les emails.' },
	// storage
	{ name: 'BLOB_READ_WRITE_TOKEN', role: 'storage', requirement: 'feature', secret: true, description: 'Token Vercel Blob (upload images GMB).' },
	// cron
	{ name: 'CRON_SECRET', role: 'cron', requirement: 'feature', secret: true, description: 'Bearer attendu par les routes /api/cron/*.' },
	// platform (injectées par Vercel)
	{ name: 'VERCEL_ENV', role: 'platform', requirement: 'optional', secret: false, description: 'Environnement Vercel (injecté).' },
	{ name: 'VERCEL_GIT_COMMIT_SHA', role: 'platform', requirement: 'optional', secret: false, description: 'SHA du commit déployé (injecté).' }
] as const;

const SCHEMA_BY_NAME = new Map(CONFIG_SCHEMA.map((v) => [v.name, v]));

/** Lecture brute d'une variable (undefined si absente ou vide). */
export function get(name: string): string | undefined {
	const raw = env[name];
	return raw && raw.length > 0 ? raw : undefined;
}

/** True si la variable est présente et non vide. */
export function has(name: string): boolean {
	return get(name) !== undefined;
}

/**
 * Récupère une variable requise par une fonctionnalité. Échoue avec un message
 * actionnable et NON sensible si elle est absente — à appeler au point d'usage.
 */
export function requireEnv(name: string, feature: string): string {
	const value = get(name);
	if (value === undefined) {
		const known = SCHEMA_BY_NAME.get(name);
		const hint = known ? ` (${known.description})` : '';
		throw new Error(`Variable d'environnement manquante « ${name} » requise pour : ${feature}${hint}. Voir .env.example.`);
	}
	return value;
}

export interface StartupReport {
	missingBoot: string[];
	presentByRole: Partial<Record<ConfigRole, number>>;
	absentFeatures: string[];
}

/**
 * Inventorie l'état des variables et le journalise (présence uniquement, jamais
 * les valeurs). Ne throw pas : le fail-fast strict est délégué à `requireEnv`.
 */
export function validateStartup(): StartupReport {
	const missingBoot: string[] = [];
	const absentFeatures: string[] = [];
	const presentByRole: Partial<Record<ConfigRole, number>> = {};

	for (const v of CONFIG_SCHEMA) {
		const present = has(v.name);
		if (present) {
			presentByRole[v.role] = (presentByRole[v.role] ?? 0) + 1;
			continue;
		}
		if (v.requirement === 'boot') missingBoot.push(v.name);
		else if (v.requirement === 'feature') absentFeatures.push(v.name);
	}

	if (missingBoot.length > 0) {
		logger.error('variables boot manquantes — l’app va échouer au premier usage', { missing: missingBoot });
	}
	if (absentFeatures.length > 0) {
		logger.info('fonctionnalités désactivées faute de variables', { absent: absentFeatures });
	}
	logger.info('config validée', { presentByRole, bootOk: missingBoot.length === 0 });

	return { missingBoot, presentByRole, absentFeatures };
}

// Validation unique au chargement du module (hors phase de build statique).
if (!building) {
	validateStartup();
}
