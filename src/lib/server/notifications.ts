import { Resend } from 'resend';
import { env } from '$env/dynamic/private';
import { db } from './db/index.js';
import { systemSettings } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { criticalErrorHtml } from './email-templates.js';
import { toDbTimestamp } from './timestamps.js';

const FROM = env.FROM_EMAIL ?? 'hub@jonlabs.ch';
const ADMIN = env.ADMIN_EMAIL ?? 'contact@jonlabs.ch';

let resendClient: Resend | null = null;
function getResend(): Resend | null {
	if (!env.RESEND_API_KEY) return null;
	if (!resendClient) resendClient = new Resend(env.RESEND_API_KEY);
	return resendClient;
}

// ── Dédup des alertes (idempotence) ────────────────────────────────
// Vivait dans `gmb_settings` jusqu'au retrait de GMB (2026-10-24) ; `system_settings` est le
// KV d'exploitation du hub, lu par clé exacte uniquement.

async function getSetting(key: string): Promise<string | null> {
	const row = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).then((r) => r[0]);
	return row?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
	const updatedAt = toDbTimestamp(new Date());
	await db
		.insert(systemSettings)
		.values({ key, value, description: 'dédup alerte critique (1 h)', updatedAt })
		.onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt } });
}

function hashContext(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
	return Math.abs(h).toString(36);
}

// ── Critical error ────────────────────────────────────────────────

const CRITICAL_DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1h

export async function sendCriticalError(context: string, error: string): Promise<{ sent: boolean; reason?: string }> {
	const resend = getResend();
	if (!resend) return { sent: false, reason: 'no_api_key' };

	const key = `notify.critical_sent.${hashContext(context)}`;
	const lastSentIso = await getSetting(key);
	if (lastSentIso) {
		const elapsed = Date.now() - new Date(lastSentIso).getTime();
		if (elapsed < CRITICAL_DEDUP_WINDOW_MS) return { sent: false, reason: 'deduped' };
	}

	const now = new Date().toISOString();
	try {
		await resend.emails.send({
			from: FROM,
			to: ADMIN,
			subject: `🚨 [hub] Erreur critique — ${context.slice(0, 60)}`,
			html: criticalErrorHtml({ context, error, timestamp: now })
		});
		await setSetting(key, now);
		return { sent: true };
	} catch (e) {
		return { sent: false, reason: `send_failed: ${(e as Error).message}` };
	}
}
