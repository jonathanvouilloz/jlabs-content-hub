<script lang="ts">
	import { ChevronDown, ChevronUp, Star } from 'lucide-svelte';
	import { formatDate } from '$lib/utils/dates.js';

	interface Props { projectSlug: string }
	let { projectSlug }: Props = $props();

	const now = new Date();
	let year = $state(now.getUTCFullYear());
	let month = $state(now.getUTCMonth() + 1);

	interface Employee {
		name: string;
		mention_count: number;
		positive_count: number;
		neutral_count: number;
		negative_count: number;
	}
	interface Sample {
		reviewId: string;
		authorName: string;
		rating: number;
		comment: string;
		createTime: string;
	}

	let collapsed = $state(true);
	let loading = $state(false);
	let error = $state('');
	let employees = $state<Employee[]>([]);
	let samples = $state<Record<string, Sample[]>>({});
	let expanded = $state<string | null>(null);

	async function fetchReport() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`/api/projects/${projectSlug}/employee-mentions?year=${year}&month=${month}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			employees = json.employees ?? [];
			samples = json.sample_reviews ?? {};
		} catch (err) {
			error = (err as Error).message;
			employees = [];
			samples = {};
		}
		loading = false;
	}

	$effect(() => {
		// Re-fetch quand year/month changent
		void year; void month;
		fetchReport();
	});

	function pct(part: number, total: number): number {
		return total > 0 ? Math.round((part / total) * 100) : 0;
	}

	function toggleExpand(name: string) {
		expanded = expanded === name ? null : name;
	}

	const monthNames = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
	const yearOptions = $derived(() => {
		const y = now.getUTCFullYear();
		return [y - 1, y, y + 1];
	});
</script>

<section class="rounded-lg border border-surface-200 bg-white p-4">
	<button
		type="button"
		onclick={() => collapsed = !collapsed}
		class="flex w-full items-center justify-between gap-3 text-left"
	>
		<h2 class="text-sm font-semibold text-surface-900">Mentions employés — rapport mensuel</h2>
		{#if collapsed}
			<ChevronDown size={14} class="text-surface-400 flex-shrink-0" />
		{:else}
			<ChevronUp size={14} class="text-surface-400 flex-shrink-0" />
		{/if}
	</button>

	{#if !collapsed}
	<div class="flex items-center justify-end gap-2 mt-3 mb-3">
		<select bind:value={month} class="rounded border border-surface-200 bg-white px-2 py-1 text-xs">
			{#each monthNames as name, i}
				<option value={i + 1}>{name}</option>
			{/each}
		</select>
		<select bind:value={year} class="rounded border border-surface-200 bg-white px-2 py-1 text-xs">
			{#each yearOptions() as y}
				<option value={y}>{y}</option>
			{/each}
		</select>
	</div>

	{#if loading}
		<div class="space-y-2 animate-pulse">
			{#each Array(3) as _}
				<div class="h-10 rounded bg-surface-100"></div>
			{/each}
		</div>
	{:else if error}
		<p class="text-xs text-red-500">Erreur : {error}</p>
	{:else if employees.length === 0}
		<p class="text-xs text-surface-400 italic">Aucune mention employé ce mois-ci.</p>
	{:else}
		<div class="space-y-2">
			{#each employees as emp}
				{@const total = emp.mention_count}
				{@const posPct = pct(emp.positive_count, total)}
				{@const neuPct = pct(emp.neutral_count, total)}
				{@const negPct = pct(emp.negative_count, total)}
				<div class="rounded border border-surface-100">
					<button
						type="button"
						onclick={() => toggleExpand(emp.name)}
						class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-50"
					>
						<div class="flex-1 min-w-0">
							<div class="flex items-center justify-between gap-2">
								<span class="text-sm font-medium text-surface-900">{emp.name}</span>
								<span class="text-xs text-surface-500">
									{total} mention{total > 1 ? 's' : ''} · {posPct}% positif
								</span>
							</div>
							<div class="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-surface-100">
								{#if emp.positive_count > 0}
									<div class="bg-emerald-500" style="width: {posPct}%" title="Positif: {emp.positive_count}"></div>
								{/if}
								{#if emp.neutral_count > 0}
									<div class="bg-surface-300" style="width: {neuPct}%" title="Neutre: {emp.neutral_count}"></div>
								{/if}
								{#if emp.negative_count > 0}
									<div class="bg-red-500" style="width: {negPct}%" title="Négatif: {emp.negative_count}"></div>
								{/if}
							</div>
						</div>
						{#if expanded === emp.name}
							<ChevronUp size={14} class="text-surface-400 flex-shrink-0" />
						{:else}
							<ChevronDown size={14} class="text-surface-400 flex-shrink-0" />
						{/if}
					</button>

					{#if expanded === emp.name}
						<div class="border-t border-surface-100 px-3 py-2 space-y-2">
							{#if samples[emp.name]?.length}
								{#each samples[emp.name] as s}
									<div class="rounded bg-surface-50 px-2 py-1.5">
										<div class="flex items-center gap-2 text-[11px] text-surface-500">
											<span class="font-medium text-surface-700">{s.authorName}</span>
											<span class="flex items-center gap-0.5">
												{#each Array(s.rating) as _}
													<Star size={10} class="fill-amber-400 text-amber-400" />
												{/each}
											</span>
											<span>·</span>
											<span>{formatDate(s.createTime)}</span>
										</div>
										<p class="mt-1 text-xs text-surface-700 line-clamp-3">{s.comment}</p>
									</div>
								{/each}
							{:else}
								<p class="text-[11px] text-surface-400 italic">Aucun avis échantillon.</p>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
	{/if}
</section>
