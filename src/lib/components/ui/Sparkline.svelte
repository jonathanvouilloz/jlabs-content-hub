<script lang="ts">
	interface Props {
		points: number[];
		width?: number;
		height?: number;
		color?: string;
		fillOpacity?: number;
	}

	let { points, width = 100, height = 24, color = 'currentColor', fillOpacity = 0.15 }: Props = $props();

	const path = $derived.by(() => {
		if (points.length === 0) return { line: '', area: '' };
		const max = Math.max(...points, 1);
		const min = Math.min(...points, 0);
		const range = max - min || 1;
		const stepX = points.length > 1 ? width / (points.length - 1) : 0;
		const coords = points.map((v, i) => {
			const x = i * stepX;
			const y = height - ((v - min) / range) * height;
			return { x, y };
		});
		const line = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
		const area = `${line} L${coords[coords.length - 1].x.toFixed(1)},${height} L0,${height} Z`;
		return { line, area };
	});
</script>

<svg viewBox="0 0 {width} {height}" preserveAspectRatio="none" class="block h-6 w-full" aria-hidden="true">
	{#if points.length > 1}
		<path d={path.area} fill={color} opacity={fillOpacity} />
		<path d={path.line} fill="none" stroke={color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
	{/if}
</svg>
