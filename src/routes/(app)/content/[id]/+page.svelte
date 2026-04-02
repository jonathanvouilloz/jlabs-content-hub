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

	// GMB publish
	let publishing = $state(false);

	async function publishGmbNow() {
		publishing = true;
		try {
			await fetch(`/api/gmb/publish/${data.content.id}`, { method: 'POST' });
			invalidateAll();
		} catch { /* ignore */ }
		publishing = false;
	}

	// CMS publish
	let publishingCms = $state(false);
	let cmsPublishError = $state('');

	async function publishToCms() {
		publishingCms = true;
		cmsPublishError = '';
		try {
			const res = await fetch(`/api/cms/publish/${data.content.id}`, { method: 'POST' });
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			invalidateAll();
		} catch (err) {
			cmsPublishError = (err as Error).message;
		}
		publishingCms = false;
	}

	// GMB parsed body
	let gmbData = $derived(() => {
		if (data.content.type !== 'gmb') return null;
		try { return JSON.parse(data.content.body); }
		catch { return null; }
	});

	// Planned date editing
	let editingDate = $state(false);
	let newPlannedDate = $state('');

	function startEditDate() {
		// Convert ISO to datetime-local format
		const d = data.content.plannedDate;
		newPlannedDate = d ? d.slice(0, 16) : '';
		editingDate = true;
	}

	async function savePlannedDate() {
		const isoDate = newPlannedDate ? new Date(newPlannedDate).toISOString() : null;
		await fetch(`/api/content/${data.content.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev-api-key' },
			body: JSON.stringify({ plannedDate: isoDate })
		});
		editingDate = false;
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
		<div class="flex items-center gap-3">
			{#if data.cmsConnection && data.content.type === 'article'}
				{#if data.content.cmsItemId}
					<span class="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
						<span class="h-2 w-2 rounded-full bg-green-500"></span>
						Publie sur {data.cmsConnection.cmsType === 'webflow' ? 'Webflow' : data.cmsConnection.cmsType}
					</span>
				{:else if data.content.status === 'approved' || data.content.status === 'review'}
					<button
						onclick={publishToCms}
						class="btn preset-filled-primary-500 text-xs"
						disabled={publishingCms}
					>
						{publishingCms ? 'Publication...' : `Publier sur ${data.cmsConnection.cmsType === 'webflow' ? 'Webflow' : data.cmsConnection.cmsType}`}
					</button>
				{/if}
			{/if}
			<StatusBadge status={data.content.status} interactive onchange={changeStatus} />
		</div>
	</div>

	{#if cmsPublishError}
		<div class="mt-2 rounded-md bg-red-50 px-4 py-2 text-xs text-red-600">{cmsPublishError}</div>
	{/if}

	<!-- Metadata -->
	<div class="mt-4 flex flex-wrap items-center gap-4 text-xs text-surface-400">
		{#if data.content.plannedDate}
			<span>
				Planifie : {formatDate(data.content.plannedDate)}
				{#if data.content.type === 'gmb' && data.content.status !== 'published'}
					{#if editingDate}
						<input
							type="datetime-local"
							bind:value={newPlannedDate}
							class="ml-1 rounded border border-surface-200 px-1.5 py-0.5 text-xs"
						/>
						<button onclick={savePlannedDate} class="ml-1 text-primary-600 hover:underline">OK</button>
						<button onclick={() => editingDate = false} class="ml-1 text-surface-400 hover:underline">Annuler</button>
					{:else}
						<button onclick={startEditDate} class="ml-1 text-primary-600 hover:underline">modifier</button>
					{/if}
				{/if}
			</span>
		{:else if data.content.type === 'gmb' && data.content.status !== 'published'}
			<span>
				Pas de date planifiee
				{#if editingDate}
					<input
						type="datetime-local"
						bind:value={newPlannedDate}
						class="ml-1 rounded border border-surface-200 px-1.5 py-0.5 text-xs"
					/>
					<button onclick={savePlannedDate} class="ml-1 text-primary-600 hover:underline">OK</button>
					<button onclick={() => editingDate = false} class="ml-1 text-surface-400 hover:underline">Annuler</button>
				{:else}
					<button onclick={startEditDate} class="ml-1 text-primary-600 hover:underline">ajouter</button>
				{/if}
			</span>
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
		{#if data.content.type === 'gmb' && gmbData()}
			{@const gmb = gmbData()}
			<!-- GMB Post display -->
			<div class="rounded-lg border border-surface-200 bg-white p-6">
				<div class="flex items-start justify-between gap-4">
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<span class="rounded-full bg-surface-100 px-2.5 py-0.5 text-xs font-medium text-surface-600">
								{gmb.type || 'whats_new'}
							</span>
							{#if gmb.cta}
								<span class="rounded-full bg-primary-50 px-2.5 py-0.5 text-xs text-primary-700">
									{gmb.cta.action}
								</span>
							{/if}
						</div>

						<p class="mt-3 text-sm leading-relaxed text-surface-700">{gmb.content}</p>

						{#if gmb.cta?.url}
							<div class="mt-3">
								<a href={gmb.cta.url} target="_blank" rel="noopener" class="text-xs text-primary-600 hover:underline">
									{gmb.cta.url}
								</a>
							</div>
						{/if}

						{#if gmb.event_start_date || gmb.event_end_date}
							<div class="mt-3 flex gap-3 text-xs text-surface-400">
								{#if gmb.event_start_date}
									<span>Debut : {formatDate(gmb.event_start_date)}</span>
								{/if}
								{#if gmb.event_end_date}
									<span>Fin : {formatDate(gmb.event_end_date)}</span>
								{/if}
							</div>
						{/if}

						{#if gmb.image_prompt}
							<details class="mt-3">
								<summary class="cursor-pointer text-xs text-surface-400">Image prompt</summary>
								<p class="mt-1 text-xs text-surface-500">{gmb.image_prompt}</p>
							</details>
						{/if}
					</div>

					{#if data.content.status !== 'published'}
						<button
							onclick={publishGmbNow}
							class="btn preset-filled-primary-500 shrink-0 text-xs"
							disabled={publishing}
						>
							{publishing ? 'Publication...' : 'Publier maintenant'}
						</button>
					{:else if data.content.gmbPostId}
						<span class="text-xs text-green-600">Publie sur Google</span>
					{/if}
				</div>
			</div>

			<!-- Raw JSON (collapsible) -->
			<details class="mt-4">
				<summary class="cursor-pointer text-sm font-medium text-surface-500">JSON brut</summary>
				<pre class="mt-2 rounded-lg bg-surface-50 p-4 text-xs overflow-auto">{JSON.stringify(gmb, null, 2)}</pre>
			</details>
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
