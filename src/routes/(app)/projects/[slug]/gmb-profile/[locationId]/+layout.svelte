<script lang="ts">
	import { page } from '$app/stores';
	import { invalidateAll } from '$app/navigation';
	import { Building2, MapPin, ExternalLink, RefreshCw, ArrowLeft, AlertTriangle } from 'lucide-svelte';

	let { data, children } = $props();

	let refreshing = $state(false);
	let refreshError = $state<string | null>(null);

	async function refresh() {
		refreshing = true;
		refreshError = null;
		try {
			const res = await fetch(
				`/api/projects/${$page.params.slug}/gmb-profile/${data.locationIdParam}/refresh`,
				{ method: 'POST' }
			);
			if (!res.ok) {
				const json = await res.json().catch(() => ({}));
				refreshError = json.error ?? `Échec (${res.status})`;
			} else {
				await invalidateAll();
			}
		} catch (err) {
			refreshError = err instanceof Error ? err.message : 'Erreur réseau';
		} finally {
			refreshing = false;
		}
	}

	function formatSyncedAgo(iso: string | null | undefined): string {
		if (!iso) return 'jamais';
		const diff = Date.now() - new Date(iso).getTime();
		const min = Math.floor(diff / 60000);
		if (min < 1) return "à l'instant";
		if (min < 60) return `il y a ${min} min`;
		const h = Math.floor(min / 60);
		if (h < 24) return `il y a ${h} h`;
		const d = Math.floor(h / 24);
		return `il y a ${d} j`;
	}

	const tabs = $derived([
		{ href: `/projects/${$page.params.slug}/gmb-profile/${data.locationIdParam}`, label: "Vue d'ensemble", exact: true },
		{ href: `/projects/${$page.params.slug}/gmb-profile/${data.locationIdParam}/infos`, label: 'Infos', exact: false },
		{ href: `/projects/${$page.params.slug}/gmb-profile/${data.locationIdParam}/horaires`, label: 'Horaires', exact: false },
		{ href: `/projects/${$page.params.slug}/gmb-profile/${data.locationIdParam}/stats`, label: 'Stats', exact: false }
	]);

	function isActive(href: string, exact: boolean): boolean {
		const path = $page.url.pathname;
		return exact ? path === href : path === href || path.startsWith(href + '/');
	}

	const mapsUri = $derived.by(() => {
		try {
			const raw = data.profile?.rawPayload ? JSON.parse(data.profile.rawPayload) : null;
			return raw?.metadata?.mapsUri ?? null;
		} catch {
			return null;
		}
	});
</script>

<!-- Back link -->
<a
	href={`/projects/${$page.params.slug}/gmb-profile`}
	class="mb-4 inline-flex items-center gap-1 text-xs text-surface-500 transition-colors hover:text-surface-900"
>
	<ArrowLeft size={12} />
	Toutes les fiches
</a>

<!-- Hero -->
<div class="mb-4 rounded-lg border border-surface-200 bg-white p-5">
	<div class="flex items-start gap-4">
		<div class="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-md bg-surface-100 text-surface-500">
			<Building2 size={22} />
		</div>
		<div class="min-w-0 flex-1">
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0">
					<h1 class="truncate text-xl font-semibold text-surface-900">
						{data.profile?.title ?? data.link.label}
					</h1>
					{#if data.link.address || data.profile?.formattedAddress}
						<p class="mt-1 flex items-center gap-1.5 text-sm text-surface-500">
							<MapPin size={12} />
							{data.profile?.formattedAddress ?? data.link.address}
						</p>
					{/if}
				</div>
				<div class="flex flex-shrink-0 items-center gap-2">
					{#if data.profile?.openStatus === 'OPEN'}
						<span class="rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">Ouvert</span>
					{:else if data.profile?.openStatus === 'CLOSED_TEMPORARILY'}
						<span class="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">Fermé temporairement</span>
					{:else if data.profile?.openStatus === 'CLOSED_PERMANENTLY'}
						<span class="rounded-md bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700">Fermé définitivement</span>
					{/if}
					{#if mapsUri}
						<a
							href={mapsUri}
							target="_blank"
							rel="noopener"
							class="inline-flex items-center gap-1 rounded-md border border-surface-200 bg-white px-2.5 py-1 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50"
						>
							<ExternalLink size={11} />
							Maps
						</a>
					{/if}
					<button
						onclick={refresh}
						disabled={refreshing}
						class="inline-flex items-center gap-1 rounded-md border border-surface-200 bg-white px-2.5 py-1 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50 disabled:opacity-50"
					>
						<RefreshCw size={11} class={refreshing ? 'animate-spin' : ''} />
						{refreshing ? 'Sync…' : 'Resynchroniser'}
					</button>
				</div>
			</div>

			<p class="mt-2 text-xs text-surface-400">
				{#if data.profile?.primaryCategoryDisplay}
					{data.profile.primaryCategoryDisplay} ·
				{/if}
				Dernière synchro {formatSyncedAgo(data.profile?.syncedAt)}
			</p>

			{#if data.syncError || refreshError}
				<div class="mt-3 flex items-start gap-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">
					<AlertTriangle size={12} class="mt-0.5 flex-shrink-0" />
					<span>{refreshError ?? data.syncError}</span>
				</div>
			{/if}
		</div>
	</div>
</div>

<!-- Tabs -->
<div class="mb-6 flex border-b border-surface-200">
	{#each tabs as tab}
		<a
			href={tab.href}
			class="border-b-2 px-3 py-2 text-sm font-medium transition-colors
				{isActive(tab.href, tab.exact)
					? 'border-primary-500 text-surface-900'
					: 'border-transparent text-surface-500 hover:text-surface-900'}"
		>
			{tab.label}
		</a>
	{/each}
</div>

{@render children()}
