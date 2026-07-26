<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { CalendarClock, Gauge, ListChecks, RotateCcw } from 'lucide-svelte';
	import {
		CADENCE_LABEL,
		CAPACITY_STATE_LABEL,
		CLASS_LABEL,
		PROVIDER_LABEL,
		STATUS_LABEL,
		formatDbTimestamp,
		formatEpochUtc,
		formatQuota,
		formatRelative,
		formatScheduleSlot
	} from '$lib/utils/job-format.js';

	let { data } = $props();

	// Les filtres viennent typés du serveur (`JobStatus`, `ErrorClass`), mais un
	// contrôle de formulaire manipule des chaînes — dont la chaîne vide « aucun
	// filtre », qui n'appartient à aucun vocabulaire. C'est `normalizeJobFilters`,
	// côté serveur, qui les y ramène.
	let projectSlug = $state<string>('');
	let type = $state<string>('');
	let errorClass = $state<string>('');

	// Les contrôles suivent l'URL, ils ne la devinent pas : sans cette synchro, un
	// retour arrière du navigateur laisserait des sélecteurs qui ne décrivent plus
	// la liste affichée. La saisie ne déclenche pas cet effet (`data` ne bouge pas).
	$effect(() => {
		projectSlug = data.filters.projectSlug ?? '';
		type = data.filters.type ?? '';
		errorClass = data.filters.errorClasses[0] ?? '';
	});

	/** Ordre d'affichage des compteurs : ce qui alerte d'abord, ce qui rassure ensuite. */
	const STATUS_ORDER = [
		'dead',
		'running',
		'queued',
		'failed',
		'skipped',
		'cancelled',
		'succeeded'
	];

	const STATUS_TONE: Record<string, string> = {
		dead: 'bg-red-50 text-red-700 border-red-200',
		running: 'bg-blue-50 text-blue-700 border-blue-200',
		queued: 'bg-surface-50 text-surface-700 border-surface-200',
		failed: 'bg-amber-50 text-amber-700 border-amber-200',
		// JOB-004 — teinte propre : un job sauté n'est ni un échec (rien n'a été tenté),
		// ni une annulation humaine (personne n'a rien décidé).
		skipped: 'bg-violet-50 text-violet-700 border-violet-200',
		cancelled: 'bg-surface-50 text-surface-500 border-surface-200',
		succeeded: 'bg-emerald-50 text-emerald-700 border-emerald-200'
	};

	const activeStatuses = $derived(new Set<string>(data.filters.statuses));

	function buildParams(overrides: Record<string, string | null>) {
		const params = new URLSearchParams(page.url.searchParams);
		for (const [k, v] of Object.entries(overrides)) {
			if (v === null || v === '') params.delete(k);
			else params.set(k, v);
		}
		// Tout changement de filtre ramène à la première page : garder l'offset
		// afficherait « aucun résultat » sur un jeu qui en a.
		if (!('offset' in overrides)) params.delete('offset');
		return params;
	}

	function toggleStatus(status: string) {
		const next = new Set<string>(activeStatuses);
		if (next.has(status)) next.delete(status);
		else next.add(status);
		goto(`?${buildParams({ status: [...next].join(',') })}`, { keepFocus: true });
	}

	function applyFilters() {
		goto(
			`?${buildParams({
				project: projectSlug || null,
				type: type || null,
				class: errorClass || null
			})}`,
			{ keepFocus: true }
		);
	}

	function resetFilters() {
		projectSlug = '';
		type = '';
		errorClass = '';
		goto('?', { keepFocus: true });
	}

	function gotoOffset(newOffset: number) {
		goto(`?${buildParams({ offset: newOffset === 0 ? null : String(newOffset) })}`, {
			keepFocus: true
		});
	}

	const totalPages = $derived(Math.ceil(data.total / data.filters.limit));
	const currentPage = $derived(Math.floor(data.filters.offset / data.filters.limit) + 1);

	// ── Planification (JOB-005) ──────────────────────────────────────
	// Seules les cadences RÉELLEMENT câblées sont listées : une cadence qui se
	// calcule mais n'enfile aucun job ferait attendre un run qui ne viendra pas.
	// Les autres sont nommées une fois, en note.
	const scheduleRows = $derived(data.schedule.rows.filter((r) => r.wired && r.enabled));
	const disabledRows = $derived(data.schedule.rows.filter((r) => r.wired && !r.enabled));
	const unwiredCadences = $derived([
		...new Set(data.schedule.rows.filter((r) => !r.wired).map((r) => r.cadence))
	]);

	/** Groupé par projet : un projet, ses cadences — l'ordre du serveur est conservé. */
	const scheduleByProject = $derived(
		scheduleRows.reduce<Array<{ slug: string; name: string; rows: typeof scheduleRows }>>(
			(acc, row) => {
				const last = acc.at(-1);
				if (last && last.slug === row.projectSlug) last.rows.push(row);
				else acc.push({ slug: row.projectSlug, name: row.projectName, rows: [row] });
				return acc;
			},
			[]
		)
	);

	// ── Capacité & quotas (JOB-006) ──────────────────────────────────
	// Les providers `none` (jobs qui ne sortent pas de la base) sont écartés de la
	// liste : ils n'ont ni quota ni budget, et les afficher ferait chercher une
	// limite là où il n'y en a pas. Leur charge se lit dans les compteurs de statut.
	const providerRows = $derived(data.capacity.providers.filter((p) => p.provider !== 'none'));
	const limitedProviders = $derived(providerRows.filter((p) => p.state !== 'ok'));
	const busyProjects = $derived(data.capacity.projects.filter((p) => p.running > 0));

	const CAPACITY_TONE: Record<string, string> = {
		ok: 'text-surface-500',
		saturated: 'text-amber-700',
		quota_limited: 'text-red-700'
	};

	/** Le prochain créneau, tous projets confondus — le résumé qu'on lit sans déplier. */
	const soonest = $derived(
		scheduleRows.reduce<(typeof scheduleRows)[number] | null>(
			(best, row) =>
				row.instantDb && (!best?.instantDb || row.instantDb < best.instantDb) ? row : best,
			null
		)
	);
</script>

<div class="flex flex-col h-[calc(100vh-73px)] -mx-6 -my-6 lg:-mx-8">
	<!-- Header -->
	<div class="flex-shrink-0 px-6 pt-6 pb-4 lg:px-8">
		<h1 class="text-xl font-semibold text-surface-900">Jobs</h1>
		<p class="mt-0.5 text-xs text-surface-400">
			File d'exécution du cockpit — {data.total} job{data.total !== 1 ? 's' : ''} pour ces filtres.
			Horodatages en <span class="font-medium">UTC</span>. La file est planifiée et drainée au tick
			horaire (<code>/api/cron/tick</code>).
		</p>

		<!-- DASH-006 — le filtre `run` n'a pas de contrôle dans la barre de filtres :
		     il se pose depuis la vue automatisations. Un filtre actif qui ne se voit
		     nulle part ferait lire « la file est presque vide » à qui regarde un run. -->
		{#if data.filters.runId}
			<p class="mt-1.5 inline-flex items-center gap-2 rounded border border-primary-200 bg-primary-50 px-2 py-1 text-[11px] text-primary-800">
				<span>Restreint aux jobs du run <code>{data.filters.runId}</code></span>
				<!-- Pas « voir CE run » : cette page ne connaît pas le projet du run, et
				     le lien retomberait sur la liste complète en promettant mieux. -->
				<a href="/automations" class="underline">automatisations</a>
				<a href={`?${buildParams({ run: null })}`} class="underline">toute la file</a>
			</p>
		{/if}
	</div>

	<!-- Planification (JOB-005) -->
	<div class="flex-shrink-0 px-6 lg:px-8 pb-3">
		<details class="rounded-lg border border-surface-200 bg-white">
			<summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-surface-600">
				<CalendarClock class="h-3.5 w-3.5 text-surface-400" />
				<span class="font-medium text-surface-900">Planification</span>
				{#if soonest}
					<span class="text-surface-400">
						prochain : {soonest.projectSlug} · {CADENCE_LABEL[soonest.cadence] ?? soonest.cadence}
						· {formatScheduleSlot(soonest.localSlot)}
						<span class="text-surface-300">({formatRelative(soonest.instantDb, data.now)})</span>
					</span>
				{:else}
					<span class="text-surface-400">aucune cadence active</span>
				{/if}
			</summary>

			<div class="border-t border-surface-100 px-3 py-2">
				<p class="mb-2 text-[11px] text-surface-400">
					Créneaux en <span class="font-medium">{data.schedule.timeZone}</span> (heure métier), et
					l'instant correspondant en <span class="font-medium">UTC</span> — l'écart est
					exactement ce que le scheduler gère aux changements d'heure.
				</p>

				<div class="grid gap-x-6 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
					{#each scheduleByProject as project (project.slug)}
						<div class="py-1">
							<div class="text-[11px] font-semibold text-surface-900">{project.name}</div>
							{#each project.rows as row (row.cadence)}
								<div class="flex items-baseline justify-between gap-2 text-[11px] text-surface-500">
									<span class="text-surface-600">{CADENCE_LABEL[row.cadence] ?? row.cadence}</span>
									<span class="tabular-nums">
										{formatScheduleSlot(row.localSlot)}
										<span class="text-surface-300">· {formatDbTimestamp(row.instantDb)} UTC</span>
									</span>
								</div>
							{/each}
						</div>
					{/each}
				</div>

				{#if disabledRows.length > 0 || unwiredCadences.length > 0}
					<p class="mt-2 border-t border-surface-100 pt-2 text-[11px] text-surface-400">
						{#if unwiredCadences.length > 0}
							Cadences sans job câblé (elles ne planifient rien) :
							{unwiredCadences.map((c) => CADENCE_LABEL[c] ?? c).join(', ')}.
						{/if}
						{#if disabledRows.length > 0}
							Désactivées par projet :
							{disabledRows
								.map((r) => `${r.projectSlug}/${CADENCE_LABEL[r.cadence] ?? r.cadence}`)
								.join(', ')}.
						{/if}
					</p>
				{/if}
			</div>
		</details>
	</div>

	<!-- Capacité & quotas (JOB-006) -->
	<div class="flex-shrink-0 px-6 lg:px-8 pb-3">
		<details class="rounded-lg border border-surface-200 bg-white">
			<summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-surface-600">
				<Gauge class="h-3.5 w-3.5 text-surface-400" />
				<span class="font-medium text-surface-900">Capacité & quotas</span>
				{#if limitedProviders.length > 0}
					<span class="text-red-700">
						{limitedProviders
							.map(
								(p) =>
									`${PROVIDER_LABEL[p.provider] ?? p.provider} : ${CAPACITY_STATE_LABEL[p.state] ?? p.state}`
							)
							.join(' · ')}
					</span>
				{:else}
					<span class="text-surface-400">
						{data.capacity.global.running} job{data.capacity.global.running !== 1 ? 's' : ''} en cours
						· aucun provider limité
					</span>
				{/if}
			</summary>

			<div class="border-t border-surface-100 px-3 py-2">
				<p class="mb-2 text-[11px] text-surface-400">
					Plafonds {data.capacity.configured
						? 'lus en base'
						: 'par défaut (aucun réglage en base)'} — modifiables sans redéploiement via
					<code>scripts/limits.ts</code>. Un plafond à <span class="font-medium">∞</span> n'est pas
					une limite. L'état d'un provider est <span class="font-medium">dérivé</span> du journal
					des tentatives : rien n'est stocké, rien ne peut diverger.
				</p>

				<div class="grid gap-x-6 gap-y-1 sm:grid-cols-2">
					<div class="py-1">
						<div class="text-[11px] font-semibold text-surface-900">Providers externes</div>
						{#each providerRows as p (p.provider)}
							<div class="flex items-baseline justify-between gap-2 text-[11px]">
								<span class="text-surface-600">{PROVIDER_LABEL[p.provider] ?? p.provider}</span>
								<span class="tabular-nums {CAPACITY_TONE[p.state] ?? 'text-surface-500'}">
									{formatQuota(p.running, p.concurrencyLimit)} en cours ·
									{formatQuota(p.attemptsInWindow, p.windowBudget)} sur la fenêtre
									{#if p.cooldownUntilMs !== null}
										<span class="font-medium">
											· au repos jusqu'à {formatEpochUtc(p.cooldownUntilMs)} UTC
										</span>
									{/if}
								</span>
							</div>
						{/each}
						{#if providerRows.every((p) => p.jobTypes.length === 0)}
							<p class="mt-1 text-[11px] text-surface-400">
								Aucun type de job ne sort encore de la base : ces budgets sont armés pour les
								collecteurs (E03), pas encore consommés.
							</p>
						{/if}
					</div>

					<div class="py-1">
						<div class="text-[11px] font-semibold text-surface-900">
							Projets · global {formatQuota(
								data.capacity.global.running,
								data.capacity.global.limit
							)}
						</div>
						{#if busyProjects.length === 0}
							<p class="text-[11px] text-surface-400">Aucun job en cours.</p>
						{:else}
							{#each busyProjects as p (p.projectId)}
								<div class="flex items-baseline justify-between gap-2 text-[11px]">
									<span class="text-surface-600">{p.projectSlug}</span>
									<span class="tabular-nums {CAPACITY_TONE[p.state] ?? 'text-surface-500'}">
										{formatQuota(p.running, p.concurrencyLimit)} en cours
									</span>
								</div>
							{/each}
						{/if}
						<p class="mt-1 text-[11px] text-surface-400">
							Équité : {data.capacity.limits.perProjectPerLap > 0
								? `${data.capacity.limits.perProjectPerLap} jobs par projet et par tour`
								: 'désarmée'}. Le tour n'existe que pendant un drain — il n'a rien à montrer
							entre deux ticks.
						</p>
					</div>
				</div>
			</div>
		</details>
	</div>

	<!-- Compteurs cliquables -->
	<div class="flex-shrink-0 px-6 lg:px-8 pb-3">
		<div class="flex flex-wrap gap-2">
			{#each STATUS_ORDER as status (status)}
				{@const n = data.byStatus[status] ?? 0}
				<button
					onclick={() => toggleStatus(status)}
					class="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors
						{STATUS_TONE[status]}
						{activeStatuses.has(status) ? 'ring-2 ring-offset-1 ring-surface-400' : 'hover:opacity-80'}"
				>
					<span>{STATUS_LABEL[status] ?? status}</span>
					<span class="font-semibold tabular-nums">{n}</span>
				</button>
			{/each}
		</div>
	</div>

	<!-- Filtres -->
	<div class="flex-shrink-0 px-6 lg:px-8 pb-4">
		<div class="flex flex-wrap items-end gap-3 rounded-lg border border-surface-200 bg-surface-50 p-3">
			<div class="flex flex-col gap-1">
				<label for="f-project" class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Projet</label>
				<select
					id="f-project"
					bind:value={projectSlug}
					class="rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-xs text-surface-900"
				>
					<option value="">Tous</option>
					{#each data.sidebarProjects as p (p.id)}
						<option value={p.slug}>{p.name}</option>
					{/each}
				</select>
			</div>

			<div class="flex flex-col gap-1">
				<label for="f-type" class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Type</label>
				<select
					id="f-type"
					bind:value={type}
					class="rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-xs text-surface-900"
				>
					<option value="">Tous</option>
					{#each data.types as t (t)}
						<option value={t}>{t}</option>
					{/each}
				</select>
			</div>

			<div class="flex flex-col gap-1">
				<label for="f-class" class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Cause</label>
				<select
					id="f-class"
					bind:value={errorClass}
					class="rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-xs text-surface-900"
				>
					<option value="">Toutes</option>
					{#each Object.entries(CLASS_LABEL) as [value, label] (value)}
						<option {value}>{label}</option>
					{/each}
				</select>
			</div>

			<button
				onclick={applyFilters}
				class="rounded-md bg-primary-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-600"
			>
				Appliquer
			</button>
			<button
				onclick={resetFilters}
				class="flex items-center gap-1 rounded-md border border-surface-200 bg-white px-3 py-1.5 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50"
			>
				<RotateCcw class="h-3 w-3" />
				Reset
			</button>
		</div>
	</div>

	<!-- Table -->
	<div class="flex-1 overflow-y-auto px-6 lg:px-8 pb-6">
		{#if data.jobs.length === 0}
			<div class="flex flex-col items-center justify-center py-16 text-center">
				<ListChecks class="h-10 w-10 text-surface-300" />
				<p class="mt-3 text-sm text-surface-500">Aucun job pour ces filtres.</p>
			</div>
		{:else}
			<div class="overflow-x-auto rounded-lg border border-surface-200 bg-white">
				<table class="w-full text-xs">
					<thead class="bg-surface-50 text-left text-[10px] font-semibold uppercase tracking-wider text-surface-500">
						<tr>
							<th class="px-3 py-2">Statut</th>
							<th class="px-3 py-2">Type</th>
							<th class="px-3 py-2">Projet</th>
							<th class="px-3 py-2">Tentatives</th>
							<th class="px-3 py-2">Dernière erreur</th>
							<th class="px-3 py-2">Disponible</th>
							<th class="px-3 py-2">Modifié</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-surface-100">
						{#each data.jobs as job (job.id)}
							<tr class="cursor-pointer hover:bg-surface-50" onclick={() => goto(`/jobs/${job.id}`)}>
								<td class="px-3 py-2 whitespace-nowrap">
									<span
										class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold {STATUS_TONE[
											job.status
										] ?? 'bg-surface-50 text-surface-600 border-surface-200'}"
									>
										{STATUS_LABEL[job.status] ?? job.status}
									</span>
								</td>
								<td class="px-3 py-2">
									<a href="/jobs/{job.id}" class="font-medium text-surface-900 hover:text-primary-600 hover:underline">
										{job.type}
									</a>
									<div class="text-[10px] text-surface-400">{job.id.slice(0, 10)}</div>
									<!-- JOB-004 — sans cette ligne, un job que la garde de dépendance
									     retient ressemble EXACTEMENT à un job coincé. -->
									{#if data.dependencies[job.id]}
										<div class="mt-0.5 text-[10px] font-medium text-violet-600">
											⏸ {data.dependencies[job.id]}
										</div>
									{/if}
								</td>
								<td class="px-3 py-2 text-surface-600 whitespace-nowrap">{job.projectSlug}</td>
								<td class="px-3 py-2 whitespace-nowrap text-surface-600 tabular-nums">
									{job.attempts}/{job.maxAttempts}
									{#if job.deferrals > 0}
										<span class="ml-1 text-[10px] text-amber-600">· {job.deferrals} report{job.deferrals > 1 ? 's' : ''}</span>
									{/if}
									{#if job.requeuedCount > 0}
										<span class="ml-1 text-[10px] text-surface-400">· {job.requeuedCount} reprise{job.requeuedCount > 1 ? 's' : ''}</span>
									{/if}
								</td>
								<td class="px-3 py-2 text-surface-600">
									{#if job.errorClass || job.errorCode}
										<span class="font-medium">{job.errorCode ?? '—'}</span>
										{#if job.errorClass}
											<span class="ml-1 text-[10px] text-surface-400">[{CLASS_LABEL[job.errorClass] ?? job.errorClass}]</span>
										{/if}
									{:else}
										<span class="text-surface-300">—</span>
									{/if}
								</td>
								<td class="px-3 py-2 whitespace-nowrap text-surface-500">
									{#if job.status === 'queued'}
										{formatRelative(job.availableAt, data.now)}
									{:else}
										<span class="text-surface-300">—</span>
									{/if}
								</td>
								<td class="px-3 py-2 whitespace-nowrap text-surface-500">{formatDbTimestamp(job.updatedAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if totalPages > 1}
				<div class="mt-3 flex items-center justify-between text-xs text-surface-500">
					<span>Page {currentPage} / {totalPages}</span>
					<div class="flex gap-2">
						<button
							disabled={data.filters.offset === 0}
							onclick={() => gotoOffset(Math.max(0, data.filters.offset - data.filters.limit))}
							class="rounded-md border border-surface-200 bg-white px-3 py-1.5 font-medium text-surface-600 transition-colors hover:bg-surface-50 disabled:opacity-40"
						>
							Précédent
						</button>
						<button
							disabled={data.filters.offset + data.filters.limit >= data.total}
							onclick={() => gotoOffset(data.filters.offset + data.filters.limit)}
							class="rounded-md border border-surface-200 bg-white px-3 py-1.5 font-medium text-surface-600 transition-colors hover:bg-surface-50 disabled:opacity-40"
						>
							Suivant
						</button>
					</div>
				</div>
			{/if}
		{/if}
	</div>
</div>
