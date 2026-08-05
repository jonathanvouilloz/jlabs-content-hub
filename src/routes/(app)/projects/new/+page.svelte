<script lang="ts">
	import { slugify } from '$lib/utils/slugify.js';
	import type { ActionData } from './$types.js';

	let { form }: { form: ActionData | null } = $props();

	const COLORS = ['#00D9A3', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];

	let name = $state('');
	let description = $state('');
	let image = $state('');
	let color = $state(COLORS[0]);

	function handleImageUpload(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			image = reader.result as string;
		};
		reader.readAsDataURL(file);
	}

	let slug = $derived(slugify(name));
</script>

<div class="mx-auto max-w-lg">
	<h1 class="text-2xl font-bold text-surface-900">Nouveau projet</h1>

	<form method="POST" class="mt-6 space-y-5">
		<input type="hidden" name="slug" value={slug} />
		<input type="hidden" name="image" value={image} />
		<input type="hidden" name="color" value={color} />
		<label class="block">
			<span class="text-sm font-medium text-surface-700">Nom du projet</span>
			<input
				name="name"
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
				name="description"
				bind:value={description}
				class="input preset-outlined-surface-200 mt-1 w-full"
				rows="3"
				placeholder="Description courte du projet..."
			></textarea>
		</label>

		<div>
			<span class="text-sm font-medium text-surface-700">Image (optionnel)</span>
			<div class="mt-2">
				{#if image}
					<div class="relative mb-2 inline-block">
						<img src={image} alt="Apercu" class="h-32 w-full rounded-lg object-cover" />
						<button
							type="button"
							onclick={() => { image = ''; }}
							class="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-xs text-white hover:bg-black/70"
							title="Supprimer l'image"
						>&times;</button>
					</div>
				{/if}
				<input
					type="file"
					accept="image/*"
					onchange={handleImageUpload}
					class="block w-full text-sm text-surface-500 file:mr-3 file:rounded-md file:border-0 file:bg-surface-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-surface-700 hover:file:bg-surface-200"
				/>
			</div>
		</div>

		<div>
			<span class="text-sm font-medium text-surface-700">Couleur</span>
			<div class="mt-2 flex items-center gap-2">
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
				<label class="relative h-8 w-8 cursor-pointer" title="Couleur personnalisee">
					<input
						type="color"
						bind:value={color}
						class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
					/>
					<span
						class="flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs transition-transform hover:scale-110
							{!COLORS.includes(color) ? 'border-surface-900 scale-110' : 'border-surface-300'}"
						style="background-color: {color};"
					>
						{#if COLORS.includes(color)}
							<svg class="h-4 w-4 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446A9 9 0 1 1 12 3Z"/></svg>
						{/if}
					</span>
				</label>
			</div>
		</div>

		{#if form?.error}
			<p class="text-sm text-red-600">{form.error}</p>
		{/if}

		<div class="flex gap-3">
			<button type="submit" disabled={!name.trim()} class="btn preset-filled-primary-500">
				Créer le projet
			</button>
			<a href="/projects" class="btn preset-outlined-surface-200">Annuler</a>
		</div>
	</form>
</div>
