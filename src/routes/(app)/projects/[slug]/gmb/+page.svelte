<script lang="ts">
	import ContentTable from '$lib/components/ContentTable.svelte';
	import ContentPreview from '$lib/components/ContentPreview.svelte';

	let { data } = $props();

	let activeContents = $derived(
		data.contents.filter((c: { status: string }) => c.status !== 'published')
	);

	let publishedContents = $state<Array<{ id: string; title: string; type: string; status: string; plannedDate: string | null }> | null>(null);
	let loadingPublished = $state(false);
	let previewId = $state<string | null>(null);

	async function loadPublished() {
		loadingPublished = true;
		try {
			const res = await fetch(`/api/content?project=${data.project.slug}&type=gmb&status=published`, {
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

<div class="flex flex-col h-[calc(100vh-73px)] -mx-6 -my-6 lg:-mx-8">
	<!-- Header -->
	<div class="flex-shrink-0 px-6 pt-6 pb-4 lg:px-8">
		<h1 class="text-xl font-semibold text-surface-900">Posts Google My Business</h1>
		<p class="mt-0.5 text-xs text-surface-400">{activeContents.length} actif{activeContents.length !== 1 ? 's' : ''}</p>
		{#if !data.connections.gmb}
			<div class="mt-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
				GMB non connecte —
				<a href="/projects/{data.project.slug}/settings" class="font-medium underline hover:no-underline">configurer</a>
			</div>
		{/if}
	</div>

	<!-- Split: table + preview -->
	<div class="flex flex-1 min-h-0">
		<div class="flex-1 overflow-y-auto px-6 pb-6 lg:px-8">
			<ContentTable
				contents={activeContents}
				projectSlug={data.project.slug}
				showType={false}
				showBatchActions={true}
				selectedId={previewId}
				onselect={(id) => { previewId = id; }}
			/>

			<div class="mt-8">
				<div class="flex items-center justify-between">
					<h2 class="text-xs font-semibold uppercase tracking-wider text-surface-400">Posts publies</h2>
					{#if publishedContents === null}
						<button
							onclick={loadPublished}
							class="rounded-md border border-surface-200 bg-white px-2.5 py-1 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50"
							disabled={loadingPublished}
						>
							{loadingPublished ? 'Chargement...' : 'Charger'}
						</button>
					{:else}
						<span class="text-xs text-surface-400">{publishedContents.length} publie{publishedContents.length !== 1 ? 's' : ''}</span>
					{/if}
				</div>
				{#if publishedContents !== null}
					<div class="mt-3">
						<ContentTable
							contents={publishedContents}
							projectSlug={data.project.slug}
							showType={false}
							showBatchActions={false}
							selectedId={previewId}
							onselect={(id) => { previewId = id; }}
						/>
					</div>
				{/if}
			</div>
		</div>

		{#if previewId}
			<div class="w-[45%] flex-shrink-0 overflow-hidden pr-6 pb-6 lg:pr-8">
				<ContentPreview
					contentId={previewId}
					projectSlug={data.project.slug}
					onclose={() => { previewId = null; }}
				/>
			</div>
		{/if}
	</div>
</div>
