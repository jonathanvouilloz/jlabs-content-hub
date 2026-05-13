<script lang="ts">
	import { page } from '$app/stores';
	import { MapPin, Eye, MousePointerClick, Phone, Navigation, ArrowRight, Star, Building2 } from 'lucide-svelte';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';

	let { data } = $props();

	function fmt(n: number): string {
		if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
		return n.toString();
	}

	function locationIdParam(fullName: string): string {
		return fullName.replace(/^locations\//, '');
	}
</script>

<PageHeader
	title="Fiches Google"
	description="Vue d'ensemble de vos fiches Google Business Profile et de leur performance (30 derniers jours)."
/>

{#if data.locations.length === 0}
	<EmptyState
		message="Aucune fiche Google rattachée à ce projet. Connectez Google et assignez au moins une location depuis les paramètres."
	/>
{:else}
	<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
		{#each data.locations as item}
			<a
				href={`/projects/${$page.params.slug}/gmb-profile/${locationIdParam(item.link.gmbLocationId)}`}
				class="group flex flex-col rounded-lg border border-surface-200 bg-white p-4 transition-shadow hover:shadow-md"
			>
				<div class="flex items-start gap-3">
					<div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-surface-100 text-surface-500">
						<Building2 size={18} />
					</div>
					<div class="min-w-0 flex-1">
						<h3 class="truncate text-sm font-semibold text-surface-900 group-hover:text-primary-600">
							{item.profile?.title ?? item.link.label}
						</h3>
						{#if item.link.address || item.profile?.formattedAddress}
							<p class="mt-0.5 flex items-center gap-1 text-xs text-surface-500">
								<MapPin size={11} />
								<span class="truncate">{item.profile?.formattedAddress ?? item.link.address}</span>
							</p>
						{/if}
					</div>
					{#if item.profile?.openStatus === 'OPEN'}
						<span class="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">Ouvert</span>
					{:else if item.profile?.openStatus === 'CLOSED_TEMPORARILY'}
						<span class="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">Fermé temp.</span>
					{:else if item.profile?.openStatus === 'CLOSED_PERMANENTLY'}
						<span class="rounded-md bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">Fermé déf.</span>
					{/if}
				</div>

				<div class="mt-4 grid grid-cols-4 gap-2 border-t border-surface-100 pt-3">
					<div class="flex flex-col items-start">
						<span class="flex items-center gap-1 text-[10px] font-medium uppercase text-surface-400">
							<Eye size={10} /> Vues
						</span>
						<span class="text-sm font-semibold text-surface-900">{fmt(item.totals.impressions)}</span>
					</div>
					<div class="flex flex-col items-start">
						<span class="flex items-center gap-1 text-[10px] font-medium uppercase text-surface-400">
							<MousePointerClick size={10} /> Site
						</span>
						<span class="text-sm font-semibold text-surface-900">{fmt(item.totals.websiteClicks)}</span>
					</div>
					<div class="flex flex-col items-start">
						<span class="flex items-center gap-1 text-[10px] font-medium uppercase text-surface-400">
							<Navigation size={10} /> Itin.
						</span>
						<span class="text-sm font-semibold text-surface-900">{fmt(item.totals.directionRequests)}</span>
					</div>
					<div class="flex flex-col items-start">
						<span class="flex items-center gap-1 text-[10px] font-medium uppercase text-surface-400">
							<Phone size={10} /> Appels
						</span>
						<span class="text-sm font-semibold text-surface-900">{fmt(item.totals.callClicks)}</span>
					</div>
				</div>

				{#if !item.hasInsights}
					<p class="mt-2 text-[11px] italic text-surface-400">Stats non synchronisées</p>
				{/if}

				<div class="mt-3 flex items-center justify-between border-t border-surface-100 pt-3">
					<div class="flex items-center gap-1 text-xs text-surface-600">
						<Star size={12} class="text-amber-400" fill="currentColor" />
						<span class="font-medium">{item.reviews.total}</span>
						<span class="text-surface-400">avis</span>
						{#if item.reviews.unreplied > 0}
							<span class="ml-1 rounded-md bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">
								{item.reviews.unreplied} sans réponse
							</span>
						{/if}
					</div>
					<ArrowRight size={14} class="text-surface-300 transition-transform group-hover:translate-x-0.5 group-hover:text-primary-500" />
				</div>
			</a>
		{/each}
	</div>
{/if}
