<script lang="ts">
	const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
		draft: { label: 'Draft', bg: 'bg-gray-100', text: 'text-gray-600' },
		review: { label: 'Review', bg: 'bg-amber-100', text: 'text-amber-700' },
		approved: { label: 'Approved', bg: 'bg-blue-100', text: 'text-blue-700' },
		published: { label: 'Published', bg: 'bg-emerald-100', text: 'text-emerald-700' }
	};

	interface Props {
		status: string;
		interactive?: boolean;
		onchange?: (newStatus: string) => void;
	}

	let { status, interactive = false, onchange }: Props = $props();

	let open = $state(false);

	const config = $derived(STATUS_CONFIG[status] ?? STATUS_CONFIG.draft);
	const statuses = Object.keys(STATUS_CONFIG);

	function select(s: string) {
		open = false;
		onchange?.(s);
	}
</script>

<div class="relative inline-block">
	{#if interactive}
		<button
			onclick={() => (open = !open)}
			class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium {config.bg} {config.text} cursor-pointer hover:opacity-80 transition-opacity"
		>
			{config.label}
			<svg class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
			</svg>
		</button>

		{#if open}
			<div class="absolute z-10 mt-1 w-32 rounded-lg border border-surface-200 bg-white py-1 shadow-lg">
				{#each statuses as s}
					<button
						onclick={() => select(s)}
						class="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-50 transition-colors
							{s === status ? 'font-semibold' : ''}"
					>
						<span class="h-2 w-2 rounded-full {STATUS_CONFIG[s].bg}"></span>
						{STATUS_CONFIG[s].label}
					</button>
				{/each}
			</div>
		{/if}
	{:else}
		<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium {config.bg} {config.text}">
			{config.label}
		</span>
	{/if}
</div>
