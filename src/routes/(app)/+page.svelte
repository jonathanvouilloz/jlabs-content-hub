<script lang="ts">
	import ContentCard from '$lib/components/ContentCard.svelte';

	let { data } = $props();
</script>

<div>
	<h1 class="text-2xl font-bold text-surface-900">Dashboard</h1>
	<p class="mt-1 text-surface-500">Bienvenue, {data.user.name}</p>

	<div class="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-5">
		<div class="rounded-lg border border-surface-200 bg-white p-6">
			<p class="text-sm font-medium text-surface-500">Projets</p>
			<p class="mt-2 text-3xl font-bold text-surface-900">{data.stats.projects}</p>
		</div>
		<div class="rounded-lg border border-surface-200 bg-white p-6">
			<p class="text-sm font-medium text-surface-500">Total contenus</p>
			<p class="mt-2 text-3xl font-bold text-surface-900">{data.stats.total}</p>
		</div>
		<div class="rounded-lg border border-surface-200 bg-white p-6">
			<p class="text-sm font-medium text-gray-500">Drafts</p>
			<p class="mt-2 text-3xl font-bold text-gray-600">{data.stats.draft}</p>
		</div>
		<div class="rounded-lg border border-surface-200 bg-white p-6">
			<p class="text-sm font-medium text-amber-500">En review</p>
			<p class="mt-2 text-3xl font-bold text-amber-600">{data.stats.review}</p>
		</div>
		<div class="rounded-lg border border-surface-200 bg-white p-6">
			<p class="text-sm font-medium text-emerald-500">Publies</p>
			<p class="mt-2 text-3xl font-bold text-emerald-600">{data.stats.published}</p>
		</div>
	</div>

	{#if data.recentContents.length > 0}
		<h2 class="mt-10 text-lg font-semibold text-surface-900">Derniers contenus</h2>
		<div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.recentContents as item}
				<ContentCard
					id={item.id}
					title={item.title}
					type={item.type}
					status={item.status}
					plannedDate={item.plannedDate}
					createdAt={item.createdAt}
					projectName={item.projectName ?? undefined}
					projectColor={item.projectColor ?? undefined}
				/>
			{/each}
		</div>
	{:else}
		<div class="mt-10 rounded-lg border border-dashed border-surface-300 p-12 text-center">
			<p class="text-surface-500">Aucun contenu pour le moment</p>
			<p class="mt-1 text-sm text-surface-400">Pousse du contenu via l'API ou cree un projet</p>
		</div>
	{/if}
</div>
