<script lang="ts">
	import { getSyncState, clearSyncResult } from '$lib/stores/sync.svelte';
	import { CheckCircle, AlertCircle, Loader, X } from 'lucide-svelte';

	const sync = getSyncState();

	let hideTimer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		if (sync.result) {
			clearTimeout(hideTimer);
			hideTimer = setTimeout(clearSyncResult, 5000);
		}
	});
</script>

{#if sync.syncing}
	<div class="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border border-surface-200 bg-white px-4 py-3 shadow-lg">
		<Loader size={16} class="animate-spin text-primary-500" />
		<span class="text-sm text-surface-700">Synchronisation des avis en cours...</span>
	</div>
{:else if sync.result}
	<div class="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border px-4 py-3 shadow-lg {sync.result.type === 'success' ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}">
		{#if sync.result.type === 'success'}
			<CheckCircle size={16} class="text-green-600" />
		{:else}
			<AlertCircle size={16} class="text-red-600" />
		{/if}
		<span class="text-sm {sync.result.type === 'success' ? 'text-green-800' : 'text-red-800'}">{sync.result.message}</span>
		<button onclick={clearSyncResult} class="ml-2 text-surface-400 hover:text-surface-600">
			<X size={14} />
		</button>
	</div>
{/if}
