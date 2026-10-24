/**
 * Email templates HTML inline pour les alertes du hub.
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

const baseStyle = 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.5;';

// ── Critical error ────────────────────────────────────────────────

export interface CriticalErrorData {
	context: string;
	error: string;
	timestamp: string;
}

export function criticalErrorHtml(data: CriticalErrorData): string {
	return `<div style="${baseStyle}">
		<h1 style="color:#c00;font-size:18px;margin:0 0 16px">⚠️ Erreur critique</h1>
		<p style="margin:0 0 8px"><b>Contexte :</b> ${escapeHtml(data.context)}</p>
		<pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:12px;overflow:auto;white-space:pre-wrap;word-wrap:break-word;color:#333">${escapeHtml(data.error)}</pre>
		<p style="color:#888;font-size:12px;margin-top:16px">${escapeHtml(data.timestamp)}</p>
	</div>`;
}
