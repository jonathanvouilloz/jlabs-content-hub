<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
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
</script>

<div>
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-surface-900">Calendrier</h1>
		<div class="flex items-center gap-1">
			<button
				onclick={() => navigateMonth(-1)}
				class="btn preset-outlined-surface-200 px-2 py-1"
				aria-label="Mois precedent"
			>
				<svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
					<path fill-rule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clip-rule="evenodd" />
				</svg>
			</button>
			<span class="min-w-40 text-center text-lg font-semibold capitalize text-surface-700">
				{monthLabel}
			</span>
			<button
				onclick={() => navigateMonth(1)}
				class="btn preset-outlined-surface-200 px-2 py-1"
				aria-label="Mois suivant"
			>
				<svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
					<path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" />
				</svg>
			</button>
		</div>
	</div>

	<!-- Filters + View toggle -->
	<div class="mt-4 flex flex-wrap items-center gap-3">
		<select
			class="input preset-outlined-surface-200 w-44 text-sm"
			value={data.filters.project ?? ''}
			onchange={(e) => applyFilter('project', (e.target as HTMLSelectElement).value)}
		>
			<option value="">Tous projets</option>
			{#each data.projects as p}
				<option value={p.id}>{p.name}</option>
			{/each}
		</select>

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

		<div class="ml-auto flex rounded-lg border border-surface-200">
			<button
				onclick={() => (view = 'calendar')}
				class="px-3 py-1.5 text-sm transition-colors {view === 'calendar' ? 'bg-primary-500 text-white' : 'text-surface-500 hover:bg-surface-50'}"
				style="border-radius: 0.5rem 0 0 0.5rem;"
			>
				Calendrier
			</button>
			<button
				onclick={() => (view = 'list')}
				class="px-3 py-1.5 text-sm transition-colors {view === 'list' ? 'bg-primary-500 text-white' : 'text-surface-500 hover:bg-surface-50'}"
				style="border-radius: 0 0.5rem 0.5rem 0;"
			>
				Liste
			</button>
		</div>
	</div>

	<!-- Content area -->
	<div class="mt-6">
		{#if data.monthContents.length === 0 && data.unplanned.length === 0}
			<div class="rounded-lg border border-dashed border-surface-300 p-12 text-center">
				<p class="text-surface-500">Aucun contenu pour ce mois</p>
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
			<h2 class="text-lg font-semibold text-surface-700">
				Non planifie
				<span class="ml-1 text-sm font-normal text-surface-400">({data.unplanned.length})</span>
			</h2>
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
