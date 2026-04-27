<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { CheckCircle2, XCircle, Clock, RotateCcw } from 'lucide-svelte';
	import { formatDate } from '$lib/utils/dates.js';

	let { data } = $props();

	let success = $state(data.filters.success);
	let locationId = $state(data.filters.locationId);
	let from = $state(data.filters.from);
	let to = $state(data.filters.to);

	function applyFilters() {
		const params = new URLSearchParams();
		if (success !== 'all') params.set('success', success);
		if (locationId) params.set('locationId', locationId);
		if (data.filters.contentId) params.set('contentId', data.filters.contentId);
		if (from) params.set('from', from);
		if (to) params.set('to', to);
		goto(`?${params.toString()}`, { keepFocus: true });
	}

	function resetFilters() {
		success = 'all';
		locationId = '';
		from = '';
		to = '';
		const params = new URLSearchParams();
		if (data.filters.contentId) params.set('contentId', data.filters.contentId);
		goto(`?${params.toString()}`, { keepFocus: true });
	}

	function gotoOffset(newOffset: number) {
		const params = new URLSearchParams(page.url.searchParams);
		if (newOffset === 0) params.delete('offset');
		else params.set('offset', String(newOffset));
		goto(`?${params.toString()}`, { keepFocus: true });
	}

	const successCount = $derived(data.logs.filter((l) => l.success).length);
	const errorCount = $derived(data.logs.filter((l) => !l.success).length);
	const totalPages = $derived(Math.ceil(data.total / data.pageSize));
	const currentPage = $derived(Math.floor(data.offset / data.pageSize) + 1);
</script>

<div class="flex flex-col h-[calc(100vh-73px)] -mx-6 -my-6 lg:-mx-8">
	<!-- Header -->
	<div class="flex-shrink-0 px-6 pt-6 pb-4 lg:px-8">
		<div class="flex items-center justify-between">
			<div>
				<h1 class="text-xl font-semibold text-surface-900">Logs de publication GMB</h1>
				<p class="mt-0.5 text-xs text-surface-400">
					{data.total} log{data.total !== 1 ? 's' : ''}
					{#if data.filters.contentId}
						<span class="ml-1">— filtré sur 1 post</span>
						<a href="?" class="ml-1 text-primary-600 hover:underline">tout voir</a>
					{/if}
				</p>
			</div>
			<a
				href="/projects/{data.project.slug}/gmb"
				class="rounded-md border border-surface-200 bg-white px-3 py-1.5 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50"
			>
				← Retour aux posts
			</a>
		</div>
	</div>

	<!-- Filters -->
	<div class="flex-shrink-0 px-6 lg:px-8 pb-4">
		<div class="flex flex-wrap items-end gap-3 rounded-lg border border-surface-200 bg-surface-50 p-3">
			<div class="flex flex-col gap-1">
				<label for="filter-success" class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Statut</label>
				<select
					id="filter-success"
					bind:value={success}
					class="rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-xs text-surface-900"
				>
					<option value="all">Tous</option>
					<option value="true">Succès</option>
					<option value="false">Erreurs</option>
				</select>
			</div>

			<div class="flex flex-col gap-1">
				<label for="filter-loc" class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Location</label>
				<select
					id="filter-loc"
					bind:value={locationId}
					class="rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-xs text-surface-900"
				>
					<option value="">Toutes</option>
					{#each data.locations as loc (loc.id)}
						<option value={loc.gmbLocationId}>{loc.label}</option>
					{/each}
				</select>
			</div>

			<div class="flex flex-col gap-1">
				<label for="filter-from" class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Du</label>
				<input
					id="filter-from"
					type="date"
					bind:value={from}
					class="rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-xs text-surface-900"
				/>
			</div>

			<div class="flex flex-col gap-1">
				<label for="filter-to" class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Au</label>
				<input
					id="filter-to"
					type="date"
					bind:value={to}
					class="rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-xs text-surface-900"
				/>
			</div>

			<button
				onclick={applyFilters}
				class="rounded-md bg-primary-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-600"
			>
				Appliquer
			</button>
			<button
				onclick={resetFilters}
				class="flex items-center gap-1 rounded-md border border-surface-200 bg-white px-3 py-1.5 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50"
			>
				<RotateCcw class="h-3 w-3" />
				Reset
			</button>

			<div class="ml-auto flex items-center gap-3 text-xs text-surface-500">
				<span class="flex items-center gap-1"><CheckCircle2 class="h-3.5 w-3.5 text-emerald-500" /> {successCount}</span>
				<span class="flex items-center gap-1"><XCircle class="h-3.5 w-3.5 text-red-500" /> {errorCount}</span>
			</div>
		</div>
	</div>

	<!-- Table -->
	<div class="flex-1 overflow-y-auto px-6 lg:px-8 pb-6">
		{#if data.logs.length === 0}
			<div class="flex flex-col items-center justify-center py-16 text-center">
				<Clock class="h-10 w-10 text-surface-300" />
				<p class="mt-3 text-sm text-surface-500">Aucun log pour ces filtres.</p>
			</div>
		{:else}
			<div class="overflow-x-auto rounded-lg border border-surface-200 bg-white">
				<table class="w-full text-xs">
					<thead class="bg-surface-50 text-left text-[10px] font-semibold uppercase tracking-wider text-surface-500">
						<tr>
							<th class="px-3 py-2">Date</th>
							<th class="px-3 py-2">Statut</th>
							<th class="px-3 py-2">Post</th>
							<th class="px-3 py-2">Location</th>
							<th class="px-3 py-2">Source</th>
							<th class="px-3 py-2">Durée</th>
							<th class="px-3 py-2">Détail</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-surface-100">
						{#each data.logs as log (log.id)}
							<tr class="hover:bg-surface-50">
								<td class="px-3 py-2 text-surface-600 whitespace-nowrap">{formatDate(log.attemptedAt)}</td>
								<td class="px-3 py-2">
									{#if log.success}
										<span class="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
											<CheckCircle2 class="h-3 w-3" /> OK
										</span>
									{:else}
										<span class="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">
											<XCircle class="h-3 w-3" /> Erreur
										</span>
									{/if}
								</td>
								<td class="px-3 py-2">
									<a
										href="/projects/{data.project.slug}/content/{log.contentId}"
										class="text-surface-900 hover:text-primary-600 hover:underline"
									>
										{log.contentTitle ?? log.contentId.slice(0, 8)}
									</a>
								</td>
								<td class="px-3 py-2 text-surface-600">{log.locationLabel ?? '—'}</td>
								<td class="px-3 py-2 text-surface-500">{log.source}</td>
								<td class="px-3 py-2 text-surface-500 whitespace-nowrap">
									{log.durationMs != null ? `${log.durationMs} ms` : '—'}
								</td>
								<td class="px-3 py-2 text-surface-600 max-w-md">
									{#if log.errorMessage}
										<span class="block truncate text-red-600" title={log.errorMessage}>{log.errorMessage}</span>
									{:else if log.gmbPostId}
										<span class="block truncate font-mono text-[10px] text-surface-400" title={log.gmbPostId}>{log.gmbPostId}</span>
									{:else}
										—
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<!-- Pagination -->
			{#if totalPages > 1}
				<div class="mt-4 flex items-center justify-between text-xs text-surface-500">
					<span>Page {currentPage} / {totalPages}</span>
					<div class="flex items-center gap-2">
						<button
							onclick={() => gotoOffset(Math.max(0, data.offset - data.pageSize))}
							disabled={data.offset === 0}
							class="rounded-md border border-surface-200 bg-white px-2.5 py-1 font-medium text-surface-600 transition-colors hover:bg-surface-50 disabled:opacity-40"
						>
							← Précédent
						</button>
						<button
							onclick={() => gotoOffset(data.offset + data.pageSize)}
							disabled={data.offset + data.pageSize >= data.total}
							class="rounded-md border border-surface-200 bg-white px-2.5 py-1 font-medium text-surface-600 transition-colors hover:bg-surface-50 disabled:opacity-40"
						>
							Suivant →
						</button>
					</div>
				</div>
			{/if}
		{/if}
	</div>
</div>
