<script lang="ts">
	import { statusConfig } from '$lib/config/design-tokens.js';

	interface Props {
		status?: string;
		label?: string;
		bg?: string;
		text?: string;
		dot?: boolean;
	}

	let { status, label, bg, text, dot = false }: Props = $props();

	const resolved = $derived(() => {
		if (status) {
			const cfg = statusConfig(status);
			return { label: label ?? cfg.label, bg: cfg.bg, text: cfg.text, dot: cfg.dot };
		}
		return {
			label: label ?? '',
			bg: bg ?? 'bg-surface-100',
			text: text ?? 'text-surface-600',
			dot: 'bg-surface-400'
		};
	});
</script>

<span class="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium {resolved().bg} {resolved().text}">
	{#if dot}
		<span class="h-1.5 w-1.5 rounded-full {resolved().dot}"></span>
	{/if}
	{resolved().label}
</span>
