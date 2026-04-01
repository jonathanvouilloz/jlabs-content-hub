<script lang="ts">
	import CalendarDay from './CalendarDay.svelte';

	interface ContentItem {
		id: string;
		title: string;
		status: string;
		plannedDate?: string | null;
		projectColor?: string | null;
	}

	interface Props {
		year: number;
		month: number;
		contents: ContentItem[];
	}

	let { year, month, contents }: Props = $props();

	const DAYS_HEADER = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

	const today = new Date();
	const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

	const daysInMonth = $derived(new Date(year, month, 0).getDate());

	// Monday = 0, Sunday = 6
	const firstDayOffset = $derived(() => {
		const jsDay = new Date(year, month - 1, 1).getDay(); // 0=Sun
		return jsDay === 0 ? 6 : jsDay - 1;
	});

	const totalCells = $derived(firstDayOffset() + daysInMonth);
	const rows = $derived(Math.ceil(totalCells / 7));

	// Group contents by day number
	const contentsByDay = $derived(() => {
		const map = new Map<number, ContentItem[]>();
		const prefix = `${year}-${String(month).padStart(2, '0')}-`;
		for (const c of contents) {
			if (c.plannedDate?.startsWith(prefix)) {
				const day = parseInt(c.plannedDate.substring(8, 10), 10);
				if (!map.has(day)) map.set(day, []);
				map.get(day)!.push(c);
			}
		}
		return map;
	});
</script>

<div class="overflow-hidden rounded-lg border border-surface-200">
	<!-- Header -->
	<div class="grid grid-cols-7 border-b border-surface-200 bg-surface-50">
		{#each DAYS_HEADER as label}
			<div class="px-2 py-2 text-center text-xs font-medium uppercase text-surface-500">
				{label}
			</div>
		{/each}
	</div>

	<!-- Grid -->
	<div class="grid grid-cols-7">
		{#each Array(rows * 7) as _, i}
			{@const dayNum = i - firstDayOffset() + 1}
			{@const isValidDay = dayNum >= 1 && dayNum <= daysInMonth}
			{@const dayStr = isValidDay ? `${year}-${String(month).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}` : ''}
			<CalendarDay
				day={isValidDay ? dayNum : null}
				isToday={dayStr === todayStr}
				contents={isValidDay ? contentsByDay().get(dayNum) ?? [] : []}
			/>
		{/each}
	</div>
</div>
