<script lang="ts">
	const STATUS_COLORS: Record<string, string> = {
		draft: 'bg-gray-400',
		review: 'bg-amber-400',
		approved: 'bg-blue-400',
		published: 'bg-emerald-400'
	};

	interface Props {
		id: string;
		title: string;
		status: string;
		projectColor?: string | null;
		projectSlug?: string | null;
	}

	let { id, title, status, projectColor, projectSlug }: Props = $props();

	const dotClass = $derived(STATUS_COLORS[status] ?? STATUS_COLORS.draft);
</script>

<a
	href="{projectSlug ? `/projects/${projectSlug}/content/${id}` : `/content/${id}`}"
	class="group flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-opacity hover:opacity-80"
	style="background-color: {projectColor ? projectColor + '18' : '#9ca3af18'};"
>
	<span class="h-1.5 w-1.5 shrink-0 rounded-full {dotClass}"></span>
	<span class="truncate text-surface-700 group-hover:text-surface-900">{title}</span>
</a>
