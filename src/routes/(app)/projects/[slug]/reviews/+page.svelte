<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { RefreshCw, Send, Save, Star, BarChart3, Trash2 } from 'lucide-svelte';
	import { formatDate } from '$lib/utils/dates.js';
	import { ratingColor } from '$lib/config/design-tokens.js';
	import EmployeeMentionsReport from '$lib/components/EmployeeMentionsReport.svelte';
	import { getSyncState, startReviewsSync } from '$lib/stores/sync.svelte';

	let { data } = $props();

	type Review = typeof data.reviews[number];

	const sync = getSyncState();

	let selectedId = $state<string | null>(null);
	let replyText = $state('');
	let submitting = $state(false);
	let saving = $state(false);
	let replyError = $state('');
	let filterLocation = $state('all');
	let batching = $state(false);
	let batchProgress = $state({ current: 0, total: 0, currentAuthor: '' });
	let batchCancelled = $state(false);
	let batchMessage = $state('');

	// Selection for batch
	let selectedIds = $state<Set<string>>(new Set());

	let filteredReviews = $derived(
		filterLocation === 'all'
			? data.reviews
			: data.reviews.filter((r: Review) => r.locationId === filterLocation)
	);

	let draftsToSend = $derived(
		filteredReviews.filter((r: Review) => r.draftReply?.trim())
	);

	let selected = $derived(
		selectedId ? data.reviews.find((r: Review) => r.id === selectedId) ?? null : null
	);

	let allSelected = $derived(
		filteredReviews.length > 0 && selectedIds.size === filteredReviews.length
	);

	// Auto-select first review
	$effect(() => {
		if (!selectedId && filteredReviews.length > 0) {
			selectedId = filteredReviews[0].id;
			replyText = filteredReviews[0].draftReply ?? '';
		}
	});

	function selectReview(id: string) {
		selectedId = id;
		const review = data.reviews.find((r: Review) => r.id === id);
		replyText = review?.draftReply ?? '';
		replyError = '';
	}

	function toggleAll() {
		if (allSelected) {
			selectedIds = new Set();
		} else {
			selectedIds = new Set(filteredReviews.map((r: Review) => r.id));
		}
	}

	function toggleOne(id: string) {
		const next = new Set(selectedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedIds = next;
	}

	function syncReviews() {
		startReviewsSync(data.project.slug);
	}

	async function cleanRepliedReviews() {
		if (!confirm('Supprimer definitivement tous les avis deja repondus ? Cette action est irreversible. Assurez-vous d\'avoir consulte le rapport du mois avant.')) return;
		const res = await fetch(`/api/projects/${data.project.slug}/reviews/clean`, { method: 'DELETE' });
		const json = await res.json();
		if (res.ok) {
			alert(`${json.deleted} avis supprime(s).`);
			invalidateAll();
		} else {
			alert('Erreur: ' + (json.error || 'Echec'));
		}
	}

	async function saveDraft() {
		if (!selected || !replyText.trim()) return;
		saving = true;
		replyError = '';
		try {
			const res = await fetch(`/api/projects/${data.project.slug}/reviews/drafts`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ drafts: [{ reviewId: selected.reviewId, draftReply: replyText.trim() }] })
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			invalidateAll();
		} catch (err) {
			replyError = (err as Error).message;
		}
		saving = false;
	}

	async function submitReply() {
		if (!selected || !replyText.trim()) return;
		submitting = true;
		replyError = '';
		try {
			const res = await fetch(`/api/projects/${data.project.slug}/reviews/reply`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reviewId: selected.reviewId, locationId: selected.locationId, reply: replyText.trim() })
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);

			const idx = filteredReviews.findIndex((r: Review) => r.id === selectedId);
			const nextReview = filteredReviews[idx + 1] ?? filteredReviews[idx - 1] ?? null;
			selectedId = nextReview?.id ?? null;
			replyText = nextReview?.draftReply ?? '';

			invalidateAll();
		} catch (err) {
			replyError = (err as Error).message;
		}
		submitting = false;
	}

	function sleep(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function batchReply() {
		const reviews = [...draftsToSend];
		if (reviews.length === 0) return;
		batching = true;
		batchCancelled = false;
		batchMessage = '';
		let sent = 0;
		let errors = 0;

		for (let i = 0; i < reviews.length; i++) {
			if (batchCancelled) break;
			const review = reviews[i];
			batchProgress = { current: i + 1, total: reviews.length, currentAuthor: review.authorName };
			try {
				const res = await fetch(`/api/projects/${data.project.slug}/reviews/reply`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ reviewId: review.reviewId, locationId: review.locationId, reply: review.draftReply!.trim() })
				});
				const json = await res.json();
				if (!res.ok) throw new Error(json.error);
				sent++;
			} catch {
				errors++;
			}
			if (i < reviews.length - 1 && !batchCancelled) {
				await sleep(1500);
			}
		}

		batching = false;
		selectedId = null;
		replyText = '';
		invalidateAll();

		const parts = [];
		if (sent > 0) parts.push(`${sent} reponse${sent > 1 ? 's' : ''} envoyee${sent > 1 ? 's' : ''}`);
		if (errors > 0) parts.push(`${errors} erreur${errors > 1 ? 's' : ''}`);
		if (batchCancelled) parts.push('interrompu');
		batchMessage = parts.join(', ');
		setTimeout(() => { batchMessage = ''; }, 5000);
	}

	function renderStars(rating: number): string {
		return '\u2605'.repeat(rating) + '\u2606'.repeat(5 - rating);
	}
</script>

<div class="flex flex-col h-[calc(100vh-73px)] -mx-6 -my-6 lg:-mx-8">
	<!-- Header -->
	<div class="flex-shrink-0 px-6 pt-6 pb-4 lg:px-8">
		<div class="flex items-center justify-between">
			<div>
				<h1 class="text-xl font-semibold text-surface-900">Avis Google</h1>
				<p class="mt-0.5 text-xs text-surface-400">
					{filteredReviews.length} avis en attente de reponse
				</p>
			</div>
			<div class="flex items-center gap-2">
				{#if batchMessage}
					<span class="text-xs text-surface-500">{batchMessage}</span>
				{/if}
				{#if data.locations.length > 1}
					<select
						bind:value={filterLocation}
						class="rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-xs text-surface-600 outline-none"
					>
						<option value="all">Tous les etablissements</option>
						{#each data.locations as loc}
							<option value={loc.gmbLocationId}>{loc.label}</option>
						{/each}
					</select>
				{/if}
				{#if batching}
					<span class="text-xs text-surface-600">
						Reponse {batchProgress.current}/{batchProgress.total} — {batchProgress.currentAuthor}
					</span>
					<button
						onclick={() => { batchCancelled = true; }}
						class="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
					>
						Annuler
					</button>
				{:else}
					{#if draftsToSend.length > 0}
						<button
							onclick={batchReply}
							class="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-600"
						>
							Repondre a tous ({draftsToSend.length})
						</button>
					{/if}
					<button
						onclick={syncReviews}
						class="inline-flex items-center gap-1.5 rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50"
						disabled={sync.syncing}
					>
						<RefreshCw size={12} class={sync.syncing ? 'animate-spin' : ''} />
						{sync.syncing ? 'Sync...' : 'Mettre a jour'}
					</button>
					<a
						href="/report/{data.project.slug}/{new Date().getFullYear()}-{String(new Date().getMonth() + 1).padStart(2, '0')}?token={data.project.accessToken}"
						target="_blank"
						class="inline-flex items-center gap-1.5 rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50"
					>
						<BarChart3 size={12} />
						Rapport du mois
					</a>
					<button
						onclick={cleanRepliedReviews}
						class="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
					>
						<Trash2 size={12} />
						Nettoyer
					</button>
				{/if}
			</div>
		</div>
		<div class="mt-4">
			<EmployeeMentionsReport projectSlug={data.project.slug} />
		</div>
	</div>

	{#if filteredReviews.length === 0}
		<div class="flex flex-1 items-center justify-center">
			<div class="text-center">
				<p class="text-sm text-surface-400">Aucun avis en attente de reponse</p>
				<button
					onclick={syncReviews}
					class="mt-3 rounded-md bg-primary-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-600"
					disabled={sync.syncing}
				>
					{sync.syncing ? 'Synchronisation...' : 'Synchroniser les avis'}
				</button>
			</div>
		</div>
	{:else}
		<!-- Split: table + preview -->
		<div class="flex flex-1 min-h-0">
			<!-- Left: review table -->
			<div class="flex-1 overflow-y-auto px-6 pb-6 lg:px-8">
				<div class="overflow-hidden rounded-lg border border-surface-200 bg-white">
					<table class="w-full text-sm">
						<thead>
							<tr class="border-b border-surface-100 bg-surface-50 text-left text-xs font-medium uppercase tracking-wider text-surface-400">
								<th class="w-10 px-4 py-2.5">
									<input type="checkbox" checked={allSelected} onchange={toggleAll} class="rounded" />
								</th>
								<th class="w-40 px-4 py-2.5">Auteur</th>
								<th class="w-20 px-4 py-2.5">Note</th>
								<th class="w-36 px-4 py-2.5">Location</th>
								<th class="w-24 px-4 py-2.5">Statut</th>
								<th class="w-28 px-4 py-2.5">Date</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-surface-100">
							{#each filteredReviews as review}
								<tr
									class="cursor-pointer transition-colors
										{selectedId === review.id ? 'bg-primary-50' : 'hover:bg-surface-50'}"
									onclick={() => selectReview(review.id)}
								>
									<td class="px-4 py-2.5" onclick={(e) => e.stopPropagation()}>
										<input
											type="checkbox"
											checked={selectedIds.has(review.id)}
											onchange={() => toggleOne(review.id)}
											class="rounded"
										/>
									</td>
									<td class="max-w-[9rem] px-4 py-2.5">
										<span class="block truncate font-medium text-surface-900">{review.authorName}</span>
									</td>
									<td class="px-4 py-2.5">
										<span class="{ratingColor(review.rating)} text-xs">{renderStars(review.rating)}</span>
									</td>
									<td class="px-4 py-2.5">
										<span class="truncate text-xs text-surface-500">{review.locationLabel}</span>
									</td>
									<td class="px-4 py-2.5">
										{#if review.draftReply}
											<span class="rounded-md bg-primary-50 px-1.5 py-0.5 text-[10px] font-medium text-primary-700">Brouillon</span>
										{:else}
											<span class="rounded-md bg-surface-100 px-1.5 py-0.5 text-[10px] font-medium text-surface-500">En attente</span>
										{/if}
									</td>
									<td class="px-4 py-2.5 text-xs text-surface-400 whitespace-nowrap">
										{formatDate(review.createTime)}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>

			<!-- Right: review detail + reply -->
			{#if selected}
				<div class="w-[45%] flex-shrink-0 flex flex-col rounded-lg border border-surface-200 bg-white overflow-hidden mr-6 mb-6 lg:mr-8">
					<!-- Preview header -->
					<div class="flex-shrink-0 flex items-center justify-between border-b border-surface-100 px-5 py-3">
						<div class="flex items-center gap-2">
							<Star size={14} class="text-surface-400" />
							<span class="text-xs text-surface-400">Avis Google</span>
							<span class="{ratingColor(selected.rating)} text-sm">{renderStars(selected.rating)}</span>
						</div>
					</div>

					<!-- Review content -->
					<div class="flex-1 overflow-y-auto px-5 py-4">
						<h2 class="text-lg font-semibold text-surface-900">{selected.authorName}</h2>
						<div class="mt-1 flex items-center gap-3 text-xs text-surface-400">
							<span>{formatDate(selected.createTime)}</span>
							<span class="rounded bg-surface-100 px-1.5 py-0.5 text-surface-600">{selected.locationLabel}</span>
						</div>

						<!-- Review text -->
						<div class="mt-4 rounded-md bg-surface-50 px-4 py-3">
							{#if selected.comment}
								<p class="text-sm leading-relaxed text-surface-700 whitespace-pre-wrap">{selected.comment}</p>
							{:else}
								<p class="text-sm italic text-surface-400">(Pas de commentaire — note uniquement)</p>
							{/if}
						</div>

						<!-- Reply form -->
						<div class="mt-4">
							<label for="reply-textarea" class="text-xs font-medium text-surface-600">Votre reponse</label>
							<textarea
								id="reply-textarea"
								bind:value={replyText}
								placeholder="Ecrivez votre reponse..."
								class="mt-1.5 w-full rounded-md border border-surface-200 bg-white px-3 py-2 text-sm text-surface-900 outline-none transition-colors focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
								rows="4"
							></textarea>
							{#if replyError}
								<p class="mt-2 text-xs text-red-500">{replyError}</p>
							{/if}
							<div class="mt-3 flex justify-end gap-2">
								<button
									onclick={saveDraft}
									class="inline-flex items-center gap-1.5 rounded-md border border-surface-200 bg-white px-3 py-1.5 text-xs font-medium text-surface-600 transition-colors hover:bg-surface-50"
									disabled={saving || !replyText.trim()}
								>
									<Save size={12} />
									{saving ? 'Sauvegarde...' : 'Sauvegarder'}
								</button>
								<button
									onclick={submitReply}
									class="inline-flex items-center gap-1.5 rounded-md bg-primary-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-600"
									disabled={submitting || !replyText.trim()}
								>
									<Send size={12} />
									{submitting ? 'Envoi...' : 'Repondre'}
								</button>
							</div>
						</div>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
