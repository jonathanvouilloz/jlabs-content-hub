<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { FileText, MapPin } from 'lucide-svelte';
	import LinkedinIcon from '$lib/components/ui/LinkedinIcon.svelte';
	import ContentTable from '$lib/components/ContentTable.svelte';
	import ContentPreview from '$lib/components/ContentPreview.svelte';
	import { formatDate } from '$lib/utils/dates.js';
	import { statusConfig } from '$lib/config/design-tokens.js';

	let { data } = $props();

	let previewId = $state<string | null>(null);

	let publishedContents = $state<Array<{ id: string; title: string; type: string; status: string; plannedDate: string | null }> | null>(null);
	let loadingPublished = $state(false);

	async function loadPublished() {
		loadingPublished = true;
		try {
			const res = await fetch(`/api/content?project=${data.project.slug}&status=published`);
			const json = await res.json();
			publishedContents = json.data ?? [];
		} catch {
			publishedContents = [];
		}
		loadingPublished = false;
	}

	const STATUSES = [
		{ value: '', label: 'Tous statuts' },
		{ value: 'draft', label: 'Draft' },
		{ value: 'review', label: 'Review' },
		{ value: 'approved', label: 'Approved' }
	];

	function applyFilter(value: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (value) params.set('status', value);
		else params.delete('status');
		goto(`?${params.toString()}`, { replaceState: true });
	}

</script>

<div class="flex flex-col h-[calc(100vh-73px)] -mx-6 -my-6 lg:-mx-8">
	<!-- Header -->
	<div class="flex-shrink-0 px-6 pt-6 pb-4 lg:px-8">
		<div class="flex items-start justify-between">
			<div>
				<h1 class="text-xl font-semibold text-surface-900">{data.project.name}</h1>
				{#if data.project.description}
					<p class="mt-0.5 text-sm text-surface-400">{data.project.description}</p>
				{/if}
			</div>
		</div>

		<!-- Stats inline -->
		<div class="mt-4 flex items-center gap-6 text-sm">
			<div class="flex items-center gap-2">
				<span class="text-surface-500">Total</span>
				<span class="font-semibold text-surface-900">{data.typeCounts.all}</span>
			</div>
			<div class="h-4 w-px bg-surface-200"></div>
			<div class="flex items-center gap-1.5">
				<FileText size={14} class="text-surface-400" />
				<span class="text-surface-500">{data.typeCounts.article}</span>
			</div>
			<div class="flex items-center gap-1.5">
				<LinkedinIcon size={14} class="text-surface-400" />
				<span class="text-surface-500">{data.typeCounts.linkedin}</span>
			</div>
			<div class="flex items-center gap-1.5">
				<MapPin size={14} class="text-surface-400" />
				<span class="text-surface-500">{data.typeCounts.gmb}</span>
			</div>
		</div>

		<!-- Filters -->
		<div class="mt-4 flex items-center justify-between">
			<h2 class="text-xs font-semibold uppercase tracking-wider text-surface-400">Contenus</h2>
			<div class="flex items-center gap-3">
				<select
					class="rounded-md border border-surface-200 bg-white px-2.5 py-1 text-xs text-surface-600 outline-none"
					value={data.filters.status ?? ''}
					onchange={(e) => applyFilter((e.target as HTMLSelectElement).value)}
				>
					{#each STATUSES as s}
						<option value={s.value}>{s.label}</option>
					{/each}
				</select>
				<span class="text-xs text-surface-400">
					{data.contents.length} contenu{data.contents.length !== 1 ? 's' : ''}
				</span>
			</div>
		</div>
	</div>

	<!-- Split: table + preview -->
	<div class="flex flex-1 min-h-0">
		<div class="flex-1 overflow-y-auto px-6 pb-6 lg:px-8">
			<ContentTable
				contents={data.contents}
				projectSlug={data.project.slug}
				showType={true}
				showBatchActions={true}
				selectedId={previewId}
				onselect={(id) => { previewId = id; }}
			/>

			<div class="mt-8">
				<div class="flex items-center justify-between">
					<h2 class="text-xs font-semibold uppercase tracking-wider text-surface-400">Contenus publies</h2>
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
							showType={true}
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
