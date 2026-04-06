<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ChevronLeft, ChevronRight } from 'lucide-svelte';
	import CalendarGrid from '$lib/components/CalendarGrid.svelte';
	import ContentCard from '$lib/components/ContentCard.svelte';

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

	let view = $state<'calendar' | 'list'>('calendar');

	const monthLabel = $derived(
		new Intl.DateTimeFormat('fr-CH', { month: 'long', year: 'numeric' }).format(
			new Date(data.year, data.month - 1)
		)
	);

	function applyFilter(key: string, value: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (value) params.set(key, value);
		else params.delete(key);
		goto(`?${params.toString()}`, { replaceState: true });
	}

	function navigateMonth(delta: number) {
		let m = data.month + delta;
		let y = data.year;
		if (m < 1) { m = 12; y--; }
		if (m > 12) { m = 1; y++; }
		applyFilter('month', `${y}-${String(m).padStart(2, '0')}`);
	}

	const selectClass = 'rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-xs text-surface-600 outline-none';
</script>

<div>
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-xl font-semibold text-surface-900">Calendrier</h1>
		<div class="flex items-center gap-1">
			<button
				onclick={() => navigateMonth(-1)}
				class="rounded-md border border-surface-200 bg-white p-1.5 text-surface-500 transition-colors hover:bg-surface-50"
				aria-label="Mois precedent"
			>
				<ChevronLeft size={16} />
			</button>
			<span class="min-w-36 text-center text-sm font-semibold capitalize text-surface-700">
				{monthLabel}
			</span>
			<button
				onclick={() => navigateMonth(1)}
				class="rounded-md border border-surface-200 bg-white p-1.5 text-surface-500 transition-colors hover:bg-surface-50"
				aria-label="Mois suivant"
			>
				<ChevronRight size={16} />
			</button>
		</div>
	</div>

	<!-- Filters + View toggle -->
	<div class="mt-4 flex flex-wrap items-center gap-2">
		<select
			class="{selectClass} w-40"
			value={data.filters.project ?? ''}
			onchange={(e) => applyFilter('project', (e.target as HTMLSelectElement).value)}
		>
			<option value="">Tous projets</option>
			{#each data.projects as p}
				<option value={p.id}>{p.name}</option>
			{/each}
		</select>

		<select
			class="{selectClass} w-32"
			value={data.filters.type ?? ''}
			onchange={(e) => applyFilter('type', (e.target as HTMLSelectElement).value)}
		>
			{#each TYPES as t}
				<option value={t.value}>{t.label}</option>
			{/each}
		</select>

		<select
			class="{selectClass} w-32"
			value={data.filters.status ?? ''}
			onchange={(e) => applyFilter('status', (e.target as HTMLSelectElement).value)}
		>
			{#each STATUSES as s}
				<option value={s.value}>{s.label}</option>
			{/each}
		</select>

		<div class="ml-auto flex overflow-hidden rounded-md border border-surface-200">
			<button
				onclick={() => (view = 'calendar')}
				class="px-3 py-1 text-xs font-medium transition-colors {view === 'calendar' ? 'bg-surface-900 text-white' : 'bg-white text-surface-500 hover:bg-surface-50'}"
			>
				Calendrier
			</button>
			<button
				onclick={() => (view = 'list')}
				class="px-3 py-1 text-xs font-medium transition-colors {view === 'list' ? 'bg-surface-900 text-white' : 'bg-white text-surface-500 hover:bg-surface-50'}"
			>
				Liste
			</button>
		</div>
	</div>

	<!-- Content area -->
	<div class="mt-4">
		{#if data.monthContents.length === 0 && data.unplanned.length === 0}
			<div class="rounded-lg border border-dashed border-surface-200 py-12 text-center">
				<p class="text-sm text-surface-400">Aucun contenu pour ce mois</p>
			</div>
		{:else if view === 'calendar'}
			<CalendarGrid year={data.year} month={data.month} contents={data.monthContents} />
		{:else}
			<div class="grid gap-3">
				{#each data.monthContents as item}
					<ContentCard
						id={item.id}
						title={item.title}
						type={item.type}
						status={item.status}
						plannedDate={item.plannedDate}
						createdAt={item.createdAt}
						projectName={item.projectName ?? undefined}
						projectColor={item.projectColor ?? undefined}
						projectSlug={item.projectSlug ?? undefined}
					/>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Unplanned block -->
	{#if data.unplanned.length > 0}
		<div class="mt-8">
			<div class="flex items-center gap-2">
				<h2 class="text-xs font-semibold uppercase tracking-wider text-surface-400">Non planifie</h2>
				<span class="text-xs text-surface-300">({data.unplanned.length})</span>
			</div>
			<div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each data.unplanned as item}
					<ContentCard
						id={item.id}
						title={item.title}
						type={item.type}
						status={item.status}
						plannedDate={item.plannedDate}
						createdAt={item.createdAt}
						projectName={item.projectName ?? undefined}
						projectColor={item.projectColor ?? undefined}
						projectSlug={item.projectSlug ?? undefined}
					/>
				{/each}
			</div>
		</div>
	{/if}
</div>
