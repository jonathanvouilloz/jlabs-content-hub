<script lang="ts">
	import { ArrowRight, FileWarning, Gauge, Map, Search, X } from 'lucide-svelte';

	let { data } = $props();

	const ix = $derived(data.indexing);

	const nf = new Intl.NumberFormat('fr-FR');
	const fmtInt = (n: number) => nf.format(n);
	/** `null` n'est JAMAIS rendu « 0 % » — qui se lirait « rien n'est indexé ». */
	const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)} %`);

	/**
	 * Même vocabulaire visuel que la vue d'ensemble pour les états de PANNEAU : le même domaine
	 * ne doit pas changer de couleur en changeant d'onglet.
	 */
	const PANEL_META: Record<string, { label: string; badge: string }> = {
		broken: { label: 'cassé', badge: 'bg-red-50 text-red-700 border-red-200' },
		stale: { label: 'en retard', badge: 'bg-amber-50 text-amber-700 border-amber-200' },
		never: { label: 'aucune collecte', badge: 'bg-violet-50 text-violet-700 border-violet-200' },
		inactive: { label: 'non branché', badge: 'bg-surface-100 text-surface-500 border-surface-200' },
		ok: { label: 'collecte à jour', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
	};
	const panelMeta = (s: string) => PANEL_META[s] ?? PANEL_META.never;

	/**
	 * Les quatre classes d'indexation. `excluded` est délibérément NEUTRE (gris, pas rouge) : un
	 * `noindex` est une décision du site — le peindre comme un échec ferait chercher une panne là
	 * où il y a un choix. `unknown` est violet comme partout ailleurs : « je ne sais pas » n'est
	 * ni un succès ni un échec.
	 */
	const CLASS_BADGE: Record<string, string> = {
		indexed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
		not_indexed: 'bg-orange-50 text-orange-700 border-orange-200',
		excluded: 'bg-surface-100 text-surface-500 border-surface-200',
		unknown: 'bg-violet-50 text-violet-700 border-violet-200'
	};

	const CANONICAL_BADGE: Record<string, string> = {
		agree: 'text-surface-400',
		mismatch: 'text-orange-700',
		incomparable: 'text-surface-400 italic'
	};

	/** `null` = incomparable, et ne se rend JAMAIS « d'accord ». */
	function canonicalLabel(mismatch: boolean | null): { label: string; cls: string } {
		if (mismatch === null) return { label: 'incomparable', cls: CANONICAL_BADGE.incomparable };
		return mismatch
			? { label: 'canonical ≠ Google', cls: CANONICAL_BADGE.mismatch }
			: { label: 'canonical ok', cls: CANONICAL_BADGE.agree };
	}

	const SEVERITY_BADGE: Record<string, string> = {
		critical: 'bg-red-50 text-red-700 border-red-200',
		high: 'bg-orange-50 text-orange-700 border-orange-200',
		medium: 'bg-amber-50 text-amber-700 border-amber-200',
		low: 'bg-surface-100 text-surface-500 border-surface-200'
	};

	const pm = $derived(panelMeta(ix.panel.state));
	const base = $derived(`/projects/${ix.project.slug}/indexing`);
	/** Le lien d'une URL préserve le filtre de classe : revenir ne doit pas perdre le contexte. */
	const urlHref = (u: string) =>
		`${base}?${ix.activeClass ? `class=${ix.activeClass}&` : ''}url=${encodeURIComponent(u)}`;
	const closeFocusHref = $derived(ix.activeClass ? `${base}?class=${ix.activeClass}` : base);
</script>

<div class="space-y-6">
	<!-- ── Le panneau, identique à celui de la vue d'ensemble ────── -->
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<h1 class="text-lg font-semibold text-surface-900">Indexation</h1>
			<p class="mt-0.5 text-sm text-surface-600">{ix.panel.note}</p>
			<!-- La fraîcheur se dit en toutes lettres : « jamais inspecté » n'est pas « 0 h ». -->
			<p class="mt-0.5 text-xs text-surface-500">{ix.freshnessNote}</p>
		</div>
		<span
			class="inline-flex flex-shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium {pm.badge}"
		>
			{pm.label}
		</span>
	</header>

	<!-- Le trio de provenance, au même endroit que sur la vue d'ensemble. -->
	<dl class="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-surface-200 bg-white px-3 py-2 text-[11px] text-surface-400">
		<div class="flex gap-1">
			<dt class="font-medium">Période</dt>
			<dd>{ix.panel.provenance.period?.label ?? 'aucune donnée'}</dd>
		</div>
		<div class="flex gap-1">
			<dt class="font-medium">Fraîcheur</dt>
			<dd>{ix.panel.provenance.freshness.lastSuccessAt ?? 'jamais collecté'}</dd>
		</div>
		<div class="flex gap-1">
			<dt class="font-medium">Source</dt>
			<dd class="font-mono">{ix.panel.provenance.source}</dd>
		</div>
	</dl>

	<!-- ── Couverture ────────────────────────────────────────────── -->
	<section class="grid gap-3 sm:grid-cols-3">
		<div class="rounded-xl border border-surface-200 bg-white p-4">
			<div class="text-2xl font-semibold text-surface-900">{pct(ix.indexation.coverageRate)}</div>
			<div class="text-[11px] text-surface-500">indexées parmi les verdicts tranchés</div>
			<p class="mt-1 text-[11px] text-surface-400">
				Les pages exclues par le site sont hors dénominateur : un noindex est une décision, pas un
				échec d'indexation.
			</p>
		</div>
		<div class="rounded-xl border border-surface-200 bg-white p-4">
			<div class="text-2xl font-semibold text-surface-900">{fmtInt(ix.indexation.urlsObserved)}</div>
			<div class="text-[11px] text-surface-500">URLs observées</div>
		</div>
		<div class="rounded-xl border border-surface-200 bg-white p-4">
			<div class="text-2xl font-semibold text-surface-900">{fmtInt(ix.quota.dueNow)}</div>
			<div class="text-[11px] text-surface-500">inspections dues et non honorées</div>
			{#if ix.quota.oldestDueDate}
				<p class="mt-1 text-[11px] text-surface-400">la plus ancienne au {ix.quota.oldestDueDate}</p>
			{/if}
		</div>
	</section>

	<!-- ── Filtres de classe : le compteur ET son lien ────────────── -->
	<section>
		<h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">
			Répartition — chaque compteur ouvre sa propre liste
		</h2>
		<div class="flex flex-wrap gap-2">
			{#each ix.classFilters as f (f.label)}
				<a
					href={f.href}
					title={f.note ?? undefined}
					class="inline-flex items-baseline gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors {f.active
						? 'border-primary-600 bg-primary-50 text-primary-800'
						: 'border-surface-200 bg-white text-surface-600 hover:border-surface-300'}"
				>
					<span class="font-semibold text-surface-900">{fmtInt(f.count)}</span>
					{f.label}
				</a>
			{/each}
		</div>
	</section>

	<!-- ── Inventaire sitemap ────────────────────────────────────── -->
	<section>
		<h2 class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-surface-400">
			<Map size={12} /> Ce que le site déclare
		</h2>
		<div class="rounded-xl border border-surface-200 bg-white p-4">
			{#if !ix.sitemap.date}
				<p class="text-sm text-surface-500">{ix.sitemap.note}</p>
			{:else}
				<div class="flex flex-wrap items-baseline gap-x-6 gap-y-1">
					<div>
						<span class="text-lg font-semibold text-surface-900">{fmtInt(ix.sitemap.urls)}</span>
						<span class="text-xs text-surface-500">URLs déclarées au {ix.sitemap.date}</span>
					</div>
					{#if ix.sitemap.alternates > 0}
						<!-- Une alternate n'est pas une page nouvelle (IDX-001) : comptée à part, sinon un
						     site multilingue annoncerait autant de pages neuves que de langues. -->
						<div class="text-xs text-surface-500">
							{fmtInt(ix.sitemap.alternates)} alternate(s) hors décompte
						</div>
					{/if}
					<div class="text-xs text-surface-500">{fmtInt(ix.sitemap.files)} fichier(s) parcouru(s)</div>
				</div>

				{#if ix.sitemap.filesWithErrors > 0}
					<!-- Un sitemap injoignable ou malformé est un FAIT interrogeable, pas un `catch {}`. -->
					<p class="mt-2 inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
						<FileWarning size={12} />
						{fmtInt(ix.sitemap.filesWithErrors)} fichier(s) en erreur — l'inventaire est partiel.
					</p>
				{/if}

				<p class="mt-2 text-xs text-surface-600">{ix.sitemap.note}</p>

				{#if ix.sitemap.diff}
					<div class="mt-3 grid gap-2 sm:grid-cols-3">
						<div class="rounded-lg border border-surface-100 px-3 py-2">
							<div class="text-sm font-semibold text-emerald-700">
								+{fmtInt(ix.sitemap.diff.added.length)}
							</div>
							<div class="text-[11px] text-surface-500">ajoutées</div>
						</div>
						<div class="rounded-lg border border-surface-100 px-3 py-2">
							<div class="text-sm font-semibold text-orange-700">
								−{fmtInt(ix.sitemap.diff.removed.length)}
							</div>
							<div class="text-[11px] text-surface-500">retirées du sitemap</div>
							<!-- Le constat s'arrête là : IDX-001 pose qu'aucune URL retirée n'est désindexée. -->
							<p class="mt-0.5 text-[10px] text-surface-400">constat seul — aucune désindexation</p>
						</div>
						<div class="rounded-lg border border-surface-100 px-3 py-2">
							<div class="text-sm font-semibold text-surface-900">
								{fmtInt(ix.sitemap.diff.changed.length)}
							</div>
							<div class="text-[11px] text-surface-500">lastmod ou canonical modifié</div>
						</div>
					</div>
				{/if}
			{/if}
		</div>
	</section>

	<!-- ── Quota d'inspection ────────────────────────────────────── -->
	<section>
		<h2 class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-surface-400">
			<Gauge size={12} /> Où part le quota
		</h2>
		<div class="rounded-xl border border-surface-200 bg-white p-4">
			<!-- ⚠️ « Au plus », jamais « il reste » : le pool consommé est une borne INFÉRIEURE. -->
			<p class="text-sm text-surface-700">{ix.quota.poolNote}</p>
			<p class="mt-0.5 text-[11px] text-surface-400">
				{fmtInt(ix.quota.poolUsedToday)} observation(s) écrite(s) aujourd'hui, tous projets
				confondus · budget de ce projet : {fmtInt(ix.quota.dailyBudgetPerProject)} / jour
			</p>

			{#if ix.quota.byFamily.length > 0}
				<ul class="mt-3 space-y-1">
					{#each ix.quota.byFamily as f (f.key)}
						<li class="flex items-baseline gap-2 text-xs text-surface-600">
							<span class="w-8 flex-shrink-0 text-right font-semibold text-surface-900">
								{fmtInt(f.count)}
							</span>
							{f.label}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="mt-3 text-xs text-surface-400">Aucune intention d'inspection en attente.</p>
			{/if}

			{#if ix.quota.expired > 0}
				<p class="mt-2 text-xs text-amber-700">
					{fmtInt(ix.quota.expired)} échéance(s) dépassée(s) depuis plus que la durée d'abandon —
					elles ne seront pas honorées. Un abandon tu se lirait comme une inspection réussie.
				</p>
			{/if}
			{#if ix.quota.unreadable > 0}
				<p class="mt-1 text-xs text-amber-700">
					{fmtInt(ix.quota.unreadable)} ligne(s) écartée(s) : leur raison de sélection n'appartient
					pas au vocabulaire connu. Elles ne sont pas réinterprétées.
				</p>
			{/if}
		</div>
	</section>

	<!-- ── Findings d'indexation ─────────────────────────────────── -->
	<section>
		<h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">
			Ce qui a bougé — {fmtInt(ix.transitions.length)} finding(s) d'indexation ouvert(s)
		</h2>
		{#if ix.transitions.length === 0}
			<p class="rounded-xl border border-dashed border-surface-200 px-4 py-4 text-center text-sm text-surface-500">
				Aucune transition d'indexation ouverte sur ce projet.
			</p>
		{:else}
			<ol class="space-y-1">
				{#each ix.transitions as f (f.id)}
					<li class="flex items-start gap-3 rounded-lg border border-surface-100 bg-white px-3 py-2">
						<span
							class="mt-0.5 flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium {SEVERITY_BADGE[
								f.severity
							] ?? SEVERITY_BADGE.low}"
						>
							{f.severity}
						</span>
						<div class="min-w-0 flex-1">
							<a href="/inbox/findings/{f.id}" class="block truncate text-sm text-surface-900 hover:underline">
								{f.title}
							</a>
							<p class="text-[11px] text-surface-500">
								{f.type} · confiance {f.confidenceScore} · vu {f.occurrenceCount} fois
							</p>
						</div>
					</li>
				{/each}
			</ol>
		{/if}
	</section>

	<!-- ── Historique d'une URL ──────────────────────────────────── -->
	{#if ix.focusUrl}
		<section class="rounded-xl border border-primary-200 bg-primary-50/40 p-4">
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0">
					<h2 class="text-xs font-semibold uppercase tracking-wider text-surface-500">
						Historique d'inspection
					</h2>
					<p class="mt-0.5 truncate font-mono text-xs text-surface-700">{ix.focusUrl}</p>
				</div>
				<a href={closeFocusHref} class="flex-shrink-0 text-surface-400 hover:text-surface-700" title="Fermer">
					<X size={14} />
				</a>
			</div>
			<ol class="mt-3 space-y-1">
				{#each ix.focusHistory as h (h.observedDate)}
					{@const hc = canonicalLabel(h.canonicalMismatch)}
					<li class="flex flex-wrap items-baseline gap-x-3 border-t border-surface-200/60 pt-1 text-xs">
						<span class="w-24 flex-shrink-0 font-mono text-surface-500">{h.observedDate}</span>
						<span class="rounded border px-1 text-[10px] {CLASS_BADGE[h.indexedClass]}">
							{h.indexedClass}
						</span>
						<span class="text-surface-500">{h.coverageState ?? 'coverage inconnu'}</span>
						<span class={hc.cls}>{hc.label}</span>
					</li>
				{/each}
			</ol>
		</section>
	{/if}

	<!-- ── Liste des URLs ────────────────────────────────────────── -->
	<section>
		<div class="mb-2 flex items-baseline justify-between">
			<h2 class="text-xs font-semibold uppercase tracking-wider text-surface-400">
				URLs — dernier état connu
			</h2>
			{#if ix.urlsTruncated}
				<!-- La troncature se DIT, avec le total réel : une liste pleine se lit comme complète. -->
				<span class="text-[11px] text-surface-400">
					{fmtInt(ix.urls.length)} affichées sur {fmtInt(ix.urlsTotal)}
				</span>
			{/if}
		</div>

		{#if ix.urls.length === 0}
			<div class="rounded-xl border border-dashed border-surface-200 px-4 py-6 text-center">
				<Search size={18} class="mx-auto text-surface-300" />
				<p class="mt-1 text-sm text-surface-500">
					{#if ix.activeClass}
						Aucune URL dans cette classe.
					{:else}
						Aucune URL inspectée sur ce projet — la sélection décide quelles pages méritent le
						quota.
					{/if}
				</p>
			</div>
		{:else}
			<div class="overflow-x-auto rounded-xl border border-surface-200 bg-white">
				<table class="w-full text-left text-xs">
					<thead class="border-b border-surface-100 text-[11px] text-surface-400">
						<tr>
							<th class="px-3 py-2 font-medium">URL</th>
							<th class="px-3 py-2 font-medium">État</th>
							<th class="px-3 py-2 font-medium">Coverage</th>
							<th class="px-3 py-2 font-medium">Canonical</th>
							<th class="px-3 py-2 font-medium">Observé</th>
						</tr>
					</thead>
					<tbody>
						{#each ix.urls as u (u.url)}
							{@const c = canonicalLabel(u.canonicalMismatch)}
							<tr class="border-b border-surface-50 last:border-0 hover:bg-surface-50/60">
								<td class="max-w-md px-3 py-1.5">
									<a href={urlHref(u.url)} class="block truncate font-mono text-surface-700 hover:underline">
										{u.url}
									</a>
								</td>
								<td class="px-3 py-1.5">
									<span class="rounded border px-1 text-[10px] {CLASS_BADGE[u.indexedClass]}">
										{u.indexedClass}
									</span>
								</td>
								<td class="px-3 py-1.5 text-surface-500">{u.coverageState ?? '—'}</td>
								<td class="px-3 py-1.5 {c.cls}">{c.label}</td>
								<td class="px-3 py-1.5 font-mono text-surface-400">{u.observedDate}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		<a
			href="/projects/{ix.project.slug}"
			class="mt-3 inline-flex items-center gap-1 text-xs text-primary-600 hover:underline"
		>
			Retour à la vue d'ensemble <ArrowRight size={11} />
		</a>
	</section>
</div>
