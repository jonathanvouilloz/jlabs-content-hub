<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ProjectPill from '$lib/components/ProjectPill.svelte';
	import { renderMarkdown } from '$lib/utils/content.js';
	import { formatDate } from '$lib/utils/dates.js';

	let { data } = $props();

	const TYPE_LABELS: Record<string, string> = {
		article: 'Article',
		linkedin: 'LinkedIn',
		gmb: 'GMB'
	};

	let renderedBody = $derived(
		data.content.type === 'gmb'
			? null
			: renderMarkdown(data.content.body)
	);

	let parsedMeta = $derived(() => {
		try { return data.content.meta ? JSON.parse(data.content.meta) : null; }
		catch { return null; }
	});

	let parsedTags = $derived(() => {
		try { return data.content.tags ? JSON.parse(data.content.tags) : []; }
		catch { return []; }
	});

	async function changeStatus(newStatus: string) {
		await fetch(`/api/content/${data.content.id}/status`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev-api-key' },
			body: JSON.stringify({ status: newStatus })
		});
		invalidateAll();
	}

	async function deleteComment(commentId: string) {
		await fetch(`/api/comments/${commentId}`, {
			method: 'DELETE',
			headers: { Authorization: 'Bearer dev-api-key' }
		});
		invalidateAll();
	}
</script>

<div>
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<div class="flex items-center gap-3">
				{#if data.project}
					<ProjectPill name={data.project.name} color={data.project.color} />
				{/if}
				<span class="text-xs text-surface-400">{TYPE_LABELS[data.content.type] ?? data.content.type}</span>
			</div>
			<h1 class="mt-2 text-2xl font-bold text-surface-900">{data.content.title}</h1>
		</div>
		<StatusBadge status={data.content.status} interactive onchange={changeStatus} />
	</div>

	<!-- Metadata -->
	<div class="mt-4 flex flex-wrap gap-4 text-xs text-surface-400">
		{#if data.content.plannedDate}
			<span>Planifie : {formatDate(data.content.plannedDate)}</span>
		{/if}
		{#if data.content.publishedAt}
			<span>Publie : {formatDate(data.content.publishedAt)}</span>
		{/if}
		<span>Cree : {formatDate(data.content.createdAt)}</span>
	</div>

	{#if parsedTags().length > 0}
		<div class="mt-3 flex flex-wrap gap-1.5">
			{#each parsedTags() as tag}
				<span class="rounded-full bg-surface-100 px-2 py-0.5 text-xs text-surface-600">{tag}</span>
			{/each}
		</div>
	{/if}

	<!-- Body -->
	<div class="mt-8">
		{#if data.content.type === 'gmb'}
			<pre class="rounded-lg bg-surface-50 p-4 text-sm overflow-auto">{JSON.stringify(JSON.parse(data.content.body), null, 2)}</pre>
		{:else if renderedBody}
			<div class="prose prose-sm max-w-none rounded-lg border border-surface-200 bg-white p-6">
				{@html renderedBody}
			</div>
		{/if}
	</div>

	<!-- Meta JSON -->
	{#if parsedMeta()}
		<details class="mt-6">
			<summary class="cursor-pointer text-sm font-medium text-surface-500">Metadonnees</summary>
			<pre class="mt-2 rounded-lg bg-surface-50 p-4 text-xs overflow-auto">{JSON.stringify(parsedMeta(), null, 2)}</pre>
		</details>
	{/if}

	<!-- Comments -->
	<div class="mt-10">
		<h2 class="text-lg font-semibold text-surface-900">
			Commentaires ({data.comments.length})
		</h2>

		{#if data.comments.length > 0}
			<div class="mt-4 space-y-3">
				{#each data.comments as comment}
					<div class="rounded-lg border border-surface-200 bg-white p-4">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium text-surface-900">{comment.authorName}</span>
								<span class="text-xs text-surface-400">{comment.authorEmail}</span>
							</div>
							<div class="flex items-center gap-2">
								<span class="text-xs text-surface-400">{formatDate(comment.createdAt)}</span>
								<button
									onclick={() => deleteComment(comment.id)}
									class="text-xs text-red-500 hover:text-red-700"
								>
									Supprimer
								</button>
							</div>
						</div>
						<p class="mt-2 text-sm text-surface-600">{comment.body}</p>
					</div>
				{/each}
			</div>
		{:else}
			<p class="mt-4 text-sm text-surface-400">Aucun commentaire</p>
		{/if}
	</div>

	<!-- Status history -->
	{#if data.history.length > 0}
		<div class="mt-10">
			<h2 class="text-lg font-semibold text-surface-900">Historique</h2>
			<div class="mt-4 space-y-2">
				{#each data.history as entry}
					<div class="flex items-center gap-3 text-xs text-surface-400">
						<span>{formatDate(entry.changedAt)}</span>
						<span>
							{#if entry.fromStatus}
								{entry.fromStatus} → {entry.toStatus}
							{:else}
								Cree en {entry.toStatus}
							{/if}
						</span>
						<span class="text-surface-300">par {entry.changedBy}</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Back link -->
	{#if data.project}
		<div class="mt-10">
			<a href="/projects/{data.project.slug}" class="text-sm text-primary-600 hover:underline">
				← Retour a {data.project.name}
			</a>
		</div>
	{/if}
</div>
