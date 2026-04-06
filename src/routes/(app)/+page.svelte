<script lang="ts">
	import { FileText, Star, Eye, ArrowRight } from 'lucide-svelte';
	import { formatDate } from '$lib/utils/dates.js';
	import { statusConfig, contentTypeConfig } from '$lib/config/design-tokens.js';

	let { data } = $props();

	// Build action items
	let actionItems = $derived(() => {
		const items: Array<{ label: string; detail: string; href: string; color: string; icon: typeof Star }> = [];

		for (const r of data.pendingReviews) {
			items.push({
				label: `${r.count} avis Google en attente`,
				detail: r.projectName ?? '',
				href: `/projects/${r.projectSlug}/reviews`,
				color: r.projectColor ?? '#888',
				icon: Star
			});
		}

		for (const c of data.reviewContents) {
			items.push({
				label: `${c.count} contenu${(c.count ?? 0) > 1 ? 's' : ''} en review`,
				detail: c.projectName ?? '',
				href: `/projects/${c.projectSlug}`,
				color: c.projectColor ?? '#888',
				icon: Eye
			});
		}

		return items;
	});
</script>

<div>
	<!-- Greeting -->
	<h1 class="text-xl font-semibold text-surface-900">Bonjour, {data.user.name}</h1>

	<!-- Stats inline -->
	<div class="mt-4 flex items-center gap-6 rounded-lg border border-surface-200 bg-white px-5 py-3">
		<div class="flex items-center gap-2">
			<span class="text-sm text-surface-500">Contenus</span>
			<span class="text-lg font-semibold text-surface-900">{data.stats.total}</span>
		</div>
		<div class="h-4 w-px bg-surface-200"></div>
		<div class="flex items-center gap-2">
			<span class="h-2 w-2 rounded-full bg-surface-400"></span>
			<span class="text-sm text-surface-500">{data.stats.draft} drafts</span>
		</div>
		<div class="flex items-center gap-2">
			<span class="h-2 w-2 rounded-full bg-amber-500"></span>
			<span class="text-sm text-surface-500">{data.stats.review} en review</span>
		</div>
		<div class="flex items-center gap-2">
			<span class="h-2 w-2 rounded-full bg-emerald-500"></span>
			<span class="text-sm text-surface-500">{data.stats.published} publies</span>
		</div>
	</div>

	<!-- Action items -->
	{#if actionItems().length > 0}
		<div class="mt-6">
			<h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">A faire</h2>
			<div class="rounded-lg border border-surface-200 bg-white divide-y divide-surface-100">
				{#each actionItems() as item}
					<a
						href={item.href}
						class="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-50 group"
					>
						<item.icon size={16} class="flex-shrink-0 text-surface-400" />
						<span class="flex-1 text-sm text-surface-700">{item.label}</span>
						<span class="flex items-center gap-1.5 text-xs text-surface-400">
							<span class="h-2 w-2 rounded-full flex-shrink-0" style="background-color: {item.color};"></span>
							{item.detail}
						</span>
						<ArrowRight size={14} class="text-surface-300 transition-colors group-hover:text-surface-500" />
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Recent activity -->
	<div class="mt-6">
		<h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">Activite recente</h2>
		{#if data.recentContents.length > 0}
			<div class="rounded-lg border border-surface-200 bg-white divide-y divide-surface-100">
				{#each data.recentContents as item}
					{@const typeConfig = contentTypeConfig(item.type)}
					{@const stConfig = statusConfig(item.status)}
					<a
						href="/projects/{item.projectSlug}/content/{item.id}"
						class="flex items-center gap-4 px-4 py-2.5 transition-colors hover:bg-surface-50 group"
					>
						<FileText size={14} class="flex-shrink-0 text-surface-300" />
						<span class="min-w-0 flex-1 truncate text-sm text-surface-700">{item.title}</span>
						<span class="flex-shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium {stConfig.bg} {stConfig.text}">
							{stConfig.label}
						</span>
						<span class="flex flex-shrink-0 items-center gap-1.5 text-xs text-surface-400 whitespace-nowrap">
							<span class="h-2 w-2 rounded-full flex-shrink-0" style="background-color: {item.projectColor};"></span>
							{item.projectName}
						</span>
						<span class="flex-shrink-0 text-xs text-surface-300 whitespace-nowrap">{formatDate(item.createdAt)}</span>
					</a>
				{/each}
			</div>
		{:else}
			<div class="rounded-lg border border-dashed border-surface-200 py-12 text-center">
				<p class="text-sm text-surface-400">Aucun contenu pour le moment</p>
			</div>
		{/if}
	</div>
</div>
