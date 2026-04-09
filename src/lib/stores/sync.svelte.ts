import { invalidateAll } from '$app/navigation';

let syncing = $state(false);
let result = $state<{ message: string; type: 'success' | 'error' } | null>(null);

export function getSyncState() {
	return {
		get syncing() { return syncing; },
		get result() { return result; }
	};
}

export function clearSyncResult() {
	result = null;
}

export async function startReviewsSync(slug: string) {
	if (syncing) return;
	syncing = true;
	result = null;
	try {
		const res = await fetch(`/api/projects/${slug}/reviews/sync`, { method: 'POST' });
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || 'Sync failed');
		const n = data.synced;
		result = {
			message: n > 0 ? `${n} nouvel avis synchronise(s)` : 'Aucun nouvel avis',
			type: 'success'
		};
		invalidateAll();
	} catch (e) {
		result = {
			message: e instanceof Error ? e.message : 'Erreur lors de la synchronisation',
			type: 'error'
		};
	} finally {
		syncing = false;
	}
}
