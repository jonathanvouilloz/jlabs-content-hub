<script lang="ts">
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import CommentBox from '$lib/components/CommentBox.svelte';
	import { parseFrontmatter, renderMarkdown } from '$lib/utils/content.js';
	import { formatDate } from '$lib/utils/dates.js';

	let { data } = $props();

	const TYPE_LABELS: Record<string, string> = {
		article: 'Article',
		linkedin: 'LinkedIn',
		gmb: 'GMB'
	};

	const isGmb = $derived(data.content.type === 'gmb');

	const renderedBody = $derived(() => {
		if (isGmb) {
			try {
				return JSON.stringify(JSON.parse(data.content.body), null, 2);
			} catch {
				return data.content.body;
			}
		}
		const { content } = parseFrontmatter(data.content.body);
		return renderMarkdown(content);
	});
</script>

<div>
	<!-- Back link -->
	<a
		href="/view/{data.project.slug}?token={data.token}"
		class="inline-flex items-center gap-1 text-sm text-surface-500 hover:text-primary-600 transition-colors"
	>
		<svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
			<path fill-rule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clip-rule="evenodd" />
		</svg>
		Retour
	</a>

	<!-- Header -->
	<div class="mt-4">
		<div class="flex items-center gap-2">
			<span class="h-3 w-3 rounded-full" style="background-color: {data.project.color};"></span>
			<span class="text-xs text-surface-400">{data.project.name}</span>
			<span class="text-xs text-surface-300">·</span>
			<span class="text-xs text-surface-400">{TYPE_LABELS[data.content.type] ?? data.content.type}</span>
		</div>
		<h1 class="mt-2 text-2xl font-bold text-surface-900">{data.content.title}</h1>
		<div class="mt-3 flex flex-wrap items-center gap-3">
			<StatusBadge status={data.content.status} />
			{#if data.content.plannedDate}
				<span class="text-xs text-surface-400">Planifie : {formatDate(data.content.plannedDate)}</span>
			{/if}
			{#if data.content.publishedAt}
				<span class="text-xs text-surface-400">Publie : {formatDate(data.content.publishedAt)}</span>
			{/if}
		</div>
	</div>

	<!-- Body -->
	<div class="mt-8">
		{#if isGmb}
			<pre class="overflow-x-auto rounded-lg border border-surface-200 bg-surface-50 p-4 text-sm text-surface-700">{renderedBody()}</pre>
		{:else}
			<article class="prose max-w-none">
				{@html renderedBody()}
			</article>
		{/if}
	</div>

	<!-- Tags -->
	{#if data.content.tags}
		{@const tags = JSON.parse(data.content.tags)}
		{#if tags.length > 0}
			<div class="mt-6 flex flex-wrap gap-2">
				{#each tags as tag}
					<span class="rounded-full bg-surface-100 px-2.5 py-0.5 text-xs text-surface-600">{tag}</span>
				{/each}
			</div>
		{/if}
	{/if}

	<!-- Comments -->
	<CommentBox contentId={data.content.id} token={data.token} comments={data.comments} />
</div>
