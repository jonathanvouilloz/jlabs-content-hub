<script lang="ts">
	interface Props {
		name: string;
		color?: string;
	}

	let { name, color = '#00D9A3' }: Props = $props();
</script>

<span
	class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
	style="background-color: {color}15; color: {color};"
>
	<span class="h-2 w-2 rounded-full" style="background-color: {color};"></span>
	{name}
</span>
