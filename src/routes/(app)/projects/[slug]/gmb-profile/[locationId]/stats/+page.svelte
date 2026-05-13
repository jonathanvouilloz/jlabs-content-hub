<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { Eye, MousePointerClick, Phone, Navigation, TrendingUp, TrendingDown, Minus } from 'lucide-svelte';
	import TimeChart from '$lib/components/ui/TimeChart.svelte';

	let { data } = $props();

	function fmt(n: number): string {
		if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
		return n.toString();
	}

	function diffPct(current: number, previous: number): { value: number; label: string } | null {
		if (previous === 0) {
			if (current === 0) return null;
			return { value: 100, label: '+100%' };
		}
		const pct = ((current - previous) / previous) * 100;
		const sign = pct > 0 ? '+' : '';
		return { value: pct, label: `${sign}${pct.toFixed(0)}%` };
	}

	const tabs = [
		{ key: '30d', label: '30 derniers jours' },
		{ key: 'month', label: 'Mois en cours' },
		{ key: 'year', label: 'Année en cours' }
	];

	function setPeriod(key: string) {
		const url = new URL($page.url);
		url.searchParams.set('period', key);
		goto(url.toString(), { keepFocus: true, replaceState: true });
	}

	const cards = $derived([
		{
			label: 'Vues totales',
			value: data.totals.impressions.current,
			previous: data.totals.impressions.previous,
			Icon: Eye,
			color: 'text-indigo-600',
			fill: 'bg-indigo-50'
		},
		{
			label: 'Clics site',
			value: data.totals.websiteClicks.current,
			previous: data.totals.websiteClicks.previous,
			Icon: MousePointerClick,
			color: 'text-emerald-600',
			fill: 'bg-emerald-50'
		},
		{
			label: 'Itinéraires',
			value: data.totals.directionRequests.current,
			previous: data.totals.directionRequests.previous,
			Icon: Navigation,
			color: 'text-amber-600',
			fill: 'bg-amber-50'
		},
		{
			label: 'Appels',
			value: data.totals.callClicks.current,
			previous: data.totals.callClicks.previous,
			Icon: Phone,
			color: 'text-rose-600',
			fill: 'bg-rose-50'
		}
	]);

	function fmtRange(start: string, end: string): string {
		const fmtOne = (iso: string) => {
			const [y, m, d] = iso.split('-');
			return `${d}/${m}/${y}`;
		};
		return `${fmtOne(start)} → ${fmtOne(end)}`;
	}
</script>

<!-- Tabs -->
<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
	<div class="inline-flex rounded-md border border-surface-200 bg-white p-0.5">
		{#each tabs as tab}
			<button
				onclick={() => setPeriod(tab.key)}
				class="rounded-md px-3 py-1 text-xs font-medium transition-colors
					{data.period === tab.key ? 'bg-surface-100 text-surface-900' : 'text-surface-500 hover:text-surface-900'}"
			>
				{tab.label}
			</button>
		{/each}
	</div>
	<div class="text-xs text-surface-500">
		{fmtRange(data.range.start, data.range.end)}
		<span class="text-surface-300"> · vs {fmtRange(data.previousRange.start, data.previousRange.end)}</span>
	</div>
</div>

<!-- KPI cards -->
<div class="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
	{#each cards as card}
		{@const d = diffPct(card.value, card.previous)}
		<div class="rounded-lg border border-surface-200 bg-white p-4">
			<div class="mb-2 flex items-center justify-between">
				<div class="flex items-center gap-2">
					<div class="flex h-7 w-7 items-center justify-center rounded-md {card.fill}">
						<card.Icon size={14} class={card.color} />
					</div>
					<span class="text-xs font-medium uppercase tracking-wide text-surface-500">{card.label}</span>
				</div>
				{#if d}
					<span class="inline-flex items-center gap-0.5 text-[11px] font-medium {d.value > 0 ? 'text-emerald-600' : d.value < 0 ? 'text-rose-600' : 'text-surface-400'}">
						{#if d.value > 0}
							<TrendingUp size={10} />
						{:else if d.value < 0}
							<TrendingDown size={10} />
						{:else}
							<Minus size={10} />
						{/if}
						{d.label}
					</span>
				{/if}
			</div>
			<div class="text-2xl font-semibold text-surface-900">{fmt(card.value)}</div>
			<div class="mt-0.5 text-xs text-surface-400">vs {fmt(card.previous)} sur la période précédente</div>
		</div>
	{/each}
</div>

{#if !data.hasInsights}
	<div class="rounded-lg border border-dashed border-surface-200 bg-surface-50 p-6 text-center text-sm text-surface-500">
		Aucune donnée pour la période sélectionnée. Cliquez sur "Resynchroniser" en haut pour récupérer les données depuis Google.
	</div>
{:else}
	<!-- Impressions chart -->
	<div class="mb-5 rounded-lg border border-surface-200 bg-white p-5">
		<h2 class="mb-3 text-sm font-semibold text-surface-900">Vues par canal</h2>
		<TimeChart
			labels={data.labels}
			series={data.impressionSeries}
			mode="area-stacked"
		/>
	</div>

	<!-- Actions chart -->
	<div class="rounded-lg border border-surface-200 bg-white p-5">
		<h2 class="mb-3 text-sm font-semibold text-surface-900">Actions des clients</h2>
		<TimeChart
			labels={data.labels}
			series={data.actionsSeries}
			mode="line"
		/>
	</div>
{/if}
