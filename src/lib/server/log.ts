/**
 * OPS-001 — Logs structurés de base.
 *
 * Un logger minimal, sans dépendance, qui émet du JSON-lines (une ligne = un
 * événement) exploitable par Vercel/collecteurs, avec des niveaux et un champ
 * `module` attaché. En dev (`NODE_ENV !== 'production'`) la sortie est un texte
 * lisible plutôt que du JSON.
 *
 * Règle SPEC §16.2 : aucune valeur secrète ne doit apparaître dans les logs.
 * On ne loggue jamais un objet d'env brut ; les clés sensibles connues sont
 * masquées par `redactFields()` en dernier rempart.
 *
 * Ce module est volontairement synchrone et sans état : il est sûr à importer
 * depuis n'importe quel rôle (web, cron, futur worker/scheduler).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Fragments de nom de champ qui déclenchent un masquage de la valeur. */
const SECRET_HINTS = ['secret', 'token', 'password', 'apikey', 'api_key', 'key', 'private', 'authorization', 'credential'];

function resolveMinLevel(): LogLevel {
	const raw = (globalThis.process?.env?.LOG_LEVEL ?? '').toLowerCase();
	if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
	return 'info';
}

const MIN_LEVEL = resolveMinLevel();
const IS_PROD = globalThis.process?.env?.NODE_ENV === 'production';

type Fields = Record<string, unknown>;

/** Masque les valeurs des champs dont le nom évoque un secret. */
export function redactFields(fields: Fields): Fields {
	const out: Fields = {};
	for (const [k, v] of Object.entries(fields)) {
		const lower = k.toLowerCase();
		out[k] = SECRET_HINTS.some((h) => lower.includes(h)) ? '[redacted]' : v;
	}
	return out;
}

function emit(level: LogLevel, module: string, msg: string, fields?: Fields): void {
	if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
	const safe = fields ? redactFields(fields) : undefined;

	if (IS_PROD) {
		const record = { ts: new Date().toISOString(), level, module, msg, ...(safe ?? {}) };
		const line = JSON.stringify(record);
		if (level === 'error') console.error(line);
		else if (level === 'warn') console.warn(line);
		else console.log(line);
		return;
	}

	// Dev : texte lisible.
	const prefix = `[${level.toUpperCase()}] ${module}:`;
	const extra = safe && Object.keys(safe).length ? ' ' + JSON.stringify(safe) : '';
	if (level === 'error') console.error(prefix, msg + extra);
	else if (level === 'warn') console.warn(prefix, msg + extra);
	else console.log(prefix, msg + extra);
}

export interface Logger {
	debug(msg: string, fields?: Fields): void;
	info(msg: string, fields?: Fields): void;
	warn(msg: string, fields?: Fields): void;
	error(msg: string, fields?: Fields): void;
	/** Dérive un logger avec un `module` différent (mêmes réglages). */
	child(module: string): Logger;
}

/** Crée un logger attaché à un nom de module (ex: `log('gmb')`). */
export function log(module: string): Logger {
	return {
		debug: (msg, fields) => emit('debug', module, msg, fields),
		info: (msg, fields) => emit('info', module, msg, fields),
		warn: (msg, fields) => emit('warn', module, msg, fields),
		error: (msg, fields) => emit('error', module, msg, fields),
		child: (child) => log(child)
	};
}
