<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import { AlertCircle, TrendingUp, TrendingDown, Minus, HelpCircle, Plus, Trash2, Target, Download } from 'lucide-svelte';
	import Sparkline from '$lib/components/ui/Sparkline.svelte';
	import TimeChart from '$lib/components/ui/TimeChart.svelte';

	let { data } = $props();

	const slug = $derived($page.params.slug);

	type WeekPoint = { weekStart: string; position: number | null; clicks: number; impressions: number; ctr: number; topPage: string | null };
	type Trend = { verdict: 'up' | 'down' | 'flat' | 'insufficient'; deltaPosition: number | null; currentPosition: number | null; vsTarget?: { targetPosition: number; reached: boolean; gap: number } };

	let newKeyword = $state('');
	let newTarget = $state('');
	let submitting = $state(false);
	let formError = $state<string | null>(null);
	let expanded = $state<string | null>(null);

	function fmtPos(p: number | null): string {
		return p == null ? '—' : p.toFixed(1);
	}

	// Sparkline : on inverse les positions (plus bas = mieux) pour qu'un tracé montant = progression.
	function sparkPoints(series: WeekPoint[]): number[] {
		return series.filter((p) => p.position !== null).map((p) => -(p.position as number));
	}

	// TimeChart n'accepte pas de null → carry-forward des trous (le détail « pas de données » reste dans le tableau).
	function lineSeries(series: WeekPoint[]) {
		const first = series.find((p) => p.position !== null)?.position ?? 0;
		let last = first;
		return series.map((p) => {
			if (p.position !== null) last = p.position;
			return last;
		});
	}

	function verdictMeta(t: Trend) {
		switch (t.verdict) {
			case 'up':
				return { icon: TrendingUp, label: 'Progresse', cls: 'text-emerald-600 bg-emerald-50' };
			case 'down':
				return { icon: TrendingDown, label: 'Recule', cls: 'text-rose-600 bg-rose-50' };
			case 'flat':
				return { icon: Minus, label: 'Stagne', cls: 'text-surface-500 bg-surface-100' };
			default:
				return { icon: HelpCircle, label: 'Données insuffisantes', cls: 'text-amber-600 bg-amber-50' };
		}
	}

	async function addKeyword(keyword: string, targetPosition?: number | null) {
		formError = null;
		submitting = true;
		try {
			const res = await fetch(`/api/projects/${slug}/keywords`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ keyword, targetPosition: targetPosition ?? null })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				formError = body.error ?? 'Erreur lors de l\'ajout';
				return;
			}
			newKeyword = '';
			newTarget = '';
			await invalidateAll();
		} finally {
			submitting = false;
		}
	}

	async function submitForm(e: SubmitEvent) {
		e.preventDefault();
		const kw = newKeyword.trim();
		if (!kw) return;
		const target = newTarget.trim() ? Number(newTarget) : null;
		await addKeyword(kw, target);
	}

	async function removeKeyword(id: string) {
		if (!confirm('Retirer ce mot-clé de la watchlist ?')) return;
		await fetch(`/api/projects/${slug}/keywords/${id}`, { method: 'DELETE' });
		await invalidateAll();
	}
</script>

<div class="space-y-8">
	<div class="flex items-start justify-between gap-4">
		<div>
			<h1 class="text-xl font-semibold text-surface-900">Positions</h1>
			<p class="mt-1 text-sm text-surface-500">
				Suivi de position dans le temps par mot-clé. La position GSC est une moyenne pondérée par
				impressions — à lire comme une <strong>tendance</strong>, pas un rang exact.
			</p>
		</div>
		{#if data.hasGsc && data.keywords.length > 0}
			<a
				href={`/api/projects/${slug}/keywords/export`}
				class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-surface-300 px-3 py-2 text-sm text-surface-600 hover:bg-surface-50"
			>
				<Download size={15} /> Export CSV
			</a>
		{/if}
	</div>

	{#if !data.hasGsc}
		<div class="rounded-xl border border-amber-200 bg-amber-50 p-6">
			<div class="flex items-start gap-3">
				<AlertCircle size={20} class="shrink-0 text-amber-600" />
				<div>
					<p class="text-sm font-medium text-amber-900">Configuration GSC manquante</p>
					<p class="mt-1 text-xs text-amber-800">
						Pour suivre les positions, configure d'abord le service account et le siteUrl dans
						<a href="settings" class="font-medium underline">les paramètres du projet</a>.
					</p>
				</div>
			</div>
		</div>
	{:else}
		<!-- Formulaire d'ajout -->
		<form onsubmit={submitForm} class="flex flex-wrap items-end gap-3 rounded-xl border border-surface-200 bg-white p-4">
			<div class="grow">
				<label for="kw" class="block text-xs font-medium text-surface-600">Mot-clé à suivre</label>
				<input
					id="kw"
					bind:value={newKeyword}
					placeholder="ex: paysagiste genève"
					class="mt-1 w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
				/>
			</div>
			<div class="w-32">
				<label for="target" class="block text-xs font-medium text-surface-600">Cible (pos.)</label>
				<input
					id="target"
					bind:value={newTarget}
					type="number"
					step="1"
					min="1"
					placeholder="ex: 3"
					class="mt-1 w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
				/>
			</div>
			<button
				type="submit"
				disabled={submitting || !newKeyword.trim()}
				class="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
			>
				<Plus size={16} /> Suivre
			</button>
			{#if formError}
				<p class="w-full text-xs text-rose-600">{formError}</p>
			{/if}
		</form>

		<!-- Watchlist -->
		<section>
			<h2 class="mb-3 text-sm font-semibold text-surface-700">Watchlist ({data.keywords.length})</h2>
			{#if data.keywords.length === 0}
				<p class="rounded-lg border border-dashed border-surface-300 p-6 text-center text-sm text-surface-400">
					Aucun mot-clé suivi. Ajoute-en un ci-dessus ou via l'auto-découverte.
				</p>
			{:else}
				<div class="overflow-hidden rounded-xl border border-surface-200 bg-white">
					<table class="w-full text-sm">
						<thead class="border-b border-surface-200 bg-surface-50 text-left text-xs text-surface-500">
							<tr>
								<th class="px-4 py-2 font-medium">Mot-clé</th>
								<th class="px-4 py-2 font-medium">Position</th>
								<th class="px-4 py-2 font-medium">Cible</th>
								<th class="px-4 py-2 font-medium">Tendance (12 sem.)</th>
								<th class="px-4 py-2 font-medium">URL</th>
								<th class="px-4 py-2"></th>
							</tr>
						</thead>
						<tbody class="divide-y divide-surface-100">
							{#each data.keywords as kw (kw.id)}
								{@const vm = verdictMeta(kw.trend)}
								<tr class="cursor-pointer hover:bg-surface-50" onclick={() => (expanded = expanded === kw.id ? null : kw.id)}>
									<td class="px-4 py-3 font-medium text-surface-900">{kw.keyword}</td>
									<td class="px-4 py-3 tabular-nums">{fmtPos(kw.currentPosition)}</td>
									<td class="px-4 py-3 tabular-nums text-surface-500">
										{#if kw.targetPosition != null}
											<span class="inline-flex items-center gap-1">
												<Target size={12} />{kw.targetPosition}
												{#if kw.trend.vsTarget?.reached}
													<span class="text-emerald-600">✓</span>
												{/if}
											</span>
										{:else}—{/if}
									</td>
									<td class="px-4 py-3">
										<div class="flex items-center gap-2">
											<span class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs {vm.cls}">
												<vm.icon size={12} />{vm.label}
											</span>
											<span class="w-20 text-indigo-500">
												<Sparkline points={sparkPoints(kw.series)} color="currentColor" />
											</span>
										</div>
									</td>
									<td class="max-w-[200px] truncate px-4 py-3 text-xs text-surface-400">
										{#if kw.topPage}<a href={kw.topPage} target="_blank" rel="noreferrer" class="hover:underline" onclick={(e) => e.stopPropagation()}>{kw.topPage}</a>{:else}—{/if}
									</td>
									<td class="px-4 py-3 text-right">
										<button class="text-surface-300 hover:text-rose-500" onclick={(e) => { e.stopPropagation(); removeKeyword(kw.id); }} aria-label="Retirer">
											<Trash2 size={15} />
										</button>
									</td>
								</tr>
								{#if expanded === kw.id}
									<tr class="bg-surface-50/50">
										<td colspan="6" class="px-4 py-4">
											<p class="mb-2 text-xs text-surface-500">Position sur 12 semaines (plus bas = mieux)</p>
											<TimeChart
												labels={kw.series.map((p) => p.weekStart)}
												series={[{ label: kw.keyword, color: '#4f46e5', points: lineSeries(kw.series) }]}
												height={180}
												showLegend={false}
											/>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<!-- Auto-découverte (movers) -->
		<section>
			<h2 class="mb-1 text-sm font-semibold text-surface-700">Auto-découverte</h2>
			<p class="mb-3 text-xs text-surface-400">
				Plus gros mouvements de position vs semaine précédente (hors watchlist).
			</p>
			<div class="grid gap-4 md:grid-cols-2">
				{#each [{ title: 'Gains', items: data.movers.gains, tone: 'emerald' }, { title: 'Pertes', items: data.movers.losses, tone: 'rose' }] as col}
					<div class="rounded-xl border border-surface-200 bg-white">
						<div class="border-b border-surface-100 px-4 py-2 text-xs font-semibold text-surface-600">{col.title}</div>
						{#if col.items.length === 0}
							<p class="px-4 py-4 text-center text-xs text-surface-400">Rien à signaler.</p>
						{:else}
							<ul class="divide-y divide-surface-100">
								{#each col.items as m (m.query)}
									<li class="flex items-center justify-between gap-2 px-4 py-2.5">
										<div class="min-w-0">
											<p class="truncate text-sm text-surface-800">{m.query}</p>
											<p class="text-xs text-surface-400">
												pos. {m.positionPrev.toFixed(1)} → {m.position.toFixed(1)}
												<span class="{m.deltaPosition < 0 ? 'text-emerald-600' : 'text-rose-600'}">
													({m.deltaPosition > 0 ? '+' : ''}{m.deltaPosition.toFixed(1)})
												</span>
											</p>
										</div>
										<button
											class="inline-flex shrink-0 items-center gap-1 rounded-lg border border-surface-300 px-2 py-1 text-xs text-surface-600 hover:bg-surface-50 disabled:opacity-50"
											disabled={submitting}
											onclick={() => addKeyword(m.query)}
										>
											<Plus size={12} /> suivre
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/if}
</div>
