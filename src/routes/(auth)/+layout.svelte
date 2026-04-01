<script lang="ts">
	let { children } = $props();
</script>

<div class="flex min-h-screen items-center justify-center bg-surface-50">
	{@render children()}
</div>
