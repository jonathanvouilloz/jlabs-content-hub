<script lang="ts">
	import { ArrowLeft, EyeOff, Info } from 'lucide-svelte';

	let { data } = $props();

	const view = $derived(data.view);

	const STATUS_BADGE: Record<string, string> = {
		complete: 'bg-emerald-50 text-emerald-700 border-emerald-200',
		partial: 'bg-amber-50 text-amber-700 border-amber-200'
	};

	/**
	 * Les trois absences ne portent PAS la même couleur, parce qu'elles ne demandent pas le même
	 * geste (REP-001) : « brancher » (non câblé), « réparer la collecte » (jamais collecté),
	 * « lancer le diagnostic » (jamais examiné). Aucune n'est rouge : ne rien mesurer n'est pas
	 * une panne.
	 */
	const ABSENCE_BADGE: Record<string, string> = {
		not_wired: 'bg-surface-100 text-surface-500 border-surface-200',
		never_collected: 'bg-violet-50 text-violet-700 border-violet-200',
		not_examined: 'bg-violet-50 text-violet-700 border-violet-200'
	};
	const ABSENCE_LABEL: Record<string, string> = {
		not_wired: 'non branché',
		never_collected: 'jamais collecté',
		not_examined: 'jamais examiné'
	};

	const BLINDSPOT_LABEL: Record<string, string> = {
		never_examined: 'jamais diagnostiqué',
		partially_examined: 'partiellement diagnostiqué',
		paused: 'en pause'
	};
</script>

<div class="space-y-6">
	<a
		href="/reports"
		class="inline-flex items-center gap-1 text-[11px] text-surface-500 hover:text-surface-800"
	>
		<ArrowLeft size={13} /> Tous les rapports
	</a>

	<!-- ── En-tête : ce qu'on lit si on ne lit qu'une ligne ───────── -->
	<header class="space-y-2">
		<div class="flex flex-wrap items-center gap-2">
			<h1 class="text-lg font-semibold text-surface-900">Rapport du {view.slotLabel}</h1>
			<span
				class="inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium {STATUS_BADGE[
					view.status
				]}"
			>
				{view.status}
			</span>
			<span class="text-[11px] {view.slo.met ? 'text-surface-400' : 'font-medium text-orange-700'}">
				{view.sloLabel}
			</span>
		</div>
		<p class="text-sm text-surface-700">{view.headline}</p>
		<p class="text-[11px] text-surface-400">{view.statusNote}</p>
	</header>

	<!-- Provenance : période RÉELLE de ce qui a été compté, et les deux dates qui ne se confondent pas. -->
	<dl
		class="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-surface-200 bg-white px-3 py-2 text-[11px] text-surface-400"
	>
		<div class="flex gap-1">
			<dt class="font-medium">Période</dt>
			<dd>{view.periodLabel}</dd>
		</div>
		<div class="flex gap-1">
			<dt class="font-medium">Créneau</dt>
			<dd class="font-mono">{view.periodSlot}</dd>
		</div>
		<div class="flex gap-1">
			<dt class="font-medium">Publié</dt>
			<dd class="font-mono">{view.publishedAt}</dd>
		</div>
		<div class="flex gap-1">
			<dt class="font-medium">Schéma</dt>
			<dd class="font-mono">v{view.reportSchemaVersion}</dd>
		</div>
	</dl>

	{#if view.readinessLabel}
		<p class="text-[11px] text-surface-500">Périmètre : {view.readinessLabel}</p>
	{/if}

	<!--
		Les angles morts du PARC, une seule fois. Ils restent dans chaque section du JSON (une
		section extraite seule doit garder sa réserve), mais les répéter douze fois les noierait —
		même compression que `renderWeeklyReportText`.
	-->
	{#if view.coverageNote}
		<div class="flex gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
			<EyeOff size={14} class="mt-0.5 flex-shrink-0 text-violet-700" />
			<p class="text-[11px] text-violet-900">{view.coverageNote}</p>
		</div>
	{/if}

	<!-- ── Les sections, DANS L'ORDRE DU JSON ARCHIVÉ ─────────────── -->
	{#each view.sections as section (section.key)}
		<section class="rounded-xl border border-surface-200 bg-white">
			<header class="flex flex-wrap items-center justify-between gap-2 border-b border-surface-100 px-4 py-2.5">
				<h2 class="text-sm font-semibold text-surface-900">{section.title}</h2>
				{#if section.kind === 'absent'}
					<span
						class="inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium {ABSENCE_BADGE[
							section.reason
						]}"
					>
						{ABSENCE_LABEL[section.reason]}
					</span>
				{/if}
			</header>

			{#if section.kind === 'absent'}
				<!--
					⭐ Une section absente n'a PAS de corps — il n'existe ici aucun champ où un « 0 »
					pourrait s'écrire. « Absent » n'est pas « zéro » : annoncer 0 visite pour un
					provider non branché décrirait un site sans trafic là où la vérité est qu'on ne
					le mesure pas.
				-->
				<div class="space-y-1 px-4 py-3">
					<p class="text-xs text-surface-600">{section.detail}</p>
					<p class="text-[11px] text-surface-400">{section.note}</p>
				</div>
			{:else}
				<div class="space-y-3 px-4 py-3">
					{#if section.metrics.length > 0}
						<dl class="flex flex-wrap gap-x-6 gap-y-2">
							{#each section.metrics as metric (metric.label)}
								<div>
									<dt class="text-[11px] text-surface-500">{metric.label}</dt>
									<dd class="text-sm font-medium text-surface-900">
										{#if metric.source?.href}
											<a href={metric.source.href} class="hover:underline">{metric.display}</a>
										{:else}
											{metric.display}
										{/if}
									</dd>
								</div>
							{/each}
						</dl>
					{/if}

					{#if section.items.length > 0}
						<ul class="divide-y divide-surface-100">
							{#each section.items as item, i (`${section.key}-${i}`)}
								<li class="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
									<div class="min-w-0">
										<span class="text-xs text-surface-800">
											{#if item.source.href}
												<a href={item.source.href} class="hover:underline">{item.label}</a>
											{:else}
												{item.label}
											{/if}
										</span>
										{#if item.detail}
											<span class="ml-1 text-[11px] text-surface-500">{item.detail}</span>
										{/if}
									</div>
									<div class="flex flex-shrink-0 items-baseline gap-2 text-[11px] text-surface-400">
										{#if item.projectSlug}
											<a href="/projects/{item.projectSlug}" class="hover:underline">
												{item.projectSlug}
											</a>
										{/if}
										<!-- Le critère de tri est AFFICHÉ : un ordre dont le critère reste caché
										     se lit comme un ordre arbitraire. -->
										<span class="font-mono" title="rang">{item.rank}</span>
										{#if !item.source.href && item.source.kind === 'observation'}
											<span class="font-mono italic" title="table source">{item.source.table}</span>
										{/if}
									</div>
								</li>
							{/each}
						</ul>
					{:else}
						<!-- « J'ai regardé, il n'y a rien » — distinct d'une absence, et jamais confondu. -->
						<p class="text-[11px] italic text-surface-400">
							Rien à signaler sur cette section pour la période.
						</p>
					{/if}

					{#if section.truncationNote}
						<p class="text-[11px] text-surface-400">{section.truncationNote}</p>
					{/if}

					{#if section.note}
						<p class="flex gap-1.5 text-[11px] text-surface-500">
							<Info size={12} class="mt-0.5 flex-shrink-0 text-surface-400" />
							{section.note}
						</p>
					{/if}

					{#if section.blindSpots.length > 0}
						<p class="text-[11px] text-violet-700">
							Angles morts de cette section :
							{#each section.blindSpots as spot, i (spot.projectSlug)}
								{i > 0 ? ' · ' : ' '}{spot.projectSlug} ({BLINDSPOT_LABEL[spot.reason]})
							{/each}
						</p>
					{/if}
				</div>
			{/if}
		</section>
	{/each}

	<p class="text-[11px] text-surface-400">
		Ce rapport est rendu depuis le JSON archivé au moment de la publication : rien n'y est
		recalculé à la lecture, hormis le verdict SLO qui se dérive de <code>published_at</code> et
		<code>due_at</code>.
	</p>
</div>
