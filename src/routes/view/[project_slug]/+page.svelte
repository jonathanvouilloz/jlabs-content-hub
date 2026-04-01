<script lang="ts">
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/utils/dates.js';

	let { data } = $props();

	const TYPE_LABELS: Record<string, string> = {
		article: 'Article',
		linkedin: 'LinkedIn',
		gmb: 'GMB'
	};
</script>

<div>
	<!-- Project header -->
	<div class="flex items-center gap-3">
		<span class="h-4 w-4 rounded-full" style="background-color: {data.project.color};"></span>
		<h1 class="text-2xl font-bold text-surface-900">{data.project.name}</h1>
	</div>
	<p class="mt-1 text-sm text-surface-500">
		{data.contents.length} contenu{data.contents.length !== 1 ? 's' : ''}
	</p>

	<!-- Content list -->
	{#if data.contents.length > 0}
		<div class="mt-6 space-y-3">
			{#each data.contents as item}
				<a
					href="/view/{data.project.slug}/{item.id}?token={data.token}"
					class="block rounded-lg border border-surface-200 bg-white p-4 transition-shadow hover:shadow-md"
				>
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0 flex-1">
							<h3 class="truncate font-medium text-surface-900">{item.title}</h3>
							<div class="mt-1.5 flex flex-wrap items-center gap-2">
								<span class="text-xs text-surface-400">{TYPE_LABELS[item.type] ?? item.type}</span>
								{#if item.plannedDate}
									<span class="text-xs text-surface-400">{formatDate(item.plannedDate)}</span>
								{/if}
							</div>
						</div>
						<StatusBadge status={item.status} />
					</div>
				</a>
			{/each}
		</div>
	{:else}
		<div class="mt-6 rounded-lg border border-dashed border-surface-300 p-12 text-center">
			<p class="text-surface-500">Aucun contenu disponible pour le moment.</p>
		</div>
	{/if}
</div>
