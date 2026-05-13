<script lang="ts">
	import { page } from '$app/stores';
	import { invalidateAll } from '$app/navigation';
	import { Save, Phone, Globe, Plus, X, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-svelte';

	type LayoutData = {
		profile: {
			title?: string | null;
			phone?: string | null;
			websiteUri?: string | null;
			additionalPhones?: string | null;
			openStatus?: string | null;
		} | null;
		locationIdParam: string;
	};

	let layout = $derived($page.data as LayoutData);

	function parseAdditional(json: string | null | undefined): string[] {
		if (!json) return [];
		try {
			const v = JSON.parse(json);
			return Array.isArray(v) ? v : [];
		} catch {
			return [];
		}
	}

	let title = $state('');
	let phone = $state('');
	let websiteUri = $state('');
	let additionalPhones = $state<string[]>([]);
	let openStatus = $state<'OPEN' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY'>('OPEN');
	let newPhone = $state('');

	let initialized = $state(false);
	$effect(() => {
		if (!initialized && layout.profile) {
			title = layout.profile.title ?? '';
			phone = layout.profile.phone ?? '';
			websiteUri = layout.profile.websiteUri ?? '';
			additionalPhones = parseAdditional(layout.profile.additionalPhones);
			const st = layout.profile.openStatus;
			if (st === 'OPEN' || st === 'CLOSED_TEMPORARILY' || st === 'CLOSED_PERMANENTLY') openStatus = st;
			initialized = true;
		}
	});

	let saving = $state(false);
	let savedAt = $state<Date | null>(null);
	let error = $state<string | null>(null);

	let dirty = $derived.by(() => {
		if (!layout.profile) return false;
		const initialAdditional = parseAdditional(layout.profile.additionalPhones);
		if (
			(layout.profile.title ?? '') !== title ||
			(layout.profile.phone ?? '') !== phone ||
			(layout.profile.websiteUri ?? '') !== websiteUri ||
			(layout.profile.openStatus ?? 'OPEN') !== openStatus
		)
			return true;
		if (initialAdditional.length !== additionalPhones.length) return true;
		return initialAdditional.some((p, i) => p !== additionalPhones[i]);
	});

	function addPhone() {
		const v = newPhone.trim();
		if (!v) return;
		additionalPhones = [...additionalPhones, v];
		newPhone = '';
	}

	function removePhone(idx: number) {
		additionalPhones = additionalPhones.filter((_, i) => i !== idx);
	}

	async function save() {
		if (!dirty || saving) return;
		saving = true;
		error = null;
		try {
			const initialAdditional = parseAdditional(layout.profile?.additionalPhones);
			const body: Record<string, unknown> = {};
			if (title !== (layout.profile?.title ?? '')) body.title = title;
			if (phone !== (layout.profile?.phone ?? '')) body.phone = phone || null;
			if (websiteUri !== (layout.profile?.websiteUri ?? '')) body.websiteUri = websiteUri || null;
			if (openStatus !== (layout.profile?.openStatus ?? 'OPEN')) body.openStatus = openStatus;
			const additionalDirty =
				initialAdditional.length !== additionalPhones.length ||
				initialAdditional.some((p, i) => p !== additionalPhones[i]);
			if (additionalDirty) body.additionalPhones = additionalPhones;

			const res = await fetch(
				`/api/projects/${$page.params.slug}/gmb-profile/${layout.locationIdParam}/basic`,
				{
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				}
			);
			if (!res.ok) {
				const json = await res.json().catch(() => ({}));
				error = json.error ?? `Échec (${res.status})`;
			} else {
				savedAt = new Date();
				initialized = false;
				await invalidateAll();
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Erreur réseau';
		} finally {
			saving = false;
		}
	}
</script>

<div class="max-w-2xl">
	<form
		class="space-y-5 rounded-lg border border-surface-200 bg-white p-6"
		onsubmit={(e) => {
			e.preventDefault();
			save();
		}}
	>
		<div>
			<label for="title" class="mb-1.5 block text-sm font-medium text-surface-700">Nom de l'établissement</label>
			<input
				id="title"
				type="text"
				bind:value={title}
				class="w-full rounded-md border border-surface-200 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
				placeholder="Ex. Le Café Central"
			/>
			<p class="mt-1 text-xs text-surface-400">Ce nom est visible sur Google Maps et dans les résultats de recherche.</p>
		</div>

		<div>
			<label for="phone" class="mb-1.5 block text-sm font-medium text-surface-700">Téléphone principal</label>
			<div class="flex items-center gap-2 rounded-md border border-surface-200 bg-white pl-3 focus-within:border-primary-500 focus-within:ring-1 focus-within:ring-primary-500">
				<Phone size={14} class="flex-shrink-0 text-surface-400" />
				<input
					id="phone"
					type="tel"
					bind:value={phone}
					class="flex-1 bg-transparent py-2 pr-3 text-sm focus:outline-none"
					placeholder="+41 22 123 45 67"
				/>
			</div>
		</div>

		<div>
			<label class="mb-1.5 block text-sm font-medium text-surface-700" for="new-phone-input">Téléphones additionnels</label>
			<div class="space-y-1.5">
				{#each additionalPhones as phone, idx (idx)}
					<div class="flex items-center gap-2 rounded-md border border-surface-200 bg-surface-50 px-3 py-1.5">
						<Phone size={12} class="text-surface-400" />
						<span class="flex-1 text-sm text-surface-700">{phone}</span>
						<button
							type="button"
							onclick={() => removePhone(idx)}
							class="rounded p-0.5 text-surface-400 hover:bg-surface-100 hover:text-rose-600"
							aria-label="Supprimer"
						>
							<X size={12} />
						</button>
					</div>
				{/each}
			</div>
			<div class="mt-2 flex gap-2">
				<input
					id="new-phone-input"
					type="tel"
					bind:value={newPhone}
					onkeydown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							addPhone();
						}
					}}
					class="flex-1 rounded-md border border-surface-200 bg-white px-3 py-1.5 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
					placeholder="Ajouter un numéro"
				/>
				<button
					type="button"
					onclick={addPhone}
					class="inline-flex items-center gap-1 rounded-md border border-surface-200 bg-white px-3 py-1.5 text-sm font-medium text-surface-600 hover:bg-surface-50"
				>
					<Plus size={12} />
					Ajouter
				</button>
			</div>
		</div>

		<div>
			<label for="website" class="mb-1.5 block text-sm font-medium text-surface-700">Site web</label>
			<div class="flex items-center gap-2 rounded-md border border-surface-200 bg-white pl-3 focus-within:border-primary-500 focus-within:ring-1 focus-within:ring-primary-500">
				<Globe size={14} class="flex-shrink-0 text-surface-400" />
				<input
					id="website"
					type="url"
					bind:value={websiteUri}
					class="flex-1 bg-transparent py-2 pr-3 text-sm focus:outline-none"
					placeholder="https://example.com"
				/>
			</div>
		</div>

		<div>
			<span class="mb-1.5 block text-sm font-medium text-surface-700">Statut</span>
			<div class="space-y-2">
				{#each [
					{ value: 'OPEN', label: 'Ouvert', desc: 'L\'établissement accepte les clients normalement.' },
					{ value: 'CLOSED_TEMPORARILY', label: 'Fermé temporairement', desc: 'Travaux, vacances, fermeture temporaire.' },
					{ value: 'CLOSED_PERMANENTLY', label: 'Fermé définitivement', desc: 'Attention : cette action retire la fiche des résultats Google.' }
				] as opt}
					<label class="flex cursor-pointer items-start gap-2.5 rounded-md border border-surface-200 px-3 py-2 transition-colors {openStatus === opt.value ? 'border-primary-500 bg-primary-50' : 'hover:bg-surface-50'}">
						<input
							type="radio"
							bind:group={openStatus}
							value={opt.value}
							class="mt-0.5 h-3.5 w-3.5"
						/>
						<div class="flex-1">
							<div class="text-sm font-medium text-surface-900">{opt.label}</div>
							<div class="text-xs text-surface-500">{opt.desc}</div>
						</div>
					</label>
				{/each}
			</div>
		</div>

		{#if error}
			<div class="flex items-start gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
				<AlertTriangle size={14} class="mt-0.5 flex-shrink-0" />
				<span>{error}</span>
			</div>
		{/if}

		<div class="flex items-center justify-between border-t border-surface-100 pt-4">
			{#if savedAt && !dirty}
				<span class="inline-flex items-center gap-1 text-xs text-emerald-600">
					<CheckCircle2 size={12} />
					Enregistré
				</span>
			{:else if dirty}
				<span class="text-xs text-amber-600">Modifications non enregistrées</span>
			{:else}
				<span></span>
			{/if}
			<button
				type="submit"
				disabled={!dirty || saving}
				class="inline-flex items-center gap-1.5 rounded-md bg-primary-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{#if saving}
					<Loader2 size={14} class="animate-spin" />
					Enregistrement…
				{:else}
					<Save size={14} />
					Enregistrer
				{/if}
			</button>
		</div>

		<p class="text-xs text-surface-400">
			Les modifications sont envoyées à Google. Elles peuvent prendre quelques minutes à apparaître sur Google Maps. Certains
			changements (nom, statut) peuvent déclencher une revue côté Google.
		</p>
	</form>
</div>
