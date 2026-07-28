/**
 * GMB-002 — Authentification Google Business Profile, chargeable PARTOUT.
 *
 * Calqué sur `gsc-auth.ts`, et pour la même raison exactement : `gmb.ts` importe
 * `$env/dynamic/private` dès sa première ligne, donc tout module qui l'importe est
 * inchargeable hors runtime SvelteKit. Le handler de `collect:gmb_reviews` a d'abord été
 * écrit avec un `await import('./gmb.js')` — il marchait sur Vercel et **mourait en
 * dead-letter** dès qu'on le drainait depuis `scripts/worker.ts` :
 *
 *     Cannot find package '$env' imported from src/lib/server/gmb.ts
 *
 * Un type de job que la file ne peut exécuter qu'en production est un type de job qu'on ne
 * peut pas prouver. `process.env` et `$env/dynamic/private` lisent le même environnement sur
 * Node et sur Vercel ; seul le premier survit à `tsx` et à vitest.
 *
 * ⚠️ Ce module est la SOURCE UNIQUE des jetons pour la collecte. `gmb.ts` garde son propre
 *    `refreshAccountToken` pour les chemins hérités (publication de posts, édition de fiche) :
 *    les deux lisent et réécrivent la même ligne `gmb_settings.account_tokens`, ce qui reste
 *    la raison pour laquelle un seul chemin de collecte doit être planifié à la fois.
 */
import { eq } from 'drizzle-orm';
import type { AppDb } from './db/types.js';
import { gmbSettings } from './db/schema.js';
import { decryptWith, encryptWith } from './crypto-core.js';

export interface GmbTokens {
	access_token: string;
	refresh_token: string;
	/** ISO — tel que le chemin hérité l'écrit. */
	expiry: string;
}

/** Marge de sécurité : un jeton qui expire dans moins d'une minute est déjà mort en vol. */
const EXPIRY_MARGIN_MS = 60_000;

function requireKey(): string {
	const key = process.env.ENCRYPTION_KEY;
	if (!key) throw new Error('ENCRYPTION_KEY absent : impossible de déchiffrer les jetons Google.');
	return key;
}

async function getSetting(db: AppDb, key: string): Promise<string | null> {
	const rows = await db
		.select({ value: gmbSettings.value })
		.from(gmbSettings)
		.where(eq(gmbSettings.key, key));
	return rows[0]?.value ?? null;
}

/**
 * Un jeton d'accès valide, rafraîchi si nécessaire.
 *
 * ⚠️ La marge d'une minute est une correction de fond par rapport au chemin hérité
 * (`gmb.ts:116`), qui compare `expiry > now` sans marge : un jeton expirant dans 200 ms
 * passait le test puis provoquait un 401 en vol, rattrapé par un retry ad hoc dans chaque
 * appelant. Ici la fenêtre est fermée en amont, une fois.
 */
export async function getGmbAccessToken(
	db: AppDb,
	deps: { fetchImpl?: typeof fetch; persist?: boolean } = {}
): Promise<string> {
	const key = requireKey();
	const encrypted = await getSetting(db, 'account_tokens');
	if (!encrypted) throw new Error('Aucun jeton Google configuré (gmb_settings.account_tokens).');

	const tokens = JSON.parse(decryptWith(key, encrypted)) as GmbTokens;
	if (new Date(tokens.expiry).getTime() - EXPIRY_MARGIN_MS > Date.now()) {
		return tokens.access_token;
	}

	const doFetch = deps.fetchImpl ?? fetch;
	const res = await doFetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: process.env.GOOGLE_CLIENT_ID || '',
			client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
			refresh_token: tokens.refresh_token,
			grant_type: 'refresh_token'
		})
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		// `invalid_grant` dans le message est ce que `classifyJobFailure` lit pour rendre
		// `auth` — un refresh mort ne doit pas être rejoué cinq fois.
		throw new Error(`Rafraîchissement du jeton Google échoué : ${res.status} ${text}`);
	}

	const data = (await res.json()) as { access_token: string; expires_in: number };
	const refreshed: GmbTokens = {
		access_token: data.access_token,
		refresh_token: tokens.refresh_token,
		expiry: new Date(Date.now() + data.expires_in * 1000).toISOString()
	};

	// `persist: false` pour les outils de diagnostic : un script lancé à la main n'a pas à
	// faire une course en écriture avec le tick sur l'unique ligne de credential.
	if (deps.persist !== false) {
		await db
			.update(gmbSettings)
			.set({ value: encryptWith(key, JSON.stringify(refreshed)) })
			.where(eq(gmbSettings.key, 'account_tokens'));
	}

	return refreshed.access_token;
}

/** L'identifiant de compte, sans son préfixe `accounts/`. */
export async function getGmbAccountId(db: AppDb): Promise<string> {
	const raw = await getSetting(db, 'account_id');
	return raw?.replace(/^accounts\//, '') ?? '';
}

/**
 * Les dépendances du collecteur d'avis. L'unique fabrique, utilisée par les trois appelants :
 * le handler de job, la route de rattrapage et le CLI.
 */
export function gmbReviewDeps(db: AppDb, options: { persist?: boolean } = {}) {
	return {
		getAccessToken: () => getGmbAccessToken(db, { persist: options.persist }),
		getAccountId: () => getGmbAccountId(db)
	};
}
