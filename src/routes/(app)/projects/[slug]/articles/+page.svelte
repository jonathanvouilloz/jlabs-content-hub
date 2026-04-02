<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import ContentTable from '$lib/components/ContentTable.svelte';

	let { data } = $props();

	const STATUSES = [
		{ value: '', label: 'Tous statuts' },
		{ value: 'draft', label: 'Draft' },
		{ value: 'review', label: 'Review' },
		{ value: 'approved', label: 'Approved' },
		{ value: 'published', label: 'Published' }
	];

	let statusFilter = $derived($page.url.searchParams.get('status') ?? '');

	let filteredContents = $derived(
		statusFilter
			? data.contents.filter((c: { status: string }) => c.status === statusFilter)
			: data.contents
	);

	function applyFilter(value: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (value) params.set('status', value);
		else params.delete('status');
		goto(`?${params.toString()}`, { replaceState: true });
	}
</script>

<div>
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-surface-900">Articles</h1>
		<div class="flex items-center gap-3">
			<select
				class="input preset-outlined-surface-200 w-40 text-sm"
				value={statusFilter}
				onchange={(e) => applyFilter((e.target as HTMLSelectElement).value)}
			>
				{#each STATUSES as s}
					<option value={s.value}>{s.label}</option>
				{/each}
			</select>
			<span class="text-sm text-surface-400">
				{filteredContents.length} article{filteredContents.length !== 1 ? 's' : ''}
			</span>
		</div>
	</div>

	<div class="mt-4">
		<ContentTable contents={filteredContents} showType={false} showBatchActions={true} />
	</div>
</div>
