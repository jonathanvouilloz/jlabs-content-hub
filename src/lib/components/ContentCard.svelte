<script lang="ts">
	import { statusConfig, contentTypeConfig } from '$lib/config/design-tokens.js';
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

	const stConfig = $derived(statusConfig(status));
	const typeConfig = $derived(contentTypeConfig(type));
</script>

<a
	href="{projectSlug ? `/projects/${projectSlug}/content/${id}` : `/content/${id}`}"
	class="flex items-center gap-3 rounded-lg border border-surface-200 bg-white px-4 py-3 transition-all hover:border-surface-300 hover:shadow-sm"
>
	<div class="min-w-0 flex-1">
		<h3 class="truncate text-sm font-medium text-surface-900">{title}</h3>
		<div class="mt-1 flex items-center gap-2">
			{#if projectName}
				<span class="flex items-center gap-1 text-xs text-surface-400">
					<span class="h-2 w-2 rounded-full flex-shrink-0" style="background-color: {projectColor};"></span>
					{projectName}
				</span>
			{/if}
			<span class="text-xs text-surface-300">{typeConfig.label}</span>
		</div>
	</div>
	<span class="rounded-md px-1.5 py-0.5 text-[10px] font-medium {stConfig.bg} {stConfig.text}">
		{stConfig.label}
	</span>
	<span class="text-xs text-surface-300 w-20 text-right flex-shrink-0">
		{#if plannedDate}
			{formatDate(plannedDate)}
		{:else}
			{formatDate(createdAt)}
		{/if}
	</span>
</a>
