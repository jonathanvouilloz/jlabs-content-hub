<script lang="ts">
	import { Search, Sparkles } from 'lucide-svelte';
	import { formatDate } from '$lib/utils/dates.js';

	let { data } = $props();

	let typeFilter = $state<'all' | string>('article');

	let filtered = $derived(
		typeFilter === 'all' ? data.items : data.items.filter((i) => i.type === typeFilter)
	);

	const statusColor: Record<string, string> = {
		draft: 'bg-surface-100 text-surface-600',
		review: 'bg-amber-100 text-amber-700',
		review_fail: 'bg-orange-100 text-orange-700',
		approved: 'bg-sky-100 text-sky-700',
		published: 'bg-emerald-100 text-emerald-700',
		writing: 'bg-indigo-100 text-indigo-700',
		needs_human: 'bg-rose-100 text-rose-700'
	};

	function report(contentId: string, type: string) {
		return data.reportsByContent[contentId]?.[type];
	}

	const brandEntries = $derived(Object.entries(data.brandVisibilityByProject));
</script>

<div>
	<!-- Header -->
	<div class="flex items-center gap-2">
		<Search size={20} class="text-surface-500" />
		<h1 class="text-xl font-semibold text-surface-900">SEO — vue cross-projet</h1>
	</div>
	<p class="mt-1 text-sm text-surface-500">
		Tous les contenus produits, tous projets, avec leurs rapports concurrence / backlinks / visibilité IA.
	</p>

	<!-- Visibilité IA par marque -->
	{#if brandEntries.length > 0}
		<div class="mt-4 rounded-lg border border-surface-200 bg-white px-5 py-3">
			<div class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-surface-400">
				<Sparkles size={13} /> Visibilité IA par marque
			</div>
			<div class="flex flex-wrap items-center gap-4">
				{#each brandEntries as [slug, v]}
					<div class="flex items-center gap-2">
						<span class="text-sm font-medium text-surface-700">{slug}</span>
						<span class="rounded bg-primary-50 px-2 py-0.5 text-sm font-semibold text-primary-600">
							{v.score ?? '—'}/100
						</span>
						<span class="text-xs text-surface-400">{v.createdAt ? formatDate(v.createdAt) : ''}</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Type filter -->
	<div class="mt-4 flex items-center gap-1.5">
		<button
			class="rounded-md px-2.5 py-1 text-sm font-medium transition-colors
				{typeFilter === 'all' ? 'bg-surface-900 text-white' : 'bg-surface-100 text-surface-600 hover:bg-surface-200'}"
			onclick={() => (typeFilter = 'all')}
		>
			Tous ({data.items.length})
		</button>
		{#each data.types as t}
			<button
				class="rounded-md px-2.5 py-1 text-sm font-medium transition-colors
					{typeFilter === t ? 'bg-surface-900 text-white' : 'bg-surface-100 text-surface-600 hover:bg-surface-200'}"
				onclick={() => (typeFilter = t)}
			>
				{t} ({data.items.filter((i) => i.type === t).length})
			</button>
		{/each}
	</div>

	<!-- Table -->
	<div class="mt-4 overflow-x-auto rounded-lg border border-surface-200 bg-white">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-surface-100 text-left text-xs text-surface-400">
					<th class="px-4 py-2 font-medium">Projet</th>
					<th class="px-4 py-2 font-medium">Contenu</th>
					<th class="px-4 py-2 font-medium">Type</th>
					<th class="px-4 py-2 font-medium">Statut</th>
					<th class="px-4 py-2 font-medium">Concurrence</th>
					<th class="px-4 py-2 font-medium">Backlinks</th>
					<th class="px-4 py-2 font-medium">Visibilité IA</th>
					<th class="px-4 py-2 font-medium">Créé</th>
				</tr>
			</thead>
			<tbody>
				{#each filtered as item (item.id)}
					<tr class="border-b border-surface-50 last:border-0 hover:bg-surface-50">
						<td class="px-4 py-2">
							<span class="inline-flex items-center gap-1.5">
								<span class="h-2 w-2 rounded-full" style="background:{item.projectColor ?? '#888'}"></span>
								<span class="text-surface-600">{item.projectName ?? item.projectSlug}</span>
							</span>
						</td>
						<td class="px-4 py-2">
							<div class="font-medium text-surface-900">{item.title}</div>
							<div class="text-xs text-surface-400">{item.slug}</div>
						</td>
						<td class="px-4 py-2 text-surface-500">{item.type}</td>
						<td class="px-4 py-2">
							<span class="rounded px-1.5 py-0.5 text-xs font-medium {statusColor[item.status] ?? 'bg-surface-100 text-surface-600'}">
								{item.status}
							</span>
						</td>
						<!-- Concurrence -->
						<td class="px-4 py-2 text-surface-500">
							{#if report(item.id, 'competitor')}
								<span title={report(item.id, 'competitor')?.target ?? ''}>
									{report(item.id, 'competitor')?.target ?? '✓'}
								</span>
							{:else}<span class="text-surface-300">—</span>{/if}
						</td>
						<!-- Backlinks -->
						<td class="px-4 py-2 text-surface-500">
							{#if report(item.id, 'backlink')}
								{report(item.id, 'backlink')?.score ?? '✓'}
							{:else}<span class="text-surface-300">—</span>{/if}
						</td>
						<!-- Visibilité IA (article) -->
						<td class="px-4 py-2">
							{#if report(item.id, 'ai_visibility')}
								<span class="rounded bg-primary-50 px-1.5 py-0.5 text-xs font-semibold text-primary-600">
									{report(item.id, 'ai_visibility')?.score ?? '—'}/100
								</span>
							{:else}<span class="text-surface-300">—</span>{/if}
						</td>
						<td class="px-4 py-2 text-xs text-surface-400">{formatDate(item.createdAt)}</td>
					</tr>
				{/each}
				{#if filtered.length === 0}
					<tr>
						<td colspan="8" class="px-4 py-8 text-center text-surface-400">Aucun contenu pour ce filtre.</td>
					</tr>
				{/if}
			</tbody>
		</table>
	</div>
</div>
