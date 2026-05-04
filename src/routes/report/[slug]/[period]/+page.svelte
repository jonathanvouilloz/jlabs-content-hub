<script lang="ts">
	import { page } from '$app/stores';
	import { ChevronLeft, ChevronRight, Loader, RefreshCw, Sparkles } from 'lucide-svelte';
	import type { AiReportSummary } from '$lib/server/ai/llm.js';

	let { data } = $props();

	const MONTH_NAMES_FULL = [
		'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
		'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'
	];

	function periodOffset(year: number, month: number, delta: number): { year: number; month: number } {
		const total = year * 12 + (month - 1) + delta;
		return { year: Math.floor(total / 12), month: (total % 12) + 1 };
	}

	function periodLabel(year: number, month: number): string {
		return `${MONTH_NAMES_FULL[month - 1]} ${year}`;
	}

	function buildPeriodUrl(year: number, month: number): string {
		const period = `${year}-${String(month).padStart(2, '0')}`;
		const token = $page.url.searchParams.get('token');
		const qs = token ? `?token=${encodeURIComponent(token)}` : '';
		return `/report/${data.project.slug}/${period}${qs}`;
	}

	let prevNav = $derived(periodOffset(data.period.year, data.period.month, -1));
	let nextNav = $derived(periodOffset(data.period.year, data.period.month, 1));
	let nextIsFuture = $derived.by(() => {
		const now = new Date();
		const currentYear = now.getFullYear();
		const currentMonth = now.getMonth() + 1;
		return nextNav.year > currentYear || (nextNav.year === currentYear && nextNav.month > currentMonth);
	});

	let aiSummary = $state<AiReportSummary | null>(data.aiSummary?.summary ?? null);
	let aiGeneratedAt = $state<string | null>(data.aiSummary?.generatedAt ?? null);
	let aiModel = $state<string | null>(data.aiSummary?.model ?? null);
	let aiBusy = $state(false);
	let aiError = $state<string | null>(null);
	let aiElapsedSeconds = $state(0);
	let reportJobId = $state<string | null>(null);
	let reportPollTimer = $state<ReturnType<typeof setInterval> | null>(null);
	let aiTickTimer = $state<ReturnType<typeof setInterval> | null>(null);

	let currentPeriodKey = $derived(`${data.period.year}-${data.period.month}`);

	// Re-sync local state when navigating between months (data changes via SvelteKit load).
	// Without this, aiSummary captured at first mount would stay stale across navigation.
	$effect(() => {
		// Track the period key so this effect re-runs on each month change.
		void currentPeriodKey;
		aiSummary = data.aiSummary?.summary ?? null;
		aiGeneratedAt = data.aiSummary?.generatedAt ?? null;
		aiModel = data.aiSummary?.model ?? null;
		stopAiTimers();
		reportJobId = null;
		aiBusy = false;
		aiElapsedSeconds = 0;
		aiError = null;
	});

	$effect(() => () => stopAiTimers());

	$effect(() => {
		console.log('[regen] aiBusy =', aiBusy, '| elapsed =', aiElapsedSeconds + 's');
	});

	function stopAiTimers() {
		if (reportPollTimer) {
			clearInterval(reportPollTimer);
			reportPollTimer = null;
		}
		if (aiTickTimer) {
			clearInterval(aiTickTimer);
			aiTickTimer = null;
		}
	}

	function progressLabel(seconds: number): string {
		if (seconds < 15) return 'Lecture des avis du mois…';
		if (seconds < 35) return 'Génération de la synthèse IA…';
		return 'Finalisation…';
	}

	async function generateAiSummary(force = false) {
		console.log('[regen] click', { force, period: `${data.period.year}-${data.period.month}` });
		aiBusy = true;
		aiError = null;
		aiElapsedSeconds = 0;
		stopAiTimers();
		aiTickTimer = setInterval(() => {
			aiElapsedSeconds += 1;
		}, 1000);
		try {
			const tokenParam = $page.url.searchParams.get('token');
			const tokenQs = tokenParam ? `&token=${encodeURIComponent(tokenParam)}` : '';
			const forceQs = force ? '&force=1' : '';
			const period = `${data.period.year}-${String(data.period.month).padStart(2, '0')}`;
			const url = `/api/projects/${data.project.slug}/reviews/ai-summary?period=${period}${forceQs}${tokenQs}`;
			console.log('[regen] POST', url);
			const res = await fetch(url, { method: 'POST' });
			const j = await res.json();
			console.log('[regen] response', { status: res.status, body: j });
			if (!res.ok) throw new Error(j.error ?? `Erreur HTTP ${res.status}`);

			// Chemin sync (token client) — réponse directe
			if ('summary' in j) {
				aiSummary = j.summary;
				aiGeneratedAt = j.generatedAt;
				aiModel = j.model;
				aiBusy = false;
				stopAiTimers();
				return;
			}

			// Chemin admin — background job
			if (!j.jobId) throw new Error('Réponse inattendue (jobId manquant)');
			reportJobId = j.jobId;
			console.log('[regen] polling job', j.jobId);
			let pollCount = 0;
			const maxPolls = 45; // 45 × 2s = 90s timeout
			reportPollTimer = setInterval(async () => {
				pollCount += 1;
				console.log('[regen] tick #' + pollCount + ' fired (before fetch)');
				if (pollCount > maxPolls) {
					console.warn('[regen] timeout after', pollCount, 'polls');
					stopAiTimers();
					aiBusy = false;
					aiError = `Pas de réponse après ${maxPolls * 2}s. Le job tourne peut-être encore : recharge la page dans une minute.`;
					return;
				}
				try {
					const pollUrl = `/api/jobs/${reportJobId}`;
					const pr = await fetch(pollUrl);
					const text = await pr.text();
					let pj: { status?: string; result?: { summary: AiReportSummary; generatedAt: string; model: string }; error?: string } = {};
					try {
						pj = JSON.parse(text);
					} catch {
						console.error('[regen] poll non-JSON response', { status: pr.status, body: text.slice(0, 200) });
						throw new Error(`Réponse non-JSON (HTTP ${pr.status})`);
					}
					console.log('[regen] poll #' + pollCount + ' →', { httpStatus: pr.status, jobStatus: pj.status });
					if (!pr.ok) {
						throw new Error(pj.error ?? `Polling HTTP ${pr.status}`);
					}
					if (pj.status === 'done') {
						stopAiTimers();
						aiBusy = false;
						aiSummary = pj.result?.summary ?? null;
						aiGeneratedAt = pj.result?.generatedAt ?? null;
						aiModel = pj.result?.model ?? null;
					} else if (pj.status === 'error') {
						stopAiTimers();
						aiBusy = false;
						aiError = pj.error ?? 'Erreur côté serveur';
					}
				} catch (pollErr) {
					console.error('[regen] poll error', pollErr);
					stopAiTimers();
					aiBusy = false;
					aiError = (pollErr as Error).message;
				}
			}, 2000);
		} catch (err) {
			console.error('[regen] error', err);
			stopAiTimers();
			aiBusy = false;
			aiError = (err as Error).message;
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
		<h1 class="text-4xl font-bold tracking-tight text-surface-900 sm:text-5xl">{data.project.name}</h1>
		<p class="mt-1 text-lg text-surface-500">Avis Google — {data.period.label}</p>

		<nav class="mt-5 flex items-center justify-center gap-2">
			<a
				href={buildPeriodUrl(prevNav.year, prevNav.month)}
				class="inline-flex items-center gap-1 rounded-md border border-surface-200 bg-white px-3 py-1.5 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50"
				aria-label="Mois précédent"
			>
				<ChevronLeft size={14} />
				{periodLabel(prevNav.year, prevNav.month)}
			</a>
			{#if nextIsFuture}
				<span
					class="inline-flex cursor-not-allowed items-center gap-1 rounded-md border border-surface-200 bg-surface-50 px-3 py-1.5 text-xs font-medium text-surface-300"
					aria-label="Mois suivant indisponible"
				>
					{periodLabel(nextNav.year, nextNav.month)}
					<ChevronRight size={14} />
				</span>
			{:else}
				<a
					href={buildPeriodUrl(nextNav.year, nextNav.month)}
					class="inline-flex items-center gap-1 rounded-md border border-surface-200 bg-white px-3 py-1.5 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50"
					aria-label="Mois suivant"
				>
					{periodLabel(nextNav.year, nextNav.month)}
					<ChevronRight size={14} />
				</a>
			{/if}
		</nav>
	</header>

	<!-- Admin actions bar -->
	{#if data.isAdmin}
		{#if aiBusy}
			<!-- Full-width prominent banner : impossible to miss -->
			<div
				class="mb-6 flex items-center gap-4 rounded-xl border-2 border-amber-400 bg-amber-100 px-5 py-4 shadow-md"
				role="status"
				aria-live="polite"
			>
				<Loader size={24} class="shrink-0 animate-spin text-amber-700" />
				<div class="flex-1">
					<p class="text-sm font-semibold text-amber-900">Régénération de la synthèse en cours…</p>
					<p class="mt-0.5 text-xs text-amber-800">
						{progressLabel(aiElapsedSeconds)} · {aiElapsedSeconds}s écoulées
					</p>
				</div>
				<div class="hidden text-right sm:block">
					<p class="text-2xl font-bold tabular-nums text-amber-900">{aiElapsedSeconds}<span class="text-sm font-medium">s</span></p>
					<p class="text-[10px] uppercase tracking-wider text-amber-700">temps</p>
				</div>
			</div>
		{:else}
			<div class="mb-6 flex flex-col items-end gap-2">
				{#if aiSummary}
					<button
						onclick={() => generateAiSummary(true)}
						class="inline-flex items-center gap-1.5 rounded-md border border-surface-200 bg-white px-3 py-1.5 text-xs font-medium text-surface-700 shadow-sm transition-colors hover:bg-surface-50"
					>
						<RefreshCw size={14} />
						Régénérer la synthèse
					</button>
				{:else}
					<button
						onclick={() => generateAiSummary(false)}
						disabled={data.stats.totalReviews === 0}
						class="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-50"
						title={data.stats.totalReviews === 0 ? 'Aucun avis sur la période' : ''}
					>
						<Sparkles size={14} />
						Générer la synthèse
					</button>
				{/if}
				{#if aiError}
					<span class="inline-flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700">
						Erreur : {aiError}
					</span>
				{/if}
			</div>
		{/if}
	{/if}

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

				{#if aiSummary.trend_vs_previous}
					{@const maxVol = Math.max(data.stats.totalReviews, data.trends.prevTotal, 1)}
					{@const maxRating = 5}
					{@const maxStarCount = Math.max(data.stats.totalReviews, data.trends.prevTotal, 1)}
					<div class="mt-4 rounded-xl bg-surface-50 px-4 py-4">
						<p class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Évolution vs {data.prevPeriod.label}</p>

						<!-- Volume + Note côte à côte -->
						<div class="mt-3 grid grid-cols-2 gap-4">
							<!-- Volume -->
							<div>
								<p class="mb-2 text-[10px] font-medium text-surface-400 uppercase tracking-wide">Volume</p>
								<div class="space-y-1.5">
									<div class="flex items-center gap-2">
										<span class="w-16 shrink-0 text-[10px] text-surface-400">{data.prevPeriod.label.split(' ').slice(0,1).join('')}</span>
										<div class="flex-1 overflow-hidden rounded-full bg-surface-200" style="height:6px">
											<div class="h-full rounded-full bg-surface-400" style="width:{(data.trends.prevTotal/maxVol*100).toFixed(1)}%"></div>
										</div>
										<span class="w-8 text-right text-[11px] font-medium text-surface-500">{data.trends.prevTotal}</span>
									</div>
									<div class="flex items-center gap-2">
										<span class="w-16 shrink-0 text-[10px] font-semibold text-surface-700">{data.period.label.split(' ').slice(0,1).join('')}</span>
										<div class="flex-1 overflow-hidden rounded-full bg-surface-200" style="height:6px">
											<div class="h-full rounded-full {data.trends.deltaVolume >= 0 ? 'bg-emerald-500' : 'bg-red-400'}" style="width:{(data.stats.totalReviews/maxVol*100).toFixed(1)}%"></div>
										</div>
										<span class="w-8 text-right text-[11px] font-bold {trendColor(data.trends.deltaVolume)}">{data.stats.totalReviews}</span>
									</div>
								</div>
								{#if data.trends.prevTotal > 0}
									<p class="mt-1 text-[10px] {trendColor(data.trends.deltaVolume)}">{trendIcon(data.trends.deltaVolume)} {data.trends.deltaVolume > 0 ? '+' : ''}{data.trends.deltaVolume} avis</p>
								{/if}
							</div>

							<!-- Note moyenne -->
							<div>
								<p class="mb-2 text-[10px] font-medium text-surface-400 uppercase tracking-wide">Note moyenne</p>
								<div class="space-y-1.5">
									<div class="flex items-center gap-2">
										<span class="w-16 shrink-0 text-[10px] text-surface-400">{data.prevPeriod.label.split(' ').slice(0,1).join('')}</span>
										<div class="flex-1 overflow-hidden rounded-full bg-surface-200" style="height:6px">
											<div class="h-full rounded-full bg-surface-400" style="width:{(data.trends.prevAvgRating/maxRating*100).toFixed(1)}%"></div>
										</div>
										<span class="w-8 text-right text-[11px] font-medium text-surface-500">{data.trends.prevAvgRating}</span>
									</div>
									<div class="flex items-center gap-2">
										<span class="w-16 shrink-0 text-[10px] font-semibold text-surface-700">{data.period.label.split(' ').slice(0,1).join('')}</span>
										<div class="flex-1 overflow-hidden rounded-full bg-surface-200" style="height:6px">
											<div class="h-full rounded-full {data.trends.deltaRating >= 0 ? 'bg-emerald-500' : 'bg-red-400'}" style="width:{(data.stats.avgRating/maxRating*100).toFixed(1)}%"></div>
										</div>
										<span class="w-8 text-right text-[11px] font-bold {trendColor(data.trends.deltaRating)}">{data.stats.avgRating}</span>
									</div>
								</div>
								{#if data.trends.prevTotal > 0}
									<p class="mt-1 text-[10px] {trendColor(data.trends.deltaRating)}">{trendIcon(data.trends.deltaRating)} {data.trends.deltaRating > 0 ? '+' : ''}{data.trends.deltaRating} étoile</p>
								{/if}
							</div>
						</div>

						<!-- Distribution étoiles comparée -->
						{#if data.trends.prevTotal > 0}
							<div class="mt-4 space-y-2">
								<p class="text-[10px] font-medium uppercase tracking-wide text-surface-400">Distribution étoiles</p>
								{#each [5,4,3,2,1] as star}
									{@const curr = data.stats.stars[star] ?? 0}
									{@const prev = data.prevStars[star] ?? 0}
									{@const colorClass = star >= 4 ? 'bg-emerald-500' : star === 3 ? 'bg-amber-400' : 'bg-red-400'}
									<div class="flex items-center gap-2">
										<span class="w-5 shrink-0 text-right text-[10px] text-surface-500">{star}★</span>
										<div class="flex flex-1 flex-col gap-0.5">
											<div class="flex items-center gap-1">
												<div class="flex-1 overflow-hidden rounded-full bg-surface-200" style="height:4px">
													<div class="h-full rounded-full {colorClass}" style="width:{(curr/maxStarCount*100).toFixed(1)}%"></div>
												</div>
												<span class="w-5 text-right text-[9px] font-medium text-surface-600">{curr}</span>
											</div>
											<div class="flex items-center gap-1">
												<div class="flex-1 overflow-hidden rounded-full bg-surface-200" style="height:4px">
													<div class="h-full rounded-full bg-surface-300" style="width:{(prev/maxStarCount*100).toFixed(1)}%"></div>
												</div>
												<span class="w-5 text-right text-[9px] text-surface-400">{prev}</span>
											</div>
										</div>
									</div>
								{/each}
								<div class="flex gap-3 pt-1 text-[9px] text-surface-400">
									<span class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-full bg-emerald-500"></span>Ce mois</span>
									<span class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-full bg-surface-300"></span>{data.prevPeriod.label}</span>
								</div>
							</div>
						{/if}

						<!-- Highlights IA -->
						{#if aiSummary.trend_vs_previous.highlights?.length}
							<ul class="mt-4 space-y-1 border-t border-surface-200 pt-3 text-sm text-surface-700">
								{#each aiSummary.trend_vs_previous.highlights as h}
									<li class="flex gap-2"><span class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-surface-400"></span>{h}</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}

				{#if aiSummary.by_location?.length}
					<div class="mt-5 space-y-3">
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
						<div class="mt-2 grid gap-2 sm:grid-cols-2">
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
								<li class="rounded-xl border border-surface-100 bg-surface-50/60 p-3">
									<span class="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset {priorityTone(a.priority)}">
										{priorityLabel(a.priority)}
									</span>
									<p class="mt-1.5 text-sm font-medium text-surface-800">{a.action}</p>
									<p class="mt-0.5 text-xs text-surface-500">{a.reason}</p>
								</li>
							{/each}
						</ol>
					</div>
				{/if}

				<div class="mt-6 border-t border-surface-200 pt-3 text-[11px] text-surface-400">
					{#if aiGeneratedAt}Généré le {formatDateTime(aiGeneratedAt)}{/if}
					{#if aiModel} · {aiModel}{/if}
				</div>
			</div>
		{:else}
			<div class="rounded-2xl border border-dashed border-surface-300 bg-white px-6 py-8 text-center">
				<p class="text-sm font-semibold text-surface-700">Synthèse IA du mois</p>
				<p class="mt-1 text-xs text-surface-500">
					Une lecture structurée des avis du mois (évolution vs {data.prevPeriod.label}, diagnostic par établissement, actions recommandées).
				</p>
				{#if data.isAdmin && data.stats.totalReviews === 0}
					<p class="mt-3 text-[11px] text-surface-400">Aucun avis sur la période.</p>
				{:else if !data.isAdmin}
					<p class="mt-3 text-[11px] text-surface-400">La synthèse n'a pas encore été générée pour ce mois.</p>
				{:else}
					<p class="mt-3 text-[11px] text-surface-400">Cliquez sur « Générer la synthèse » en haut à droite pour lancer l'analyse.</p>
				{/if}
			</div>
		{/if}
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
