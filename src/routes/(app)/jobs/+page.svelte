<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ListChecks, RotateCcw } from 'lucide-svelte';
	import {
		CLASS_LABEL,
		STATUS_LABEL,
		formatDbTimestamp,
		formatRelative
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
	const STATUS_ORDER = ['dead', 'running', 'queued', 'failed', 'cancelled', 'succeeded'];

	const STATUS_TONE: Record<string, string> = {
		dead: 'bg-red-50 text-red-700 border-red-200',
		running: 'bg-blue-50 text-blue-700 border-blue-200',
		queued: 'bg-surface-50 text-surface-700 border-surface-200',
		failed: 'bg-amber-50 text-amber-700 border-amber-200',
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
</script>

<div class="flex flex-col h-[calc(100vh-73px)] -mx-6 -my-6 lg:-mx-8">
	<!-- Header -->
	<div class="flex-shrink-0 px-6 pt-6 pb-4 lg:px-8">
		<h1 class="text-xl font-semibold text-surface-900">Jobs</h1>
		<p class="mt-0.5 text-xs text-surface-400">
			File d'exécution du cockpit — {data.total} job{data.total !== 1 ? 's' : ''} pour ces filtres.
			Horodatages en <span class="font-medium">UTC</span>.
		</p>
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
