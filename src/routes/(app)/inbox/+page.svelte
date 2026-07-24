<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { Inbox, Layers, RotateCcw, ShieldAlert } from 'lucide-svelte';
	import { formatDbTimestamp, formatRelative } from '$lib/utils/job-format.js';
	import {
		ACTION_LABEL,
		FINDING_STATUS_LABEL,
		FINDING_TYPE_LABEL,
		LEVEL_APPROVER,
		LEVEL_LABEL,
		PROPOSAL_STATUS_LABEL,
		RISK_LABEL,
		SEVERITY_LABEL,
		priorityBand,
		shortHash
	} from '$lib/utils/proposal-format.js';

	let { data } = $props();

	let projectSlug = $state<string>('');
	let actionType = $state<string>('');
	let risk = $state<string>('');

	// Les contrôles suivent l'URL, ils ne la devinent pas : sans cette synchro, un
	// retour arrière du navigateur laisserait des sélecteurs qui ne décrivent plus
	// la liste affichée.
	$effect(() => {
		projectSlug = data.filters.projectSlug ?? '';
		actionType = data.filters.actionType ?? '';
		risk = data.filters.risks[0] ?? '';
	});

	/** Ordre d'affichage : ce qui attend une décision d'abord, ce qui est classé ensuite. */
	const PROPOSAL_STATUS_ORDER = [
		'proposed',
		'invalidated',
		'changes_requested',
		'approved',
		'rejected',
		'superseded'
	];
	const FINDING_STATUS_ORDER = [
		'open',
		'reopened',
		'acknowledged',
		'planned',
		'in_progress',
		'snoozed',
		'resolved',
		'dismissed'
	];

	const PROPOSAL_TONE: Record<string, string> = {
		proposed: 'bg-blue-50 text-blue-700 border-blue-200',
		invalidated: 'bg-amber-50 text-amber-700 border-amber-200',
		changes_requested: 'bg-violet-50 text-violet-700 border-violet-200',
		approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
		rejected: 'bg-surface-50 text-surface-500 border-surface-200',
		superseded: 'bg-surface-50 text-surface-400 border-surface-200',
		expired: 'bg-surface-50 text-surface-400 border-surface-200',
		executing: 'bg-blue-50 text-blue-700 border-blue-200',
		executed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
		failed: 'bg-red-50 text-red-700 border-red-200'
	};

	const FINDING_TONE: Record<string, string> = {
		open: 'bg-blue-50 text-blue-700 border-blue-200',
		reopened: 'bg-amber-50 text-amber-700 border-amber-200',
		acknowledged: 'bg-surface-50 text-surface-700 border-surface-200',
		planned: 'bg-surface-50 text-surface-700 border-surface-200',
		in_progress: 'bg-violet-50 text-violet-700 border-violet-200',
		snoozed: 'bg-surface-50 text-surface-400 border-surface-200',
		resolved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
		dismissed: 'bg-surface-50 text-surface-400 border-surface-200'
	};

	const RISK_TONE: Record<string, string> = {
		high: 'text-red-700',
		medium: 'text-amber-700',
		low: 'text-surface-500',
		inconnu: 'text-surface-400'
	};

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

	const activeProposalStatuses = $derived(new Set<string>(data.filters.statuses));
	const activeFindingStatuses = $derived(new Set<string>(data.findingStatuses));

	function toggleStatus(status: string) {
		const key = data.tab === 'findings' ? 'fstatus' : 'status';
		const current = data.tab === 'findings' ? activeFindingStatuses : activeProposalStatuses;
		const next = new Set<string>(current);
		if (next.has(status)) next.delete(status);
		else next.add(status);
		goto(`?${buildParams({ [key]: [...next].join(',') })}`, { keepFocus: true });
	}

	function applyFilters() {
		goto(
			`?${buildParams({ project: projectSlug || null, action: actionType || null, risk: risk || null })}`,
			{ keepFocus: true }
		);
	}

	function resetFilters() {
		goto(`?${new URLSearchParams(data.tab === 'findings' ? { tab: 'findings' } : {})}`, {
			keepFocus: true
		});
	}

	function gotoOffset(newOffset: number) {
		goto(`?${buildParams({ offset: newOffset === 0 ? null : String(newOffset) })}`, {
			keepFocus: true
		});
	}

	const total = $derived(data.tab === 'findings' ? data.findingTotal : data.proposalTotal);
	const totalPages = $derived(Math.ceil(total / data.filters.limit));
	const currentPage = $derived(Math.floor(data.filters.offset / data.filters.limit) + 1);

	const openProposals = $derived(
		(data.proposalCounts.proposed ?? 0) +
			(data.proposalCounts.invalidated ?? 0) +
			(data.proposalCounts.changes_requested ?? 0)
	);
	const openFindings = $derived(
		FINDING_STATUS_ORDER.slice(0, 5).reduce((n, s) => n + (data.findingCounts[s] ?? 0), 0)
	);

	// ── Validation groupée ───────────────────────────────────────────
	// Les lots viennent du SERVEUR, calculés sur les lignes réelles, et
	// `approve-batch` rejouera le même calcul avant d'écrire. L'écran ne peut donc
	// pas fabriquer un lot que la base ne permettrait pas.
	let busyLot = $state<string | null>(null);
	let lotResult = $state<{ key: string; message: string; ok: boolean } | null>(null);

	async function approveLot(lot: (typeof data.lots)[number]) {
		busyLot = lot.key;
		lotResult = null;
		try {
			const res = await fetch('/api/ops/proposals/approve-batch', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ items: lot.items })
			});
			const body = await res.json();
			if (!res.ok) {
				lotResult = { key: lot.key, ok: false, message: body.error ?? 'Refus du serveur.' };
				return;
			}
			const skipped = (body.skipped ?? []) as { id: string; reason: string }[];
			lotResult = {
				key: lot.key,
				ok: skipped.length === 0,
				// Le compte rendu par item est TOUJOURS affiché : un lot qui « réussit »
				// en taisant deux items refusés se lit comme un lot complet.
				message:
					`${body.approved.length} approuvée${body.approved.length > 1 ? 's' : ''}` +
					(skipped.length > 0
						? ` · ${skipped.length} écartée${skipped.length > 1 ? 's' : ''} : ` +
							skipped.map((s) => s.reason).join(' · ')
						: '')
			};
			await invalidateAll();
		} catch (e) {
			lotResult = { key: lot.key, ok: false, message: e instanceof Error ? e.message : String(e) };
		} finally {
			busyLot = null;
		}
	}
</script>

<div class="flex flex-col h-[calc(100vh-73px)] -mx-6 -my-6 lg:-mx-8">
	<!-- Header -->
	<div class="flex-shrink-0 px-6 pt-6 pb-4 lg:px-8">
		<h1 class="text-xl font-semibold text-surface-900">Inbox</h1>
		<p class="mt-0.5 text-xs text-surface-400">
			Ce que le cockpit a détecté et proposé, et qui attend une décision humaine. Horodatages en
			<span class="font-medium">UTC</span>. Approuver enregistre une décision —
			<span class="font-medium">rien ne l'exécute encore</span> (aucun handler d'exécution à ce jour).
		</p>
	</div>

	<!-- Onglets : les deux compteurs sont toujours calculés, jamais seulement celui de l'onglet ouvert -->
	<div class="flex-shrink-0 px-6 lg:px-8 pb-3">
		<div class="flex gap-1 border-b border-surface-200">
			{#each [{ key: 'proposals', label: 'Propositions', n: openProposals }, { key: 'findings', label: 'Findings', n: openFindings }] as t (t.key)}
				<a
					href={t.key === 'findings' ? '?tab=findings' : '?'}
					class="flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors
						{data.tab === t.key
						? 'border-primary-500 text-surface-900'
						: 'border-transparent text-surface-500 hover:text-surface-800'}"
				>
					{t.label}
					<span class="rounded-full bg-surface-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-surface-600">
						{t.n}
					</span>
				</a>
			{/each}
		</div>
	</div>

	<!-- Compteurs cliquables -->
	<div class="flex-shrink-0 px-6 lg:px-8 pb-3">
		<div class="flex flex-wrap gap-2">
			{#each data.tab === 'findings' ? FINDING_STATUS_ORDER : PROPOSAL_STATUS_ORDER as status (status)}
				{@const counts = data.tab === 'findings' ? data.findingCounts : data.proposalCounts}
				{@const active =
					data.tab === 'findings'
						? activeFindingStatuses.has(status)
						: activeProposalStatuses.has(status)}
				{@const label =
					data.tab === 'findings' ? FINDING_STATUS_LABEL[status] : PROPOSAL_STATUS_LABEL[status]}
				{@const tone = data.tab === 'findings' ? FINDING_TONE[status] : PROPOSAL_TONE[status]}
				<button
					onclick={() => toggleStatus(status)}
					class="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors
						{tone ?? 'bg-surface-50 text-surface-600 border-surface-200'}
						{active ? 'ring-2 ring-offset-1 ring-surface-400' : 'hover:opacity-80'}"
				>
					<span>{label ?? status}</span>
					<span class="font-semibold tabular-nums">{counts[status] ?? 0}</span>
				</button>
			{/each}
		</div>
	</div>

	<!-- Filtre d'ACTIVITÉ (arrivée depuis un compteur de l'accueil, DASH-002) -->
	<!-- Une liste filtrée sur une période qui ne dirait pas son filtre se lirait comme un
	     total : le bandeau nomme la période ET offre la sortie. -->
	{#if data.activity}
		<div class="flex-shrink-0 px-6 lg:px-8 pb-3">
			<div class="flex flex-wrap items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
				<span class="font-medium">
					Filtré sur l'activité : {data.activity.events.join(', ')}
				</span>
				<span class="text-sky-700">depuis {data.activity.since.slice(0, 16)}</span>
				<a href="/inbox?tab=findings" class="ml-auto font-medium text-sky-700 underline hover:text-sky-900">
					Voir tous les findings
				</a>
			</div>
		</div>
	{/if}

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

			{#if data.tab === 'proposals'}
				<div class="flex flex-col gap-1">
					<label for="f-action" class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Action</label>
					<select
						id="f-action"
						bind:value={actionType}
						class="rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-xs text-surface-900"
					>
						<option value="">Toutes</option>
						{#each Object.entries(ACTION_LABEL) as [value, label] (value)}
							<option {value}>{label}</option>
						{/each}
					</select>
				</div>

				<div class="flex flex-col gap-1">
					<label for="f-risk" class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Risque</label>
					<select
						id="f-risk"
						bind:value={risk}
						class="rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-xs text-surface-900"
					>
						<option value="">Tous</option>
						<option value="high">élevé</option>
						<option value="medium">moyen</option>
						<option value="low">faible</option>
					</select>
				</div>
			{/if}

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

	<div class="flex-1 overflow-y-auto px-6 lg:px-8 pb-6">
		{#if data.tab === 'proposals'}
			<!-- Lots homogènes -->
			{#if data.lots.length > 0}
				<div class="mb-4 rounded-lg border border-surface-200 bg-white">
					<div class="flex items-center gap-2 border-b border-surface-100 px-3 py-2">
						<Layers class="h-3.5 w-3.5 text-surface-400" />
						<span class="text-xs font-medium text-surface-900">Validation groupée</span>
						<span class="text-[11px] text-surface-400">
							Un lot = un projet, une action, un niveau, un risque. Les
							<span class="font-medium">L4 n'y entrent jamais</span> : elles se décident une par une.
						</span>
					</div>
					<div class="divide-y divide-surface-100">
						{#each data.lots as lot (lot.key)}
							<div class="px-3 py-2">
								<div class="flex flex-wrap items-center justify-between gap-2">
									<div class="text-xs text-surface-600">
										<span class="font-medium text-surface-900">{lot.projectSlug ?? '—'}</span>
										· {ACTION_LABEL[lot.actionType] ?? lot.actionType}
										· {LEVEL_LABEL[lot.level] ?? lot.level}
										· risque <span class={RISK_TONE[lot.risk] ?? ''}>{RISK_LABEL[lot.risk] ?? lot.risk}</span>
										<span class="ml-1 font-semibold tabular-nums">({lot.items.length})</span>
									</div>
									<button
										onclick={() => approveLot(lot)}
										disabled={busyLot !== null}
										class="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
									>
										{busyLot === lot.key ? 'Approbation…' : `Approuver les ${lot.items.length}`}
									</button>
								</div>
								{#if lotResult && lotResult.key === lot.key}
									<p class="mt-1 text-[11px] {lotResult.ok ? 'text-emerald-700' : 'text-red-700'}">
										{lotResult.message}
									</p>
								{/if}
							</div>
						{/each}
					</div>
					{#if data.excludedFromLots.length > 0}
						<p class="border-t border-surface-100 px-3 py-2 text-[11px] text-surface-400">
							Hors lot ({data.excludedFromLots.length}) :
							{data.excludedFromLots.map((e) => e.reason).join(' · ')}
						</p>
					{/if}
				</div>
			{/if}

			{#if data.proposals.length === 0}
				<div class="flex flex-col items-center justify-center py-16 text-center">
					<Inbox class="h-10 w-10 text-surface-300" />
					<p class="mt-3 text-sm text-surface-500">Aucune proposition pour ces filtres.</p>
				</div>
			{:else}
				<div class="overflow-x-auto rounded-lg border border-surface-200 bg-white">
					<table class="w-full text-xs">
						<thead class="bg-surface-50 text-left text-[10px] font-semibold uppercase tracking-wider text-surface-500">
							<tr>
								<th class="px-3 py-2">Statut</th>
								<th class="px-3 py-2">Action</th>
								<th class="px-3 py-2">Cible</th>
								<th class="px-3 py-2">Projet</th>
								<th class="px-3 py-2">Niveau</th>
								<th class="px-3 py-2">Risque</th>
								<th class="px-3 py-2">Payload</th>
								<th class="px-3 py-2">Modifiée</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-surface-100">
							{#each data.proposals as p (p.id)}
								<tr class="cursor-pointer hover:bg-surface-50" onclick={() => goto(`/inbox/proposals/${p.id}`)}>
									<td class="px-3 py-2 whitespace-nowrap">
										<span
											class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold {PROPOSAL_TONE[
												p.status
											] ?? 'bg-surface-50 text-surface-600 border-surface-200'}"
										>
											{PROPOSAL_STATUS_LABEL[p.status] ?? p.status}
										</span>
									</td>
									<td class="px-3 py-2">
										<a href="/inbox/proposals/{p.id}" class="font-medium text-surface-900 hover:text-primary-600 hover:underline">
											{ACTION_LABEL[p.actionType] ?? p.actionType}
										</a>
										{#if p.findingTitle}
											<div class="text-[10px] text-surface-400">{p.findingTitle}</div>
										{/if}
									</td>
									<td class="px-3 py-2 max-w-[22rem] truncate text-surface-600" title={p.target ?? ''}>
										{p.target ?? '—'}
									</td>
									<td class="px-3 py-2 whitespace-nowrap text-surface-600">{p.projectSlug ?? '—'}</td>
									<td class="px-3 py-2 whitespace-nowrap">
										<span class="font-medium text-surface-700">{p.requiredApprovalLevel}</span>
										<div class="text-[10px] text-surface-400">{LEVEL_APPROVER[p.requiredApprovalLevel] ?? ''}</div>
									</td>
									<td class="px-3 py-2 whitespace-nowrap {RISK_TONE[p.riskLevel ?? 'inconnu'] ?? ''}">
										{RISK_LABEL[p.riskLevel ?? 'inconnu'] ?? p.riskLevel}
									</td>
									<td class="px-3 py-2 whitespace-nowrap font-mono text-[10px] text-surface-400">
										{shortHash(p.payloadHash, 8)}
									</td>
									<td class="px-3 py-2 whitespace-nowrap text-surface-500">{formatDbTimestamp(p.updatedAt)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		{:else if data.findings.length === 0}
			<div class="flex flex-col items-center justify-center py-16 text-center">
				<ShieldAlert class="h-10 w-10 text-surface-300" />
				<p class="mt-3 text-sm text-surface-500">Aucun finding pour ces filtres.</p>
			</div>
		{:else}
			<div class="overflow-x-auto rounded-lg border border-surface-200 bg-white">
				<table class="w-full text-xs">
					<thead class="bg-surface-50 text-left text-[10px] font-semibold uppercase tracking-wider text-surface-500">
						<tr>
							<th class="px-3 py-2">Statut</th>
							<th class="px-3 py-2">Finding</th>
							<th class="px-3 py-2">Entité</th>
							<th class="px-3 py-2">Projet</th>
							<th class="px-3 py-2">Sévérité</th>
							<th class="px-3 py-2">Priorité</th>
							<th class="px-3 py-2">Occurrences</th>
							<th class="px-3 py-2">Vu</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-surface-100">
						{#each data.findings as f (f.id)}
							<tr class="cursor-pointer hover:bg-surface-50" onclick={() => goto(`/inbox/findings/${f.id}`)}>
								<td class="px-3 py-2 whitespace-nowrap">
									<span
										class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold {FINDING_TONE[
											f.status
										] ?? 'bg-surface-50 text-surface-600 border-surface-200'}"
									>
										{FINDING_STATUS_LABEL[f.status] ?? f.status}
									</span>
								</td>
								<td class="px-3 py-2">
									<a href="/inbox/findings/{f.id}" class="font-medium text-surface-900 hover:text-primary-600 hover:underline">
										{f.title}
									</a>
									<div class="text-[10px] text-surface-400">{FINDING_TYPE_LABEL[f.type] ?? f.type}</div>
								</td>
								<td class="px-3 py-2 max-w-[20rem] truncate text-surface-600" title={f.entityKey}>
									{f.entityKey}
								</td>
								<td class="px-3 py-2 whitespace-nowrap text-surface-600">{f.projectSlug ?? '—'}</td>
								<td class="px-3 py-2 whitespace-nowrap text-surface-600">
									{SEVERITY_LABEL[f.severity] ?? f.severity}
								</td>
								<td class="px-3 py-2 whitespace-nowrap tabular-nums text-surface-700">
									{f.priorityScore}
									<span class="ml-1 text-[10px] text-surface-400">{priorityBand(f.priorityScore)}</span>
								</td>
								<td class="px-3 py-2 whitespace-nowrap tabular-nums text-surface-500">{f.occurrenceCount}</td>
								<td class="px-3 py-2 whitespace-nowrap text-surface-500">
									{formatRelative(f.lastSeenAt, data.now)}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		{#if totalPages > 1}
			<div class="mt-3 flex items-center justify-between text-xs text-surface-500">
				<span>Page {currentPage} / {totalPages}</span>
				<div class="flex gap-2">
					<button
						disabled={data.filters.offset === 0}
						onclick={() => gotoOffset(Math.max(0, data.filters.offset - data.filters.limit))}
						class="rounded-md border border-surface-200 bg-white px-3 py-1 font-medium transition-colors hover:bg-surface-50 disabled:opacity-40"
					>
						Précédent
					</button>
					<button
						disabled={currentPage >= totalPages}
						onclick={() => gotoOffset(data.filters.offset + data.filters.limit)}
						class="rounded-md border border-surface-200 bg-white px-3 py-1 font-medium transition-colors hover:bg-surface-50 disabled:opacity-40"
					>
						Suivant
					</button>
				</div>
			</div>
		{/if}
	</div>
</div>
