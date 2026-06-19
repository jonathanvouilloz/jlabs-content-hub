<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { ChevronLeft, ChevronRight, RefreshCw, Loader, AlertCircle, Sparkles, Plus } from 'lucide-svelte';

	let { data } = $props();

	const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

	function addDays(iso: string, days: number): string {
		const d = new Date(`${iso}T00:00:00Z`);
		d.setUTCDate(d.getUTCDate() + days);
		return d.toISOString().slice(0, 10);
	}

	function formatWeekRange(weekStart: string): string {
		const start = new Date(`${weekStart}T00:00:00Z`);
		const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
		const sd = start.getUTCDate();
		const sm = MONTHS_SHORT[start.getUTCMonth()];
		const ed = end.getUTCDate();
		const em = MONTHS_SHORT[end.getUTCMonth()];
		const ey = end.getUTCFullYear();
		if (sm === em) return `${sd} – ${ed} ${em} ${ey}`;
		return `${sd} ${sm} – ${ed} ${em} ${ey}`;
	}

	function gotoWeek(weekStart: string) {
		const params = new URLSearchParams();
		params.set('week', weekStart);
		goto(`?${params.toString()}`);
	}

	let prevWeek = $derived(addDays(data.weekStart, -7));
	let nextWeek = $derived(addDays(data.weekStart, 7));
	let nextIsFuture = $derived.by(() => {
		const today = new Date().toISOString().slice(0, 10);
		return nextWeek > today;
	});

	let busy = $state(false);
	let busyLabel = $state('');
	let busyError = $state<string | null>(null);
	let elapsed = $state(0);
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let tickTimer: ReturnType<typeof setInterval> | null = null;

	function stopTimers() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
	}

	$effect(() => () => stopTimers());

	async function runJob(endpoint: string, body: unknown, label: string) {
		busy = true;
		busyError = null;
		busyLabel = label;
		elapsed = 0;
		stopTimers();
		tickTimer = setInterval(() => {
			elapsed += 1;
		}, 1000);
		try {
			const res = await fetch(`/api/projects/${data.project.slug}/gsc/${endpoint}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const j = await res.json();
			if (!res.ok) throw new Error(j.error ?? `Erreur HTTP ${res.status}`);
			if (!j.jobId) throw new Error('Réponse inattendue (jobId manquant)');

			let pollCount = 0;
			const maxPolls = 120; // 4 min max
			pollTimer = setInterval(async () => {
				pollCount += 1;
				if (pollCount > maxPolls) {
					stopTimers();
					busy = false;
					busyError = 'Timeout. Le job tourne peut-être encore — recharge la page dans une minute.';
					return;
				}
				try {
					const pr = await fetch(`/api/jobs/${j.jobId}`);
					const pj = await pr.json();
					if (!pr.ok) throw new Error(pj.error ?? `HTTP ${pr.status}`);
					if (pj.status === 'done') {
						stopTimers();
						busy = false;
						await invalidateAll();
					} else if (pj.status === 'error') {
						stopTimers();
						busy = false;
						busyError = pj.error ?? 'Erreur côté serveur';
					}
				} catch (err) {
					stopTimers();
					busy = false;
					busyError = (err as Error).message;
				}
			}, 2000);
		} catch (err) {
			stopTimers();
			busy = false;
			busyError = (err as Error).message;
		}
	}

	function snapshotCurrent() {
		runJob('snapshot', { weekStart: data.weekStart, force: false }, 'Snapshot semaine en cours');
	}

	function snapshotForce() {
		runJob('snapshot', { weekStart: data.weekStart, force: true }, 'Re-pull de la semaine');
	}

	function backfill4() {
		runJob('backfill', { weeks: 4 }, 'Backfill 4 dernières semaines');
	}

	function fmtInt(n: number): string {
		return n.toLocaleString('fr-CH');
	}
	function fmtPct(n: number, digits = 1): string {
		return `${(n * 100).toFixed(digits)}%`;
	}
	function fmtPosition(n: number): string {
		return n.toFixed(1);
	}
	function fmtSignedInt(n: number): string {
		if (n > 0) return `+${fmtInt(n)}`;
		return fmtInt(n);
	}
	function fmtSignedPct(n: number, digits = 1): string {
		if (Number.isNaN(n) || !Number.isFinite(n)) return '—';
		const sign = n > 0 ? '+' : '';
		return `${sign}${n.toFixed(digits)}%`;
	}
	function fmtSignedPos(n: number): string {
		if (n === 0) return '±0';
		const sign = n > 0 ? '+' : '';
		return `${sign}${n.toFixed(1)}`;
	}
	function deltaColor(delta: number, inverse = false): string {
		const positive = inverse ? delta < 0 : delta > 0;
		const negative = inverse ? delta > 0 : delta < 0;
		if (positive) return 'text-emerald-600';
		if (negative) return 'text-red-500';
		return 'text-surface-400';
	}

	function shortPage(url: string): string {
		try {
			const u = new URL(url);
			const path = u.pathname === '/' ? '/' : u.pathname.replace(/\/$/, '');
			return path.length > 50 ? path.slice(0, 47) + '…' : path;
		} catch {
			return url;
		}
	}

	// « + suivre » sur un conflit → ajoute le mot-clé à la watchlist (onglet Positions).
	let tracking = $state<string | null>(null);
	let tracked = $state<Set<string>>(new Set());
	let trackError = $state<string | null>(null);

	async function trackKeyword(keyword: string) {
		tracking = keyword;
		trackError = null;
		try {
			const res = await fetch(`/api/projects/${data.project.slug}/keywords`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ keyword })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				trackError = body.error ?? 'Erreur lors du suivi';
				return;
			}
			tracked = new Set(tracked).add(keyword);
		} finally {
			tracking = null;
		}
	}
</script>

<svelte:head>
	<title>SEO data — {data.project.name}</title>
</svelte:head>

<div class="space-y-6">
	<div class="flex items-start justify-between gap-4">
		<div>
			<h1 class="text-xl font-semibold text-surface-900">Données SEO hebdomadaires</h1>
			<p class="mt-0.5 text-xs text-surface-400">
				{#if data.hasGsc}
					Source : Google Search Console — {data.siteUrl}
				{:else}
					Service account et site URL à configurer dans <a href="settings" class="text-primary-600 hover:underline">les paramètres</a>.
				{/if}
			</p>
		</div>
		{#if data.hasGsc}
			<div class="flex items-center gap-2">
				<button
					onclick={snapshotCurrent}
					disabled={busy}
					class="inline-flex items-center gap-1.5 rounded-md border border-surface-200 bg-white px-3 py-1.5 text-xs font-medium text-surface-700 shadow-sm transition-colors hover:bg-surface-50 disabled:opacity-50"
				>
					<RefreshCw size={14} />
					Snapshot
				</button>
				<button
					onclick={backfill4}
					disabled={busy}
					class="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-50"
				>
					<Sparkles size={14} />
					Backfill 4 semaines
				</button>
			</div>
		{/if}
	</div>

	{#if !data.hasGsc}
		<div class="rounded-xl border border-amber-200 bg-amber-50 p-6">
			<div class="flex items-start gap-3">
				<AlertCircle size={20} class="shrink-0 text-amber-600" />
				<div>
					<p class="text-sm font-medium text-amber-900">Configuration GSC manquante</p>
					<p class="mt-1 text-xs text-amber-800">
						Pour activer les snapshots Search Console, configure d'abord le service account et le siteUrl dans
						<a href="settings" class="font-medium underline">les paramètres du projet</a>.
					</p>
				</div>
			</div>
		</div>
	{:else if busy}
		<div class="flex items-center gap-4 rounded-xl border-2 border-amber-400 bg-amber-100 px-5 py-4 shadow-md">
			<Loader size={24} class="shrink-0 animate-spin text-amber-700" />
			<div class="flex-1">
				<p class="text-sm font-semibold text-amber-900">{busyLabel} en cours…</p>
				<p class="mt-0.5 text-xs text-amber-800">{elapsed}s écoulées — {data.weekStart}</p>
			</div>
		</div>
	{:else if busyError}
		<div class="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
			Erreur : {busyError}
		</div>
	{/if}

	{#if data.hasGsc}
		<!-- Week selector -->
		<nav class="flex items-center justify-between rounded-xl border border-surface-200 bg-white px-4 py-3">
			<button
				onclick={() => gotoWeek(prevWeek)}
				class="inline-flex items-center gap-1 rounded-md border border-surface-200 bg-white px-3 py-1.5 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50"
				aria-label="Semaine précédente"
			>
				<ChevronLeft size={14} />
				{formatWeekRange(prevWeek)}
			</button>
			<div class="text-center">
				<p class="text-xs uppercase tracking-wider text-surface-400">Semaine</p>
				<p class="text-sm font-semibold text-surface-900">{formatWeekRange(data.weekStart)}</p>
			</div>
			{#if nextIsFuture}
				<span class="inline-flex cursor-not-allowed items-center gap-1 rounded-md border border-surface-200 bg-surface-50 px-3 py-1.5 text-xs font-medium text-surface-300">
					{formatWeekRange(nextWeek)}
					<ChevronRight size={14} />
				</span>
			{:else}
				<button
					onclick={() => gotoWeek(nextWeek)}
					class="inline-flex items-center gap-1 rounded-md border border-surface-200 bg-white px-3 py-1.5 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50"
					aria-label="Semaine suivante"
				>
					{formatWeekRange(nextWeek)}
					<ChevronRight size={14} />
				</button>
			{/if}
		</nav>

		{#if !data.snapshot}
			<div class="rounded-xl border border-surface-200 bg-white p-8 text-center">
				<p class="text-sm font-medium text-surface-900">Aucun snapshot pour cette semaine</p>
				<p class="mt-1 text-xs text-surface-500">
					Lance le backfill pour récupérer les 4 dernières semaines, ou un snapshot ponctuel pour {formatWeekRange(data.weekStart)}.
				</p>
				<div class="mt-4 flex items-center justify-center gap-2">
					<button
						onclick={snapshotCurrent}
						disabled={busy}
						class="inline-flex items-center gap-1.5 rounded-md border border-surface-200 bg-white px-3 py-1.5 text-xs font-medium text-surface-700 shadow-sm transition-colors hover:bg-surface-50 disabled:opacity-50"
					>
						<RefreshCw size={14} />
						Snapshot cette semaine
					</button>
					<button
						onclick={backfill4}
						disabled={busy}
						class="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-50"
					>
						<Sparkles size={14} />
						Backfill 4 semaines
					</button>
				</div>
			</div>
		{:else if data.snapshot.status === 'failed'}
			<div class="rounded-xl border border-red-300 bg-red-50 p-6">
				<p class="text-sm font-medium text-red-900">Snapshot en erreur</p>
				<p class="mt-1 text-xs text-red-700">{data.snapshot.errorMessage ?? 'Erreur inconnue'}</p>
				<button
					onclick={snapshotForce}
					disabled={busy}
					class="mt-3 inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 shadow-sm transition-colors hover:bg-red-100 disabled:opacity-50"
				>
					<RefreshCw size={14} />
					Re-tenter
				</button>
			</div>
		{:else}
			<!-- KPI Cards -->
			<section class="grid grid-cols-2 gap-4 sm:grid-cols-4">
				<div class="rounded-xl border border-surface-200 bg-white p-5 text-center">
					<p class="text-3xl font-bold text-surface-900">{fmtInt(data.snapshot.totalClicks)}</p>
					<p class="mt-1 text-xs text-surface-500">Clics</p>
					{#if data.diff}
						<p class="mt-1 text-xs {deltaColor(data.diff.kpis.clicks.deltaAbs)}">
							{fmtSignedInt(data.diff.kpis.clicks.deltaAbs)} ({fmtSignedPct(data.diff.kpis.clicks.deltaPct, 0)})
						</p>
					{/if}
				</div>
				<div class="rounded-xl border border-surface-200 bg-white p-5 text-center">
					<p class="text-3xl font-bold text-surface-900">{fmtInt(data.snapshot.totalImpressions)}</p>
					<p class="mt-1 text-xs text-surface-500">Impressions</p>
					{#if data.diff}
						<p class="mt-1 text-xs {deltaColor(data.diff.kpis.impressions.deltaAbs)}">
							{fmtSignedInt(data.diff.kpis.impressions.deltaAbs)} ({fmtSignedPct(data.diff.kpis.impressions.deltaPct, 0)})
						</p>
					{/if}
				</div>
				<div class="rounded-xl border border-surface-200 bg-white p-5 text-center">
					<p class="text-3xl font-bold text-surface-900">{fmtPct(data.snapshot.avgCtr)}</p>
					<p class="mt-1 text-xs text-surface-500">CTR</p>
					{#if data.diff}
						<p class="mt-1 text-xs {deltaColor(data.diff.kpis.ctr.deltaAbs)}">
							{fmtSignedPct(data.diff.kpis.ctr.deltaAbs * 100, 2)}
						</p>
					{/if}
				</div>
				<div class="rounded-xl border border-surface-200 bg-white p-5 text-center">
					<p class="text-3xl font-bold text-surface-900">{fmtPosition(data.snapshot.avgPosition)}</p>
					<p class="mt-1 text-xs text-surface-500">Position moy.</p>
					{#if data.diff}
						<p class="mt-1 text-xs {deltaColor(data.diff.kpis.position.deltaAbs, true)}">
							{fmtSignedPos(data.diff.kpis.position.deltaAbs)}
						</p>
					{/if}
				</div>
			</section>

			{#if !data.diff}
				<div class="rounded-xl border border-surface-200 bg-surface-50 p-4 text-center text-xs text-surface-500">
					Pas de comparaison disponible (snapshot N-1 manquant). Lance le backfill pour générer les diffs.
				</div>
			{:else}
				<!-- Rising -->
				{#if data.diff.rising.length > 0}
					<section class="overflow-hidden rounded-xl border border-surface-200 bg-white">
						<header class="flex items-center justify-between border-b border-surface-100 bg-emerald-50 px-4 py-2.5">
							<h2 class="text-sm font-semibold text-emerald-900">↑ Mots-clés en hausse</h2>
							<span class="text-xs text-emerald-700">Top {data.diff.rising.length}</span>
						</header>
						<table class="w-full text-xs">
							<thead class="bg-surface-50 text-surface-500">
								<tr>
									<th class="px-3 py-2 text-left font-medium">Query</th>
									<th class="px-3 py-2 text-left font-medium">Page</th>
									<th class="px-3 py-2 text-right font-medium">Clics</th>
									<th class="px-3 py-2 text-right font-medium">Impressions</th>
									<th class="px-3 py-2 text-right font-medium">Position</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-surface-100">
								{#each data.diff.rising as e}
									<tr>
										<td class="max-w-[280px] truncate px-3 py-2 font-medium text-surface-900">{e.query}</td>
										<td class="max-w-[200px] truncate px-3 py-2 text-surface-500">{shortPage(e.page)}</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-900">
											{fmtInt(e.clicks)}
											<span class="ml-1 text-emerald-600">{fmtSignedInt(e.deltaClicks)}</span>
										</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-900">
											{fmtInt(e.impressions)}
											<span class="ml-1 {deltaColor(e.deltaImpressions)}">{fmtSignedInt(e.deltaImpressions)}</span>
										</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-900">
											{fmtPosition(e.position)}
											<span class="ml-1 {deltaColor(e.deltaPosition, true)}">{fmtSignedPos(e.deltaPosition)}</span>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</section>
				{/if}

				<!-- Falling -->
				{#if data.diff.falling.length > 0}
					<section class="overflow-hidden rounded-xl border border-surface-200 bg-white">
						<header class="flex items-center justify-between border-b border-surface-100 bg-red-50 px-4 py-2.5">
							<h2 class="text-sm font-semibold text-red-900">↓ Mots-clés en baisse</h2>
							<span class="text-xs text-red-700">Top {data.diff.falling.length}</span>
						</header>
						<table class="w-full text-xs">
							<thead class="bg-surface-50 text-surface-500">
								<tr>
									<th class="px-3 py-2 text-left font-medium">Query</th>
									<th class="px-3 py-2 text-left font-medium">Page</th>
									<th class="px-3 py-2 text-right font-medium">Clics</th>
									<th class="px-3 py-2 text-right font-medium">Impressions</th>
									<th class="px-3 py-2 text-right font-medium">Position</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-surface-100">
								{#each data.diff.falling as e}
									<tr>
										<td class="max-w-[280px] truncate px-3 py-2 font-medium text-surface-900">{e.query}</td>
										<td class="max-w-[200px] truncate px-3 py-2 text-surface-500">{shortPage(e.page)}</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-900">
											{fmtInt(e.clicks)}
											<span class="ml-1 text-red-500">{fmtSignedInt(e.deltaClicks)}</span>
										</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-900">
											{fmtInt(e.impressions)}
											<span class="ml-1 {deltaColor(e.deltaImpressions)}">{fmtSignedInt(e.deltaImpressions)}</span>
										</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-900">
											{fmtPosition(e.position)}
											<span class="ml-1 {deltaColor(e.deltaPosition, true)}">{fmtSignedPos(e.deltaPosition)}</span>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</section>
				{/if}

				<!-- Opportunities -->
				{#if data.diff.opportunities.length > 0}
					<section class="overflow-hidden rounded-xl border border-surface-200 bg-white">
						<header class="flex items-center justify-between border-b border-surface-100 bg-amber-50 px-4 py-2.5">
							<h2 class="text-sm font-semibold text-amber-900">💡 Opportunités</h2>
							<span class="text-xs text-amber-700">Beaucoup d'impressions, 0 clic, position {'>'}20</span>
						</header>
						<table class="w-full text-xs">
							<thead class="bg-surface-50 text-surface-500">
								<tr>
									<th class="px-3 py-2 text-left font-medium">Query</th>
									<th class="px-3 py-2 text-left font-medium">Page top</th>
									<th class="px-3 py-2 text-right font-medium">Impressions</th>
									<th class="px-3 py-2 text-right font-medium">Position</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-surface-100">
								{#each data.diff.opportunities as e}
									<tr>
										<td class="max-w-[280px] truncate px-3 py-2 font-medium text-surface-900">{e.query}</td>
										<td class="max-w-[200px] truncate px-3 py-2 text-surface-500">{shortPage(e.page)}</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-900">{fmtInt(e.impressions)}</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-900">{fmtPosition(e.position)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</section>
				{/if}

				<!-- New keywords -->
				{#if data.diff.newKeywords.length > 0}
					<section class="overflow-hidden rounded-xl border border-surface-200 bg-white">
						<header class="flex items-center justify-between border-b border-surface-100 bg-sky-50 px-4 py-2.5">
							<h2 class="text-sm font-semibold text-sky-900">🆕 Nouvelles queries</h2>
							<span class="text-xs text-sky-700">Apparues cette semaine</span>
						</header>
						<table class="w-full text-xs">
							<thead class="bg-surface-50 text-surface-500">
								<tr>
									<th class="px-3 py-2 text-left font-medium">Query</th>
									<th class="px-3 py-2 text-left font-medium">Page</th>
									<th class="px-3 py-2 text-right font-medium">Impressions</th>
									<th class="px-3 py-2 text-right font-medium">Clics</th>
									<th class="px-3 py-2 text-right font-medium">Position</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-surface-100">
								{#each data.diff.newKeywords as e}
									<tr>
										<td class="max-w-[280px] truncate px-3 py-2 font-medium text-surface-900">{e.query}</td>
										<td class="max-w-[200px] truncate px-3 py-2 text-surface-500">{shortPage(e.page)}</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-900">{fmtInt(e.impressions)}</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-900">{fmtInt(e.clicks)}</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-900">{fmtPosition(e.position)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</section>
				{/if}

				<!-- Lost keywords -->
				{#if data.diff.lostKeywords.length > 0}
					<section class="overflow-hidden rounded-xl border border-surface-200 bg-white">
						<header class="flex items-center justify-between border-b border-surface-100 bg-surface-50 px-4 py-2.5">
							<h2 class="text-sm font-semibold text-surface-700">Queries disparues</h2>
							<span class="text-xs text-surface-500">Présentes en N-1, absentes cette semaine</span>
						</header>
						<table class="w-full text-xs">
							<thead class="bg-surface-50 text-surface-500">
								<tr>
									<th class="px-3 py-2 text-left font-medium">Query</th>
									<th class="px-3 py-2 text-right font-medium">Imp. N-1</th>
									<th class="px-3 py-2 text-right font-medium">Clics N-1</th>
									<th class="px-3 py-2 text-right font-medium">Pos. N-1</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-surface-100">
								{#each data.diff.lostKeywords as e}
									<tr>
										<td class="max-w-[400px] truncate px-3 py-2 font-medium text-surface-900">{e.query}</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-500">{fmtInt(e.impressionsPrev)}</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-500">{fmtInt(e.clicksPrev)}</td>
										<td class="px-3 py-2 text-right tabular-nums text-surface-500">{fmtPosition(e.positionPrev)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</section>
				{/if}
			{/if}
		{/if}

		<!-- Cannibalisation -->
		{#if data.cannibalization.length > 0}
			<section class="overflow-hidden rounded-xl border border-surface-200 bg-white">
				<header class="flex items-center justify-between border-b border-surface-100 bg-red-50 px-4 py-2.5">
					<h2 class="text-sm font-semibold text-red-900">⚠ Cannibalisation</h2>
					<span class="text-xs text-red-700">
						{data.cannibalization.length} requête(s) — plusieurs URLs en concurrence
					</span>
				</header>
				<table class="w-full text-xs">
					<thead class="bg-surface-50 text-surface-500">
						<tr>
							<th class="px-3 py-2 text-left font-medium">Mot-clé</th>
							<th class="px-3 py-2 text-left font-medium">URLs en conflit (position · part d'impressions)</th>
							<th class="px-3 py-2 text-right font-medium">Écart pos.</th>
							<th class="px-3 py-2"></th>
						</tr>
					</thead>
					<tbody class="divide-y divide-surface-100">
						{#each data.cannibalization as c}
							<tr class={c.severity === 'high' ? 'bg-red-50/40' : ''}>
								<td class="max-w-[220px] px-3 py-2 align-top">
									<p class="truncate font-medium text-surface-900">{c.query}</p>
									<p class="text-surface-400">
										{fmtInt(c.totalImpressions)} impr.{#if c.severity === 'high'}
											· <span class="font-medium text-red-600">{c.conflictsInTop20} en top 20</span>
										{/if}
									</p>
								</td>
								<td class="px-3 py-2 align-top">
									<ul class="space-y-1">
										{#each c.pages as p}
											<li class="flex items-center gap-2">
												<span class="inline-block w-9 shrink-0 text-right tabular-nums {p.position <= 20 ? 'font-medium text-red-600' : 'text-surface-400'}">#{fmtPosition(p.position)}</span>
												<a href={p.page} target="_blank" rel="noreferrer" class="max-w-[260px] truncate text-surface-600 hover:underline">{shortPage(p.page)}</a>
												<span class="shrink-0 tabular-nums text-surface-400">{fmtPct(p.share, 0)}</span>
											</li>
										{/each}
									</ul>
								</td>
								<td class="px-3 py-2 text-right align-top tabular-nums text-surface-900">{fmtPosition(c.positionSpread)}</td>
								<td class="px-3 py-2 text-right align-top">
									{#if tracked.has(c.query)}
										<span class="inline-flex items-center gap-1 text-emerald-600">✓ suivi</span>
									{:else}
										<button
											class="inline-flex shrink-0 items-center gap-1 rounded-lg border border-surface-300 px-2 py-1 text-surface-600 hover:bg-surface-50 disabled:opacity-50"
											disabled={tracking === c.query}
											onclick={() => trackKeyword(c.query)}
										>
											<Plus size={12} /> suivre
										</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
				{#if trackError}
					<p class="px-4 py-2 text-xs text-red-600">{trackError}</p>
				{/if}
			</section>
		{/if}

		<!-- History list -->
		{#if data.history.length > 0}
			<section class="overflow-hidden rounded-xl border border-surface-200 bg-white">
				<header class="border-b border-surface-100 bg-surface-50 px-4 py-2.5">
					<h2 class="text-sm font-semibold text-surface-700">Historique des snapshots</h2>
				</header>
				<table class="w-full text-xs">
					<thead class="bg-surface-50 text-surface-500">
						<tr>
							<th class="px-3 py-2 text-left font-medium">Semaine</th>
							<th class="px-3 py-2 text-right font-medium">Clics</th>
							<th class="px-3 py-2 text-right font-medium">Impressions</th>
							<th class="px-3 py-2 text-right font-medium">CTR</th>
							<th class="px-3 py-2 text-right font-medium">Position</th>
							<th class="px-3 py-2 text-right font-medium">Status</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-surface-100">
						{#each data.history as h}
							<tr class:bg-surface-50={h.weekStart === data.weekStart}>
								<td class="px-3 py-2">
									<button onclick={() => gotoWeek(h.weekStart)} class="font-medium text-surface-900 hover:text-primary-600 hover:underline">
										{formatWeekRange(h.weekStart)}
									</button>
								</td>
								<td class="px-3 py-2 text-right tabular-nums text-surface-900">{fmtInt(h.totalClicks)}</td>
								<td class="px-3 py-2 text-right tabular-nums text-surface-900">{fmtInt(h.totalImpressions)}</td>
								<td class="px-3 py-2 text-right tabular-nums text-surface-900">{fmtPct(h.avgCtr)}</td>
								<td class="px-3 py-2 text-right tabular-nums text-surface-900">{fmtPosition(h.avgPosition)}</td>
								<td class="px-3 py-2 text-right">
									{#if h.status === 'success'}
										<span class="text-emerald-600">✓</span>
									{:else if h.status === 'failed'}
										<span class="text-red-500">✗</span>
									{:else}
										<span class="text-amber-500">⋯</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		{/if}
	{/if}
</div>
