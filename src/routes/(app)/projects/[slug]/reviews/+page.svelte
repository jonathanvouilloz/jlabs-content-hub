<script lang="ts">
	import { onMount } from 'svelte';
	import { formatDate } from '$lib/utils/dates.js';

	let { data } = $props();

	interface Review {
		reviewId: string;
		locationId: string;
		locationLabel: string;
		authorName: string;
		rating: number;
		comment: string;
		createTime: string;
		reply: string | null;
		replyTime: string | null;
	}

	let reviews = $state<Review[]>([]);
	let loading = $state(true);
	let error = $state('');

	// Reply state
	let replyingTo = $state<string | null>(null);
	let replyText = $state('');
	let submitting = $state(false);
	let replyError = $state('');

	onMount(async () => {
		await loadReviews();
	});

	async function loadReviews() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`/api/projects/${data.project.slug}/reviews`);
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			reviews = json.reviews;
		} catch (err) {
			error = (err as Error).message;
		}
		loading = false;
	}

	function startReply(reviewId: string) {
		replyingTo = reviewId;
		replyText = '';
		replyError = '';
	}

	function cancelReply() {
		replyingTo = null;
		replyText = '';
		replyError = '';
	}

	async function submitReply(review: Review) {
		if (!replyText.trim()) return;
		submitting = true;
		replyError = '';
		try {
			const res = await fetch(`/api/projects/${data.project.slug}/reviews/${review.reviewId}/reply`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ locationId: review.locationId, reply: replyText.trim() })
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			// Remove from list (it's now replied)
			reviews = reviews.filter((r) => r.reviewId !== review.reviewId);
			replyingTo = null;
			replyText = '';
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

<div>
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-surface-900">Avis Google</h1>
			<p class="mt-1 text-sm text-surface-400">
				Avis non repondus des 30 derniers jours
			</p>
		</div>
		<button
			onclick={loadReviews}
			class="btn preset-outlined-surface-200 text-xs"
			disabled={loading}
		>
			{loading ? 'Chargement...' : 'Rafraichir'}
		</button>
	</div>

	{#if loading}
		<div class="mt-8 flex items-center justify-center">
			<span class="text-sm text-surface-400">Chargement des avis...</span>
		</div>
	{:else if error}
		<div class="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
	{:else if reviews.length === 0}
		<div class="mt-8 text-center">
			<p class="text-sm text-surface-400">Aucun avis en attente de reponse</p>
		</div>
	{:else}
		<div class="mt-6">
			<!-- Count -->
			<p class="mb-3 text-xs text-surface-500">
				{reviews.length} avis en attente de reponse
			</p>

			<!-- Table -->
			<div class="overflow-hidden rounded-lg border border-surface-200 bg-white">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-surface-100 bg-surface-50 text-left text-xs font-medium uppercase text-surface-500">
							<th class="px-4 py-3 w-28">Date</th>
							<th class="px-4 py-3 w-36">Location</th>
							<th class="px-4 py-3 w-16 text-center">Note</th>
							<th class="px-4 py-3 w-32">Auteur</th>
							<th class="px-4 py-3">Avis</th>
							<th class="px-4 py-3 w-28 text-right">Action</th>
						</tr>
					</thead>
					<tbody>
						{#each reviews as review}
							<tr class="border-b border-surface-100 hover:bg-surface-50 {replyingTo === review.reviewId ? 'bg-primary-50/30' : ''}">
								<td class="px-4 py-3 text-xs text-surface-500 whitespace-nowrap">
									{formatDate(review.createTime)}
								</td>
								<td class="px-4 py-3">
									<span class="inline-block max-w-[130px] truncate rounded-full bg-surface-100 px-2 py-0.5 text-xs text-surface-600">
										{review.locationLabel}
									</span>
								</td>
								<td class="px-4 py-3 text-center">
									<span class="{ratingColor(review.rating)} text-sm" title="{review.rating}/5">
										{renderStars(review.rating)}
									</span>
								</td>
								<td class="px-4 py-3 text-xs font-medium text-surface-700 truncate max-w-[120px]">
									{review.authorName}
								</td>
								<td class="px-4 py-3 text-sm text-surface-700">
									<p class="line-clamp-2">{review.comment || '(pas de commentaire)'}</p>
								</td>
								<td class="px-4 py-3 text-right">
									{#if replyingTo === review.reviewId}
										<button
											onclick={cancelReply}
											class="text-xs text-surface-400 hover:text-surface-600"
										>
											Annuler
										</button>
									{:else}
										<button
											onclick={() => startReply(review.reviewId)}
											class="btn preset-filled-primary-500 text-xs"
										>
											Repondre
										</button>
									{/if}
								</td>
							</tr>

							<!-- Reply form (inline row) -->
							{#if replyingTo === review.reviewId}
								<tr class="bg-primary-50/20">
									<td colspan="6" class="px-4 py-3">
										<div class="flex gap-3">
											<textarea
												bind:value={replyText}
												placeholder="Votre reponse..."
												class="input preset-outlined-surface-200 flex-1 text-sm"
												rows="3"
											></textarea>
											<div class="flex flex-col gap-2">
												<button
													onclick={() => submitReply(review)}
													class="btn preset-filled-primary-500 text-xs"
													disabled={submitting || !replyText.trim()}
												>
													{submitting ? 'Envoi...' : 'Envoyer'}
												</button>
											</div>
										</div>
										{#if replyError}
											<p class="mt-2 text-xs text-red-500">{replyError}</p>
										{/if}
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>
