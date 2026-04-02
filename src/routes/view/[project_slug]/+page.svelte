<script lang="ts">
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/utils/dates.js';

	let { data } = $props();

	const TYPE_LABELS: Record<string, string> = {
		article: 'Article',
		linkedin: 'LinkedIn',
		gmb: 'GMB'
	};

	// ── Filters ─────────────────────────────────────────────────────
	const TABS = [
		{ value: '', label: 'Tous' },
		{ value: 'article', label: 'Articles' },
		{ value: 'linkedin', label: 'LinkedIn' },
		{ value: 'gmb', label: 'GMB' }
	];

	let activeTab = $state('');
	let viewMode = $state<'table' | 'calendar'>('table');

	let filteredContents = $derived(
		activeTab
			? data.contents.filter((c: { type: string }) => c.type === activeTab)
			: data.contents
	);

	function tabCount(type: string): number {
		if (!type) return data.contents.length;
		return data.contents.filter((c: { type: string }) => c.type === type).length;
	}

	// ── Detail panel ────────────────────────────────────────────────
	let selectedId = $state<string | null>(null);

	let selectedContent = $derived(
		selectedId ? data.contents.find((c: { id: string }) => c.id === selectedId) ?? null : null
	);

	// ── Calendar ────────────────────────────────────────────────────
	let calendarDate = $state(new Date());

	let calendarYear = $derived(calendarDate.getFullYear());
	let calendarMonth = $derived(calendarDate.getMonth());

	let calendarDays = $derived(() => {
		const firstDay = new Date(calendarYear, calendarMonth, 1);
		const lastDay = new Date(calendarYear, calendarMonth + 1, 0);
		const startOffset = (firstDay.getDay() + 6) % 7; // Monday = 0
		const totalDays = lastDay.getDate();

		const days: { date: number | null; dateStr: string; isToday: boolean }[] = [];

		for (let i = 0; i < startOffset; i++) {
			days.push({ date: null, dateStr: '', isToday: false });
		}

		const today = new Date();
		const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

		for (let d = 1; d <= totalDays; d++) {
			const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
			days.push({ date: d, dateStr, isToday: dateStr === todayStr });
		}

		return days;
	});

	function getContentsForDate(dateStr: string) {
		return filteredContents.filter((c: { plannedDate: string | null }) => {
			if (!c.plannedDate) return false;
			return c.plannedDate.startsWith(dateStr);
		});
	}

	function prevMonth() {
		calendarDate = new Date(calendarYear, calendarMonth - 1, 1);
	}

	function nextMonth() {
		calendarDate = new Date(calendarYear, calendarMonth + 1, 1);
	}

	const MONTH_NAMES = ['Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre'];
	const DAY_NAMES = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

	const STATUS_DOT: Record<string, string> = {
		review: 'bg-yellow-400',
		approved: 'bg-blue-400',
		published: 'bg-green-400'
	};
</script>

<div>
	<!-- Header -->
	<div class="flex items-center gap-3">
		<span class="h-4 w-4 rounded-full" style="background-color: {data.project.color};"></span>
		<h1 class="text-2xl font-bold text-surface-900">{data.project.name}</h1>
	</div>

	<!-- Toolbar : tabs + view toggle -->
	<div class="mt-6 flex items-center justify-between">
		<div class="flex gap-1">
			{#each TABS as tab}
				<button
					onclick={() => activeTab = tab.value}
					class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors {activeTab === tab.value ? 'bg-surface-900 text-white' : 'text-surface-500 hover:bg-surface-100'}"
				>
					{tab.label}
					<span class="ml-1 text-xs {activeTab === tab.value ? 'text-surface-300' : 'text-surface-400'}">
						{tabCount(tab.value)}
					</span>
				</button>
			{/each}
		</div>

		<div class="flex items-center gap-1 rounded-lg border border-surface-200 p-0.5">
			<button
				onclick={() => viewMode = 'table'}
				class="rounded-md px-3 py-1 text-xs font-medium transition-colors {viewMode === 'table' ? 'bg-surface-900 text-white' : 'text-surface-500 hover:bg-surface-100'}"
			>
				Tableau
			</button>
			<button
				onclick={() => viewMode = 'calendar'}
				class="rounded-md px-3 py-1 text-xs font-medium transition-colors {viewMode === 'calendar' ? 'bg-surface-900 text-white' : 'text-surface-500 hover:bg-surface-100'}"
			>
				Calendrier
			</button>
		</div>
	</div>

	<!-- Main content: two columns -->
	<div class="mt-4 flex gap-4" style="min-height: 600px;">
		<!-- Left: table or calendar -->
		<div class="min-w-0" style="flex: 55;">
			{#if viewMode === 'table'}
				{#if filteredContents.length > 0}
					<div class="overflow-hidden rounded-lg border border-surface-200 bg-white">
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-surface-100 bg-surface-50 text-left text-xs font-medium uppercase text-surface-500">
									<th class="px-4 py-3">Titre</th>
									<th class="px-4 py-3">Type</th>
									<th class="px-4 py-3">Statut</th>
									<th class="px-4 py-3">Date</th>
								</tr>
							</thead>
							<tbody>
								{#each filteredContents as item}
									<tr
										onclick={() => selectedId = item.id}
										class="cursor-pointer border-b border-surface-100 transition-colors {selectedId === item.id ? 'bg-primary-50' : 'hover:bg-surface-50'}"
									>
										<td class="px-4 py-3 font-medium text-surface-900">{item.title}</td>
										<td class="px-4 py-3 text-surface-500">{TYPE_LABELS[item.type] ?? item.type}</td>
										<td class="px-4 py-3">
											<StatusBadge status={item.status} />
										</td>
										<td class="px-4 py-3 text-surface-400">
											{item.plannedDate ? formatDate(item.plannedDate) : '—'}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<div class="rounded-lg border border-dashed border-surface-300 p-12 text-center">
						<p class="text-surface-500">Aucun contenu</p>
					</div>
				{/if}
			{:else}
				<!-- CALENDAR VIEW -->
				<div class="rounded-lg border border-surface-200 bg-white">
					<div class="flex items-center justify-between border-b border-surface-100 px-4 py-3">
						<button onclick={prevMonth} class="rounded p-1 text-surface-400 hover:bg-surface-100 hover:text-surface-700">
							<svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clip-rule="evenodd"/></svg>
						</button>
						<span class="text-sm font-semibold text-surface-900">
							{MONTH_NAMES[calendarMonth]} {calendarYear}
						</span>
						<button onclick={nextMonth} class="rounded p-1 text-surface-400 hover:bg-surface-100 hover:text-surface-700">
							<svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd"/></svg>
						</button>
					</div>

					<div class="grid grid-cols-7 border-b border-surface-100">
						{#each DAY_NAMES as day}
							<div class="px-2 py-2 text-center text-xs font-medium text-surface-400">{day}</div>
						{/each}
					</div>

					<div class="grid grid-cols-7">
						{#each calendarDays() as day}
							<div class="min-h-[80px] border-b border-r border-surface-100 p-1 {day.isToday ? 'bg-primary-50/30' : ''}">
								{#if day.date}
									<span class="text-xs font-medium {day.isToday ? 'text-primary-600' : 'text-surface-400'}">
										{day.date}
									</span>
									{#each getContentsForDate(day.dateStr) as item}
										<button
											onclick={() => selectedId = item.id}
											class="mt-0.5 block w-full truncate rounded px-1 py-0.5 text-left text-xs transition-colors {selectedId === item.id ? 'bg-primary-100 text-primary-800' : 'bg-surface-50 text-surface-700 hover:bg-surface-100'}"
											title={item.title}
										>
											<span class="mr-1 inline-block h-1.5 w-1.5 rounded-full {STATUS_DOT[item.status] ?? 'bg-surface-300'}"></span>
											{item.title}
										</button>
									{/each}
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<!-- Right: detail panel -->
		<div class="min-w-0" style="flex: 45;">
			{#if selectedContent}
				<div class="sticky top-4 rounded-lg border border-surface-200 bg-white">
					<div class="border-b border-surface-100 p-4">
						<div class="flex items-center justify-between">
							<span class="text-xs text-surface-400">{TYPE_LABELS[selectedContent.type] ?? selectedContent.type}</span>
							<StatusBadge status={selectedContent.status} />
						</div>
						<h2 class="mt-2 text-lg font-bold text-surface-900">{selectedContent.title}</h2>
						<div class="mt-2 flex flex-wrap gap-3 text-xs text-surface-400">
							{#if selectedContent.plannedDate}
								<span>Planifie : {formatDate(selectedContent.plannedDate)}</span>
							{/if}
							{#if selectedContent.publishedAt}
								<span>Publie : {formatDate(selectedContent.publishedAt)}</span>
							{/if}
						</div>
					</div>

					<div class="max-h-[500px] overflow-y-auto p-4">
						{#if selectedContent.type === 'gmb' && selectedContent.gmbData}
							{@const gmb = selectedContent.gmbData}
							<p class="text-sm leading-relaxed text-surface-700">{gmb.content}</p>
							{#if gmb.cta}
								<div class="mt-3 flex items-center gap-2">
									<span class="rounded bg-primary-50 px-2 py-0.5 text-xs text-primary-700">{gmb.cta.action}</span>
									<a href={gmb.cta.url} target="_blank" rel="noopener" class="text-xs text-primary-600 hover:underline truncate">{gmb.cta.url}</a>
								</div>
							{/if}
							{#if gmb.event_start_date}
								<div class="mt-2 text-xs text-surface-400">
									Evenement : {formatDate(gmb.event_start_date)} — {formatDate(gmb.event_end_date)}
								</div>
							{/if}
						{:else if selectedContent.renderedBody}
							<div class="prose prose-sm max-w-none">
								{@html selectedContent.renderedBody}
							</div>
						{:else}
							<p class="text-sm text-surface-500">{selectedContent.body}</p>
						{/if}
					</div>

					{#if selectedContent.tags}
						{@const tags = (() => { try { return JSON.parse(selectedContent.tags); } catch { return []; } })()}
						{#if tags.length > 0}
							<div class="border-t border-surface-100 px-4 py-3">
								<div class="flex flex-wrap gap-1.5">
									{#each tags as tag}
										<span class="rounded-full bg-surface-100 px-2 py-0.5 text-xs text-surface-600">{tag}</span>
									{/each}
								</div>
							</div>
						{/if}
					{/if}

					<div class="border-t border-surface-100 px-4 py-3">
						<a
							href="/view/{data.project.slug}/{selectedContent.id}?token={data.token}"
							class="text-xs text-primary-600 hover:underline"
						>
							Voir le detail complet
						</a>
					</div>
				</div>
			{:else}
				<div class="flex h-full items-center justify-center rounded-lg border border-dashed border-surface-300 p-8">
					<p class="text-sm text-surface-400">Selectionnez un contenu pour voir les details</p>
				</div>
			{/if}
		</div>
	</div>
</div>
