<script lang="ts">
	import { TrendingUp, TrendingDown, Minus, AlertTriangle, CheckCircle2, Clock } from 'lucide-svelte';

	let { data } = $props();

	const report = $derived(data.report);

	const SPAN_LABEL: Record<number, string> = { 7: '7 jours', 28: '28 jours', 90: '90 jours' };
	const SPAN_SUB: Record<number, string> = { 7: '1 semaine', 28: '4 semaines', 90: '13 semaines' };

	const nf = new Intl.NumberFormat('fr-FR');

	function fmtInt(n: number | null | undefined): string {
		return n === null || n === undefined ? '—' : nf.format(Math.round(n));
	}
	function fmtCtr(n: number | null | undefined): string {
		return n === null || n === undefined ? '—' : `${(n * 100).toFixed(1)} %`;
	}
	function fmtPos(n: number | null | undefined): string {
		return n === null || n === undefined ? '—' : n.toFixed(1);
	}
	function fmtPct(pct: number | null): string {
		if (pct === null) return '—';
		const sign = pct > 0 ? '+' : '';
		return `${sign}${pct.toFixed(0)} %`;
	}

	// clics/impressions/ctr : hausse = bien. Position : baisse = bien (rang plus proche de 1).
	function trend(metric: 'clicks' | 'impressions' | 'ctr' | 'position', abs: number): 'up' | 'down' | 'flat' {
		if (abs === 0) return 'flat';
		const good = metric === 'position' ? abs < 0 : abs > 0;
		return good ? 'up' : 'down';
	}
	function trendClass(t: 'up' | 'down' | 'flat'): string {
		return t === 'up' ? 'text-emerald-600' : t === 'down' ? 'text-red-600' : 'text-surface-400';
	}

	const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
	function fmtDate(iso: string): string {
		const d = new Date(`${iso}T00:00:00Z`);
		return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
	}
</script>

<div class="space-y-4">
	<header class="flex flex-wrap items-end justify-between gap-2">
		<div>
			<h1 class="text-lg font-semibold text-surface-900">Fenêtres de comparaison</h1>
			<p class="text-sm text-surface-500">
				7 / 28 / 90 jours sur les données Search Console (canon d'observations).
			</p>
		</div>
		<div class="text-right text-xs text-surface-500">
			<div>
				Dernière semaine complète : <span class="font-medium text-surface-700">{fmtDate(report.latestCompleteWeekStart)}</span>
			</div>
			<div>Latence : {report.latencyDays} j · {report.weeksAvailable} semaine(s) en base</div>
		</div>
	</header>

	{#if report.weeksAvailable === 0}
		<div class="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
			Aucune observation GSC pour ce projet — lancez une collecte ou un backfill
			(<code>scripts/backfill-gsc.ts</code>).
		</div>
	{:else}
		<div class="grid gap-4 md:grid-cols-3">
			{#each report.windows as w (w.span)}
				{@const yoy = report.yoy.find((y) => y.span === w.span)}
				<section class="flex flex-col gap-3 rounded-xl border border-surface-200 bg-white p-4 shadow-sm">
					<div class="flex items-baseline justify-between">
						<h2 class="text-base font-semibold text-surface-900">{SPAN_LABEL[w.span]}</h2>
						<span class="text-xs text-surface-400">{SPAN_SUB[w.span]}</span>
					</div>

					<!-- Complétude / fraîcheur (confiance dérivée) -->
					{#if w.completeness.complete}
						<div class="inline-flex items-center gap-1.5 self-start rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
							<CheckCircle2 size={13} /> Fenêtre complète et à jour
						</div>
					{:else}
						<div class="space-y-1">
							{#each w.completeness.caveats as caveat}
								<div class="inline-flex items-center gap-1.5 self-start rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
									{#if caveat.includes('pas à jour')}
										<Clock size={13} />
									{:else}
										<AlertTriangle size={13} />
									{/if}
									{caveat}
								</div>
							{/each}
							<div class="text-[11px] text-surface-400">
								couverture {(w.completeness.coverage * 100).toFixed(0)} %
							</div>
						</div>
					{/if}

					<!-- KPI courants -->
					<dl class="grid grid-cols-2 gap-2 text-sm">
						<div>
							<dt class="text-xs text-surface-500">Clics</dt>
							<dd class="font-semibold text-surface-900">{fmtInt(w.current?.clicks)}</dd>
						</div>
						<div>
							<dt class="text-xs text-surface-500">Impressions</dt>
							<dd class="font-semibold text-surface-900">{fmtInt(w.current?.impressions)}</dd>
						</div>
						<div>
							<dt class="text-xs text-surface-500">CTR</dt>
							<dd class="font-semibold text-surface-900">{fmtCtr(w.current?.ctr)}</dd>
						</div>
						<div>
							<dt class="text-xs text-surface-500">Position moy.</dt>
							<dd class="font-semibold text-surface-900">{fmtPos(w.current?.position)}</dd>
						</div>
					</dl>

					<!-- Delta vs période précédente (gate de comparabilité) -->
					{#if w.delta.available}
						<div class="border-t border-surface-100 pt-2">
							<div class="mb-1 text-xs text-surface-400">vs période précédente</div>
							<div class="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
								{#each [['Clics', 'clicks', w.delta.clicks], ['Impr.', 'impressions', w.delta.impressions], ['CTR', 'ctr', w.delta.ctr], ['Position', 'position', w.delta.position]] as [label, metric, d]}
									{@const t = trend(metric as 'clicks', (d as { abs: number }).abs)}
									<div class="flex items-center gap-1 {trendClass(t)}">
										{#if t === 'up'}
											<TrendingUp size={12} />
										{:else if t === 'down'}
											<TrendingDown size={12} />
										{:else}
											<Minus size={12} />
										{/if}
										<span class="text-surface-500">{label}</span>
										<span class="font-medium">{fmtPct((d as { pct: number | null }).pct)}</span>
									</div>
								{/each}
							</div>
						</div>
					{:else}
						<div class="border-t border-surface-100 pt-2 text-xs text-surface-400">
							Pas de comparaison : période précédente incomplète (longueurs incompatibles).
						</div>
					{/if}

					<!-- Année N-1 (gate inerte) -->
					<div class="mt-auto text-[11px] text-surface-400">
						{#if yoy && yoy.available}
							N-1 : {fmtInt(yoy.current.clicks)} clics vs {fmtInt(yoy.yearAgo.clicks)}
						{:else}
							Année N-1 : indisponible {#if yoy}({yoy.reason === 'insufficient_current' ? 'historique courant trop court' : 'pas de données il y a un an'}){/if}
						{/if}
					</div>

					{#if w.currentWindow}
						<div class="text-[11px] text-surface-300">
							{fmtDate(w.currentWindow.start)} → {fmtDate(w.currentWindow.end)}
						</div>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
</div>
