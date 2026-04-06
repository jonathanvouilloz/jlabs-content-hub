<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { formatDate } from '$lib/utils/dates.js';

	let { data } = $props();

	type Review = typeof data.reviews[number];

	let selectedId = $state<string | null>(null);
	let syncing = $state(false);
	let replyText = $state('');
	let submitting = $state(false);
	let replyError = $state('');
	let syncMessage = $state('');

	let selected = $derived(
		selectedId ? data.reviews.find((r: Review) => r.id === selectedId) ?? null : null
	);

	// Auto-select first review
	$effect(() => {
		if (!selectedId && data.reviews.length > 0) {
			selectedId = data.reviews[0].id;
			replyText = data.reviews[0].draftReply ?? '';
		}
	});

	function selectReview(id: string) {
		selectedId = id;
		const review = data.reviews.find((r: Review) => r.id === id);
		replyText = review?.draftReply ?? '';
		replyError = '';
	}

	async function syncReviews() {
		syncing = true;
		syncMessage = '';
		try {
			const res = await fetch(`/api/projects/${data.project.slug}/reviews/sync`, { method: 'POST' });
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			syncMessage = json.synced > 0
				? `${json.synced} nouvel avis synchronise${json.synced > 1 ? 's' : ''}`
				: 'Aucun nouvel avis';
			invalidateAll();
		} catch (err) {
			syncMessage = (err as Error).message;
		}
		syncing = false;
		setTimeout(() => { syncMessage = ''; }, 4000);
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

			// Select next review
			const idx = data.reviews.findIndex((r: Review) => r.id === selectedId);
			const nextReview = data.reviews[idx + 1] ?? data.reviews[idx - 1] ?? null;
			selectedId = nextReview?.id ?? null;
			replyText = '';

			invalidateAll();
		} catch (err) {
			replyError = (err as Error).message;
		}
		submitting = false;
	}

	function renderStars(rating: number): string {
		return '\u2605'.repeat(rating) + '\u2606'.repeat(5 - rating);
	}

	function ratingColor(rating: number): string {
		if (rating >= 4) return 'text-green-500';
		if (rating === 3) return 'text-amber-500';
		return 'text-red-500';
	}
</script>

<div class="flex h-full flex-col">
	<!-- Header -->
	<div class="flex items-center justify-between pb-4">
		<div>
			<h1 class="text-2xl font-bold text-surface-900">Avis Google</h1>
			<p class="mt-0.5 text-xs text-surface-400">
				{data.reviews.length} avis en attente de reponse
			</p>
		</div>
		<div class="flex items-center gap-3">
			{#if syncMessage}
				<span class="text-xs text-surface-500">{syncMessage}</span>
			{/if}
			<button
				onclick={syncReviews}
				class="btn preset-outlined-surface-200 text-xs"
				disabled={syncing}
			>
				{syncing ? 'Synchronisation...' : 'Mettre a jour'}
			</button>
		</div>
	</div>

	{#if data.reviews.length === 0}
		<div class="flex flex-1 items-center justify-center">
			<div class="text-center">
				<p class="text-sm text-surface-400">Aucun avis en attente de reponse</p>
				<button
					onclick={syncReviews}
					class="mt-3 btn preset-filled-primary-500 text-xs"
					disabled={syncing}
				>
					{syncing ? 'Synchronisation...' : 'Synchroniser les avis'}
				</button>
			</div>
		</div>
	{:else}
		<!-- 2-column layout -->
		<div class="flex flex-1 gap-4 min-h-0">
			<!-- Left: review list -->
			<div class="w-[40%] flex-shrink-0 overflow-y-auto rounded-lg border border-surface-200 bg-white">
				{#each data.reviews as review}
					<button
						onclick={() => selectReview(review.id)}
						class="flex w-full items-center gap-3 border-b border-surface-100 px-4 py-3 text-left transition-colors
							{selectedId === review.id
								? 'bg-primary-50 border-l-2 border-l-primary-500'
								: 'hover:bg-surface-50 border-l-2 border-l-transparent'}"
					>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="text-xs text-surface-400 whitespace-nowrap">{formatDate(review.createTime)}</span>
								<span class="{ratingColor(review.rating)} text-xs">{renderStars(review.rating)}</span>
							</div>
							<p class="mt-0.5 text-sm font-medium text-surface-800 truncate">{review.authorName}</p>
							<div class="flex items-center gap-2 mt-0.5">
								<span class="inline-block max-w-[140px] truncate rounded-full bg-surface-100 px-2 py-0.5 text-[10px] text-surface-500">
									{review.locationLabel}
								</span>
								{#if review.draftReply}
									<span class="rounded-full bg-primary-100 px-2 py-0.5 text-[10px] font-medium text-primary-700">Brouillon</span>
								{/if}
							</div>
						</div>
					</button>
				{/each}
			</div>

			<!-- Right: detail + reply -->
			<div class="flex-1 overflow-y-auto rounded-lg border border-surface-200 bg-white p-6">
				{#if selected}
					<!-- Review meta -->
					<div class="flex items-start justify-between">
						<div>
							<h2 class="text-lg font-semibold text-surface-900">{selected.authorName}</h2>
							<div class="mt-1 flex items-center gap-3 text-xs text-surface-400">
								<span>{formatDate(selected.createTime)}</span>
								<span class="rounded-full bg-surface-100 px-2 py-0.5 text-surface-600">{selected.locationLabel}</span>
							</div>
						</div>
						<span class="{ratingColor(selected.rating)} text-lg">{renderStars(selected.rating)}</span>
					</div>

					<!-- Review text -->
					<div class="mt-6 rounded-lg bg-surface-50 px-5 py-4">
						{#if selected.comment}
							<p class="text-sm leading-relaxed text-surface-700 whitespace-pre-wrap">{selected.comment}</p>
						{:else}
							<p class="text-sm italic text-surface-400">(Pas de commentaire — note uniquement)</p>
						{/if}
					</div>

					<!-- Reply form -->
					<div class="mt-6">
						<label for="reply-textarea" class="text-xs font-medium text-surface-600">Votre reponse</label>
						<textarea
							id="reply-textarea"
							bind:value={replyText}
							placeholder="Ecrivez votre reponse..."
							class="input preset-outlined-surface-200 mt-2 w-full text-sm"
							rows="4"
						></textarea>
						{#if replyError}
							<p class="mt-2 text-xs text-red-500">{replyError}</p>
						{/if}
						<div class="mt-3 flex justify-end">
							<button
								onclick={submitReply}
								class="btn preset-filled-primary-500 text-sm"
								disabled={submitting || !replyText.trim()}
							>
								{submitting ? 'Envoi...' : 'Repondre'}
							</button>
						</div>
					</div>
				{:else}
					<div class="flex h-full items-center justify-center">
						<p class="text-sm text-surface-400">Selectionnez un avis</p>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
