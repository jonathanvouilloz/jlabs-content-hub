<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	// ── Project image ───────────────────────────────────────────────
	let imageUploading = $state(false);

	async function handleProjectImageUpload(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		imageUploading = true;
		const reader = new FileReader();
		reader.onload = async () => {
			const base64 = reader.result as string;
			await fetch(`/api/projects/${data.project.slug}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image: base64 })
			});
			imageUploading = false;
			invalidateAll();
		};
		reader.readAsDataURL(file);
	}

	async function removeProjectImage() {
		imageUploading = true;
		await fetch(`/api/projects/${data.project.slug}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ image: null })
		});
		imageUploading = false;
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
</script>

<div>
	<!-- Header -->
	<div class="flex items-center gap-3">
		<span class="h-4 w-4 rounded-full" style="background-color: {data.project.color};"></span>
		<h1 class="text-2xl font-bold text-surface-900">Parametres — {data.project.name}</h1>
	</div>

	<!-- Section 0: Project -->
	<div class="mt-6 rounded-lg border border-surface-200 bg-white p-4">
		<h2 class="text-sm font-semibold text-surface-900">Projet</h2>
		<div class="mt-3">
			<span class="text-xs font-medium text-surface-500">Image du projet</span>
			<div class="mt-2">
				{#if data.project.image}
					<div class="relative mb-2 inline-block">
						<img src={data.project.image} alt={data.project.name} class="h-32 w-full rounded-lg object-cover" />
						<button
							type="button"
							onclick={removeProjectImage}
							disabled={imageUploading}
							class="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-xs text-white hover:bg-black/70"
							title="Supprimer l'image"
						>&times;</button>
					</div>
				{:else}
					<div class="flex h-32 w-full items-center justify-center rounded-lg text-2xl font-bold text-white/80" style="background-color: {data.project.color};">
						{data.project.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
					</div>
				{/if}
				<input
					type="file"
					accept="image/*"
					onchange={handleProjectImageUpload}
					disabled={imageUploading}
					class="mt-2 block w-full text-sm text-surface-500 file:mr-3 file:rounded-md file:border-0 file:bg-surface-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-surface-700 hover:file:bg-surface-200"
				/>
				{#if imageUploading}
					<p class="mt-1 text-xs text-surface-400">Upload en cours...</p>
				{/if}
			</div>
		</div>
	</div>

	<!-- Section 1: CMS Publishing -->
	<div class="mt-6 rounded-lg border border-surface-200 bg-white p-4">
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

	<!-- Section 2: Google My Business -->
	<div class="mt-4 rounded-lg border border-surface-200 bg-white p-4">
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

	<!-- Section 3: LinkedIn -->
	<div class="mt-4 rounded-lg border border-surface-200 bg-white p-4">
		<h2 class="text-sm font-semibold text-surface-900">LinkedIn</h2>

		{#if data.linkedinConnected}
			<div class="mt-3 flex items-center gap-3">
				<span class="inline-flex items-center gap-1.5 text-xs text-green-600">
					<span class="h-2 w-2 rounded-full bg-green-500"></span>
					Connecte
				</span>
				{#if data.linkedinPersonName}
					<span class="text-xs text-surface-500">{data.linkedinPersonName}</span>
				{/if}
			</div>
		{:else}
			<div class="mt-3 flex items-center gap-3">
				<span class="text-sm text-surface-400">LinkedIn non connecte</span>
				<a href="/api/auth/linkedin" class="btn preset-filled-primary-500 text-xs">
					Connecter LinkedIn
				</a>
			</div>
		{/if}
	</div>
</div>
