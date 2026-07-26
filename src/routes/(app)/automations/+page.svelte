<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import {
		AlarmClockOff,
		CalendarClock,
		Gauge,
		PauseCircle,
		ShieldCheck,
		ToggleLeft
	} from 'lucide-svelte';
	import {
		CADENCE_HEALTH_LABEL,
		CADENCE_LABEL,
		CAPACITY_STATE_LABEL,
		PROVIDER_LABEL,
		RUN_STATUS_LABEL,
		STEP_STATUS_LABEL,
		TRIGGER_LABEL,
		formatDbTimestamp,
		formatDuration,
		formatQuota,
		formatRelative,
		formatScheduleSlot
	} from '$lib/utils/job-format.js';

	let { data } = $props();

	let projectSlug = $state<string>('');
	let runStatus = $state<string>('');
	let cadence = $state<string>('');

	// Les contrôles suivent l'URL, ils ne la devinent pas (même règle que `/jobs`) :
	// sans cette synchro, un retour arrière laisserait des sélecteurs qui ne
	// décrivent plus la liste affichée.
	$effect(() => {
		projectSlug = data.filters.projectSlug ?? '';
		runStatus = data.filters.statuses[0] ?? '';
		cadence = data.filters.cadence ?? '';
	});

	function buildParams(overrides: Record<string, string | null>) {
		const params = new URLSearchParams(page.url.searchParams);
		for (const [k, v] of Object.entries(overrides)) {
			if (v === null || v === '') params.delete(k);
			else params.set(k, v);
		}
		if (!('offset' in overrides)) params.delete('offset');
		return params;
	}

	function applyFilters() {
		goto(
			`?${buildParams({
				project: projectSlug || null,
				status: runStatus || null,
				cadence: cadence || null
			})}`,
			{ keepFocus: true }
		);
	}

	// ── Pauses (DASH-006 lot 2) ─────────────────────────────────────────
	//
	// Aucune form action : la discipline du repo est `load` en lecture seule puis POST
	// JSON vers `/api/ops/**` (cf. inbox findings). La RAISON saisie tient lieu de
	// confirmation — pas de `window.confirm`, qui bloquerait sans rien journaliser.

	/**
	 * Les providers qu'on peut suspendre. `none` en est exclu : ce n'est pas un provider
	 * mais son absence — le suspendre couperait détecteurs, veilles et producteur sous un
	 * libellé qui promet le contraire (l'endpoint le refuse aussi).
	 */
	const PAUSABLE_PROVIDERS = ['gsc', 'dataforseo', 'gmb', 'llm'] as const;

	/** Cible du formulaire ouvert, ou null. Une seule à la fois : le geste est délibéré. */
	let pauseForm = $state<{
		scope: 'project_cadence' | 'project' | 'provider';
		eventType: 'paused' | 'resumed';
		projectId?: string;
		cadence?: string;
		provider?: string;
		label: string;
	} | null>(null);
	let pauseReason = $state('');
	let pauseUntilDays = $state('');
	let busy = $state(false);
	let feedback = $state<{ ok: boolean; message: string } | null>(null);

	function openPauseForm(target: NonNullable<typeof pauseForm>) {
		pauseForm = target;
		pauseReason = '';
		pauseUntilDays = '';
		feedback = null;
	}

	async function submitPause() {
		if (!pauseForm || busy) return;
		// Exigée par l'endpoint aussi : la demander ici évite un aller-retour pour rien.
		const reason = pauseReason.trim();
		if (!reason) {
			feedback = { ok: false, message: 'Une raison est requise.' };
			return;
		}
		busy = true;
		try {
			const res = await fetch('/api/ops/automations/pause', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					eventType: pauseForm.eventType,
					scope: pauseForm.scope,
					projectId: pauseForm.projectId ?? null,
					cadence: pauseForm.cadence ?? null,
					provider: pauseForm.provider ?? null,
					reason,
					untilDays: pauseForm.eventType === 'paused' ? pauseUntilDays || null : null
				})
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) {
				feedback = { ok: false, message: payload.error ?? 'Échec de la décision.' };
				return;
			}
			feedback = { ok: true, message: payload.note ?? 'Enregistré.' };
			pauseForm = null;
			pauseReason = '';
			pauseUntilDays = '';
			await invalidateAll();
		} finally {
			busy = false;
		}
	}

	function resetFilters() {
		projectSlug = '';
		runStatus = '';
		cadence = '';
		goto('?', { keepFocus: true });
	}

	function gotoOffset(newOffset: number) {
		goto(`?${buildParams({ offset: newOffset === 0 ? null : String(newOffset) })}`, {
			keepFocus: true
		});
	}

	const totalPages = $derived(Math.ceil(data.totalRuns / data.filters.limit));
	const currentPage = $derived(Math.floor(data.filters.offset / data.filters.limit) + 1);

	// ── Calendrier ───────────────────────────────────────────────────
	// Une cadence non câblée n'a rien à attendre : elle est nommée une fois, en
	// note, plutôt que répétée sur chaque projet.
	const tracked = $derived(data.cadences.filter((r) => r.wired));
	const unwiredCadences = $derived([
		...new Set(data.cadences.filter((r) => !r.wired).map((r) => r.cadence))
	]);

	const byProject = $derived(
		tracked.reduce<Array<{ slug: string; name: string; rows: typeof tracked }>>((acc, row) => {
			const last = acc.at(-1);
			if (last && last.slug === row.projectSlug) last.rows.push(row);
			else acc.push({ slug: row.projectSlug, name: row.projectName, rows: [row] });
			return acc;
		}, [])
	);

	const HEALTH_TONE: Record<string, string> = {
		ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
		late: 'bg-amber-50 text-amber-700 border-amber-200',
		missed: 'bg-red-50 text-red-700 border-red-200',
		disabled: 'bg-surface-50 text-surface-500 border-surface-200',
		// Bleu, jamais rouge ni ambre : une pause est une décision qui tient, pas un
		// incident à traiter. La peindre en alerte remettrait la confusion que ce lot
		// existe pour supprimer.
		paused: 'bg-sky-50 text-sky-700 border-sky-200',
		unwired: 'bg-surface-50 text-surface-400 border-surface-200',
		never_due: 'bg-violet-50 text-violet-700 border-violet-200'
	};

	const RUN_TONE: Record<string, string> = {
		success: 'text-emerald-700',
		partial: 'text-amber-700',
		failed: 'text-red-700',
		cancelled: 'text-surface-500',
		running: 'text-blue-700',
		queued: 'text-surface-500'
	};

	const STEP_TONE: Record<string, string> = {
		success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
		failed: 'bg-red-50 text-red-700 border-red-200',
		skipped: 'bg-violet-50 text-violet-700 border-violet-200',
		provider_unavailable: 'bg-amber-50 text-amber-700 border-amber-200',
		running: 'bg-blue-50 text-blue-700 border-blue-200',
		queued: 'bg-surface-50 text-surface-600 border-surface-200'
	};

	const lookbackHours = $derived(Math.round(data.lookbackMs / 3_600_000));

	const providerRows = $derived(data.rules.capacity.providers.filter((p) => p.provider !== 'none'));
	const activeFlags = $derived(
		Object.entries(data.rules.flags ?? {})
			.filter(([, on]) => on)
			.map(([name]) => name)
	);
</script>

<div class="flex flex-col h-[calc(100vh-73px)] -mx-6 -my-6 lg:-mx-8">
	<!-- Header -->
	<div class="flex-shrink-0 px-6 pt-6 pb-4 lg:px-8">
		<h1 class="text-xl font-semibold text-surface-900">Automatisations</h1>
		<p class="mt-0.5 text-xs text-surface-400">
			Ce que le cockpit devait déclencher, et ce qu'il a réellement déclenché. Créneaux en
			<span class="font-medium">{data.timeZone}</span> (heure métier), horodatages en
			<span class="font-medium">UTC</span>.
		</p>
	</div>

	<!-- Résumé : la seule ligne qui se lit sans rien déplier -->
	<div class="flex-shrink-0 px-6 lg:px-8 pb-3">
		<div
			class="rounded-lg border px-3 py-2 text-xs
				{data.summary.missed > 0
				? 'border-red-200 bg-red-50 text-red-800'
				: data.summary.late > 0
					? 'border-amber-200 bg-amber-50 text-amber-800'
					: 'border-surface-200 bg-white text-surface-600'}"
		>
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				{#if data.summary.missed > 0}
					<AlarmClockOff class="h-4 w-4 flex-shrink-0" />
					<span class="font-semibold">
						{data.summary.missed} créneau{data.summary.missed > 1 ? 'x' : ''} manqué{data.summary
							.missed > 1
							? 's'
							: ''} hors fenêtre de rattrapage
					</span>
					<span>
						— il{data.summary.missed > 1 ? 's' : ''} ne partira{data.summary.missed > 1
							? 'ont'
							: ''} jamais. Projets : {data.summary.projectsMissing.join(', ')}.
					</span>
				{:else if data.summary.late > 0}
					<CalendarClock class="h-4 w-4 flex-shrink-0" />
					<span class="font-semibold">{data.summary.late} créneau(x) en retard</span>
					<span>— encore dans la fenêtre de {lookbackHours} h : le prochain tick les tirera.</span>
				{:else}
					<ShieldCheck class="h-4 w-4 flex-shrink-0 text-emerald-600" />
					<span class="font-medium text-surface-900">Tous les créneaux dus ont été tirés.</span>
					<span class="text-surface-400">
						Ce verdict porte sur la PLANIFICATION seule — la réussite de ce qui a été tiré se lit
						run par run ci-dessous.
					</span>
				{/if}
			</div>
			<div class="mt-1 text-[11px] opacity-80">
				{data.summary.expected} cadence{data.summary.expected > 1 ? 's' : ''} attendue{data.summary
					.expected > 1
					? 's'
					: ''} (câblée, activée, non suspendue) · {data.summary.ok} à l'heure · {data.summary
					.paused} suspendue(s) · {data.summary.disabled} désactivée(s) · {data.summary.neverDue} jamais
				due(s) · {data.summary.unwired} non câblée(s)
			</div>
		</div>
	</div>

	<div class="flex-1 overflow-y-auto px-6 lg:px-8 pb-8 space-y-4">
		<!-- Calendrier : créneau attendu ↔ run observé -->
		<section class="rounded-lg border border-surface-200 bg-white">
			<div class="flex items-center gap-2 border-b border-surface-100 px-3 py-2">
				<CalendarClock class="h-3.5 w-3.5 text-surface-400" />
				<span class="text-xs font-medium text-surface-900">Calendrier</span>
				<span class="text-[11px] text-surface-400">
					le dernier créneau <span class="font-medium">dû</span> (calculé) contre le run
					<span class="font-medium">observé</span> — un tick qui n'a pas tourné ne laisse aucune ligne
					en base, c'est cette comparaison qui le révèle
				</span>
			</div>

			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead class="border-b border-surface-100 text-left text-[11px] text-surface-400">
						<tr>
							<th class="px-3 py-1.5 font-medium">Projet / cadence</th>
							<th class="px-3 py-1.5 font-medium">Dernier créneau dû</th>
							<th class="px-3 py-1.5 font-medium">Planification</th>
							<th class="px-3 py-1.5 font-medium">Run de ce créneau</th>
							<th class="px-3 py-1.5 font-medium">Dernière réussite</th>
							<th class="px-3 py-1.5 font-medium">Prochain créneau</th>
							<th class="px-3 py-1.5 font-medium">Pause</th>
						</tr>
					</thead>
					<tbody>
						{#each byProject as project (project.slug)}
							{#each project.rows as row, i (row.cadence)}
								<tr class="border-b border-surface-50 last:border-0">
									<td class="px-3 py-1.5">
										{#if i === 0}
											<a
												href="/projects/{project.slug}"
												class="font-semibold text-surface-900 hover:underline"
											>
												{project.name}
											</a>
											<!-- Le geste PROJET vit sur la ligne de tête, une seule fois : le
											     répéter par cadence laisserait croire qu'il porte sur elle. -->
											{#if project.rows.some((r) => r.pauseScope === 'project')}
												<button
													class="ml-1.5 text-[10px] text-sky-700 hover:underline"
													onclick={() =>
														openPauseForm({
															scope: 'project',
															eventType: 'resumed',
															projectId: row.projectId,
															label: `projet ${project.slug}`
														})}
												>
													dégeler
												</button>
											{:else}
												<button
													class="ml-1.5 text-[10px] text-surface-300 hover:text-surface-600 hover:underline"
													onclick={() =>
														openPauseForm({
															scope: 'project',
															eventType: 'paused',
															projectId: row.projectId,
															label: `projet ${project.slug}`
														})}
												>
													geler
												</button>
											{/if}
										{/if}
										<div class="text-surface-500">
											{CADENCE_LABEL[row.cadence] ?? row.cadence}
										</div>
									</td>
									<td class="px-3 py-1.5 tabular-nums text-surface-600">
										{formatScheduleSlot(row.lastDueSlot)}
										{#if row.lastDueDb}
											<span class="text-surface-300">
												· {formatRelative(row.lastDueDb, data.now)}
											</span>
										{/if}
									</td>
									<td class="px-3 py-1.5">
										<span
											class="inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium
												{HEALTH_TONE[row.verdict.health] ?? 'border-surface-200 text-surface-500'}"
											title={row.verdict.reason}
										>
											{CADENCE_HEALTH_LABEL[row.verdict.health] ?? row.verdict.health}
										</span>
										{#if row.verdict.recoverable}
											<span class="ml-1 text-[10px] text-surface-400">rattrapable</span>
										{/if}
									</td>
									<td class="px-3 py-1.5">
										{#if row.lastRun}
											<span class={RUN_TONE[row.lastRun.status] ?? 'text-surface-500'}>
												{RUN_STATUS_LABEL[row.lastRun.status] ?? row.lastRun.status}
											</span>
										{:else}
											<span class="text-surface-300">aucun</span>
										{/if}
									</td>
									<td class="px-3 py-1.5 tabular-nums text-surface-500">
										{#if row.lastSuccess}
											{formatScheduleSlot(row.lastSuccess.slot)}
										{:else}
											<span class="text-surface-300">jamais</span>
										{/if}
									</td>
									<td class="px-3 py-1.5 tabular-nums text-surface-500">
										{#if row.nextSlot}
											{formatScheduleSlot(row.nextSlot)}
											<span class="text-surface-300">· {formatRelative(row.nextDb, data.now)}</span>
										{:else}
											<span class="text-surface-300">—</span>
										{/if}
									</td>
									<td class="px-3 py-1.5">
										{#if row.verdict.health === 'paused' && row.pauseScope === 'project'}
											<!-- La pause qui la retient n'est pas la sienne : offrir « Reprendre »
											     ici ferait cliquer dans le vide, le gel projet subsistant. -->
											<span class="text-[10px] text-surface-400">via pause projet</span>
										{:else if row.verdict.health === 'paused'}
											<button
												class="text-[11px] text-sky-700 hover:underline"
												onclick={() =>
													openPauseForm({
														scope: 'project_cadence',
														eventType: 'resumed',
														projectId: row.projectId,
														cadence: row.cadence,
														label: `${project.slug} · ${CADENCE_LABEL[row.cadence] ?? row.cadence}`
													})}
											>
												Reprendre
											</button>
										{:else if row.wired && row.spec.enabled}
											<button
												class="text-[11px] text-surface-400 hover:text-surface-700 hover:underline"
												onclick={() =>
													openPauseForm({
														scope: 'project_cadence',
														eventType: 'paused',
														projectId: row.projectId,
														cadence: row.cadence,
														label: `${project.slug} · ${CADENCE_LABEL[row.cadence] ?? row.cadence}`
													})}
											>
												Suspendre
											</button>
										{:else}
											<!-- Rien à suspendre : non câblée, ou déjà désactivée. Un bouton ici
											     promettrait un effet qu'aucune décision ne produirait. -->
											<span class="text-surface-300">—</span>
										{/if}
									</td>
								</tr>
							{/each}
						{/each}
					</tbody>
				</table>
			</div>

			{#if unwiredCadences.length > 0}
				<p class="border-t border-surface-100 px-3 py-1.5 text-[11px] text-surface-400">
					Cadences sans job câblé (elles se calculent mais ne mettent rien en file, donc aucun run
					n'est attendu) :
					<span class="font-medium">
						{unwiredCadences.map((c) => CADENCE_LABEL[c] ?? c).join(', ')}
					</span>
				</p>
			{/if}
		</section>

		<!-- Pauses : décision, formulaire, journal (DASH-006 lot 2) -->
		<section class="rounded-lg border border-surface-200 bg-white">
			<div class="flex flex-wrap items-center gap-2 border-b border-surface-100 px-3 py-2 text-xs">
				<PauseCircle class="h-3.5 w-3.5 text-surface-400" />
				<span class="font-medium text-surface-900">Pauses</span>
				<span class="text-[11px] text-surface-400">
					{data.summary.paused} cadence{data.summary.paused > 1 ? 's' : ''} suspendue{data.summary
						.paused > 1
						? 's'
						: ''}
					· {data.rules.providerPauses.length} provider{data.rules.providerPauses.length > 1
						? 's'
						: ''}
				</span>
			</div>

			{#if feedback}
				<p
					class="px-3 py-1.5 text-[11px] {feedback.ok ? 'text-emerald-700' : 'text-red-700'}"
				>
					{feedback.message}
				</p>
			{/if}

			<!-- Formulaire : la RAISON tient lieu de confirmation. Pas de window.confirm,
			     qui bloquerait la page sans rien journaliser. -->
			{#if pauseForm}
				<div class="border-b border-surface-100 bg-surface-50 px-3 py-2">
					<p class="text-[11px] font-medium text-surface-900">
						{pauseForm.eventType === 'paused' ? 'Suspendre' : 'Reprendre'} — {pauseForm.label}
					</p>
					<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
						<input
							bind:value={pauseReason}
							placeholder="Raison (obligatoire) — relue dans trois semaines"
							class="min-w-[22rem] flex-1 rounded border border-surface-200 px-2 py-1 text-[11px]"
						/>
						{#if pauseForm.eventType === 'paused'}
							<input
								bind:value={pauseUntilDays}
								type="number"
								min="1"
								max="365"
								placeholder="jours"
								title="Échéance facultative : la reprise sera automatique, sans autre geste."
								class="w-20 rounded border border-surface-200 px-2 py-1 text-[11px]"
							/>
						{/if}
						<button
							disabled={busy}
							onclick={submitPause}
							class="rounded bg-surface-900 px-2 py-1 text-[11px] text-white disabled:opacity-40"
						>
							{busy ? 'Enregistrement…' : 'Confirmer'}
						</button>
						<button
							disabled={busy}
							onclick={() => (pauseForm = null)}
							class="px-2 py-1 text-[11px] text-surface-500 hover:underline disabled:opacity-40"
						>
							Annuler
						</button>
					</div>
				</div>
			{/if}

			<!-- Providers : transverses à TOUS les projets, donc sans ligne de cadence où
			     vivre. Sans ce panneau, une coupure GSC se lirait comme six collectes
			     cassées, et la décision unique qui les coupe resterait invisible. -->
			<div class="border-b border-surface-100 px-3 py-2">
				<p class="text-[11px] font-medium text-surface-500">Providers</p>
				<div class="mt-1 flex flex-wrap items-center gap-2">
					{#each PAUSABLE_PROVIDERS as provider (provider)}
						{@const active = data.rules.providerPauses.find(
							(p) => p.target.provider === provider
						)}
						<span
							class="inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[10px]
								{active ? 'border-sky-200 bg-sky-50 text-sky-700' : 'border-surface-200 text-surface-500'}"
						>
							{PROVIDER_LABEL[provider] ?? provider}
							{#if active}
								<span class="text-sky-500" title={active.reason}>
									suspendu{active.until ? ` jusqu’au ${formatDbTimestamp(active.until)}` : ''}
								</span>
								<button
									class="text-sky-700 hover:underline"
									onclick={() =>
										openPauseForm({
											scope: 'provider',
											eventType: 'resumed',
											provider,
											label: `provider ${provider}`
										})}
								>
									reprendre
								</button>
							{:else}
								<button
									class="text-surface-300 hover:text-surface-600 hover:underline"
									onclick={() =>
										openPauseForm({
											scope: 'provider',
											eventType: 'paused',
											provider,
											label: `provider ${provider}`
										})}
								>
									suspendre
								</button>
							{/if}
						</span>
					{/each}
				</div>
				<p class="mt-1 text-[10px] text-surface-400">
					Suspendre un provider ne suspend aucune cadence : le run s'ouvre, et seuls les jobs de
					ce provider sont sautés. Les steps qui n'en dépendent pas continuent.
				</p>
			</div>

			<!-- Journal : c'est LUI l'acceptation « pause et reprise sont auditables ».
			     L'état effectif s'en dérive, il n'est stocké nulle part. -->
			<div class="px-3 py-2">
				<p class="text-[11px] font-medium text-surface-500">Journal des décisions</p>
				{#if data.pauseJournal.length === 0}
					<p class="mt-1 text-[11px] text-surface-300">
						Aucune décision de pause à ce jour.
					</p>
				{:else}
					<ul class="mt-1 space-y-0.5">
						{#each data.pauseJournal as entry (entry.id)}
							<li class="text-[11px] text-surface-600">
								<span class="tabular-nums text-surface-400">
									{formatDbTimestamp(entry.createdAt)}
								</span>
								<span class={entry.eventType === 'paused' ? 'text-sky-700' : 'text-emerald-700'}>
									{entry.eventType === 'paused' ? 'suspend' : 'reprend'}
								</span>
								<span class="font-medium">
									{entry.scope === 'provider'
										? `provider ${entry.provider}`
										: entry.scope === 'project'
											? `projet ${entry.projectSlug ?? entry.projectId}`
											: `${entry.projectSlug ?? entry.projectId} · ${CADENCE_LABEL[entry.cadence ?? ''] ?? entry.cadence}`}
								</span>
								<span class="text-surface-400">— {entry.reason}</span>
								<span class="text-surface-300">({entry.actor})</span>
								{#if entry.until}
									<span class="text-surface-300">
										· échéance {formatDbTimestamp(entry.until)}
									</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</section>

		<!-- Runs -->
		<section class="rounded-lg border border-surface-200 bg-white">
			<div
				class="flex flex-wrap items-center gap-2 border-b border-surface-100 px-3 py-2 text-xs"
			>
				<span class="font-medium text-surface-900">Runs</span>
				<span class="text-[11px] text-surface-400">
					{data.totalRuns} pour ces filtres
				</span>

				<div class="ml-auto flex flex-wrap items-center gap-1.5">
					<select
						bind:value={projectSlug}
						onchange={applyFilters}
						class="rounded border border-surface-200 px-1.5 py-1 text-[11px] text-surface-700"
					>
						<option value="">Tous les projets</option>
						{#each data.projectList as p (p.slug)}
							<option value={p.slug}>{p.name}</option>
						{/each}
					</select>
					<select
						bind:value={cadence}
						onchange={applyFilters}
						class="rounded border border-surface-200 px-1.5 py-1 text-[11px] text-surface-700"
					>
						<option value="">Toutes cadences</option>
						{#each ['daily', 'weekly', 'hourly', 'monthly'] as c (c)}
							<option value={c}>{CADENCE_LABEL[c]}</option>
						{/each}
					</select>
					<select
						bind:value={runStatus}
						onchange={applyFilters}
						class="rounded border border-surface-200 px-1.5 py-1 text-[11px] text-surface-700"
					>
						<option value="">Tous statuts</option>
						{#each ['success', 'partial', 'failed', 'running', 'queued', 'cancelled'] as s (s)}
							<option value={s}>{RUN_STATUS_LABEL[s]}</option>
						{/each}
					</select>
					<button
						onclick={resetFilters}
						class="rounded border border-surface-200 px-1.5 py-1 text-[11px] text-surface-500 hover:bg-surface-50"
					>
						Réinitialiser
					</button>
				</div>
			</div>

			{#if data.filters.sinceDb}
				<p class="border-b border-surface-100 px-3 py-1.5 text-[11px] text-surface-400">
					Limité aux runs créés depuis
					<span class="font-medium tabular-nums">{formatDbTimestamp(data.filters.sinceDb)} UTC</span>
					— la borne vient du compteur de l'accueil qui a ouvert cette liste.
				</p>
			{/if}

			{#if data.runs.length === 0}
				<p class="px-3 py-4 text-center text-xs text-surface-400">Aucun run pour ces filtres.</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-xs">
						<thead class="border-b border-surface-100 text-left text-[11px] text-surface-400">
							<tr>
								<th class="px-3 py-1.5 font-medium">Projet</th>
								<!-- « Type » et non « Cadence » : `manual` et `post_publish` sont des
								     run_types sans cadran, et les ranger sous « cadence » ferait
								     chercher un créneau qui n'existe pas. -->
								<th class="px-3 py-1.5 font-medium">Type / créneau</th>
								<th class="px-3 py-1.5 font-medium">Issue</th>
								<th class="px-3 py-1.5 font-medium">Steps (dernière tentative)</th>
								<th class="px-3 py-1.5 font-medium">Terminé</th>
								<th class="px-3 py-1.5 font-medium"></th>
							</tr>
						</thead>
						<tbody>
							{#each data.runs as run (run.id)}
								<tr class="border-b border-surface-50 align-top last:border-0">
									<td class="px-3 py-1.5">
										{#if run.projectSlug}
											<a
												href="/projects/{run.projectSlug}"
												class="text-surface-700 hover:underline">{run.projectName}</a
											>
										{:else}
											<span class="text-surface-400">—</span>
										{/if}
									</td>
									<td class="px-3 py-1.5 text-surface-600">
										{CADENCE_LABEL[run.runType] ?? run.runType}
										<span class="tabular-nums text-surface-400">
											· {formatScheduleSlot(run.periodEnd)}
										</span>
										<div class="text-[10px] text-surface-400">
											{TRIGGER_LABEL[run.triggeredBy] ?? run.triggeredBy}
										</div>
									</td>
									<td class="px-3 py-1.5 font-medium {RUN_TONE[run.status] ?? 'text-surface-500'}">
										{RUN_STATUS_LABEL[run.status] ?? run.status}
									</td>
									<td class="px-3 py-1.5">
										{#if run.steps.length === 0}
											<span class="text-surface-300">
												aucun step conclu — les jobs de ce run n'ont pas encore abouti
											</span>
										{:else}
											<div class="flex flex-wrap gap-1">
												{#each run.steps as step (step.stepType)}
													<span
														class="inline-block rounded border px-1.5 py-0.5 text-[10px]
															{STEP_TONE[step.status] ?? 'border-surface-200 text-surface-500'}"
														title="{STEP_STATUS_LABEL[step.status] ?? step.status}{step.errorMessage
															? ` — ${step.errorMessage}`
															: ''}{step.durationMs ? ` (${formatDuration(step.durationMs)})` : ''}"
													>
														{step.stepType}
													</span>
												{/each}
											</div>
										{/if}
									</td>
									<td class="px-3 py-1.5 tabular-nums text-surface-500">
										{formatDbTimestamp(run.finishedAt ?? run.createdAt)}
									</td>
									<td class="px-3 py-1.5 text-right">
										<!-- La liste des jobs de CE run : le nombre affiché et la liste
										     qu'il ouvre naissent du même identifiant. -->
										<a
											href="/jobs?run={run.id}"
											class="text-[11px] text-primary-600 hover:underline">jobs →</a
										>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				{#if totalPages > 1}
					<div
						class="flex items-center justify-between border-t border-surface-100 px-3 py-1.5 text-[11px] text-surface-400"
					>
						<span>Page {currentPage} / {totalPages}</span>
						<div class="flex gap-1">
							<button
								disabled={data.filters.offset === 0}
								onclick={() => gotoOffset(data.filters.offset - data.filters.limit)}
								class="rounded border border-surface-200 px-1.5 py-0.5 disabled:opacity-40"
							>
								Précédent
							</button>
							<button
								disabled={currentPage >= totalPages}
								onclick={() => gotoOffset(data.filters.offset + data.filters.limit)}
								class="rounded border border-surface-200 px-1.5 py-0.5 disabled:opacity-40"
							>
								Suivant
							</button>
						</div>
					</div>
				{/if}
			{/if}
		</section>

		<!-- Règles effectives -->
		<section class="rounded-lg border border-surface-200 bg-white">
			<div class="flex items-center gap-2 border-b border-surface-100 px-3 py-2">
				<Gauge class="h-3.5 w-3.5 text-surface-400" />
				<span class="text-xs font-medium text-surface-900">Règles effectives</span>
				<span class="text-[11px] text-surface-400">
					ce que la file appliquera réellement — lu, jamais recopié
				</span>
			</div>

			<div class="grid gap-4 px-3 py-2 lg:grid-cols-3">
				<!-- Quotas & plafonds -->
				<div>
					<div class="mb-1 text-[11px] font-semibold text-surface-900">Quotas providers</div>
					{#each providerRows as p (p.provider)}
						<div class="flex items-baseline justify-between gap-2 text-[11px]">
							<span class="text-surface-600">{PROVIDER_LABEL[p.provider] ?? p.provider}</span>
							<span class="tabular-nums text-surface-500">
								{formatQuota(p.running, p.concurrencyLimit)}
								<span
									class={p.state === 'ok'
										? 'text-surface-300'
										: p.state === 'quota_limited'
											? 'text-red-700'
											: 'text-amber-700'}
								>
									· {CAPACITY_STATE_LABEL[p.state] ?? p.state}
								</span>
							</span>
						</div>
					{:else}
						<p class="text-[11px] text-surface-400">Aucun provider externe sollicité.</p>
					{/each}
					<p class="mt-1 text-[10px] text-surface-400">
						Plafond global : {formatQuota(
							data.rules.capacity.global.running,
							data.rules.capacity.global.limit
						)}{data.rules.capacity.configured
							? ' (overrides en base)'
							: ' (défauts du code)'}. Réglable sans redéploiement (<code>system_settings</code>).
					</p>
				</div>

				<!-- Flags -->
				<div>
					<div class="mb-1 flex items-center gap-1 text-[11px] font-semibold text-surface-900">
						<ToggleLeft class="h-3 w-3 text-surface-400" />
						Flags de migration
					</div>
					{#if data.rules.flags === null}
						<p class="text-[11px] text-surface-400">
							Non lisible dans ce contexte d'exécution — affiché comme tel plutôt que
							« tous à false », qui serait une affirmation sans preuve.
						</p>
					{:else if activeFlags.length === 0}
						<p class="text-[11px] text-surface-400">
							Tous à <span class="font-medium">false</span> — c'est le défaut : rien ne s'active par
							accident.
						</p>
					{:else}
						<div class="flex flex-wrap gap-1">
							{#each activeFlags as flag (flag)}
								<span
									class="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700"
									>{flag}</span
								>
							{/each}
						</div>
					{/if}
					<p class="mt-1 text-[10px] text-surface-400">
						Valeurs GLOBALES (variables d'env). Les overrides par projet n'ont pas encore de table
						(GOV-005) : aucun n'est appliqué, donc aucun n'est affiché.
					</p>
				</div>

				<!-- Politiques d'avis -->
				<div>
					<div class="mb-1 text-[11px] font-semibold text-surface-900">Politiques d'avis</div>
					{#each data.rules.reviewPolicies as policy (policy.projectId + (policy.locationId ?? ''))}
						<div class="flex items-baseline justify-between gap-2 text-[11px]">
							<span class="text-surface-600">
								{policy.projectSlug ?? policy.projectId}
								{#if policy.locationId}<span class="text-surface-300">· {policy.locationId}</span
									>{/if}
							</span>
							<span class="text-surface-500">
								{policy.mode}
								{#if policy.killSwitch}
									<span class="font-medium text-red-700">· kill switch</span>
								{/if}
							</span>
						</div>
					{:else}
						<p class="text-[11px] text-surface-400">
							Aucune politique promue : les envois automatiques d'avis restent à leur défaut sûr
							(<span class="font-medium">draft_only</span>).
						</p>
					{/each}
				</div>
			</div>
		</section>
	</div>
</div>
