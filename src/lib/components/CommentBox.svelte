<script lang="ts">
	import { formatDate } from '$lib/utils/dates.js';

	interface Comment {
		id: string;
		authorName: string;
		authorEmail: string;
		body: string;
		createdAt: string;
	}

	interface Props {
		contentId: string;
		token: string;
		comments: Comment[];
	}

	let { contentId, token, comments }: Props = $props();

	let authorName = $state('');
	let authorEmail = $state('');
	let body = $state('');
	let submitting = $state(false);
	let error = $state('');
	let localComments = $state<Comment[]>(comments);

	// Sync prop changes
	$effect(() => {
		localComments = comments;
	});

	// Load from localStorage on mount
	$effect(() => {
		try {
			const savedName = localStorage.getItem('clientName');
			const savedEmail = localStorage.getItem('clientEmail');
			if (savedName) authorName = savedName;
			if (savedEmail) authorEmail = savedEmail;
		} catch {
			// localStorage unavailable
		}
	});

	const canSubmit = $derived(
		body.trim() !== '' && authorName.trim() !== '' && authorEmail.trim() !== '' && !submitting
	);

	async function submit() {
		if (!canSubmit) return;
		submitting = true;
		error = '';

		const optimistic: Comment = {
			id: 'temp-' + Date.now(),
			authorName: authorName.trim(),
			authorEmail: authorEmail.trim(),
			body: body.trim(),
			createdAt: new Date().toISOString()
		};

		localComments = [optimistic, ...localComments];
		const bodyText = body.trim();
		body = '';

		try {
			const res = await fetch(`/api/comments?token=${token}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					content_id: contentId,
					author_name: authorName.trim(),
					author_email: authorEmail.trim(),
					body: bodyText
				})
			});

			if (res.ok) {
				const result = await res.json();
				localComments = localComments.map((c) =>
					c.id === optimistic.id ? { ...c, id: result.data.id } : c
				);
				try {
					localStorage.setItem('clientName', authorName.trim());
					localStorage.setItem('clientEmail', authorEmail.trim());
				} catch {
					// localStorage unavailable
				}
			} else {
				localComments = localComments.filter((c) => c.id !== optimistic.id);
				body = bodyText;
				error = 'Erreur lors de l\'envoi. Veuillez reessayer.';
			}
		} catch {
			localComments = localComments.filter((c) => c.id !== optimistic.id);
			body = bodyText;
			error = 'Erreur de connexion. Veuillez reessayer.';
		}

		submitting = false;
	}
</script>

<div class="mt-10">
	<h2 class="text-lg font-semibold text-surface-900">
		Commentaires
		{#if localComments.length > 0}
			<span class="ml-1 text-sm font-normal text-surface-400">({localComments.length})</span>
		{/if}
	</h2>

	<!-- Comment form -->
	<div class="mt-4 rounded-lg border border-surface-200 bg-white p-4">
		<div class="grid gap-3 sm:grid-cols-2">
			<input
				type="text"
				bind:value={authorName}
				placeholder="Votre nom"
				class="input preset-outlined-surface-200 text-sm"
			/>
			<input
				type="email"
				bind:value={authorEmail}
				placeholder="Votre email"
				class="input preset-outlined-surface-200 text-sm"
			/>
		</div>
		<textarea
			bind:value={body}
			placeholder="Votre commentaire..."
			rows="3"
			class="input preset-outlined-surface-200 mt-3 w-full text-sm"
		></textarea>
		{#if error}
			<p class="mt-2 text-xs text-red-600">{error}</p>
		{/if}
		<div class="mt-3 flex justify-end">
			<button
				onclick={submit}
				disabled={!canSubmit}
				class="btn preset-filled-primary-500 text-sm disabled:opacity-50"
			>
				{submitting ? 'Envoi...' : 'Envoyer'}
			</button>
		</div>
	</div>

	<!-- Comment list -->
	{#if localComments.length > 0}
		<div class="mt-4 space-y-3">
			{#each localComments as comment}
				<div class="rounded-lg border border-surface-200 bg-white p-4">
					<div class="flex items-center justify-between">
						<span class="text-sm font-medium text-surface-900">{comment.authorName}</span>
						<span class="text-xs text-surface-400">{formatDate(comment.createdAt)}</span>
					</div>
					<p class="mt-1.5 text-sm text-surface-600 whitespace-pre-line">{comment.body}</p>
				</div>
			{/each}
		</div>
	{:else}
		<p class="mt-4 text-sm text-surface-400">Aucun commentaire pour le moment.</p>
	{/if}
</div>
