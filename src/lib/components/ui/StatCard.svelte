<script lang="ts">
	interface Props {
		label: string;
		value: number | string;
		color?: string;
	}

	let { label, value, color = 'text-surface-900' }: Props = $props();
</script>

<div class="flex flex-col gap-0.5">
	<span class="text-xs font-medium uppercase tracking-wide text-surface-400">{label}</span>
	<span class="text-2xl font-semibold {color}">{value}</span>
</div>
