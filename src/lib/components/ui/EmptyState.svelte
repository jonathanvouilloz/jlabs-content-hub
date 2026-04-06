<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		message: string;
		actions?: Snippet;
	}

	let { message, actions }: Props = $props();
</script>

<div class="flex flex-col items-center justify-center py-16 text-center">
	<p class="text-sm text-surface-400">{message}</p>
	{#if actions}
		<div class="mt-4">
			{@render actions()}
		</div>
	{/if}
</div>
