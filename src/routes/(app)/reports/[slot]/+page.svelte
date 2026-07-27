<script lang="ts">
	import { ArrowLeft, EyeOff, History, Info, Minus, TrendingDown, TrendingUp } from 'lucide-svelte';

	let { data } = $props();

	const view = $derived(data.view);
	const comparison = $derived(data.comparison);
	/**
	 * ⚠️ Le tri « cette section a-t-elle changé ? » est fait par `sectionHasChange` (module pur,
	 * testé), côté loader — jamais par un `{#if}` ici. Une règle qui ne vivrait que dans un
	 * template se perdrait au premier refactor (doctrine `buildProjectCounters`), et celle-ci
	 * décide de ce que Jonathan verra ou non.
	 */
	const changed = $derived(data.changedSections);
	const unchanged = $derived(data.unchangedSections);

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
		{#if view.revisionLabel}
			<p class="text-[11px] text-surface-500">
				{view.revisionLabel}
				{#if view.revisionReason}
					<span class="italic">Raison : « {view.revisionReason} »</span>
				{/if}
			</p>
		{/if}
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
			<!-- Écriture de CETTE révision — le SLO, lui, porte sur la première publication. -->
			<dt class="font-medium">Publié</dt>
			<dd class="font-mono">{view.publishedAt}</dd>
		</div>
		<div class="flex gap-1">
			<dt class="font-medium">Révision</dt>
			<dd class="font-mono">{view.revision}/{view.revisionCount}</dd>
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
		── Le lignage (REP-004) ──────────────────────────────────────────
		L'acceptation « régénérer ne remplace pas silencieusement l'original » n'a de sens que si
		l'original reste ATTEIGNABLE : chaque révision porte son lien, sa raison et son statut
		d'origine. Rien ici quand le créneau n'a qu'une révision — il n'y a alors rien à raconter.
	-->
	{#if view.lineage}
		<section class="rounded-xl border border-surface-200 bg-white">
			<header class="flex items-center gap-2 border-b border-surface-100 px-4 py-2.5">
				<History size={14} class="text-surface-400" />
				<h2 class="text-sm font-semibold text-surface-900">Révisions de ce créneau</h2>
				<span class="text-[11px] text-surface-400">{view.lineage.note}</span>
			</header>
			<ul class="divide-y divide-surface-100">
				{#each view.lineage.entries as entry (entry.id)}
					<li class="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2">
						<div class="min-w-0">
							<a
								href="/reports/{encodeURIComponent(view.periodSlot)}?revision={entry.revision}"
								class="text-xs {entry.revision === view.revision
									? 'font-semibold text-surface-900'
									: 'text-surface-700 hover:underline'}"
							>
								Révision {entry.revision}{entry.current ? ' (courante)' : ''}
							</a>
							{#if entry.reason}
								<span class="ml-1 text-[11px] text-surface-500">« {entry.reason} »</span>
							{:else}
								<span class="ml-1 text-[11px] italic text-surface-400">
									publication automatique du tick
								</span>
							{/if}
						</div>
						<div class="flex flex-shrink-0 items-baseline gap-2 text-[11px]">
							<span
								class="inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium {STATUS_BADGE[
									entry.status
								]}"
							>
								{entry.status}
							</span>
							<span class="font-mono text-surface-400">{entry.publishedAt}</span>
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<!--
		── Ce qui a changé (REP-004) ─────────────────────────────────────
		⭐ Une section devenue disponible (ou devenue absente) n'a AUCUN chiffre ici, et ce n'est
		pas un oubli de template : `SectionComparison` est une union dont ces variantes ne portent
		pas de champ chiffré. Un provider branché cette semaine ne peut donc pas s'afficher
		« +13 », et un provider tombé en panne ne peut pas s'afficher « −13 » (ce qui se lirait
		comme treize problèmes résolus).
	-->
	<section class="rounded-xl border border-surface-200 bg-white">
		<header class="flex flex-wrap items-center justify-between gap-2 border-b border-surface-100 px-4 py-2.5">
			<h2 class="text-sm font-semibold text-surface-900">Ce qui a changé</h2>
			{#if comparison?.kind === 'available'}
				<span class="text-[11px] text-surface-500">
					{comparison.axis === 'revision' ? 'depuis la révision' : 'depuis le créneau'}
					<a href={data.baseHref} class="font-mono hover:underline">
						{comparison.base.periodSlot}{comparison.base.revision > 1
							? ` (rév. ${comparison.base.revision})`
							: ''}
					</a>
				</span>
			{/if}
		</header>

		{#if !comparison}
			<!-- « Rien à comparer » est un ÉTAT, jamais une liste vide. -->
			<p class="px-4 py-3 text-[11px] text-surface-500">{data.comparisonAbsence}</p>
		{:else if comparison.kind === 'unavailable'}
			<p class="px-4 py-3 text-[11px] text-surface-500">{comparison.note}</p>
		{:else}
			<div class="space-y-3 px-4 py-3">
				<p class="text-xs text-surface-700">{comparison.summary.headline}</p>

				{#each comparison.blocks as block (block.reason)}
					<!-- Un blocage n'est pas une panne : les faits restent lisibles, seul l'écart
					     est refusé. Ambre, jamais rouge. -->
					<p class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
						{block.note}
					</p>
				{/each}

				{#if changed.length === 0}
					<p class="text-[11px] italic text-surface-400">
						Aucune section n'a bougé entre les deux rapports.
					</p>
				{/if}

				{#each changed as section (section.key)}
					<div class="space-y-1 border-t border-surface-100 pt-2 first:border-0 first:pt-0">
						<h3 class="text-xs font-medium text-surface-800">{section.title}</h3>

						{#if section.kind === 'comparable'}
							<ul class="space-y-0.5">
								{#each section.metrics as metric (metric.key)}
									{#if metric.kind === 'comparable' && (metric.delta !== 0 || metric.renamed)}
										<li class="flex flex-wrap items-baseline gap-1.5 text-[11px]">
											{#if metric.direction === 'up'}
												<TrendingUp size={12} class="text-orange-600" />
											{:else if metric.direction === 'down'}
												<TrendingDown size={12} class="text-emerald-600" />
											{:else}
												<Minus size={12} class="text-surface-300" />
											{/if}
											<span class="text-surface-600">{metric.headLabel}</span>
											<span class="font-mono text-surface-400">{metric.baseDisplay}</span>
											<span class="text-surface-300">→</span>
											<span class="font-mono font-medium text-surface-900">{metric.headDisplay}</span>
											{#if metric.renamed}
												<span class="italic text-surface-400">
													(renommée, autrefois « {metric.baseLabel} »)
												</span>
											{/if}
										</li>
									{:else if metric.kind === 'appeared'}
										<li class="text-[11px] text-surface-600">
											<span class="text-violet-700">nouvelle métrique</span>
											{metric.label} : <span class="font-mono">{metric.headDisplay}</span> — elle
											n'existait pas avant, ce n'est donc pas une hausse.
										</li>
									{:else if metric.kind === 'disappeared'}
										<li class="text-[11px] text-surface-600">
											<span class="text-violet-700">métrique disparue</span>
											{metric.label} (valait <span class="font-mono">{metric.baseDisplay}</span>).
										</li>
									{:else if metric.kind === 'unquantified'}
										<li class="text-[11px] text-surface-500">
											{metric.label} : {metric.baseDisplay} → {metric.headDisplay} — {metric.note}
										</li>
									{:else if metric.kind === 'blocked'}
										<li class="text-[11px] text-surface-500">
											{metric.label} : {metric.baseDisplay} → {metric.headDisplay} — écart non
											calculé ({metric.reason}).
										</li>
									{/if}
								{/each}
							</ul>

							{#if section.items.kind === 'movements'}
								{#if section.items.entered.length > 0}
									<p class="text-[11px] text-surface-600">
										Entrés ({section.items.entered.length}) :
										{#each section.items.entered.slice(0, 5) as item, i (item.label + i)}
											{i > 0 ? ' · ' : ''}{item.label}
										{/each}
										{#if section.items.entered.length > 5}
											… et {section.items.entered.length - 5} autres
										{/if}
									</p>
								{/if}
								{#if section.items.left.length > 0}
									<p class="text-[11px] text-surface-600">
										Sortis ({section.items.left.length}) :
										{#each section.items.left.slice(0, 5) as item, i (item.label + i)}
											{i > 0 ? ' · ' : ''}{item.label}
										{/each}
										{#if section.items.left.length > 5}
											… et {section.items.left.length - 5} autres
										{/if}
									</p>
								{/if}
							{:else}
								<p class="text-[11px] italic text-surface-400">{section.items.note}</p>
							{/if}
						{:else}
							<!-- ⭐ Les variantes non comparables : une phrase, aucun chiffre. -->
							<p class="text-[11px] text-violet-700">{section.note}</p>
						{/if}
					</div>
				{/each}

				{#if unchanged > 0}
					<p class="border-t border-surface-100 pt-2 text-[11px] text-surface-400">
						{unchanged} section{unchanged > 1 ? 's' : ''} sans changement, masquée{unchanged > 1
							? 's'
							: ''} — elles restent lisibles ci-dessous.
					</p>
				{/if}
			</div>
		{/if}
	</section>

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
		recalculé à la lecture, hormis le verdict SLO qui se dérive de <code>published_at</code> (celui
		de la <em>première</em> publication du créneau) et <code>due_at</code>. Régénérer ce créneau
		ajoute une révision et n'écrase jamais celle-ci :
		<code>npx tsx scripts/rep-003-publish.ts --revise {view.periodSlot} --reason "…"</code>.
	</p>
</div>
