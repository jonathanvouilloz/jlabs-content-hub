import { Resend } from 'resend';
import { env } from '$env/dynamic/private';
import { db } from './db/index.js';
import { gmbSettings } from './db/schema.js';
import { eq } from 'drizzle-orm';
import {
	adminDailyHtml,
	clientWeeklyHtml,
	criticalErrorHtml,
	type AdminDailyData,
	type ClientWeeklyData
} from './email-templates.js';

const FROM = env.FROM_EMAIL ?? 'hub@jonlabs.ch';
const ADMIN = env.ADMIN_EMAIL ?? 'contact@jonlabs.ch';
const APP_URL = env.PUBLIC_APP_URL ?? 'https://hub.jonlabs.ch';

let resendClient: Resend | null = null;
function getResend(): Resend | null {
	if (!env.RESEND_API_KEY) return null;
	if (!resendClient) resendClient = new Resend(env.RESEND_API_KEY);
	return resendClient;
}

// ── Settings helpers (idempotence) ─────────────────────────────────

async function getSetting(key: string): Promise<string | null> {
	const row = await db.select().from(gmbSettings).where(eq(gmbSettings.key, key)).then((r) => r[0]);
	return row?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
	await db
		.insert(gmbSettings)
		.values({ key, value })
		.onConflictDoUpdate({ target: gmbSettings.key, set: { value } });
}

function todayIso(): string {
	return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function hashContext(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
	return Math.abs(h).toString(36);
}

// ── Admin daily digest ────────────────────────────────────────────

export interface BuildAdminDigestInput {
	date: string;
	logs: Array<{
		contentId: string;
		success: boolean;
		locationLabel: string | null;
		errorMessage: string | null;
		project: { name: string; slug: string };
		contentTitle: string;
	}>;
}

export function buildAdminDigestData(input: BuildAdminDigestInput): AdminDailyData {
	const successes = input.logs.filter((l) => l.success);
	const errors = input.logs.filter((l) => !l.success);

	const successMap = new Map<string, { projectName: string; contentIds: Set<string>; locations: Set<string> }>();
	for (const l of successes) {
		const key = l.project.slug;
		if (!successMap.has(key)) {
			successMap.set(key, { projectName: l.project.name, contentIds: new Set(), locations: new Set() });
		}
		const entry = successMap.get(key)!;
		entry.contentIds.add(l.contentId);
		if (l.locationLabel) entry.locations.add(l.locationLabel);
	}

	return {
		date: input.date,
		successCount: successes.length,
		errorCount: errors.length,
		successesByProject: [...successMap.values()].map((s) => ({
			projectName: s.projectName,
			count: s.contentIds.size,
			locations: [...s.locations]
		})),
		errors: errors.map((e) => ({
			projectName: e.project.name,
			contentTitle: e.contentTitle,
			locationLabel: e.locationLabel ?? '—',
			errorMessage: e.errorMessage ?? 'Erreur inconnue',
			contentUrl: `${APP_URL}/projects/${e.project.slug}/content/${e.contentId}`
		}))
	};
}

export async function sendAdminDailyDigest(data: AdminDailyData): Promise<{ sent: boolean; reason?: string }> {
	if (data.successCount === 0 && data.errorCount === 0) {
		return { sent: false, reason: 'empty' };
	}

	const today = todayIso();
	const lastSent = await getSetting('last_daily_digest_date');
	if (lastSent === today) return { sent: false, reason: 'already_sent_today' };

	const resend = getResend();
	if (!resend) return { sent: false, reason: 'no_api_key' };

	const subject = `[hub] GMB ${data.date} — ${data.successCount} OK, ${data.errorCount} erreur${data.errorCount !== 1 ? 's' : ''}`;

	try {
		await resend.emails.send({
			from: FROM,
			to: ADMIN,
			subject,
			html: adminDailyHtml(data)
		});
		await setSetting('last_daily_digest_date', today);
		return { sent: true };
	} catch (e) {
		return { sent: false, reason: `send_failed: ${(e as Error).message}` };
	}
}

// ── Client weekly digest ──────────────────────────────────────────

export async function sendClientWeeklyDigest(
	project: { id: string; name: string; slug: string; color: string; clientEmail: string | null; weeklyDigestEnabled: boolean },
	data: Omit<ClientWeeklyData, 'projectName' | 'projectColor'>
): Promise<{ sent: boolean; reason?: string }> {
	if (!project.weeklyDigestEnabled) return { sent: false, reason: 'disabled' };
	if (!project.clientEmail) return { sent: false, reason: 'no_email' };
	if (data.posts.length === 0) return { sent: false, reason: 'no_posts' };

	const resend = getResend();
	if (!resend) return { sent: false, reason: 'no_api_key' };

	const periodLabel = new Date(data.periodEnd).toLocaleDateString('fr-CH', { day: 'numeric', month: 'long' });
	const subject = `Récap GMB ${project.name} — ${data.posts.length} post${data.posts.length > 1 ? 's' : ''} (${periodLabel})`;

	try {
		await resend.emails.send({
			from: FROM,
			to: project.clientEmail,
			subject,
			html: clientWeeklyHtml({ ...data, projectName: project.name, projectColor: project.color })
		});
		return { sent: true };
	} catch (e) {
		return { sent: false, reason: `send_failed: ${(e as Error).message}` };
	}
}

// ── Critical error ────────────────────────────────────────────────

const CRITICAL_DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1h

export async function sendCriticalError(context: string, error: string): Promise<{ sent: boolean; reason?: string }> {
	const resend = getResend();
	if (!resend) return { sent: false, reason: 'no_api_key' };

	const key = `critical_sent_${hashContext(context)}`;
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
			subject: `🚨 [hub] Erreur critique GMB — ${context.slice(0, 60)}`,
			html: criticalErrorHtml({ context, error, timestamp: now })
		});
		await setSetting(key, now);
		return { sent: true };
	} catch (e) {
		return { sent: false, reason: `send_failed: ${(e as Error).message}` };
	}
}
