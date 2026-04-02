<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/utils/dates.js';

	let { data } = $props();

	// ── Tabs ────────────────────────────────────────────────────────
	const TABS = [
		{ value: '', label: 'All' },
		{ value: 'article', label: 'Articles' },
		{ value: 'linkedin', label: 'LinkedIn' },
		{ value: 'gmb', label: 'GMB' }
	];

	const STATUSES = [
		{ value: '', label: 'Tous statuts' },
		{ value: 'draft', label: 'Draft' },
		{ value: 'review', label: 'Review' },
		{ value: 'approved', label: 'Approved' },
		{ value: 'published', label: 'Published' }
	];

	function tabCount(type: string): number {
		if (!type) return data.typeCounts.all;
		return (data.typeCounts as Record<string, number>)[type] ?? 0;
	}

	function applyFilter(key: string, value: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (value) params.set(key, value);
		else params.delete(key);
		goto(`?${params.toString()}`, { replaceState: true });
	}

	// ── Token copy ──────────────────────────────────────────────────
	let copied = $state(false);
	function copyToken() {
		navigator.clipboard.writeText(data.project.accessToken);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	let copiedLink = $state(false);
	function copyClientLink() {
		const link = `${window.location.origin}/view/${data.project.slug}?token=${data.project.accessToken}`;
		navigator.clipboard.writeText(link);
		copiedLink = true;
		setTimeout(() => (copiedLink = false), 2000);
	}

	// ── GMB location ────────────────────────────────────────────────
	interface GmbLocation { name: string; title: string; address: string; }
	let gmbLocations = $state<GmbLocation[]>([]);
	let loadingLocations = $state(false);
	let savingLocation = $state(false);

	async function fetchLocations() {
		loadingLocations = true;
		try {
			const res = await fetch('/api/gmb/locations');
			const json = await res.json();
			if (json.locations) gmbLocations = json.locations;
		} catch { /* ignore */ }
		loadingLocations = false;
	}

	async function assignLocation(locationId: string) {
		savingLocation = true;
		await fetch(`/api/projects/${data.project.slug}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ gmbLocationId: locationId || null })
		});
		savingLocation = false;
		invalidateAll();
	}

	// ── CMS connection ──────────────────────────────────────────────
	interface CmsSite { id: string; name: string; }
	interface CmsCollection { id: string; name: string; slug: string; }
	interface CmsField { slug: string; name: string; type: string; required: boolean; }
	interface FieldMapping { hubField: string; cmsField: string; transform: string; }

	const HUB_FIELDS = [
		{ value: '', label: '— Ignorer —', description: '' },
		{ value: 'title', label: 'Titre', description: 'Titre de l\'article' },
		{ value: 'slug', label: 'Slug', description: 'URL slug' },
		{ value: 'body', label: 'Contenu (HTML)', description: 'Corps de l\'article en HTML' },
		{ value: 'description', label: 'Meta description', description: 'Description SEO (frontmatter description)' },
		{ value: 'schema', label: 'Schema JSON-LD', description: 'Donnees structurees Schema.org' },
		{ value: 'author', label: 'Auteur', description: 'Auteur (frontmatter)' },
		{ value: 'category', label: 'Categorie', description: 'Categorie (frontmatter)' },
		{ value: 'tags', label: 'Tags', description: 'Tags separes par virgule' },
		{ value: 'image.src', label: 'Image URL', description: 'URL image principale (frontmatter)' },
		{ value: 'image.alt', label: 'Image alt', description: 'Texte alternatif image (frontmatter)' },
		{ value: 'pubDate', label: 'Date de publication', description: 'Date (frontmatter)' }
	];

	let cmsStep = $state<'idle' | 'token' | 'sites' | 'collections' | 'mapping' | 'saving'>('idle');
	let cmsType = $state('webflow');
	let cmsToken = $state('');
	let cmsSites = $state<CmsSite[]>([]);
	let cmsCollections = $state<CmsCollection[]>([]);
	let cmsSelectedSite = $state<CmsSite | null>(null);
	let cmsSelectedCollection = $state<CmsCollection | null>(null);
	let cmsFields = $state<CmsField[]>([]);
	let cmsMappings = $state<Record<string, string>>({});
	let cmsError = $state('');
	let cmsLoading = $state(false);

	function startCmsSetup() {
		cmsStep = 'token';
		cmsToken = '';
		cmsError = '';
	}

	async function fetchCmsSites() {
		cmsLoading = true;
		cmsError = '';
		try {
			const res = await fetch(`/api/cms/sites?cmsType=${cmsType}&apiToken=${encodeURIComponent(cmsToken)}`);
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			cmsSites = json.data;
			cmsStep = 'sites';
		} catch (err) {
			cmsError = (err as Error).message;
		}
		cmsLoading = false;
	}

	async function selectCmsSite(site: CmsSite) {
		cmsSelectedSite = site;
		cmsLoading = true;
		cmsError = '';
		try {
			const res = await fetch(`/api/cms/collections?cmsType=${cmsType}&apiToken=${encodeURIComponent(cmsToken)}&siteId=${site.id}`);
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			cmsCollections = json.data;
			cmsStep = 'collections';
		} catch (err) {
			cmsError = (err as Error).message;
		}
		cmsLoading = false;
	}

	function autoDetectMapping(cmsFieldSlug: string, cmsFieldType: string): string {
		const slug = cmsFieldSlug.toLowerCase();
		if (slug === 'name' || slug === 'title') return 'title';
		if (slug === 'slug') return 'slug';
		if (cmsFieldType === 'RichText' || slug.includes('body') || slug.includes('content')) return 'body';
		if (slug.includes('description') || slug.includes('excerpt') || slug.includes('summary') || slug.includes('meta-desc')) return 'description';
		if (slug.includes('schema') || slug.includes('json-ld') || slug.includes('structured')) return 'schema';
		if (slug.includes('author')) return 'author';
		if (slug.includes('category') || slug.includes('categorie')) return 'category';
		if (slug.includes('tag')) return 'tags';
		if (slug.includes('date') || slug.includes('pub')) return 'pubDate';
		if (cmsFieldType === 'ImageRef' || slug.includes('image') || slug.includes('thumbnail') || slug.includes('cover')) return 'image.src';
		return '';
	}

	function getUnmappedHubFields(): typeof HUB_FIELDS {
		const mappedValues = new Set(Object.values(cmsMappings).filter(Boolean));
		return HUB_FIELDS.filter(f => f.value && !mappedValues.has(f.value));
	}

	async function selectCmsCollection(collection: CmsCollection) {
		cmsSelectedCollection = collection;
		cmsLoading = true;
		cmsError = '';
		try {
			const res = await fetch(`/api/cms/fields?cmsType=${cmsType}&apiToken=${encodeURIComponent(cmsToken)}&collectionId=${collection.id}`);
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			cmsFields = json.data;

			// Auto-detect mappings
			const mappings: Record<string, string> = {};
			for (const field of cmsFields) {
				mappings[field.slug] = autoDetectMapping(field.slug, field.type);
			}
			cmsMappings = mappings;

			cmsStep = 'mapping';
		} catch (err) {
			cmsError = (err as Error).message;
		}
		cmsLoading = false;
	}

	function getMappingStatus(): { mapped: string[]; missing: string[]; ok: boolean } {
		const mappedHubFields = Object.values(cmsMappings).filter(Boolean);
		const mapped = [...new Set(mappedHubFields)];
		const required = ['title', 'slug', 'body'];
		const missing = required.filter(r => !mapped.includes(r));
		return { mapped, missing, ok: missing.length === 0 };
	}

	async function saveCmsConnection() {
		cmsStep = 'saving';
		cmsError = '';
		try {
			const fieldMappings: FieldMapping[] = [];
			for (const [cmsField, hubField] of Object.entries(cmsMappings)) {
				if (!hubField) continue;
				const transform = hubField === 'body' ? 'html' : 'none';
				fieldMappings.push({ hubField, cmsField, transform });
			}

			const config = {
				siteId: cmsSelectedSite!.id,
				siteName: cmsSelectedSite!.name,
				collectionId: cmsSelectedCollection!.id,
				collectionName: cmsSelectedCollection!.name,
				fieldMappings
			};

			const res = await fetch('/api/cms/connections', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					projectId: data.project.id,
					cmsType,
					config,
					apiToken: cmsToken
				})
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);

			cmsStep = 'idle';
			cmsToken = '';
			invalidateAll();
		} catch (err) {
			cmsError = (err as Error).message;
			cmsStep = 'mapping';
		}
	}

	async function disconnectCms() {
		await fetch(`/api/cms/connections?projectId=${data.project.id}`, { method: 'DELETE' });
		invalidateAll();
	}

	// ── Selection & batch ───────────────────────────────────────────
	let selected = $state<Set<string>>(new Set());
	let batchStatus = $state('');
	let batchLoading = $state(false);

	let allSelected = $derived(
		data.contents.length > 0 && selected.size === data.contents.length
	);

	function toggleAll() {
		if (allSelected) {
			selected = new Set();
		} else {
			selected = new Set(data.contents.map((c: { id: string }) => c.id));
		}
	}

	function toggleOne(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	async function applyBatchStatus() {
		if (!batchStatus || selected.size === 0) return;
		batchLoading = true;
		await Promise.all(
			[...selected].map((id) =>
				fetch(`/api/content/${id}/status`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ status: batchStatus })
				})
			)
		);
		selected = new Set();
		batchStatus = '';
		batchLoading = false;
		invalidateAll();
	}

	// ── Inline date edit ────────────────────────────────────────────
	let editingDateId = $state<string | null>(null);
	let editingDateValue = $state('');

	function startEditDate(id: string, currentDate: string | null) {
		editingDateId = id;
		editingDateValue = currentDate ? currentDate.slice(0, 16) : '';
	}

	async function saveDate(id: string) {
		const isoDate = editingDateValue ? new Date(editingDateValue).toISOString() : null;
		await fetch(`/api/content/${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev-api-key' },
			body: JSON.stringify({ plannedDate: isoDate })
		});
		editingDateId = null;
		invalidateAll();
	}
</script>

<div>
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div class="flex items-center gap-3">
			<span class="h-4 w-4 rounded-full" style="background-color: {data.project.color};"></span>
			<div>
				<h1 class="text-2xl font-bold text-surface-900">{data.project.name}</h1>
				{#if data.project.description}
					<p class="mt-1 text-sm text-surface-500">{data.project.description}</p>
				{/if}
			</div>
		</div>
		<div class="flex gap-2">
			<button onclick={copyClientLink} class="btn preset-filled-primary-500 text-xs">
				{copiedLink ? 'Copie !' : 'Copier lien client'}
			</button>
			<button onclick={copyToken} class="btn preset-outlined-surface-200 text-xs">
				{copied ? 'Copie !' : 'Copier token'}
			</button>
		</div>
	</div>

	<!-- GMB Section -->
	<div class="mt-6 rounded-lg border border-surface-200 bg-white p-4">
		<h2 class="text-sm font-semibold text-surface-900">Google My Business</h2>

		{#if !data.gmbConnected}
			<div class="mt-3 flex items-center gap-3">
				<span class="text-sm text-surface-400">Compte Google non connecte</span>
				<a href="/api/auth/google" class="btn preset-filled-primary-500 text-xs">
					Connecter Google
				</a>
			</div>
		{:else}
			<div class="mt-3 flex items-center gap-3">
				<span class="inline-flex items-center gap-1.5 text-xs text-green-600">
					<span class="h-2 w-2 rounded-full bg-green-500"></span>
					Connecte
				</span>

				{#if data.project.gmbLocationId}
					<span class="text-xs text-surface-500">
						Location : {data.project.gmbLocationId}
					</span>
				{/if}

				<button
					onclick={fetchLocations}
					class="btn preset-outlined-surface-200 text-xs"
					disabled={loadingLocations}
				>
					{loadingLocations ? 'Chargement...' : data.project.gmbLocationId ? 'Changer la location' : 'Assigner une location'}
				</button>
			</div>

			{#if gmbLocations.length > 0}
				<div class="mt-3 space-y-1.5">
					{#each gmbLocations as loc}
						<button
							onclick={() => assignLocation(loc.name)}
							class="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-surface-50 {data.project.gmbLocationId === loc.name ? 'border-primary-500 bg-primary-50' : 'border-surface-200'}"
							disabled={savingLocation}
						>
							<div>
								<span class="font-medium text-surface-900">{loc.title}</span>
								{#if loc.address}
									<span class="ml-2 text-xs text-surface-400">{loc.address}</span>
								{/if}
							</div>
							{#if data.project.gmbLocationId === loc.name}
								<span class="text-xs text-primary-600">Actif</span>
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		{/if}
	</div>

	<!-- CMS Publishing Section -->
	<div class="mt-4 rounded-lg border border-surface-200 bg-white p-4">
		<h2 class="text-sm font-semibold text-surface-900">Publication CMS</h2>

		{#if data.cmsConnection}
			<div class="mt-3 flex items-center justify-between">
				<div class="flex items-center gap-3">
					<span class="inline-flex items-center gap-1.5 text-xs text-green-600">
						<span class="h-2 w-2 rounded-full bg-green-500"></span>
						Connecte
					</span>
					<span class="text-xs text-surface-500">
						{data.cmsConnection.cmsType === 'webflow' ? 'Webflow' : data.cmsConnection.cmsType}
						&mdash; {data.cmsConnection.config.siteName} &rarr; {data.cmsConnection.config.collectionName}
					</span>
				</div>
				<button
					onclick={disconnectCms}
					class="btn preset-outlined-surface-200 text-xs text-red-500 hover:text-red-700"
				>
					Deconnecter
				</button>
			</div>
		{:else if cmsStep === 'idle'}
			<div class="mt-3 flex items-center gap-3">
				<span class="text-sm text-surface-400">Aucun CMS connecte</span>
				<button onclick={startCmsSetup} class="btn preset-filled-primary-500 text-xs">
					Connecter un CMS
				</button>
			</div>
		{:else if cmsStep === 'token'}
			<div class="mt-3 space-y-3">
				<div class="flex items-center gap-2">
					<select bind:value={cmsType} class="input preset-outlined-surface-200 w-36 text-sm">
						<option value="webflow">Webflow</option>
						<option value="sanity" disabled>Sanity (bientot)</option>
						<option value="wordpress" disabled>WordPress (bientot)</option>
					</select>
					<input
						type="password"
						bind:value={cmsToken}
						placeholder="API token Webflow"
						class="input preset-outlined-surface-200 flex-1 text-sm"
					/>
					<button
						onclick={fetchCmsSites}
						class="btn preset-filled-primary-500 text-xs"
						disabled={!cmsToken || cmsLoading}
					>
						{cmsLoading ? 'Chargement...' : 'Connecter'}
					</button>
					<button onclick={() => cmsStep = 'idle'} class="text-xs text-surface-400 hover:text-surface-600">
						Annuler
					</button>
				</div>
				{#if cmsError}
					<p class="text-xs text-red-500">{cmsError}</p>
				{/if}
			</div>
		{:else if cmsStep === 'sites'}
			<div class="mt-3 space-y-2">
				<p class="text-xs text-surface-500">Selectionner un site :</p>
				{#each cmsSites as site}
					<button
						onclick={() => selectCmsSite(site)}
						class="flex w-full items-center justify-between rounded-md border border-surface-200 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-50"
						disabled={cmsLoading}
					>
						<span class="font-medium text-surface-900">{site.name}</span>
					</button>
				{/each}
				<button onclick={() => cmsStep = 'token'} class="text-xs text-surface-400 hover:text-surface-600">
					&larr; Retour
				</button>
				{#if cmsError}
					<p class="text-xs text-red-500">{cmsError}</p>
				{/if}
			</div>
		{:else if cmsStep === 'collections'}
			<div class="mt-3 space-y-2">
				<p class="text-xs text-surface-500">
					Site : <span class="font-medium text-surface-700">{cmsSelectedSite?.name}</span>
					&mdash; Selectionner une collection :
				</p>
				{#each cmsCollections as col}
					<button
						onclick={() => selectCmsCollection(col)}
						class="flex w-full items-center justify-between rounded-md border border-surface-200 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-50"
						disabled={cmsLoading}
					>
						<span class="font-medium text-surface-900">{col.name}</span>
						<span class="text-xs text-surface-400">{col.slug}</span>
					</button>
				{/each}
				<button onclick={() => cmsStep = 'sites'} class="text-xs text-surface-400 hover:text-surface-600">
					&larr; Retour
				</button>
				{#if cmsError}
					<p class="text-xs text-red-500">{cmsError}</p>
				{/if}
			</div>
		{:else if cmsStep === 'mapping'}
			{@const status = getMappingStatus()}
			<div class="mt-3 space-y-3">
				<div class="flex items-center justify-between">
					<p class="text-xs text-surface-500">
						<span class="font-medium text-surface-700">{cmsSelectedSite?.name}</span>
						&rarr; <span class="font-medium text-surface-700">{cmsSelectedCollection?.name}</span>
						&mdash; Mapping des champs
					</p>
					{#if status.ok}
						<span class="inline-flex items-center gap-1 text-xs text-green-600">
							<span class="h-2 w-2 rounded-full bg-green-500"></span>
							Pret
						</span>
					{:else}
						<span class="text-xs text-amber-600">
							Manquant : {status.missing.join(', ')}
						</span>
					{/if}
				</div>

				<div class="rounded-lg border border-surface-200 overflow-hidden">
					<table class="w-full text-sm">
						<thead>
							<tr class="border-b border-surface-100 bg-surface-50 text-left text-xs font-medium uppercase text-surface-500">
								<th class="px-3 py-2">Champ CMS</th>
								<th class="px-3 py-2">Type</th>
								<th class="px-3 py-2">Requis</th>
								<th class="px-3 py-2">Champ Hub</th>
							</tr>
						</thead>
						<tbody>
							{#each cmsFields as field}
								<tr class="border-b border-surface-100 {cmsMappings[field.slug] ? 'bg-green-50/50' : ''}">
									<td class="px-3 py-2">
										<span class="font-medium text-surface-900">{field.name}</span>
										<span class="ml-1 text-xs text-surface-400">{field.slug}</span>
									</td>
									<td class="px-3 py-2 text-xs text-surface-500">{field.type}</td>
									<td class="px-3 py-2">
										{#if field.required}
											<span class="text-xs text-red-500">Oui</span>
										{:else}
											<span class="text-xs text-surface-300">—</span>
										{/if}
									</td>
									<td class="px-3 py-2">
										<select
											class="input preset-outlined-surface-200 w-full text-xs"
											value={cmsMappings[field.slug] ?? ''}
											onchange={(e) => { cmsMappings[field.slug] = (e.target as HTMLSelectElement).value; cmsMappings = { ...cmsMappings }; }}
										>
											{#each HUB_FIELDS as hf}
												<option value={hf.value}>{hf.label}</option>
											{/each}
										</select>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				{#if getUnmappedHubFields().length > 0}
					<div class="rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
						<p class="text-xs font-medium text-amber-800">Donnees Hub disponibles non mappees :</p>
						<ul class="mt-1.5 space-y-0.5">
							{#each getUnmappedHubFields() as field}
								<li class="text-xs text-amber-700">
									<span class="font-medium">{field.label}</span>
									<span class="text-amber-500"> — {field.description}. Ajoutez un champ dans votre collection CMS pour l'utiliser.</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				<div class="flex items-center gap-3">
					<button
						onclick={saveCmsConnection}
						class="btn preset-filled-primary-500 text-xs"
						disabled={!status.ok}
					>
						Sauvegarder la connexion
					</button>
					<button onclick={() => cmsStep = 'collections'} class="text-xs text-surface-400 hover:text-surface-600">
						&larr; Retour
					</button>
				</div>
				{#if cmsError}
					<p class="text-xs text-red-500">{cmsError}</p>
				{/if}
			</div>
		{:else if cmsStep === 'saving'}
			<div class="mt-3">
				<span class="text-sm text-surface-400">Sauvegarde en cours...</span>
			</div>
		{/if}
	</div>

	<!-- Tabs + Status filter -->
	<div class="mt-6 flex items-center justify-between">
		<div class="flex gap-1">
			{#each TABS as tab}
				<button
					onclick={() => applyFilter('type', tab.value)}
					class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors {(data.filters.type ?? '') === tab.value ? 'bg-surface-900 text-white' : 'text-surface-500 hover:bg-surface-100'}"
				>
					{tab.label}
					<span class="ml-1 text-xs {(data.filters.type ?? '') === tab.value ? 'text-surface-300' : 'text-surface-400'}">
						{tabCount(tab.value)}
					</span>
				</button>
			{/each}
		</div>

		<div class="flex items-center gap-3">
			<select
				class="input preset-outlined-surface-200 w-40 text-sm"
				value={data.filters.status ?? ''}
				onchange={(e) => applyFilter('status', (e.target as HTMLSelectElement).value)}
			>
				{#each STATUSES as s}
					<option value={s.value}>{s.label}</option>
				{/each}
			</select>

			<span class="text-sm text-surface-400">
				{data.contents.length} contenu{data.contents.length !== 1 ? 's' : ''}
			</span>
		</div>
	</div>

	<!-- Batch actions bar -->
	{#if selected.size > 0}
		<div class="mt-3 flex items-center gap-3 rounded-lg bg-primary-50 px-4 py-2">
			<span class="text-sm font-medium text-primary-700">
				{selected.size} selectionne{selected.size > 1 ? 's' : ''}
			</span>
			<select
				bind:value={batchStatus}
				class="input preset-outlined-surface-200 w-36 text-sm"
			>
				<option value="">Changer statut...</option>
				<option value="draft">Draft</option>
				<option value="review">Review</option>
				<option value="approved">Approved</option>
				<option value="published">Published</option>
			</select>
			<button
				onclick={applyBatchStatus}
				class="btn preset-filled-primary-500 text-xs"
				disabled={!batchStatus || batchLoading}
			>
				{batchLoading ? 'En cours...' : 'Appliquer'}
			</button>
			<button
				onclick={() => { selected = new Set(); }}
				class="text-xs text-surface-500 hover:text-surface-700"
			>
				Deselectionner
			</button>
		</div>
	{/if}

	<!-- Content table -->
	{#if data.contents.length > 0}
		<div class="mt-4 overflow-hidden rounded-lg border border-surface-200 bg-white">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-surface-100 bg-surface-50 text-left text-xs font-medium uppercase text-surface-500">
						<th class="w-10 px-4 py-3">
							<input
								type="checkbox"
								checked={allSelected}
								onchange={toggleAll}
								class="rounded"
							/>
						</th>
						<th class="px-4 py-3">Titre</th>
						<th class="px-4 py-3">Type</th>
						<th class="px-4 py-3">Statut</th>
						<th class="px-4 py-3">Date planifiee</th>
					</tr>
				</thead>
				<tbody>
					{#each data.contents as item}
						<tr class="border-b border-surface-100 transition-colors hover:bg-surface-50 {selected.has(item.id) ? 'bg-primary-50/50' : ''}">
							<td class="px-4 py-3">
								<input
									type="checkbox"
									checked={selected.has(item.id)}
									onchange={() => toggleOne(item.id)}
									class="rounded"
								/>
							</td>
							<td class="px-4 py-3">
								<a href="/content/{item.id}" class="font-medium text-surface-900 hover:text-primary-600">
									{item.title}
								</a>
							</td>
							<td class="px-4 py-3 text-surface-500">{item.type}</td>
							<td class="px-4 py-3">
								<StatusBadge status={item.status} />
							</td>
							<td class="px-4 py-3 text-surface-400">
								{#if editingDateId === item.id}
									<div class="flex items-center gap-1">
										<input
											type="datetime-local"
											bind:value={editingDateValue}
											class="rounded border border-surface-200 px-1.5 py-0.5 text-xs"
										/>
										<button onclick={() => saveDate(item.id)} class="text-xs text-primary-600 hover:underline">OK</button>
										<button onclick={() => editingDateId = null} class="text-xs text-surface-400 hover:underline">x</button>
									</div>
								{:else}
									<button
										onclick={() => startEditDate(item.id, item.plannedDate)}
										class="text-left hover:text-primary-600"
									>
										{item.plannedDate ? formatDate(item.plannedDate) : '—'}
									</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<div class="mt-4 rounded-lg border border-dashed border-surface-300 p-12 text-center">
			<p class="text-surface-500">Aucun contenu dans ce projet</p>
		</div>
	{/if}
</div>
