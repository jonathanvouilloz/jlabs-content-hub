<script lang="ts">
	import {
		AlertOctagon,
		AlertTriangle,
		ArrowRight,
		CheckCircle2,
		Clock,
		FileText,
		HelpCircle,
		Eye,
		Gauge,
		PlugZap,
		Activity
	} from 'lucide-svelte';
	import { formatDate } from '$lib/utils/dates.js';
	import { statusConfig, contentTypeConfig } from '$lib/config/design-tokens.js';

	let { data } = $props();

	const cockpit = $derived(data.cockpit);

	const nf = new Intl.NumberFormat('fr-FR');
	const fmtInt = (n: number) => nf.format(n);

	// Un seul vocabulaire visuel pour les 5 états — défini une fois, sinon « broken » et
	// « at_risk » finissent par se ressembler sur un écran et pas sur un autre.
	const STATE_META: Record<
		string,
		{ label: string; badge: string; dot: string; icon: typeof AlertOctagon }
	> = {
		broken: {
			label: 'Collecte cassée',
			badge: 'bg-red-50 text-red-700 border-red-200',
			dot: 'bg-red-500',
			icon: AlertOctagon
		},
		at_risk: {
			label: 'À traiter',
			badge: 'bg-orange-50 text-orange-700 border-orange-200',
			dot: 'bg-orange-500',
			icon: AlertTriangle
		},
		unknown: {
			label: 'État inconnu',
			badge: 'bg-violet-50 text-violet-700 border-violet-200',
			dot: 'bg-violet-500',
			icon: HelpCircle
		},
		watch: {
			label: 'À surveiller',
			badge: 'bg-amber-50 text-amber-700 border-amber-200',
			dot: 'bg-amber-500',
			icon: Eye
		},
		ok: {
			label: 'Sain',
			badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
			dot: 'bg-emerald-500',
			icon: CheckCircle2
		}
	};
	const meta = (state: string) => STATE_META[state] ?? STATE_META.unknown;

	// `as const` et non `string[]` : les littéraux indexent `byState` sans cast, et l'ordre
	// d'affichage reste celui de l'urgence (le même que `stateRank`, côté module pur).
	const STATE_ORDER = ['broken', 'at_risk', 'unknown', 'watch', 'ok'] as const;

	const RUN_STATUS_CLASS: Record<string, string> = {
		success: 'text-emerald-600',
		partial: 'text-amber-600',
		failed: 'text-red-600',
		running: 'text-sky-600',
		queued: 'text-surface-400',
		cancelled: 'text-surface-400'
	};

	/**
	 * La fraîcheur, dite en mots. `never` n'est JAMAIS rendu comme « il y a 0 h » : c'est
	 * l'acceptation « l'état des données n'est jamais confondu avec une valeur zéro », et
	 * elle se perdrait ici si le template formatait `ageHours ?? 0`.
	 */
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
</script>

<div class="space-y-6">
	<!-- ── Santé globale ─────────────────────────────────────────── -->
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-xl font-semibold text-surface-900">Bonjour, {data.user.name}</h1>
			<p class="mt-0.5 text-sm text-surface-500">
				{#if cockpit.portfolio.needingAction === 0}
					{cockpit.portfolio.total} projet{cockpit.portfolio.total > 1 ? 's' : ''} — rien à traiter.
				{:else}
					<span class="font-medium text-surface-700">
						{cockpit.portfolio.needingAction} projet{cockpit.portfolio.needingAction > 1 ? 's' : ''}
						demande{cockpit.portfolio.needingAction > 1 ? 'nt' : ''} une action
					</span>
					sur {cockpit.portfolio.total}.
				{/if}
			</p>
		</div>
		<div class="text-right text-xs text-surface-500">
			<div class="flex items-center justify-end gap-2">
				{#each STATE_ORDER as s (s)}
					{#if cockpit.portfolio.byState[s] > 0}
						<span class="inline-flex items-center gap-1">
							<span class="h-2 w-2 rounded-full {meta(s).dot}"></span>
							{cockpit.portfolio.byState[s]}
						</span>
					{/if}
				{/each}
			</div>
			<div class="mt-1">
				Période : {cockpit.windowDays} jours glissants (depuis {fmtDb(cockpit.sinceDb)})
			</div>
		</div>
	</header>

	<!-- ── Compteurs cross-projet ────────────────────────────────── -->
	<!-- Chaque compteur porte le lien de SON filtre (ou aucun lien s'il n'existe pas de
	     liste qui reproduise ce qu'il compte). Le template ne construit aucune URL. -->
	<div class="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
		{#each cockpit.counters as c (c.label)}
			{#if c.href}
				<a
					href={c.href}
					class="group rounded-lg border border-surface-200 bg-white px-3 py-2 transition-colors hover:border-surface-300 hover:bg-surface-50"
				>
					<div class="text-lg font-semibold text-surface-900">{fmtInt(c.count)}</div>
					<div class="flex items-center gap-1 text-[11px] text-surface-500">
						{c.label}
						<ArrowRight
							size={11}
							class="text-surface-300 transition-colors group-hover:text-surface-500"
						/>
					</div>
				</a>
			{:else}
				<div
					class="rounded-lg border border-dashed border-surface-200 px-3 py-2"
					title="Aucune liste ne reproduit exactement ce compteur — il reste un chiffre plutôt qu'un lien qui mènerait ailleurs."
				>
					<div class="text-lg font-semibold text-surface-900">{fmtInt(c.count)}</div>
					<div class="text-[11px] text-surface-400">{c.label}</div>
				</div>
			{/if}
		{/each}
	</div>

	<!-- ── Projets à traiter ─────────────────────────────────────── -->
	<section>
		<h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">
			À traiter — par urgence
		</h2>

		{#if cockpit.needingAction.length === 0}
			<div class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-6 text-center">
				<CheckCircle2 size={18} class="mx-auto text-emerald-600" />
				<p class="mt-1 text-sm text-emerald-800">
					Aucun projet ne demande d'action sur les {cockpit.windowDays} derniers jours.
				</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each cockpit.needingAction as p (p.projectId)}
					{@const m = meta(p.state)}
					<article class="rounded-xl border border-surface-200 bg-white p-4 shadow-sm">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div class="min-w-0">
								<div class="flex items-center gap-2">
									<span
										class="h-2.5 w-2.5 flex-shrink-0 rounded-full"
										style="background-color: {p.color ?? '#888'};"
									></span>
									<a
										href="/projects/{p.slug}"
										class="truncate text-sm font-semibold text-surface-900 hover:underline"
									>
										{p.name}
									</a>
									<span
										class="inline-flex flex-shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium {m.badge}"
									>
										<m.icon size={11} />
										{m.label}
									</span>
								</div>
								<p class="mt-1 text-sm text-surface-600">{p.headline}</p>
							</div>
							<div class="flex-shrink-0 text-right text-[11px] text-surface-400">
								<div class="inline-flex items-center gap-1">
									<Clock size={11} />
									GSC {freshnessLabel(p.freshness)}
								</div>
							</div>
						</div>

						<!-- Les DEUX axes, côte à côte et jamais fondus : « la donnée arrive-t-elle ? »
						     et « que dit-elle ? » demandent deux gestes différents. -->
						<div class="mt-3 grid gap-2 sm:grid-cols-2">
							<div class="rounded-lg bg-surface-50 px-3 py-2">
								<div class="flex items-center gap-1.5 text-[11px] font-medium text-surface-500">
									<PlugZap size={12} /> Collecte
									<span class="text-surface-400">· {p.pipeline.state}</span>
								</div>
								{#if p.pipeline.reasons.length === 0}
									<p class="mt-0.5 text-xs text-surface-400">la donnée arrive</p>
								{:else}
									<ul class="mt-0.5 space-y-0.5">
										{#each p.pipeline.reasons as r}
											<li class="text-xs text-surface-600">{r}</li>
										{/each}
									</ul>
								{/if}
							</div>
							<div class="rounded-lg bg-surface-50 px-3 py-2">
								<div class="flex items-center gap-1.5 text-[11px] font-medium text-surface-500">
									<Activity size={12} /> Performance
									<span class="text-surface-400">· {p.signal.state}</span>
								</div>
								{#if p.signal.reasons.length === 0}
									<p class="mt-0.5 text-xs text-surface-400">rien à signaler</p>
								{:else}
									<ul class="mt-0.5 space-y-0.5">
										{#each p.signal.reasons as r}
											<li class="text-xs text-surface-600">{r}</li>
										{/each}
									</ul>
								{/if}
							</div>
						</div>

						<!-- Compteurs du projet : mêmes filtres, portée projet -->
						<div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-surface-100 pt-2">
							{#each p.counters as c (c.label)}
								{#if c.href}
									<a
										href={c.href}
										class="group inline-flex items-baseline gap-1 text-xs text-surface-500 hover:text-surface-800"
									>
										<span class="font-semibold text-surface-900">{fmtInt(c.count)}</span>
										{c.label}
										<ArrowRight
											size={10}
											class="self-center text-surface-300 transition-colors group-hover:text-surface-500"
										/>
									</a>
								{:else}
									<span class="inline-flex items-baseline gap-1 text-xs text-surface-400">
										<span class="font-semibold text-surface-700">{fmtInt(c.count)}</span>
										{c.label}
									</span>
								{/if}
							{/each}
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>

	<!-- ── Projets sains, condensés ──────────────────────────────── -->
	{#if cockpit.portfolio.byState.ok > 0}
		<section>
			<h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">
				Rien à traiter
			</h2>
			<div class="flex flex-wrap gap-2">
				{#each cockpit.projects.filter((p) => p.state === 'ok') as p (p.projectId)}
					<a
						href="/projects/{p.slug}"
						class="inline-flex items-center gap-2 rounded-lg border border-surface-200 bg-white px-3 py-1.5 text-xs text-surface-600 transition-colors hover:bg-surface-50"
					>
						<span class="h-2 w-2 rounded-full" style="background-color: {p.color ?? '#888'};"></span>
						{p.name}
						<span class="text-surface-400">{p.openTotal} ouvert{p.openTotal > 1 ? 's' : ''}</span>
					</a>
				{/each}
			</div>
		</section>
	{/if}

	<!-- ── Exploitation : runs, quotas, coûts ────────────────────── -->
	<div class="grid gap-4 lg:grid-cols-2">
		<section>
			<h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">
				Derniers runs
			</h2>
			{#if cockpit.recentRuns.length === 0}
				<div class="rounded-xl border border-dashed border-surface-200 py-8 text-center text-sm text-surface-400">
					Aucun run enregistré
				</div>
			{:else}
				<div class="divide-y divide-surface-100 rounded-xl border border-surface-200 bg-white">
					{#each cockpit.recentRuns as r (r.id)}
						<div class="flex items-center gap-3 px-3 py-2 text-xs">
							<span class="font-medium {RUN_STATUS_CLASS[r.status] ?? 'text-surface-500'}">
								{r.status}
							</span>
							<span class="text-surface-400">{r.runType}</span>
							<span class="min-w-0 flex-1 truncate text-surface-600">{r.projectName ?? '—'}</span>
							<span class="flex-shrink-0 text-surface-300">{fmtDb(r.createdAt)}</span>
						</div>
					{/each}
				</div>
			{/if}
			{#if Object.keys(cockpit.runStatusCounts).length > 0}
				<p class="mt-1 text-[11px] text-surface-400">
					Sur la période :
					{#each Object.entries(cockpit.runStatusCounts) as [status, n], i}
						{i > 0 ? ' · ' : ''}{n} {status}
					{/each}
				</p>
			{/if}
		</section>

		<section class="space-y-4">
			<div>
				<h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">
					Quotas &amp; capacité
				</h2>
				<div class="rounded-xl border border-surface-200 bg-white p-3">
					<div class="flex items-center gap-2 text-xs text-surface-600">
						<Gauge size={13} class="text-surface-400" />
						<span class="font-medium">
							{cockpit.capacity.global.running}/{cockpit.capacity.global.limit === 0
								? '∞'
								: cockpit.capacity.global.limit}
						</span>
						job(s) en vol
						<span class="text-surface-400">· {cockpit.capacity.global.state}</span>
						{#if !cockpit.capacity.configured}
							<span class="text-surface-300">(limites par défaut)</span>
						{/if}
					</div>
					<div class="mt-2 space-y-1">
						{#each cockpit.capacity.providers.filter((p) => p.state !== 'ok' || p.attemptsInWindow > 0) as pr (pr.provider)}
							<div class="flex items-center justify-between text-[11px]">
								<span class="text-surface-500">{pr.provider}</span>
								<span
									class={pr.state === 'quota_limited'
										? 'font-medium text-red-600'
										: pr.state === 'saturated'
											? 'font-medium text-amber-600'
											: 'text-surface-500'}
								>
									{pr.attemptsInWindow}/{pr.windowBudget === 0 ? '∞' : pr.windowBudget}
									{#if pr.state !== 'ok'}· {pr.state}{/if}
								</span>
							</div>
						{/each}
						{#if cockpit.capacity.providers.every((p) => p.state === 'ok' && p.attemptsInWindow === 0)}
							<p class="text-[11px] text-surface-400">Aucune tentative provider sur la fenêtre.</p>
						{/if}
					</div>
					<a href="/jobs" class="mt-2 inline-flex items-center gap-1 text-[11px] text-surface-500 hover:text-surface-800">
						Console de la file <ArrowRight size={10} />
					</a>
				</div>
			</div>

			<div>
				<h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">
					Coûts de la période
				</h2>
				<!-- « Non instrumenté » et non « 0 » : afficher un zéro confondrait « gratuit »
				     et « pas mesuré ». Le panneau se remplira SEUL le jour où un run portera
				     un coût. -->
				{#if cockpit.costs.instrumented}
					<div class="rounded-xl border border-surface-200 bg-white p-3 text-xs text-surface-600">
						{cockpit.costs.runs} run(s) avec coût —
						{#each Object.entries(cockpit.costs.totals) as [key, value], i}
							{i > 0 ? ' · ' : ''}<span class="font-medium text-surface-900">{fmtInt(value)}</span>
							{key}
						{/each}
					</div>
				{:else}
					<div class="rounded-xl border border-dashed border-surface-200 p-3">
						<p class="text-xs font-medium text-surface-500">Non instrumenté</p>
						<p class="mt-0.5 text-[11px] text-surface-400">{cockpit.costs.detail}</p>
					</div>
				{/if}
			</div>
		</section>
	</div>

	<!-- ── Contenu (ancien accueil, en second : il ne décide de rien) ── -->
	<section class="border-t border-surface-200 pt-4">
		<h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">Contenu</h2>
		<div class="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-surface-200 bg-white px-4 py-2.5">
			<div class="flex items-center gap-2">
				<span class="text-xs text-surface-500">Total</span>
				<span class="text-sm font-semibold text-surface-900">{data.contentStats.total}</span>
			</div>
			<div class="flex items-center gap-2">
				<span class="h-2 w-2 rounded-full bg-surface-400"></span>
				<span class="text-xs text-surface-500">{data.contentStats.draft} drafts</span>
			</div>
			<div class="flex items-center gap-2">
				<span class="h-2 w-2 rounded-full bg-amber-500"></span>
				<span class="text-xs text-surface-500">{data.contentStats.review} en review</span>
			</div>
			<div class="flex items-center gap-2">
				<span class="h-2 w-2 rounded-full bg-emerald-500"></span>
				<span class="text-xs text-surface-500">{data.contentStats.published} publiés</span>
			</div>
		</div>

		{#if data.recentContents.length > 0}
			<div class="mt-2 divide-y divide-surface-100 rounded-lg border border-surface-200 bg-white">
				{#each data.recentContents as item (item.id)}
					{@const typeConf = contentTypeConfig(item.type)}
					{@const stConf = statusConfig(item.status)}
					<a
						href="/projects/{item.projectSlug}/content/{item.id}"
						class="group flex items-center gap-4 px-4 py-2 transition-colors hover:bg-surface-50"
					>
						<FileText size={13} class="flex-shrink-0 text-surface-300" />
						<span class="min-w-0 flex-1 truncate text-xs text-surface-700">{item.title}</span>
						<span class="flex-shrink-0 text-[10px] text-surface-400">{typeConf.label}</span>
						<span
							class="flex-shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium {stConf.bg} {stConf.text}"
						>
							{stConf.label}
						</span>
						<span class="flex-shrink-0 whitespace-nowrap text-[10px] text-surface-300">
							{formatDate(item.createdAt)}
						</span>
					</a>
				{/each}
			</div>
		{/if}
	</section>
</div>
