<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/utils/dates.js';

	let { data } = $props();

	const TYPES = [
		{ value: '', label: 'Tous types' },
		{ value: 'article', label: 'Articles' },
		{ value: 'linkedin', label: 'LinkedIn' },
		{ value: 'gmb', label: 'GMB' }
	];

	const STATUSES = [
		{ value: '', label: 'Tous statuts' },
		{ value: 'draft', label: 'Draft' },
		{ value: 'review', label: 'Review' },
		{ value: 'approved', label: 'Approved' },
		{ value: 'published', label: 'Published' }
	];

	function applyFilter(key: string, value: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (value) params.set(key, value);
		else params.delete(key);
		goto(`?${params.toString()}`, { replaceState: true });
	}

	let copied = $state(false);
	function copyToken() {
		navigator.clipboard.writeText(data.project.accessToken);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<div>
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div class="flex items-center gap-3">
			<span class="h-4 w-4 rounded-full" style="background-color: {data.project.color};"></span>
			<div>
				<h1 class="text-2xl font-bold text-surface-900">{data.project.name}</h1>
				{#if data.project.description}
					<p class="mt-1 text-sm text-surface-500">{data.project.description}</p>
				{/if}
			</div>
		</div>
		<button onclick={copyToken} class="btn preset-outlined-surface-200 text-xs">
			{copied ? 'Copie !' : 'Copier token client'}
		</button>
	</div>

	<!-- Filters -->
	<div class="mt-6 flex gap-3">
		<select
			class="input preset-outlined-surface-200 w-40 text-sm"
			value={data.filters.type ?? ''}
			onchange={(e) => applyFilter('type', (e.target as HTMLSelectElement).value)}
		>
			{#each TYPES as t}
				<option value={t.value}>{t.label}</option>
			{/each}
		</select>

		<select
			class="input preset-outlined-surface-200 w-40 text-sm"
			value={data.filters.status ?? ''}
			onchange={(e) => applyFilter('status', (e.target as HTMLSelectElement).value)}
		>
			{#each STATUSES as s}
				<option value={s.value}>{s.label}</option>
			{/each}
		</select>

		<span class="self-center text-sm text-surface-400">
			{data.contents.length} contenu{data.contents.length !== 1 ? 's' : ''}
		</span>
	</div>

	<!-- Content table -->
	{#if data.contents.length > 0}
		<div class="mt-4 overflow-hidden rounded-lg border border-surface-200 bg-white">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-surface-100 bg-surface-50 text-left text-xs font-medium uppercase text-surface-500">
						<th class="px-4 py-3">Titre</th>
						<th class="px-4 py-3">Type</th>
						<th class="px-4 py-3">Statut</th>
						<th class="px-4 py-3">Date planifiee</th>
						<th class="px-4 py-3">Cree le</th>
					</tr>
				</thead>
				<tbody>
					{#each data.contents as item}
						<tr class="border-b border-surface-100 transition-colors hover:bg-surface-50">
							<td class="px-4 py-3">
								<a href="/content/{item.id}" class="font-medium text-surface-900 hover:text-primary-600">
									{item.title}
								</a>
							</td>
							<td class="px-4 py-3 text-surface-500">{item.type}</td>
							<td class="px-4 py-3">
								<StatusBadge status={item.status} />
							</td>
							<td class="px-4 py-3 text-surface-400">
								{item.plannedDate ? formatDate(item.plannedDate) : '—'}
							</td>
							<td class="px-4 py-3 text-surface-400">{formatDate(item.createdAt)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<div class="mt-4 rounded-lg border border-dashed border-surface-300 p-12 text-center">
			<p class="text-surface-500">Aucun contenu dans ce projet</p>
		</div>
	{/if}
</div>
