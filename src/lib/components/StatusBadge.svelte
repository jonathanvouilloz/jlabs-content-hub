<script lang="ts">
	import { ChevronDown } from 'lucide-svelte';
	import { STATUS, statusConfig } from '$lib/config/design-tokens.js';

	interface Props {
		status: string;
		interactive?: boolean;
		onchange?: (newStatus: string) => void;
	}

	let { status, interactive = false, onchange }: Props = $props();

	let open = $state(false);

	const config = $derived(statusConfig(status));
	const statuses = Object.keys(STATUS);

	function select(s: string) {
		open = false;
		onchange?.(s);
	}
</script>

<div class="relative inline-block">
	{#if interactive}
		<button
			onclick={() => (open = !open)}
			class="inline-flex items-center gap-1 rounded-md px-2.5 py-0.5 text-xs font-medium {config.bg} {config.text} cursor-pointer hover:opacity-80 transition-opacity"
		>
			{config.label}
			<ChevronDown size={12} />
		</button>

		{#if open}
			<div class="absolute z-10 mt-1 w-32 rounded-md border border-surface-200 bg-white py-1 shadow-lg">
				{#each statuses as s}
					{@const cfg = statusConfig(s)}
					<button
						onclick={() => select(s)}
						class="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-50 transition-colors
							{s === status ? 'font-semibold' : ''}"
					>
						<span class="h-2 w-2 rounded-full {cfg.dot}"></span>
						{cfg.label}
					</button>
				{/each}
			</div>
		{/if}
	{:else}
		<span class="inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-medium {config.bg} {config.text}">
			{config.label}
		</span>
	{/if}
</div>
