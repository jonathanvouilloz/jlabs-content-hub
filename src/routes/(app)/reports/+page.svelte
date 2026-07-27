<script lang="ts">
	import { ArrowRight, FileText } from 'lucide-svelte';

	let { data } = $props();

	const rows = $derived(data.rows);
	const freshness = $derived(data.freshness);

	/**
	 * `partial` est AMBRE, jamais rouge : le rapport est bien parti, il ne couvre simplement pas
	 * tout le périmètre attendu. Le peindre comme une panne ferait chercher un incident là où
	 * il y a un constat — et REP-003 publie délibérément plutôt que d'attendre indéfiniment.
	 */
	const STATUS_BADGE: Record<string, string> = {
		complete: 'bg-emerald-50 text-emerald-700 border-emerald-200',
		partial: 'bg-amber-50 text-amber-700 border-amber-200'
	};

	const FRESHNESS_BADGE: Record<string, string> = {
		// « jamais publié » est VIOLET, comme partout ailleurs dans le cockpit : ce n'est ni un
		// succès ni un échec, c'est un « je n'ai rien à dire », et il demande un autre geste.
		never: 'bg-violet-50 text-violet-700 border-violet-200',
		stale: 'bg-amber-50 text-amber-700 border-amber-200',
		current: 'bg-emerald-50 text-emerald-700 border-emerald-200'
	};
	const FRESHNESS_LABEL: Record<string, string> = {
		never: 'aucune publication',
		stale: 'créneau manqué',
		current: 'à jour'
	};
</script>

<div class="space-y-6">
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<h1 class="text-lg font-semibold text-surface-900">Rapports hebdomadaires</h1>
			<p class="mt-0.5 text-sm text-surface-600">
				Le rapport consolidé du lundi, tel qu'il a été publié. Cross-projet : il n'appartient à
				aucun projet en particulier.
			</p>
			<p class="mt-0.5 text-xs text-surface-500">{freshness.note}</p>
		</div>
		<span
			class="inline-flex flex-shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium {FRESHNESS_BADGE[
				freshness.state
			]}"
		>
			{FRESHNESS_LABEL[freshness.state]}
		</span>
	</header>

	{#if rows.length === 0}
		<!--
			L'état vide est NOMMÉ, jamais un tableau vide : « aucun rapport publié » et « une semaine
			sans rien à signaler » demandent deux gestes opposés (brancher le tick / lire le rapport).
		-->
		<div class="rounded-xl border border-dashed border-surface-300 bg-white p-8 text-center">
			<FileText size={20} class="mx-auto text-surface-300" />
			<p class="mt-2 text-sm font-medium text-surface-700">Aucun rapport publié à ce jour</p>
			<p class="mx-auto mt-1 max-w-lg text-xs text-surface-500">
				Le rapport se publie depuis le tick horaire, après le créneau hebdomadaire. Tant qu'aucun
				tick n'a tourné, cette liste reste vide — ce n'est pas une semaine sans nouvelle.
			</p>
			<p class="mt-2 font-mono text-[11px] text-surface-400">
				npx tsx scripts/rep-003-publish.ts --dry-run
			</p>
		</div>
	{:else}
		<ul class="space-y-2">
			{#each rows as row (row.periodSlot)}
				<li>
					<a
						href={row.href}
						class="group flex flex-wrap items-start justify-between gap-3 rounded-xl border border-surface-200 bg-white p-4 transition-colors hover:border-surface-300"
					>
						<div class="min-w-0 space-y-1">
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium text-surface-900">{row.slotLabel}</span>
								<span
									class="inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium {STATUS_BADGE[
										row.status
									]}"
								>
									{row.status}
								</span>
								<!-- Le SLO est DÉRIVÉ à chaque lecture (aucune colonne de verdict) : changer
								     `report.publish_deadline_minutes` change cette phrase sans réécrire une ligne. -->
								<span
									class="text-[11px] {row.slo.met ? 'text-surface-400' : 'font-medium text-orange-700'}"
								>
									{row.sloLabel}
								</span>
								{#if row.revisionCount > 1}
									<!-- REP-004 : la ligne montre la révision COURANTE ; les précédentes restent
									     lisibles depuis le détail. Le badge existe pour qu'un créneau révisé ne
									     se lise pas comme un créneau publié une seule fois. -->
									<span
										class="inline-flex items-center rounded-md border border-surface-200 bg-surface-50 px-1.5 py-0.5 text-[10px] font-medium text-surface-600"
									>
										rév. {row.revision}/{row.revisionCount}
									</span>
								{/if}
								{#if row.detailState === 'purged'}
									<!-- REP-004 lot 2 — le créneau reste une ligne entière (statut, SLO,
									     périmètre) ; seul son détail vit désormais dans le vault. Le badge
									     évite qu'un rapport ouvert et court se lise comme un rapport vide. -->
									<span
										class="inline-flex items-center rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
									>
										détail archivé
									</span>
								{/if}
							</div>
							{#if row.readinessLabel}
								<p class="text-[11px] text-surface-500">{row.readinessLabel}</p>
							{:else}
								<p class="text-[11px] italic text-surface-400">
									Préparation illisible — le périmètre de ce créneau ne peut pas être affiché.
								</p>
							{/if}
							<p class="text-[11px] text-surface-400">{row.statusNote}</p>
							{#if row.revisionLabel}
								<p class="text-[11px] text-surface-500">{row.revisionLabel}</p>
							{/if}
							{#if row.detailNote}
								<p class="text-[11px] text-violet-700">{row.detailNote}</p>
							{/if}
						</div>
						<div class="flex flex-shrink-0 items-center gap-2 text-[11px] text-surface-400">
							<span class="font-mono">publié {row.publishedAt}</span>
							<ArrowRight size={14} class="text-surface-300 group-hover:text-surface-500" />
						</div>
					</a>
				</li>
			{/each}
		</ul>

		<p class="text-[11px] text-surface-400">
			Les 12 derniers créneaux — une ligne par semaine, jamais deux : le tick ne publie qu'une
			révision par créneau. Un créneau régénéré (REP-004) affiche sa révision COURANTE ; les
			précédentes restent lisibles depuis son détail.
		</p>
	{/if}
</div>
