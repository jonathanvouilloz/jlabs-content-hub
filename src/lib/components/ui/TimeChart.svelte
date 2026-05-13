<script lang="ts">
	interface Series {
		label: string;
		color: string;
		points: number[];
	}

	interface Props {
		labels: string[];
		series: Series[];
		mode?: 'line' | 'area-stacked';
		height?: number;
		showLegend?: boolean;
	}

	let { labels, series, mode = 'line', height = 220, showLegend = true }: Props = $props();

	const PADDING = { top: 12, right: 12, bottom: 28, left: 36 };
	const W = 800;

	const stacked = $derived.by(() => {
		if (mode !== 'area-stacked') return null;
		const n = labels.length;
		const layers: number[][] = [];
		const cumulative = new Array(n).fill(0);
		for (const s of series) {
			const layer = s.points.map((v, i) => {
				const start = cumulative[i];
				cumulative[i] = start + v;
				return start;
			});
			layers.push(layer);
		}
		return { layers, totals: cumulative };
	});

	const maxValue = $derived.by(() => {
		if (mode === 'area-stacked' && stacked) {
			return Math.max(1, ...stacked.totals);
		}
		const all = series.flatMap((s) => s.points);
		return Math.max(1, ...all);
	});

	const innerW = W - PADDING.left - PADDING.right;
	const innerH = $derived(height - PADDING.top - PADDING.bottom);

	function xAt(i: number, n: number): number {
		if (n <= 1) return PADDING.left;
		return PADDING.left + (i / (n - 1)) * innerW;
	}
	function yAt(v: number): number {
		return PADDING.top + innerH - (v / maxValue) * innerH;
	}

	function buildLine(points: number[]): string {
		return points
			.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i, points.length).toFixed(1)},${yAt(v).toFixed(1)}`)
			.join(' ');
	}

	function buildArea(points: number[], baseline: number[]): string {
		const top = points.map((v, i) => `L${xAt(i, points.length).toFixed(1)},${yAt(v + baseline[i]).toFixed(1)}`).join(' ');
		const bottom = points
			.map((_, i) => {
				const idx = points.length - 1 - i;
				return `L${xAt(idx, points.length).toFixed(1)},${yAt(baseline[idx]).toFixed(1)}`;
			})
			.join(' ');
		const startX = xAt(0, points.length).toFixed(1);
		const startY = yAt(baseline[0]).toFixed(1);
		return `M${startX},${startY} ${top} ${bottom} Z`;
	}

	function niceTicks(max: number): number[] {
		if (max <= 5) return [0, max];
		const exp = Math.floor(Math.log10(max));
		const step = Math.pow(10, exp);
		const m = Math.ceil(max / step) * step;
		const out: number[] = [];
		for (let v = 0; v <= m; v += step / 2) out.push(v);
		return out.filter((v) => v <= max + step / 4).slice(0, 6);
	}

	const yTicks = $derived(niceTicks(maxValue));

	function fmtTick(v: number): string {
		if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
		return v.toString();
	}

	function xLabel(i: number): string {
		const iso = labels[i];
		if (!iso) return '';
		const [, m, d] = iso.split('-');
		return `${d}/${m}`;
	}

	const xLabelIndexes = $derived.by(() => {
		const n = labels.length;
		if (n === 0) return [];
		if (n <= 6) return labels.map((_, i) => i);
		// 5 ticks: first, last, evenly spaced
		const out: number[] = [];
		for (let t = 0; t < 5; t++) out.push(Math.round((t * (n - 1)) / 4));
		return [...new Set(out)];
	});
</script>

<div class="w-full">
	<svg viewBox="0 0 {W} {height}" preserveAspectRatio="none" class="block h-auto w-full" aria-hidden="true">
		<!-- Y grid + ticks -->
		{#each yTicks as t}
			<line x1={PADDING.left} x2={W - PADDING.right} y1={yAt(t)} y2={yAt(t)} stroke="#e2e8f0" stroke-width="1" />
			<text x={PADDING.left - 4} y={yAt(t) + 3} text-anchor="end" font-size="10" fill="#94a3b8">{fmtTick(t)}</text>
		{/each}

		<!-- X labels -->
		{#each xLabelIndexes as i}
			<text x={xAt(i, labels.length)} y={height - PADDING.bottom + 14} text-anchor="middle" font-size="10" fill="#94a3b8">
				{xLabel(i)}
			</text>
		{/each}

		{#if mode === 'area-stacked' && stacked}
			{#each series as s, idx}
				<path d={buildArea(s.points, stacked.layers[idx])} fill={s.color} opacity="0.55" />
			{/each}
			{#each series as s, idx}
				{@const sumLine = s.points.map((v, i) => v + stacked.layers[idx][i])}
				<path d={buildLine(sumLine)} fill="none" stroke={s.color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
			{/each}
		{:else}
			{#each series as s}
				<path d={buildLine(s.points)} fill="none" stroke={s.color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
			{/each}
		{/if}
	</svg>

	{#if showLegend}
		<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
			{#each series as s}
				<span class="inline-flex items-center gap-1.5 text-surface-600">
					<span class="h-2 w-2 rounded-full" style="background-color: {s.color}"></span>
					{s.label}
				</span>
			{/each}
		</div>
	{/if}
</div>
