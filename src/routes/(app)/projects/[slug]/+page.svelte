<script lang="ts">
	import {
		Activity,
		AlertOctagon,
		AlertTriangle,
		ArrowRight,
		CheckCircle2,
		Clock,
		Eye,
		HelpCircle,
		PlugZap,
		Power,
		Search
	} from 'lucide-svelte';

	let { data } = $props();

	const cockpit = $derived(data.cockpit);
	const card = $derived(data.cockpit.card);

	const nf = new Intl.NumberFormat('fr-FR');
	const fmtInt = (n: number) => nf.format(n);
	const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)} %`);

	// Même vocabulaire visuel que l'accueil pour les états de PROJET : le même projet ne doit
	// pas changer de couleur en changeant d'écran.
	const STATE_META: Record<string, { label: string; badge: string; icon: typeof AlertOctagon }> = {
		broken: { label: 'Collecte cassée', badge: 'bg-red-50 text-red-700 border-red-200', icon: AlertOctagon },
		at_risk: { label: 'À traiter', badge: 'bg-orange-50 text-orange-700 border-orange-200', icon: AlertTriangle },
		unknown: { label: 'État inconnu', badge: 'bg-violet-50 text-violet-700 border-violet-200', icon: HelpCircle },
		watch: { label: 'À surveiller', badge: 'bg-amber-50 text-amber-700 border-amber-200', icon: Eye },
		ok: { label: 'Sain', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: CheckCircle2 }
	};
	const meta = (state: string) => STATE_META[state] ?? STATE_META.unknown;

	/**
	 * Les états de PANNEAU, distincts de ceux du projet — et `inactive` est délibérément neutre
	 * (gris, pas rouge) : un provider qu'on n'a pas branché n'est pas une panne, c'est une
	 * décision. Le peindre comme une erreur ferait reprocher à Jonathan un flux qu'il n'utilise
	 * pas encore.
	 */
	const PANEL_META: Record<string, { label: string; badge: string }> = {
		broken: { label: 'cassé', badge: 'bg-red-50 text-red-700 border-red-200' },
		stale: { label: 'en retard', badge: 'bg-amber-50 text-amber-700 border-amber-200' },
		never: { label: 'aucune collecte', badge: 'bg-violet-50 text-violet-700 border-violet-200' },
		inactive: { label: 'non branché', badge: 'bg-surface-100 text-surface-500 border-surface-200' },
		ok: { label: 'à jour', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
	};
	const panelMeta = (s: string) => PANEL_META[s] ?? PANEL_META.never;

	const KIND_META: Record<string, { label: string; dot: string }> = {
		run: { label: 'run', dot: 'bg-sky-400' },
		finding: { label: 'diagnostic', dot: 'bg-amber-400' },
		decision: { label: 'décision', dot: 'bg-emerald-500' }
	};

	/** `never` n'est JAMAIS rendu « il y a 0 h » — l'état des données ne se confond pas avec zéro. */
	function freshnessLabel(f: { state: string; ageHours: number | null }): string {
		if (f.state === 'never' || f.ageHours === null) return 'jamais collecté';
		const h = f.ageHours;
		if (h < 1) return "il y a moins d'une heure";
		if (h < 48) return `il y a ${Math.round(h)} h`;
		return `il y a ${Math.round(h / 24)} j`;
	}

	function fmtDb(ts: string): string {
		return ts.slice(0, 16).replace(' ', ' à ');
	}

	function fmtDelta(d: { abs: number; pct: number | null }): string {
		const sign = d.abs > 0 ? '+' : '';
		return d.pct === null ? `${sign}${fmtInt(d.abs)}` : `${sign}${fmtInt(d.abs)} (${sign}${Math.round(d.pct)} %)`;
	}

	const gsc28 = $derived(cockpit.gsc.windows.find((w) => w.span === 28) ?? cockpit.gsc.windows[0] ?? null);
</script>

<div class="space-y-6">
	<!-- ── Santé : les deux axes, jamais fondus ──────────────────── -->
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<div class="flex items-center gap-2">
				<span
					class="h-2.5 w-2.5 flex-shrink-0 rounded-full"
					style="background-color: {cockpit.project.color ?? '#888'};"
				></span>
				<h1 class="truncate text-xl font-semibold text-surface-900">{cockpit.project.name}</h1>
				{#if card}
					{@const m = meta(card.state)}
					<span
						class="inline-flex flex-shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium {m.badge}"
					>
						<m.icon size={11} />
						{m.label}
					</span>
				{/if}
			</div>
			<p class="mt-1 text-sm text-surface-600">
				{#if card}
					{card.headline}
				{:else}
					Projet archivé — la santé n'est calculée que pour les projets actifs.
				{/if}
			</p>
		</div>
		<div class="flex-shrink-0 text-right text-[11px] text-surface-400">
			<div class="inline-flex items-center gap-1">
				<Clock size={11} />
				{cockpit.windowDays} jours glissants (depuis {fmtDb(cockpit.sinceDb)})
			</div>
		</div>
	</header>

	{#if card}
		<div class="grid gap-2 sm:grid-cols-2">
			<div class="rounded-lg border border-surface-200 bg-white px-3 py-2">
				<div class="flex items-center gap-1.5 text-[11px] font-medium text-surface-500">
					<PlugZap size={12} /> Collecte
					<span class="text-surface-400">· {card.pipeline.state}</span>
				</div>
				{#if card.pipeline.reasons.length === 0}
					<p class="mt-0.5 text-xs text-surface-400">la donnée arrive</p>
				{:else}
					<ul class="mt-0.5 space-y-0.5">
						{#each card.pipeline.reasons as r}
							<li class="text-xs text-surface-600">{r}</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="rounded-lg border border-surface-200 bg-white px-3 py-2">
				<div class="flex items-center gap-1.5 text-[11px] font-medium text-surface-500">
					<Activity size={12} /> Performance
					<span class="text-surface-400">· {card.signal.state}</span>
				</div>
				{#if card.signal.reasons.length === 0}
					<p class="mt-0.5 text-xs text-surface-400">rien à signaler</p>
				{:else}
					<ul class="mt-0.5 space-y-0.5">
						{#each card.signal.reasons as r}
							<li class="text-xs text-surface-600">{r}</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>

		<!-- Compteurs du projet : le nombre ET son lien viennent du même descripteur. -->
		<div class="flex flex-wrap items-center gap-x-4 gap-y-1">
			{#each cockpit.counters as c (c.label)}
				{#if c.href}
					<a href={c.href} class="group inline-flex items-baseline gap-1 text-xs text-surface-500 hover:text-surface-800">
						<span class="font-semibold text-surface-900">{fmtInt(c.count)}</span>
						{c.label}
						<ArrowRight size={10} class="self-center text-surface-300 transition-colors group-hover:text-surface-500" />
					</a>
				{:else}
					<span
						class="inline-flex items-baseline gap-1 text-xs text-surface-400"
						title="Aucune liste ne reproduit exactement ce compteur — il reste un chiffre plutôt qu'un lien qui mènerait ailleurs."
					>
						<span class="font-semibold text-surface-700">{fmtInt(c.count)}</span>
						{c.label}
					</span>
				{/if}
			{/each}
		</div>
	{/if}

	<!-- ── Panneaux par domaine ──────────────────────────────────── -->
	<!-- Chaque panneau porte son TRIO : période réellement couverte, fraîcheur, table source.
	     Un chiffre sans période est incomparable ; sans source, invérifiable. -->
	<section>
		<h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">
			Domaines — par urgence
		</h2>
		<div class="grid gap-3 lg:grid-cols-3">
			{#each cockpit.panels as p (p.key)}
				{@const pm = panelMeta(p.state)}
				<article
					class="rounded-xl border bg-white p-4 shadow-sm {p.state === 'inactive'
						? 'border-dashed border-surface-200'
						: 'border-surface-200'}"
				>
					<div class="flex items-start justify-between gap-2">
						<h3 class="text-sm font-semibold text-surface-900">{p.label}</h3>
						<span class="inline-flex flex-shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium {pm.badge}">
							{#if p.state === 'inactive'}<Power size={10} />{/if}
							{pm.label}
						</span>
					</div>
					<p class="mt-0.5 text-xs text-surface-500">{p.note}</p>

					<!-- Le contenu ne s'affiche QUE si le domaine a quelque chose à dire. Rendre des
					     zéros pour un flux non branché serait la panne muette que DASH-002 refuse. -->
					{#if p.key === 'gsc' && p.state !== 'inactive' && p.state !== 'never' && gsc28}
						<div class="mt-3 grid grid-cols-2 gap-2 text-sm">
							<div>
								<div class="text-lg font-semibold text-surface-900">{fmtInt(gsc28.current?.clicks ?? 0)}</div>
								<div class="text-[11px] text-surface-500">clics</div>
							</div>
							<div>
								<div class="text-lg font-semibold text-surface-900">{fmtInt(gsc28.current?.impressions ?? 0)}</div>
								<div class="text-[11px] text-surface-500">impressions</div>
							</div>
						</div>
						<p class="mt-1 text-[11px] text-surface-500">
							{#if gsc28.delta.available}
								clics {fmtDelta(gsc28.delta.clicks)} vs période précédente
							{:else}
								<!-- Le refus de delta vit dans le module pur : deux fenêtres de longueurs
								     différentes ne se comparent pas, et l'écran le DIT. -->
								pas de comparaison : les deux fenêtres n'ont pas la même longueur
							{/if}
						</p>
						{#if gsc28.completeness.caveats.length > 0}
							<ul class="mt-1 space-y-0.5">
								{#each gsc28.completeness.caveats as c}
									<li class="text-[11px] text-amber-700">{c}</li>
								{/each}
							</ul>
						{/if}
						<a href="/projects/{cockpit.project.slug}/windows" class="mt-2 inline-flex items-center gap-1 text-xs text-primary-600 hover:underline">
							Fenêtres 7 / 28 / 90 j <ArrowRight size={11} />
						</a>
					{:else if p.key === 'indexing' && p.state !== 'inactive' && p.state !== 'never'}
						<div class="mt-3 grid grid-cols-2 gap-2">
							<div>
								<div class="text-lg font-semibold text-surface-900">{pct(cockpit.indexation.coverageRate)}</div>
								<div class="text-[11px] text-surface-500">indexées (verdict tranché)</div>
							</div>
							<div>
								<div class="text-lg font-semibold text-surface-900">{fmtInt(cockpit.indexation.urlsObserved)}</div>
								<div class="text-[11px] text-surface-500">URLs observées</div>
							</div>
						</div>
						<ul class="mt-2 space-y-0.5 text-[11px] text-surface-500">
							<li>{fmtInt(cockpit.indexation.classes.not_indexed)} non indexées · {fmtInt(cockpit.indexation.classes.excluded)} exclues (décision du site)</li>
							{#if cockpit.indexation.dueNow > 0}
								<!-- Des INTENTIONS dues, jamais « pages inspectées » : la table est optimiste. -->
								<li>
									{fmtInt(cockpit.indexation.dueNow)} inspection(s) due(s), la plus ancienne au {cockpit.indexation.oldestDueDate}
								</li>
							{:else}
								<li>aucune inspection en attente</li>
							{/if}
						</ul>
					{:else if p.key === 'findings' && card}
						<div class="mt-3 grid grid-cols-2 gap-2">
							<div>
								<div class="text-lg font-semibold text-surface-900">{fmtInt(card.openTotal)}</div>
								<div class="text-[11px] text-surface-500">findings ouverts</div>
							</div>
							<div>
								<div class="text-lg font-semibold text-surface-900">{fmtInt(card.activity.created)}</div>
								<div class="text-[11px] text-surface-500">nouveaux sur la période</div>
							</div>
						</div>
						<a href="/inbox?tab=findings&project={cockpit.project.slug}" class="mt-2 inline-flex items-center gap-1 text-xs text-primary-600 hover:underline">
							Ouvrir l'inbox <ArrowRight size={11} />
						</a>
					{/if}

					<!-- Le trio, sur chaque panneau, toujours au même endroit. -->
					<dl class="mt-3 space-y-0.5 border-t border-surface-100 pt-2 text-[11px] text-surface-400">
						<div class="flex gap-1">
							<dt class="font-medium">Période</dt>
							<dd>{p.provenance.period?.label ?? 'aucune donnée'}</dd>
						</div>
						<div class="flex gap-1">
							<dt class="font-medium">Fraîcheur</dt>
							<dd>{freshnessLabel(p.provenance.freshness)}</dd>
						</div>
						<div class="flex gap-1">
							<dt class="font-medium">Source</dt>
							<dd class="truncate font-mono">{p.provenance.source}</dd>
						</div>
					</dl>

					{#if p.state === 'inactive'}
						<a href="/projects/{cockpit.project.slug}/settings" class="mt-2 inline-flex items-center gap-1 text-xs text-surface-500 hover:text-surface-800">
							Brancher <ArrowRight size={11} />
						</a>
					{/if}
				</article>
			{/each}
		</div>
	</section>

	<!-- ── Timeline ──────────────────────────────────────────────── -->
	<section>
		<div class="mb-2 flex items-baseline justify-between">
			<h2 class="text-xs font-semibold uppercase tracking-wider text-surface-400">
				Ce qui s'est passé
			</h2>
			{#if cockpit.timeline.truncated > 0}
				<!-- Une troncature se DIT : sans ça, une timeline pleine se lit comme complète. -->
				<span class="text-[11px] text-surface-400">
					{cockpit.timeline.truncated} entrée(s) plus ancienne(s) non affichée(s)
				</span>
			{/if}
		</div>

		{#if cockpit.timeline.entries.length === 0}
			<div class="rounded-xl border border-dashed border-surface-200 px-4 py-6 text-center">
				<Search size={18} class="mx-auto text-surface-300" />
				<p class="mt-1 text-sm text-surface-500">
					Aucun run, aucun diagnostic, aucune décision sur ce projet.
				</p>
			</div>
		{:else}
			<ol class="space-y-1">
				{#each cockpit.timeline.entries as e (e.kind + e.id)}
					{@const km = KIND_META[e.kind]}
					<li class="flex items-start gap-3 rounded-lg border border-surface-100 bg-white px-3 py-2">
						<span class="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full {km.dot}" title={km.label}></span>
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-baseline gap-x-2">
								{#if e.href}
									<a href={e.href} class="truncate text-sm text-surface-900 hover:underline">{e.title}</a>
								{:else}
									<span class="truncate text-sm text-surface-900">{e.title}</span>
								{/if}
								{#if e.approvalLevel}
									<span class="rounded border border-surface-200 px-1 text-[10px] text-surface-500">{e.approvalLevel}</span>
								{/if}
							</div>
							{#if e.detail}
								<p class="text-xs text-surface-500">{e.detail}</p>
							{/if}
							{#if e.reason}
								<!-- Le motif est obligatoire à l'écriture (DASH-005) : il doit se relire ici,
								     sinon « les décisions passées sont accessibles » serait décoratif. -->
								<p class="text-xs text-surface-600">« {e.reason} »</p>
							{/if}
						</div>
						<div class="flex-shrink-0 text-right text-[11px] text-surface-400">
							<div>{fmtDb(e.at)}</div>
							{#if e.actor}<div>{e.actor}</div>{/if}
						</div>
					</li>
				{/each}
			</ol>
		{/if}
	</section>
</div>
