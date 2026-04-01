<script lang="ts">
	import CalendarItem from './CalendarItem.svelte';

	interface ContentItem {
		id: string;
		title: string;
		status: string;
		projectColor?: string | null;
	}

	interface Props {
		day: number | null;
		isToday: boolean;
		contents: ContentItem[];
	}

	let { day, isToday, contents }: Props = $props();

	const MAX_VISIBLE = 3;
	const visible = $derived(contents.slice(0, MAX_VISIBLE));
	const overflow = $derived(contents.length - MAX_VISIBLE);
</script>

<div
	class="min-h-24 border-b border-r border-surface-200 p-1 {day === null ? 'bg-surface-50' : 'bg-white'}"
>
	{#if day !== null}
		<div class="mb-0.5 text-right">
			<span
				class="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium
					{isToday ? 'bg-primary-500 text-white' : 'text-surface-500'}"
			>
				{day}
			</span>
		</div>
		<div class="flex flex-col gap-0.5">
			{#each visible as item}
				<CalendarItem
					id={item.id}
					title={item.title}
					status={item.status}
					projectColor={item.projectColor}
				/>
			{/each}
			{#if overflow > 0}
				<span class="px-1.5 text-xs text-surface-400">+{overflow}</span>
			{/if}
		</div>
	{/if}
</div>
