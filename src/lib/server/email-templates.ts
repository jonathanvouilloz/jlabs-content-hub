/**
 * Email templates HTML inline pour les notifications GMB.
 * Pas de framework — strings brutes, échappement basique.
 */

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function fmtDate(iso: string, opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' }): string {
	return new Date(iso).toLocaleDateString('fr-CH', opts);
}

const baseStyle = 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.5;';

// ── Admin daily digest ────────────────────────────────────────────

export interface AdminDailyData {
	date: string; // YYYY-MM-DD
	successCount: number;
	errorCount: number;
	successesByProject: Array<{ projectName: string; count: number; locations: string[] }>;
	errors: Array<{ projectName: string; contentTitle: string; locationLabel: string; errorMessage: string; contentUrl: string }>;
}

export function adminDailyHtml(data: AdminDailyData): string {
	const successBlock = data.successCount > 0
		? `<h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#888;border-bottom:1px solid #eee;padding-bottom:8px;margin-top:24px">Réussites (${data.successCount})</h2>
			<ul style="padding-left:20px;margin:8px 0">
				${data.successesByProject.map((s) => `<li style="margin:6px 0"><b>${escapeHtml(s.projectName)}</b> — ${s.count} post${s.count > 1 ? 's' : ''} sur ${escapeHtml(s.locations.join(', '))}</li>`).join('')}
			</ul>`
		: '';

	const errorBlock = data.errors.length > 0
		? `<h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#c00;border-bottom:1px solid #eee;padding-bottom:8px;margin-top:24px">Erreurs (${data.errors.length})</h2>
			${data.errors.map((e) => `
				<div style="background:#fff5f5;border-left:3px solid #c00;padding:12px;margin:10px 0;border-radius:0 4px 4px 0">
					<div style="font-weight:600">${escapeHtml(e.projectName)} — ${escapeHtml(e.contentTitle)}</div>
					<div style="color:#666;font-size:13px;margin-top:4px">${escapeHtml(e.locationLabel)}: ${escapeHtml(e.errorMessage)}</div>
					<a href="${escapeHtml(e.contentUrl)}" style="color:#c00;font-size:12px;text-decoration:none;margin-top:6px;display:inline-block">→ Voir le post</a>
				</div>`).join('')}`
		: '';

	return `<div style="${baseStyle}">
		<h1 style="font-size:20px;margin:0 0 8px">GMB digest — ${fmtDate(data.date)}</h1>
		<p style="color:#666;margin:0 0 16px;font-size:14px">${data.successCount} publication${data.successCount !== 1 ? 's' : ''} OK · ${data.errorCount} erreur${data.errorCount !== 1 ? 's' : ''}</p>
		${successBlock}
		${errorBlock}
		<p style="color:#aaa;font-size:11px;margin-top:32px;border-top:1px solid #eee;padding-top:12px">jlabs-content-hub · cron quotidien GMB</p>
	</div>`;
}

// ── Client weekly digest ──────────────────────────────────────────

export interface ClientWeeklyData {
	projectName: string;
	projectColor: string;
	periodStart: string;
	periodEnd: string;
	posts: Array<{ title: string; locations: string[]; publishedAt: string }>;
	positions?: Array<{
		keyword: string;
		currentPosition: number | null;
		targetPosition: number | null;
		verdict: 'up' | 'down' | 'flat' | 'insufficient';
	}>;
	positionsUrl?: string;
}

export function clientWeeklyHtml(data: ClientWeeklyData): string {
	const safeColor = /^#[0-9a-fA-F]{6}$/.test(data.projectColor) ? data.projectColor : '#00D9A3';
	const period = `${fmtDate(data.periodStart, { day: 'numeric', month: 'long' })} → ${fmtDate(data.periodEnd, { day: 'numeric', month: 'long' })}`;

	const postsList = data.posts.map((p) => `
		<li style="margin:10px 0;padding-left:8px;border-left:2px solid ${safeColor}">
			<div style="font-weight:600;color:#1a1a1a">${escapeHtml(p.title)}</div>
			<div style="color:#666;font-size:13px;margin-top:2px">${escapeHtml(p.locations.join(' · '))} · ${fmtDate(p.publishedAt)}</div>
		</li>`).join('');

	const verdictLabel = { up: '↑ progresse', down: '↓ recule', flat: '→ stable', insufficient: '· données insuffisantes' };
	const positionsBlock = data.positions && data.positions.length > 0 ? `
			<h2 style="margin:28px 0 8px;font-size:15px;font-weight:600;color:#1a1a1a">Vos positions Google</h2>
			<table style="width:100%;border-collapse:collapse;font-size:13px">
				${data.positions.map((p) => `
					<tr style="border-top:1px solid #f0f0f0">
						<td style="padding:8px 0;color:#1a1a1a">${escapeHtml(p.keyword)}</td>
						<td style="padding:8px 0;text-align:right;color:#444;font-weight:600">${p.currentPosition != null ? p.currentPosition.toFixed(1) : '—'}${p.targetPosition != null ? `<span style="color:#aaa;font-weight:400"> / obj. ${p.targetPosition}</span>` : ''}</td>
						<td style="padding:8px 0 8px 12px;text-align:right;color:#666;white-space:nowrap">${verdictLabel[p.verdict]}</td>
					</tr>`).join('')}
			</table>
			${data.positionsUrl ? `<p style="margin:10px 0 0"><a href="${escapeHtml(data.positionsUrl)}" style="color:${safeColor};font-size:13px">Voir le détail sur 12 semaines →</a></p>` : ''}` : '';

	return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto">
		<div style="background:${safeColor};color:white;padding:24px;border-radius:8px 8px 0 0">
			<h1 style="margin:0;font-size:18px;font-weight:600">Récap GMB — ${escapeHtml(data.projectName)}</h1>
			<p style="margin:4px 0 0;opacity:0.9;font-size:13px">${period}</p>
		</div>
		<div style="background:white;padding:24px;border:1px solid #eee;border-top:0;border-radius:0 0 8px 8px">
			<p style="margin:0 0 16px;color:#444">Cette semaine, <b>${data.posts.length} post${data.posts.length > 1 ? 's' : ''}</b> publié${data.posts.length > 1 ? 's' : ''} sur vos fiches Google My Business :</p>
			<ul style="list-style:none;padding:0;margin:0">${postsList}</ul>
			${positionsBlock}
			<p style="color:#aaa;font-size:11px;margin-top:32px;border-top:1px solid #eee;padding-top:12px">Posts gérés par jlabs-content-hub · contact@jonlabs.ch</p>
		</div>
	</div>`;
}

// ── Critical error ────────────────────────────────────────────────

export interface CriticalErrorData {
	context: string;
	error: string;
	timestamp: string;
}

export function criticalErrorHtml(data: CriticalErrorData): string {
	return `<div style="${baseStyle}">
		<h1 style="color:#c00;font-size:18px;margin:0 0 16px">⚠️ Erreur critique GMB</h1>
		<p style="margin:0 0 8px"><b>Contexte :</b> ${escapeHtml(data.context)}</p>
		<pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:12px;overflow:auto;white-space:pre-wrap;word-wrap:break-word;color:#333">${escapeHtml(data.error)}</pre>
		<p style="color:#888;font-size:12px;margin-top:16px">${escapeHtml(data.timestamp)}</p>
	</div>`;
}
