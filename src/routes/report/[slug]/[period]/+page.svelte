<script lang="ts">
	import { page } from '$app/stores';
	import type { AiReportSummary } from '$lib/server/ai/llm.js';

	let { data } = $props();

	let aiSummary = $state<AiReportSummary | null>(data.aiSummary?.summary ?? null);
	let aiGeneratedAt = $state<string | null>(data.aiSummary?.generatedAt ?? null);
	let aiModel = $state<string | null>(data.aiSummary?.model ?? null);
	let aiBusy = $state(false);
	let aiError = $state<string | null>(null);

	async function generateAiSummary(force = false) {
		aiBusy = true;
		aiError = null;
		try {
			const tokenParam = $page.url.searchParams.get('token');
			const tokenQs = tokenParam ? `&token=${encodeURIComponent(tokenParam)}` : '';
			const forceQs = force ? '&force=1' : '';
			const period = `${data.period.year}-${String(data.period.month).padStart(2, '0')}`;
			const res = await fetch(
				`/api/projects/${data.project.slug}/reviews/ai-summary?period=${period}${forceQs}${tokenQs}`,
				{ method: 'POST' }
			);
			const json = await res.json();
			if (!res.ok) throw new Error(json.error ?? 'Erreur lors de la génération');
			aiSummary = json.summary;
			aiGeneratedAt = json.generatedAt;
			aiModel = json.model;
		} catch (err) {
			aiError = (err as Error).message;
		} finally {
			aiBusy = false;
		}
	}

	function verdictLabel(v: 'improved' | 'stable' | 'declined'): string {
		if (v === 'improved') return 'En progression';
		if (v === 'declined') return 'En recul';
		return 'Stable';
	}

	function verdictTone(v: 'improved' | 'stable' | 'declined'): string {
		if (v === 'improved') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
		if (v === 'declined') return 'border-red-200 bg-red-50 text-red-700';
		return 'border-surface-200 bg-surface-50 text-surface-600';
	}

	function priorityTone(p: 'high' | 'medium' | 'low'): string {
		if (p === 'high') return 'bg-red-100 text-red-700 ring-red-200';
		if (p === 'medium') return 'bg-amber-100 text-amber-700 ring-amber-200';
		return 'bg-surface-100 text-surface-600 ring-surface-200';
	}

	function priorityLabel(p: 'high' | 'medium' | 'low'): string {
		if (p === 'high') return 'Priorité haute';
		if (p === 'medium') return 'Priorité moyenne';
		return 'Priorité basse';
	}

	function formatDateTime(iso: string): string {
		return new Date(iso).toLocaleString('fr-CH', {
			day: 'numeric',
			month: 'long',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function renderStars(rating: number): string {
		return '★'.repeat(rating) + '☆'.repeat(5 - rating);
	}

	function ratingColor(rating: number): string {
		if (rating >= 4) return 'text-emerald-600';
		if (rating === 3) return 'text-amber-500';
		return 'text-red-500';
	}

	function trendIcon(delta: number): string {
		if (delta > 0) return '↑';
		if (delta < 0) return '↓';
		return '→';
	}

	function trendColor(delta: number, inverse = false): string {
		const positive = inverse ? delta < 0 : delta > 0;
		const negative = inverse ? delta > 0 : delta < 0;
		if (positive) return 'text-emerald-600';
		if (negative) return 'text-red-500';
		return 'text-surface-400';
	}

	function formatDateShort(date: string): string {
		return new Date(date).toLocaleDateString('fr-CH', { day: 'numeric', month: 'short', year: 'numeric' });
	}

	function sentimentBar(emp: { positiveCount: number; neutralCount: number; negativeCount: number }) {
		const total = emp.positiveCount + emp.neutralCount + emp.negativeCount;
		if (total === 0) return { positive: 0, neutral: 0, negative: 0 };
		return {
			positive: Math.round(emp.positiveCount / total * 100),
			neutral: Math.round(emp.neutralCount / total * 100),
			negative: Math.round(emp.negativeCount / total * 100)
		};
	}

	// Strip "(Translated by Google)" blocks from comments
	function cleanComment(comment: string): string {
		return comment.replace(/\n*\(Translated by Google\)[\s\S]*$/, '').trim();
	}
</script>

<svelte:head>
	<title>Rapport avis Google — {data.project.name} — {data.period.label}</title>
</svelte:head>

<div class="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
	<!-- Header -->
	<header class="mb-10 text-center">
		<div class="mb-2 inline-block rounded-full bg-surface-100 px-4 py-1 text-xs font-medium uppercase tracking-wider text-surface-500">
			Rapport mensuel
		</div>
		<h1 class="text-3xl font-bold text-surface-900">{data.project.name}</h1>
		<p class="mt-1 text-lg text-surface-500">Avis Google — {data.period.label}</p>
	</header>

	<!-- AI Synthesis -->
	<section class="mb-10">
		{#if aiSummary}
			<div class="rounded-2xl border border-surface-200 bg-white p-6 shadow-sm">
				<div class="mb-4 flex items-start justify-between gap-4">
					<div>
						<p class="text-xs font-semibold uppercase tracking-wider text-primary-600">Synthèse du mois</p>
						<p class="mt-1 text-sm text-surface-700 leading-relaxed">{aiSummary.executive_summary}</p>
					</div>
					{#if aiSummary.trend_vs_previous}
						<span class="shrink-0 rounded-full border px-3 py-1 text-xs font-medium {verdictTone(aiSummary.trend_vs_previous.verdict)}">
							{verdictLabel(aiSummary.trend_vs_previous.verdict)}
						</span>
					{/if}
				</div>

				{#if aiSummary.trend_vs_previous?.highlights?.length}
					<div class="mt-4 rounded-xl bg-surface-50 px-4 py-3">
						<p class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Évolution vs {data.prevPeriod.label}</p>
						<ul class="mt-2 space-y-1 text-sm text-surface-700">
							{#each aiSummary.trend_vs_previous.highlights as h}
								<li class="flex gap-2"><span class="mt-1 h-1 w-1 shrink-0 rounded-full bg-surface-400"></span>{h}</li>
							{/each}
						</ul>
					</div>
				{/if}

				{#if aiSummary.by_location?.length}
					<div class="mt-5 grid gap-3 {aiSummary.by_location.length > 1 ? 'sm:grid-cols-2' : ''}">
						{#each aiSummary.by_location as loc}
							<div class="rounded-xl border border-surface-200 bg-surface-50/40 p-4">
								<div class="flex items-center justify-between gap-3">
									<h3 class="text-sm font-semibold text-surface-900">{loc.location_label}</h3>
									<span class="rounded-full border px-2 py-0.5 text-[10px] font-medium {verdictTone(loc.verdict)}">{verdictLabel(loc.verdict)}</span>
								</div>
								<p class="mt-2 text-sm text-surface-600 leading-relaxed">{loc.summary}</p>
								{#if loc.strengths?.length}
									<div class="mt-3">
										<p class="text-[10px] font-semibold uppercase tracking-wider text-emerald-600">Points forts</p>
										<ul class="mt-1 space-y-0.5 text-xs text-surface-600">
											{#each loc.strengths as s}<li>· {s}</li>{/each}
										</ul>
									</div>
								{/if}
								{#if loc.watch_points?.length}
									<div class="mt-3">
										<p class="text-[10px] font-semibold uppercase tracking-wider text-amber-600">À surveiller</p>
										<ul class="mt-1 space-y-0.5 text-xs text-surface-600">
											{#each loc.watch_points as w}<li>· {w}</li>{/each}
										</ul>
									</div>
								{/if}
								{#if loc.actions?.length}
									<div class="mt-3">
										<p class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Actions</p>
										<ul class="mt-1 space-y-0.5 text-xs text-surface-700">
											{#each loc.actions as a}<li>→ {a}</li>{/each}
										</ul>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				{#if aiSummary.team_highlights?.length}
					<div class="mt-5">
						<p class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Équipe</p>
						<div class="mt-2 space-y-2">
							{#each aiSummary.team_highlights as t}
								<div class="rounded-lg border border-surface-200 bg-white px-3 py-2 text-sm">
									<div class="font-medium text-surface-900">{t.employee}</div>
									<p class="mt-0.5 text-surface-600">{t.context}</p>
									<p class="mt-1 text-xs text-surface-500"><span class="font-medium text-surface-600">→</span> {t.recommendation}</p>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				{#if aiSummary.actions_recommended?.length}
					<div class="mt-6 border-t border-surface-200 pt-5">
						<p class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Actions recommandées pour le mois suivant</p>
						<ol class="mt-3 space-y-2">
							{#each aiSummary.actions_recommended as a}
								<li class="flex gap-3">
									<span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset {priorityTone(a.priority)}">
										{priorityLabel(a.priority)}
									</span>
									<div class="text-sm">
										<p class="font-medium text-surface-800">{a.action}</p>
										<p class="mt-0.5 text-xs text-surface-500">{a.reason}</p>
									</div>
								</li>
							{/each}
						</ol>
					</div>
				{/if}

				<div class="mt-6 flex items-center justify-between border-t border-surface-200 pt-3 text-[11px] text-surface-400">
					<span>
						{#if aiGeneratedAt}Généré le {formatDateTime(aiGeneratedAt)}{/if}
						{#if aiModel} · {aiModel}{/if}
					</span>
					{#if data.isAdmin}
						<button
							onclick={() => generateAiSummary(true)}
							disabled={aiBusy}
							class="rounded-md border border-surface-200 bg-white px-3 py-1 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50 disabled:opacity-50"
						>
							{aiBusy ? 'Régénération…' : 'Régénérer la synthèse'}
						</button>
					{/if}
				</div>
			</div>
		{:else}
			<div class="rounded-2xl border border-dashed border-surface-300 bg-white px-6 py-8 text-center">
				<p class="text-sm font-semibold text-surface-700">Synthèse IA du mois</p>
				<p class="mt-1 text-xs text-surface-500">
					Une lecture structurée des avis du mois (évolution vs {data.prevPeriod.label}, diagnostic par établissement, actions recommandées).
				</p>
				{#if data.isAdmin}
					<button
						onclick={() => generateAiSummary(false)}
						disabled={aiBusy || data.stats.totalReviews === 0}
						class="mt-4 rounded-md bg-primary-500 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-50"
					>
						{aiBusy ? 'Génération en cours…' : 'Générer la synthèse'}
					</button>
					{#if data.stats.totalReviews === 0}
						<p class="mt-2 text-[11px] text-surface-400">Aucun avis sur la période.</p>
					{/if}
				{:else}
					<p class="mt-3 text-[11px] text-surface-400">La synthèse n'a pas encore été générée pour ce mois.</p>
				{/if}
			</div>
		{/if}
		{#if aiError}
			<p class="mt-2 text-center text-xs text-red-500">{aiError}</p>
		{/if}
	</section>

	<!-- KPI Cards -->
	<section class="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
		<div class="rounded-xl border border-surface-200 bg-white p-5 text-center">
			<p class="text-3xl font-bold text-surface-900">{data.stats.totalReviews}</p>
			<p class="mt-1 text-xs text-surface-500">Avis ce mois</p>
			{#if data.trends.prevTotal > 0}
				<p class="mt-1 text-xs {trendColor(data.trends.deltaVolume)}">
					{trendIcon(data.trends.deltaVolume)} {data.trends.deltaVolume > 0 ? '+' : ''}{data.trends.deltaVolume} vs {data.prevPeriod.label}
				</p>
			{/if}
		</div>
		<div class="rounded-xl border border-surface-200 bg-white p-5 text-center">
			<p class="text-3xl font-bold {ratingColor(Math.round(data.stats.avgRating))}">{data.stats.avgRating}</p>
			<p class="mt-1 text-xs text-surface-500">Note moyenne</p>
			{#if data.trends.prevTotal > 0}
				<p class="mt-1 text-xs {trendColor(data.trends.deltaRating)}">
					{trendIcon(data.trends.deltaRating)} {data.trends.deltaRating > 0 ? '+' : ''}{data.trends.deltaRating} vs {data.trends.prevAvgRating}
				</p>
			{/if}
		</div>
		<div class="rounded-xl border border-surface-200 bg-white p-5 text-center">
			<p class="text-3xl font-bold text-emerald-600">{data.stats.positivePercent}%</p>
			<p class="mt-1 text-xs text-surface-500">Avis positifs (4-5★)</p>
		</div>
		<div class="rounded-xl border border-surface-200 bg-white p-5 text-center">
			<p class="text-3xl font-bold text-surface-900">{data.trends.currentMentions}</p>
			<p class="mt-1 text-xs text-surface-500">Mentions equipe</p>
			{#if data.trends.prevMentions > 0}
				{@const delta = data.trends.currentMentions - data.trends.prevMentions}
				<p class="mt-1 text-xs {trendColor(delta)}">
					{trendIcon(delta)} {delta > 0 ? '+' : ''}{delta} vs {data.prevPeriod.label}
				</p>
			{/if}
		</div>
	</section>

	<!-- Star Distribution -->
	<section class="mb-10 rounded-xl border border-surface-200 bg-white p-6">
		<h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-surface-500">Repartition des notes</h2>
		<div class="space-y-2">
			{#each [5, 4, 3, 2, 1] as star}
				{@const count = data.stats.stars[star] || 0}
				{@const pct = data.stats.totalReviews > 0 ? count / data.stats.totalReviews * 100 : 0}
				<div class="flex items-center gap-3">
					<span class="w-8 text-right text-sm font-medium text-surface-700">{star}★</span>
					<div class="flex-1 overflow-hidden rounded-full bg-surface-100" style="height: 10px;">
						<div
							class="h-full rounded-full transition-all {star >= 4 ? 'bg-emerald-500' : star === 3 ? 'bg-amber-400' : 'bg-red-400'}"
							style="width: {pct}%"
						></div>
					</div>
					<span class="w-12 text-right text-xs text-surface-400">{count} ({Math.round(pct)}%)</span>
				</div>
			{/each}
		</div>
	</section>

	<!-- Per Location -->
	{#if data.locations.length > 1}
		<section class="mb-10">
			<h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-surface-500">Par etablissement</h2>
			<div class="grid gap-4 sm:grid-cols-2">
				{#each data.locations as loc}
					<div class="rounded-xl border border-surface-200 bg-white p-5">
						<h3 class="text-sm font-semibold text-surface-900">{loc.label}</h3>
						<div class="mt-2 flex items-baseline gap-3">
							<span class="text-2xl font-bold {ratingColor(Math.round(loc.avgRating))}">{Math.round(loc.avgRating * 10) / 10}</span>
							<span class="text-xs text-surface-400">{loc.count} avis</span>
						</div>
						<div class="mt-3 flex gap-1">
							{#each [5, 4, 3, 2, 1] as star}
								{@const pct = loc.count > 0 ? loc.stars[star] / loc.count * 100 : 0}
								{#if pct > 0}
									<div
										class="h-2 rounded-full {star >= 4 ? 'bg-emerald-400' : star === 3 ? 'bg-amber-300' : 'bg-red-300'}"
										style="width: {pct}%"
										title="{star}★ : {loc.stars[star]}"
									></div>
								{/if}
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Employees -->
	{#if data.employees.length > 0}
		<section class="mb-10 rounded-xl border border-surface-200 bg-white p-6">
			<h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-surface-500">Equipe — mentions dans les avis</h2>
			<div class="space-y-4">
				{#each data.employees.sort((a, b) => b.mentionCount - a.mentionCount) as emp}
					{@const bar = sentimentBar(emp)}
					<div>
						<div class="flex items-center justify-between">
							<span class="text-sm font-semibold text-surface-900">{emp.name}</span>
							<span class="text-xs text-surface-400">{emp.mentionCount} mention{emp.mentionCount !== 1 ? 's' : ''}</span>
						</div>
						<div class="mt-1.5 flex h-2 overflow-hidden rounded-full">
							{#if bar.positive > 0}
								<div class="bg-emerald-400" style="width: {bar.positive}%"></div>
							{/if}
							{#if bar.neutral > 0}
								<div class="bg-surface-300" style="width: {bar.neutral}%"></div>
							{/if}
							{#if bar.negative > 0}
								<div class="bg-red-400" style="width: {bar.negative}%"></div>
							{/if}
						</div>
						<div class="mt-1 flex gap-3 text-[10px] text-surface-400">
							<span class="text-emerald-600">{emp.positiveCount} positif{emp.positiveCount !== 1 ? 's' : ''}</span>
							{#if emp.neutralCount > 0}<span>{emp.neutralCount} neutre{emp.neutralCount !== 1 ? 's' : ''}</span>{/if}
							{#if emp.negativeCount > 0}<span class="text-red-500">{emp.negativeCount} negatif{emp.negativeCount !== 1 ? 's' : ''}</span>{/if}
						</div>
						<!-- Sample reviews -->
						{#if data.employeeSamples[emp.name]}
							<div class="mt-2 space-y-1.5 pl-3 border-l-2 border-surface-100">
								{#each data.employeeSamples[emp.name] as sample}
									<div class="text-xs">
										<span class="font-medium text-surface-700">{sample.authorName}</span>
										<span class="{ratingColor(sample.rating)}">{renderStars(sample.rating)}</span>
										{#if sample.comment}
											<p class="mt-0.5 text-surface-500 line-clamp-2">{cleanComment(sample.comment)}</p>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<!-- All Reviews -->
	<section class="mb-10">
		<h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-surface-500">Tous les avis du mois ({data.reviews.length})</h2>
		<div class="space-y-4">
			{#each data.reviews as review}
				<div class="rounded-xl border border-surface-200 bg-white p-5">
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-2">
							<span class="font-medium text-surface-900">{review.authorName}</span>
							<span class="{ratingColor(review.rating)} text-sm">{renderStars(review.rating)}</span>
						</div>
						<div class="flex items-center gap-2">
							{#if review.locationLabel}
								<span class="rounded-full bg-surface-100 px-2 py-0.5 text-[10px] text-surface-500">{review.locationLabel}</span>
							{/if}
							<span class="text-xs text-surface-400">{formatDateShort(review.createTime)}</span>
						</div>
					</div>
					{#if review.comment}
						<p class="mt-2 text-sm text-surface-700">{cleanComment(review.comment)}</p>
					{/if}
					{#if review.draftReply}
						<div class="mt-3 rounded-lg bg-surface-50 px-4 py-3">
							<p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-surface-400">
								Reponse {review.repliedAt ? 'envoyee' : 'brouillon'}
							</p>
							<p class="text-sm text-surface-600">{review.draftReply}</p>
						</div>
					{/if}
				</div>
			{/each}
			{#if data.reviews.length === 0}
				<p class="text-center text-sm text-surface-400">Aucun avis pour cette periode.</p>
			{/if}
		</div>
	</section>

	<!-- Footer -->
	<footer class="border-t border-surface-200 pt-6 text-center text-xs text-surface-400">
		<p>Rapport genere par JLabs Content Hub</p>
	</footer>
</div>

<style>
	:global(body) {
		background-color: #f8fafc;
	}
</style>
