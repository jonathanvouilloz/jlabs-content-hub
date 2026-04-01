<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<div class="min-h-screen bg-surface-50">
	<header class="border-b border-surface-200 bg-white">
		<div class="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
			<span class="text-lg font-bold text-surface-900">Content Hub</span>
			<span class="text-xs text-surface-400">Jon Labs</span>
		</div>
	</header>

	<main class="mx-auto max-w-4xl px-4 py-8">
		{@render children()}
	</main>

	<footer class="border-t border-surface-200 py-6 text-center text-xs text-surface-400">
		Powered by Jon Labs
	</footer>
</div>
