<script lang="ts">
	import { page } from '$app/stores';
	import { Eye, MousePointerClick, Phone, Navigation, Star, Globe, Clock, ChevronRight, TrendingUp, TrendingDown, Minus } from 'lucide-svelte';
	import Sparkline from '$lib/components/ui/Sparkline.svelte';

	let { data } = $props();

	type LayoutData = {
		profile: {
			phone?: string | null;
			websiteUri?: string | null;
			regularHours?: string | null;
			profileDescription?: string | null;
		} | null;
		reviewsStats: { total: number; replied: number; unreplied: number };
	};

	let layout = $derived($page.data as LayoutData);

	function fmt(n: number): string {
		if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
		return n.toString();
	}

	function diffPct(current: number, previous: number): { value: number; label: string } | null {
		if (previous === 0) {
			if (current === 0) return null;
			return { value: 100, label: '+100%' };
		}
		const pct = ((current - previous) / previous) * 100;
		const sign = pct > 0 ? '+' : '';
		return { value: pct, label: `${sign}${pct.toFixed(0)}%` };
	}

	const cards = $derived([
		{
			label: 'Vues',
			value: data.totals.impressions.current,
			previous: data.totals.impressions.previous,
			Icon: Eye,
			color: 'text-indigo-600',
			fill: 'bg-indigo-50',
			points: data.sparklines.impressions.map((p) => p.value)
		},
		{
			label: 'Clics site',
			value: data.totals.websiteClicks.current,
			previous: data.totals.websiteClicks.previous,
			Icon: MousePointerClick,
			color: 'text-emerald-600',
			fill: 'bg-emerald-50',
			points: data.sparklines.websiteClicks.map((p) => p.value)
		},
		{
			label: 'Itinéraires',
			value: data.totals.directionRequests.current,
			previous: data.totals.directionRequests.previous,
			Icon: Navigation,
			color: 'text-amber-600',
			fill: 'bg-amber-50',
			points: data.sparklines.directionRequests.map((p) => p.value)
		},
		{
			label: 'Appels',
			value: data.totals.callClicks.current,
			previous: data.totals.callClicks.previous,
			Icon: Phone,
			color: 'text-rose-600',
			fill: 'bg-rose-50',
			points: data.sparklines.callClicks.map((p) => p.value)
		}
	]);

	const DAY_LABELS: Record<string, string> = {
		MONDAY: 'Lundi',
		TUESDAY: 'Mardi',
		WEDNESDAY: 'Mercredi',
		THURSDAY: 'Jeudi',
		FRIDAY: 'Vendredi',
		SATURDAY: 'Samedi',
		SUNDAY: 'Dimanche'
	};
	const DAY_ORDER = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

	type Period = { openDay: string; closeDay?: string; openTime?: { hours?: number; minutes?: number }; closeTime?: { hours?: number; minutes?: number } };

	function fmtTime(t?: { hours?: number; minutes?: number }): string {
		if (!t) return '00:00';
		return `${String(t.hours ?? 0).padStart(2, '0')}:${String(t.minutes ?? 0).padStart(2, '0')}`;
	}

	const hoursByDay = $derived.by(() => {
		const raw = layout?.profile?.regularHours;
		if (!raw) return null;
		try {
			const parsed: { periods?: Period[] } = JSON.parse(raw);
			const map: Record<string, string[]> = Object.fromEntries(DAY_ORDER.map((d) => [d, []]));
			for (const p of parsed.periods ?? []) {
				const day = p.openDay;
				if (!day || !map[day]) continue;
				map[day].push(`${fmtTime(p.openTime)} – ${fmtTime(p.closeTime)}`);
			}
			return map;
		} catch {
			return null;
		}
	});

	function todayKey(): string {
		const d = new Date().getDay();
		// Sunday = 0 → DAY_ORDER[6]
		return DAY_ORDER[(d + 6) % 7];
	}

	const todayHours = $derived(hoursByDay?.[todayKey()] ?? null);
</script>

<!-- KPI cards -->
<div class="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
	{#each cards as card}
		{@const d = diffPct(card.value, card.previous)}
		<div class="rounded-lg border border-surface-200 bg-white p-4">
			<div class="mb-2 flex items-center justify-between">
				<div class="flex items-center gap-2">
					<div class="flex h-7 w-7 items-center justify-center rounded-md {card.fill}">
						<card.Icon size={14} class={card.color} />
					</div>
					<span class="text-xs font-medium uppercase tracking-wide text-surface-500">{card.label}</span>
				</div>
				{#if d}
					<span class="inline-flex items-center gap-0.5 text-[11px] font-medium {d.value > 0 ? 'text-emerald-600' : d.value < 0 ? 'text-rose-600' : 'text-surface-400'}">
						{#if d.value > 0}
							<TrendingUp size={10} />
						{:else if d.value < 0}
							<TrendingDown size={10} />
						{:else}
							<Minus size={10} />
						{/if}
						{d.label}
					</span>
				{/if}
			</div>
			<div class="mb-2 text-2xl font-semibold text-surface-900">{fmt(card.value)}</div>
			<div class={card.color}>
				<Sparkline points={card.points} />
			</div>
		</div>
	{/each}
</div>

{#if !data.hasInsights}
	<div class="mb-6 rounded-lg border border-dashed border-surface-200 bg-surface-50 p-4 text-sm text-surface-500">
		Aucune donnée de performance synchronisée pour le moment. Cliquez sur "Resynchroniser" en haut pour récupérer les 90 derniers jours depuis Google.
	</div>
{/if}

<div class="grid gap-4 lg:grid-cols-3">
	<!-- Reviews block -->
	<div class="rounded-lg border border-surface-200 bg-white p-5">
		<div class="mb-3 flex items-center justify-between">
			<h2 class="flex items-center gap-2 text-sm font-semibold text-surface-900">
				<Star size={14} class="text-amber-400" fill="currentColor" />
				Avis Google
			</h2>
			<a
				href={`/projects/${$page.params.slug}/reviews?location=${$page.params.locationId}`}
				class="inline-flex items-center gap-0.5 text-xs font-medium text-primary-600 hover:text-primary-700"
			>
				Voir <ChevronRight size={11} />
			</a>
		</div>
		<div class="grid grid-cols-3 gap-3">
			<div>
				<div class="text-2xl font-semibold text-surface-900">{layout.reviewsStats.total}</div>
				<div class="text-[11px] font-medium uppercase text-surface-400">Total</div>
			</div>
			<div>
				<div class="text-2xl font-semibold text-emerald-600">{layout.reviewsStats.replied}</div>
				<div class="text-[11px] font-medium uppercase text-surface-400">Répondus</div>
			</div>
			<div>
				<div class="text-2xl font-semibold {layout.reviewsStats.unreplied > 0 ? 'text-rose-600' : 'text-surface-400'}">
					{layout.reviewsStats.unreplied}
				</div>
				<div class="text-[11px] font-medium uppercase text-surface-400">Sans réponse</div>
			</div>
		</div>
	</div>

	<!-- Info block -->
	<div class="rounded-lg border border-surface-200 bg-white p-5">
		<h2 class="mb-3 text-sm font-semibold text-surface-900">Coordonnées</h2>
		<dl class="space-y-2.5 text-sm">
			<div class="flex items-start gap-2">
				<Phone size={13} class="mt-0.5 flex-shrink-0 text-surface-400" />
				<div class="min-w-0 flex-1">
					{#if layout.profile?.phone}
						<a href={`tel:${layout.profile.phone}`} class="text-surface-700 hover:text-primary-600">
							{layout.profile.phone}
						</a>
					{:else}
						<span class="text-surface-400 italic">Pas de téléphone</span>
					{/if}
				</div>
			</div>
			<div class="flex items-start gap-2">
				<Globe size={13} class="mt-0.5 flex-shrink-0 text-surface-400" />
				<div class="min-w-0 flex-1">
					{#if layout.profile?.websiteUri}
						<a
							href={layout.profile.websiteUri}
							target="_blank"
							rel="noopener"
							class="block truncate text-surface-700 hover:text-primary-600"
						>
							{layout.profile.websiteUri.replace(/^https?:\/\//, '').replace(/\/$/, '')}
						</a>
					{:else}
						<span class="text-surface-400 italic">Pas de site</span>
					{/if}
				</div>
			</div>
		</dl>
		<a
			href={`/projects/${$page.params.slug}/gmb-profile/${$page.params.locationId}/infos`}
			class="mt-4 inline-flex items-center gap-0.5 text-xs font-medium text-primary-600 hover:text-primary-700"
		>
			Éditer <ChevronRight size={11} />
		</a>
	</div>

	<!-- Hours block -->
	<div class="rounded-lg border border-surface-200 bg-white p-5">
		<h2 class="mb-3 flex items-center gap-2 text-sm font-semibold text-surface-900">
			<Clock size={14} class="text-surface-500" />
			Horaires
		</h2>
		{#if hoursByDay}
			<dl class="space-y-1 text-xs">
				{#each DAY_ORDER as day}
					{@const isToday = day === todayKey()}
					<div class="flex justify-between {isToday ? 'font-semibold text-surface-900' : 'text-surface-600'}">
						<dt class="w-20">{DAY_LABELS[day]}</dt>
						<dd class="flex-1 text-right">
							{#if hoursByDay[day].length === 0}
								<span class="text-surface-400">Fermé</span>
							{:else}
								{hoursByDay[day].join(', ')}
							{/if}
						</dd>
					</div>
				{/each}
			</dl>
		{:else}
			<p class="text-xs italic text-surface-400">Horaires non renseignés</p>
		{/if}
		<a
			href={`/projects/${$page.params.slug}/gmb-profile/${$page.params.locationId}/horaires`}
			class="mt-4 inline-flex items-center gap-0.5 text-xs font-medium text-primary-600 hover:text-primary-700"
		>
			Éditer <ChevronRight size={11} />
		</a>
	</div>
</div>

{#if layout.profile?.profileDescription}
	<div class="mt-4 rounded-lg border border-surface-200 bg-white p-5">
		<h2 class="mb-2 text-sm font-semibold text-surface-900">Description</h2>
		<p class="whitespace-pre-line text-sm text-surface-600">{layout.profile.profileDescription}</p>
	</div>
{/if}
