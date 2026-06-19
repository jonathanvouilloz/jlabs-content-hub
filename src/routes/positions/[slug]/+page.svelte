<script lang="ts">
	import { TrendingUp, TrendingDown, Minus, HelpCircle, Target, Download } from 'lucide-svelte';
	import Sparkline from '$lib/components/ui/Sparkline.svelte';
	import TimeChart from '$lib/components/ui/TimeChart.svelte';

	let { data } = $props();

	type WeekPoint = { weekStart: string; position: number | null; clicks: number; impressions: number; ctr: number; topPage: string | null; primaryPosition: number | null; primaryPage: string | null };
	type Trend = { verdict: 'up' | 'down' | 'flat' | 'insufficient'; deltaPosition: number | null; currentPosition: number | null; vsTarget?: { targetPosition: number; reached: boolean; gap: number } };

	const safeColor = $derived(/^#[0-9a-fA-F]{6}$/.test(data.project.color) ? data.project.color : '#4f46e5');
	const exportHref = $derived(`/api/projects/${data.project.slug}/keywords/export?token=${encodeURIComponent(data.token)}`);

	let expanded = $state<string | null>(null);

	function fmtPos(p: number | null): string {
		return p == null ? '—' : p.toFixed(1);
	}
	function sparkPoints(series: WeekPoint[]): number[] {
		return series.filter((p) => p.position !== null).map((p) => -(p.position as number));
	}
	function lineSeries(series: WeekPoint[]): number[] {
		const first = series.find((p) => p.position !== null)?.position ?? 0;
		let last = first;
		return series.map((p) => {
			if (p.position !== null) last = p.position;
			return last;
		});
	}
	function verdictMeta(t: Trend) {
		switch (t.verdict) {
			case 'up': return { icon: TrendingUp, label: 'Progresse', cls: 'color:#059669;background:#ecfdf5' };
			case 'down': return { icon: TrendingDown, label: 'Recule', cls: 'color:#e11d48;background:#fff1f2' };
			case 'flat': return { icon: Minus, label: 'Stable', cls: 'color:#64748b;background:#f1f5f9' };
			default: return { icon: HelpCircle, label: 'Données insuffisantes', cls: 'color:#d97706;background:#fffbeb' };
		}
	}
</script>

<svelte:head><title>Positions — {data.project.name}</title><meta name="robots" content="noindex" /></svelte:head>

<div style="min-height:100vh;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
	<div style="max-width:880px;margin:0 auto;padding:0 16px 48px">
		<header style="background:{safeColor};color:white;padding:28px 24px;border-radius:0 0 12px 12px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">
			<div>
				<h1 style="margin:0;font-size:20px;font-weight:700">Positions Google — {data.project.name}</h1>
				<p style="margin:4px 0 0;opacity:.9;font-size:13px">Suivi de vos mots-clés dans le temps · tendance, pas un rang exact</p>
			</div>
			{#if data.keywords.length > 0}
				<a href={exportHref} style="display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.18);color:white;padding:8px 14px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">
					<Download size={15} /> Export CSV
				</a>
			{/if}
		</header>

		<main style="margin-top:24px">
			{#if !data.hasGsc || data.keywords.length === 0}
				<div style="background:white;border:1px solid #e2e8f0;border-radius:12px;padding:32px;text-align:center;color:#94a3b8;font-size:14px">
					Aucune position suivie pour le moment.
				</div>
			{:else}
				<div style="background:white;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
					<table style="width:100%;border-collapse:collapse;font-size:14px">
						<thead>
							<tr style="background:#f8fafc;color:#64748b;font-size:12px;text-align:left">
								<th style="padding:10px 16px;font-weight:600">Mot-clé</th>
								<th style="padding:10px 16px;font-weight:600">Position</th>
								<th style="padding:10px 16px;font-weight:600">Objectif</th>
								<th style="padding:10px 16px;font-weight:600">Tendance (12 sem.)</th>
							</tr>
						</thead>
						<tbody>
							{#each data.keywords as kw (kw.id)}
								{@const vm = verdictMeta(kw.trend)}
								<tr style="border-top:1px solid #f1f5f9;cursor:pointer" onclick={() => (expanded = expanded === kw.id ? null : kw.id)}>
									<td style="padding:12px 16px;font-weight:600;color:#0f172a">{kw.keyword}</td>
									<td style="padding:12px 16px;font-variant-numeric:tabular-nums">{fmtPos(kw.currentPosition)}</td>
									<td style="padding:12px 16px;color:#64748b;font-variant-numeric:tabular-nums">
										{#if kw.targetPosition != null}
											<span style="display:inline-flex;align-items:center;gap:4px"><Target size={12} />{kw.targetPosition}{#if kw.trend.vsTarget?.reached}<span style="color:#059669"> ✓</span>{/if}</span>
										{:else}—{/if}
									</td>
									<td style="padding:12px 16px">
										<div style="display:flex;align-items:center;gap:10px">
											<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:12px;{vm.cls}"><vm.icon size={12} />{vm.label}</span>
											<span style="width:90px;color:{safeColor}"><Sparkline points={sparkPoints(kw.series)} color="currentColor" /></span>
										</div>
									</td>
								</tr>
								{#if expanded === kw.id}
									<tr style="background:#fbfcfe"><td colspan="4" style="padding:16px">
										<p style="margin:0 0 8px;font-size:12px;color:#64748b">Position sur 12 semaines (plus bas = mieux)</p>
										<TimeChart labels={kw.series.map((p) => p.weekStart)} series={[{ label: kw.keyword, color: safeColor, points: lineSeries(kw.series) }]} height={180} showLegend={false} />
									</td></tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
				<p style="margin:20px 4px 0;color:#94a3b8;font-size:11px">
					La position affichée est la meilleure position de vos pages sur ce mot-clé (source : Google Search Console, ~3 j de latence). À lire comme une tendance. · Suivi par jlabs-content-hub
				</p>
			{/if}
		</main>
	</div>
</div>
