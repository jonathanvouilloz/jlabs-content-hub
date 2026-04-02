<script lang="ts">
	import ContentTable from '$lib/components/ContentTable.svelte';

	let { data } = $props();

	let activeContents = $derived(
		data.contents.filter((c: { status: string }) => c.status !== 'published')
	);

	let publishedContents = $state<Array<{ id: string; title: string; type: string; status: string; plannedDate: string | null }> | null>(null);
	let loadingPublished = $state(false);

	async function loadPublished() {
		loadingPublished = true;
		try {
			const res = await fetch(`/api/content?project=${data.project.slug}&type=linkedin&status=published`, {
				headers: { Authorization: 'Bearer dev-api-key' }
			});
			const json = await res.json();
			publishedContents = json.data ?? [];
		} catch {
			publishedContents = [];
		}
		loadingPublished = false;
	}
</script>

<div>
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-surface-900">Posts LinkedIn</h1>
		<span class="text-sm text-surface-400">
			{activeContents.length} actif{activeContents.length !== 1 ? 's' : ''}
		</span>
	</div>

	{#if !data.connections.linkedin}
		<div class="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
			<p class="text-sm text-amber-800">
				LinkedIn non connecte.
				<a href="/projects/{data.project.slug}/settings" class="font-medium text-amber-900 underline hover:no-underline">
					Configurer dans les parametres
				</a>
			</p>
		</div>
	{/if}

	<div class="mt-4">
		<ContentTable contents={activeContents} projectSlug={data.project.slug} showType={false} showBatchActions={true} />
	</div>

	<!-- Published section -->
	<div class="mt-10">
		<div class="flex items-center justify-between">
			<h2 class="text-lg font-semibold text-surface-700">Posts publies</h2>
			{#if publishedContents === null}
				<button
					onclick={loadPublished}
					class="btn preset-outlined-surface-200 text-xs"
					disabled={loadingPublished}
				>
					{loadingPublished ? 'Chargement...' : 'Charger les posts publies'}
				</button>
			{:else}
				<span class="text-sm text-surface-400">{publishedContents.length} publie{publishedContents.length !== 1 ? 's' : ''}</span>
			{/if}
		</div>

		{#if publishedContents !== null}
			<div class="mt-4">
				<ContentTable contents={publishedContents} projectSlug={data.project.slug} showType={false} showBatchActions={false} />
			</div>
		{/if}
	</div>
</div>
