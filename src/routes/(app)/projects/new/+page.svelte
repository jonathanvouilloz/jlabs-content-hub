<script lang="ts">
	import { goto } from '$app/navigation';
	import { slugify } from '$lib/utils/slugify.js';

	const COLORS = ['#00D9A3', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];

	let name = $state('');
	let description = $state('');
	let color = $state(COLORS[0]);
	let error = $state('');
	let loading = $state(false);

	let slug = $derived(slugify(name));

	async function handleSubmit(e: Event) {
		e.preventDefault();
		if (!name.trim()) return;

		error = '';
		loading = true;

		const res = await fetch('/api/projects', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${import.meta.env.VITE_API_KEY ?? 'dev-api-key'}`
			},
			body: JSON.stringify({ name, slug, description: description || undefined, color })
		});

		const data = await res.json();

		if (!data.ok) {
			error = data.error ?? 'Erreur lors de la creation';
			loading = false;
			return;
		}

		goto(`/projects/${data.data.slug}`);
	}
</script>

<div class="mx-auto max-w-lg">
	<h1 class="text-2xl font-bold text-surface-900">Nouveau projet</h1>

	<form onsubmit={handleSubmit} class="mt-6 space-y-5">
		<label class="block">
			<span class="text-sm font-medium text-surface-700">Nom du projet</span>
			<input
				type="text"
				bind:value={name}
				required
				class="input preset-outlined-surface-200 mt-1 w-full"
				placeholder="Barber Concept"
			/>
			{#if slug}
				<p class="mt-1 text-xs text-surface-400">Slug : {slug}</p>
			{/if}
		</label>

		<label class="block">
			<span class="text-sm font-medium text-surface-700">Description (optionnel)</span>
			<textarea
				bind:value={description}
				class="input preset-outlined-surface-200 mt-1 w-full"
				rows="3"
				placeholder="Description courte du projet..."
			></textarea>
		</label>

		<div>
			<span class="text-sm font-medium text-surface-700">Couleur</span>
			<div class="mt-2 flex gap-2">
				{#each COLORS as c}
					<button
						type="button"
						title="Couleur {c}"
						onclick={() => (color = c)}
						class="h-8 w-8 rounded-full border-2 transition-transform hover:scale-110
							{color === c ? 'border-surface-900 scale-110' : 'border-transparent'}"
						style="background-color: {c};"
					></button>
				{/each}
			</div>
		</div>

		{#if error}
			<p class="text-sm text-red-600">{error}</p>
		{/if}

		<div class="flex gap-3">
			<button type="submit" disabled={loading || !name.trim()} class="btn preset-filled-primary-500">
				{loading ? 'Creation...' : 'Creer le projet'}
			</button>
			<a href="/projects" class="btn preset-outlined-surface-200">Annuler</a>
		</div>
	</form>
</div>
