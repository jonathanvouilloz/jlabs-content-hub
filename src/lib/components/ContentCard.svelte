<script lang="ts">
	import StatusBadge from './StatusBadge.svelte';
	import ProjectPill from './ProjectPill.svelte';
	import { formatDate } from '$lib/utils/dates.js';

	interface Props {
		id: string;
		title: string;
		type: string;
		status: string;
		plannedDate?: string | null;
		createdAt: string;
		projectName?: string;
		projectColor?: string;
		projectSlug?: string;
	}

	let { id, title, type, status, plannedDate, createdAt, projectName, projectColor, projectSlug }: Props = $props();

	const TYPE_LABELS: Record<string, string> = {
		article: 'Article',
		linkedin: 'LinkedIn',
		gmb: 'GMB',
		newsletter: 'Newsletter',
		other: 'Autre'
	};
</script>

<a
	href="{projectSlug ? `/projects/${projectSlug}/content/${id}` : `/content/${id}`}"
	class="block rounded-lg border border-surface-200 bg-white p-4 transition-shadow hover:shadow-md"
>
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0 flex-1">
			<h3 class="truncate text-sm font-medium text-surface-900">{title}</h3>
			<div class="mt-1.5 flex flex-wrap items-center gap-2">
				{#if projectName}
					<ProjectPill name={projectName} color={projectColor} />
				{/if}
				<span class="text-xs text-surface-400">{TYPE_LABELS[type] ?? type}</span>
			</div>
		</div>
		<StatusBadge {status} />
	</div>
	<div class="mt-3 text-xs text-surface-400">
		{#if plannedDate}
			Planifie : {formatDate(plannedDate)}
		{:else}
			Cree : {formatDate(createdAt)}
		{/if}
	</div>
</a>
