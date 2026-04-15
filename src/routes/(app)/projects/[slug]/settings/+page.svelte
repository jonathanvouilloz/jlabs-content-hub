<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { DEFAULT_CONTEXT, type ProjectContext, type TeamMember } from '$lib/types/project-context.js';

	let { data } = $props();

	// ── Business context ────────────────────────────────────────────
	let ctx = $state<ProjectContext>(data.projectContext ? { ...DEFAULT_CONTEXT, ...data.projectContext } : { ...DEFAULT_CONTEXT });
	let ctxSaving = $state(false);
	let ctxMessage = $state('');

	// Temporary inputs for array fields
	let newService = $state('');
	let newValue = $state('');
	let newKeyword = $state('');
	let newMemberName = $state('');
	let newMemberRole = $state('');

	function addToArray(arr: string[], value: string, resetFn: () => void) {
		const trimmed = value.trim();
		if (trimmed && !arr.includes(trimmed)) {
			arr.push(trimmed);
			resetFn();
		}
	}

	function removeFromArray(arr: string[], index: number) {
		arr.splice(index, 1);
	}

	function addMember() {
		const name = newMemberName.trim();
		const role = newMemberRole.trim();
		if (name) {
			ctx.teamMembers.push({ name, role });
			newMemberName = '';
			newMemberRole = '';
		}
	}

	function removeMember(index: number) {
		ctx.teamMembers.splice(index, 1);
	}

	async function saveContext() {
		ctxSaving = true;
		ctxMessage = '';
		try {
			const res = await fetch(`/api/projects/${data.project.slug}/context`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(ctx)
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			ctxMessage = 'Profil sauvegarde';
			invalidateAll();
		} catch (err) {
			ctxMessage = (err as Error).message;
		}
		ctxSaving = false;
		setTimeout(() => { ctxMessage = ''; }, 3000);
	}

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

	// ── GMB locations (multi) ────────────────────────────────────────
	interface GmbLocation { name: string; title: string; address: string; }
	let gmbAvailableLocations = $state<GmbLocation[]>([]);
	let loadingLocations = $state(false);
	let savingLocation = $state(false);

	async function fetchAvailableLocations() {
		loadingLocations = true;
		try {
			const res = await fetch('/api/gmb/locations');
			const json = await res.json();
			if (json.locations) gmbAvailableLocations = json.locations;
		} catch { /* ignore */ }
		loadingLocations = false;
	}

	function isLocationAssigned(locationName: string): boolean {
		return data.assignedGmbLocations.some((l: { gmbLocationId: string }) => l.gmbLocationId === locationName);
	}

	async function addLocation(loc: GmbLocation) {
		savingLocation = true;
		await fetch(`/api/projects/${data.project.slug}/gmb-locations`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ gmbLocationId: loc.name, label: loc.title, address: loc.address })
		});
		savingLocation = false;
		invalidateAll();
	}

	async function removeLocation(id: string) {
		savingLocation = true;
		await fetch(`/api/projects/${data.project.slug}/gmb-locations/${id}`, { method: 'DELETE' });
		savingLocation = false;
		invalidateAll();
	}

	// ── GMB Reviews export ──────────────────────────────────────────────
	let reviewsExporting = $state(false);
	let reviewsExportJson = $state<string | null>(null);

	async function exportReviews() {
		reviewsExporting = true;
		reviewsExportJson = null;
		try {
			const res = await fetch(`/api/projects/${data.project.slug}/reviews/export`);
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			reviewsExportJson = JSON.stringify(json, null, 2);
		} catch (err) {
			reviewsExportJson = `Erreur: ${(err as Error).message}`;
		}
		reviewsExporting = false;
	}

	// ── Google Indexing API ─────────────────────────────────────────
	let idxCred = $state(data.indexingCredentials);
	let idxSubs = $state(data.indexingSubmissions as Array<{ id: string; url: string; type: string; status: string; httpStatus: number | null; response: string | null; source: string | null; submittedAt: string }>);
	let idxSubsTotal = $state(data.indexingSubmissionsTotal ?? 0);
	let idxSubsOffset = $state(0);
	const idxSubsPageSize = 20;
	let idxJson = $state('');
	let idxSiteUrl = $state(data.indexingCredentials?.siteUrl ?? '');
	let idxSitemapUrl = $state(data.indexingCredentials?.sitemapUrl ?? '');
	let idxTemplate = $state(data.indexingCredentials?.publicUrlTemplate ?? '');
	let idxAutoSubmit = $state(data.indexingCredentials?.autoSubmitOnPublish ?? false);
	let idxSaving = $state(false);
	let idxMessage = $state('');
	let idxManualUrl = $state('');
	let idxManualType = $state<'URL_UPDATED' | 'URL_DELETED'>('URL_UPDATED');
	let idxSubmitting = $state(false);
	let idxSitemapBusy = $state(false);

	async function refreshIndexing(resetOffset = true) {
		if (resetOffset) idxSubsOffset = 0;
		const [credRes, subsRes] = await Promise.all([
			fetch(`/api/projects/${data.project.slug}/indexing/credentials`),
			fetch(`/api/projects/${data.project.slug}/indexing/submissions?limit=${idxSubsPageSize}&offset=${idxSubsOffset}`)
		]);
		if (credRes.ok) idxCred = (await credRes.json()).credentials;
		if (subsRes.ok) {
			const json = await subsRes.json();
			idxSubs = json.submissions;
			idxSubsTotal = json.total ?? idxSubsTotal;
		}
	}

	async function goToSubsPage(newOffset: number) {
		idxSubsOffset = Math.max(0, newOffset);
		const res = await fetch(`/api/projects/${data.project.slug}/indexing/submissions?limit=${idxSubsPageSize}&offset=${idxSubsOffset}`);
		if (res.ok) {
			const json = await res.json();
			idxSubs = json.submissions;
			idxSubsTotal = json.total ?? idxSubsTotal;
		}
	}

	async function saveIndexingCredentials() {
		idxSaving = true;
		idxMessage = '';
		try {
			const body: Record<string, unknown> = {
				siteUrl: idxSiteUrl || null,
				sitemapUrl: idxSitemapUrl || null,
				publicUrlTemplate: idxTemplate || null,
				autoSubmitOnPublish: idxAutoSubmit
			};
			if (idxJson.trim()) body.serviceAccountJson = idxJson.trim();
			else if (!idxCred) {
				idxMessage = 'Colle le JSON du service account';
				idxSaving = false;
				return;
			}
			const res = await fetch(`/api/projects/${data.project.slug}/indexing/credentials`, {
				method: idxCred && !idxJson.trim() ? 'POST' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			idxMessage = 'Configuration sauvegardee';
			idxJson = '';
			await refreshIndexing();
		} catch (err) {
			idxMessage = (err as Error).message;
		}
		idxSaving = false;
		setTimeout(() => { idxMessage = ''; }, 4000);
	}

	async function removeIndexingCredentials() {
		if (!confirm('Supprimer la configuration Indexing API pour ce projet ?')) return;
		const res = await fetch(`/api/projects/${data.project.slug}/indexing/credentials`, { method: 'DELETE' });
		if (res.ok) {
			idxCred = null;
			idxJson = '';
			idxSiteUrl = '';
			idxSitemapUrl = '';
			idxTemplate = '';
			idxAutoSubmit = false;
		}
	}

	async function submitManualUrl() {
		if (!idxManualUrl.trim()) return;
		idxSubmitting = true;
		idxMessage = '';
		try {
			const res = await fetch(`/api/projects/${data.project.slug}/indexing/submit`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ urls: [idxManualUrl.trim()], type: idxManualType })
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			idxMessage = `Soumis: ${json.success}/${json.total} (echecs: ${json.failed})`;
			idxManualUrl = '';
			await refreshIndexing();
		} catch (err) {
			idxMessage = (err as Error).message;
		}
		idxSubmitting = false;
		setTimeout(() => { idxMessage = ''; }, 4000);
	}

	async function submitFromSitemap() {
		if (!idxSitemapUrl.trim() && !idxCred?.sitemapUrl) {
			idxMessage = 'Renseigne un sitemap URL d\'abord';
			return;
		}
		idxSitemapBusy = true;
		idxMessage = 'Lecture du sitemap...';
		try {
			const dryRes = await fetch(`/api/projects/${data.project.slug}/indexing/from-sitemap`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sitemapUrl: idxSitemapUrl || undefined, dryRun: true })
			});
			const dry = await dryRes.json();
			if (!dryRes.ok) throw new Error(dry.error);
			if (!confirm(`${dry.count} URL(s) trouvees dans le sitemap. Lancer l'indexation ?`)) {
				idxSitemapBusy = false;
				idxMessage = '';
				return;
			}
			idxMessage = `Soumission de ${dry.count} URL(s)...`;
			const res = await fetch(`/api/projects/${data.project.slug}/indexing/from-sitemap`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sitemapUrl: idxSitemapUrl || undefined })
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			idxMessage = `Termine: ${json.success}/${json.total} OK, ${json.failed} echec(s)`;
			await refreshIndexing();
		} catch (err) {
			idxMessage = (err as Error).message;
		}
		idxSitemapBusy = false;
		setTimeout(() => { idxMessage = ''; }, 6000);
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
				<span class="text-xs text-surface-500">
					{data.assignedGmbLocations.length} location{data.assignedGmbLocations.length !== 1 ? 's' : ''} assignee{data.assignedGmbLocations.length !== 1 ? 's' : ''}
				</span>
				<button
					class="btn preset-outlined-error-500 text-xs"
					onclick={async () => {
						if (!confirm('Deconnecter le compte Google ? Les tokens seront supprimes.')) return;
						await fetch('/api/auth/google', { method: 'DELETE' });
						location.reload();
					}}
				>
					Deconnecter Google
				</button>
			</div>

			<!-- Assigned locations -->
			{#if data.assignedGmbLocations.length > 0}
				<div class="mt-3 space-y-1.5">
					<p class="text-xs font-medium text-surface-500">Locations assignees</p>
					{#each data.assignedGmbLocations as loc}
						<div class="flex items-center justify-between rounded-md border border-primary-200 bg-primary-50 px-3 py-2">
							<div>
								<span class="text-sm font-medium text-surface-900">{loc.label}</span>
								{#if loc.address}
									<span class="ml-2 text-xs text-surface-400">{loc.address}</span>
								{/if}
							</div>
							<button
								onclick={() => removeLocation(loc.id)}
								class="text-xs text-red-400 hover:text-red-600"
								disabled={savingLocation}
							>
								Retirer
							</button>
						</div>
					{/each}
				</div>
			{/if}

			<!-- Export avis Google -->
			{#if data.assignedGmbLocations.length > 0}
				<div class="mt-3 flex items-center gap-3">
					<button
						onclick={exportReviews}
						class="btn preset-outlined-surface-200 text-xs"
						disabled={reviewsExporting}
					>
						{reviewsExporting ? 'Chargement...' : 'Exporter les avis Google (top 20 / salon)'}
					</button>
					{#if reviewsExportJson}
						<button
							onclick={() => navigator.clipboard.writeText(reviewsExportJson!)}
							class="btn preset-outlined-surface-200 text-xs"
						>
							Copier le JSON
						</button>
						<button
							onclick={() => { reviewsExportJson = null; }}
							class="text-xs text-surface-400 hover:text-surface-600"
						>
							Fermer
						</button>
					{/if}
				</div>
				{#if reviewsExportJson}
					<pre class="mt-3 max-h-80 overflow-auto rounded-md border border-surface-200 bg-surface-50 p-3 text-xs text-surface-700 whitespace-pre-wrap">{reviewsExportJson}</pre>
				{/if}
			{/if}

			<!-- Add locations -->
			<div class="mt-3">
				<button
					onclick={fetchAvailableLocations}
					class="btn preset-outlined-surface-200 text-xs"
					disabled={loadingLocations}
				>
					{loadingLocations ? 'Chargement...' : 'Ajouter une location'}
				</button>
			</div>

			{#if gmbAvailableLocations.length > 0}
				<div class="mt-2 space-y-1.5">
					<p class="text-xs font-medium text-surface-500">Locations disponibles</p>
					{#each gmbAvailableLocations as loc}
						{@const assigned = isLocationAssigned(loc.name)}
						<button
							onclick={() => addLocation(loc)}
							class="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors {assigned ? 'border-surface-100 bg-surface-50 opacity-50' : 'border-surface-200 hover:bg-surface-50'}"
							disabled={savingLocation || assigned}
						>
							<div>
								<span class="font-medium text-surface-900">{loc.title}</span>
								{#if loc.address}
									<span class="ml-2 text-xs text-surface-400">{loc.address}</span>
								{/if}
							</div>
							{#if assigned}
								<span class="text-xs text-surface-400">Deja assignee</span>
							{:else}
								<span class="text-xs text-primary-600">Ajouter</span>
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

	<!-- Section 4: Business Context -->
	<div class="mt-4 rounded-lg border border-surface-200 bg-white p-4">
		<div class="flex items-center justify-between">
			<h2 class="text-sm font-semibold text-surface-900">Profil Business</h2>
			{#if data.projectContext}
				<span class="inline-flex items-center gap-1.5 text-xs text-green-600">
					<span class="h-2 w-2 rounded-full bg-green-500"></span>
					Configure
				</span>
			{:else}
				<span class="text-xs text-surface-400">Non configure</span>
			{/if}
		</div>
		<p class="mt-1 text-xs text-surface-400">
			Contexte utilise pour generer les reponses aux avis Google et adapter le ton des communications.
		</p>

		<div class="mt-4 space-y-4">
			<!-- Identity -->
			<div class="grid grid-cols-3 gap-3">
				<div>
					<label class="text-xs font-medium text-surface-600">Nom du business</label>
					<input type="text" bind:value={ctx.businessName} placeholder="Le Studio" class="input preset-outlined-surface-200 mt-1 w-full text-sm" />
				</div>
				<div>
					<label class="text-xs font-medium text-surface-600">Type d'activite</label>
					<input type="text" bind:value={ctx.businessType} placeholder="Barbershop, restaurant..." class="input preset-outlined-surface-200 mt-1 w-full text-sm" />
				</div>
				<div>
					<label class="text-xs font-medium text-surface-600">Localite</label>
					<input type="text" bind:value={ctx.locality} placeholder="Geneve, Rive" class="input preset-outlined-surface-200 mt-1 w-full text-sm" />
				</div>
			</div>

			<!-- Tone & Signatures -->
			<div class="grid grid-cols-3 gap-3">
				<div>
					<label class="text-xs font-medium text-surface-600">Ton</label>
					<select bind:value={ctx.tone} class="input preset-outlined-surface-200 mt-1 w-full text-sm">
						<option value="decontracte">Decontracte</option>
						<option value="chaleureux">Chaleureux</option>
						<option value="professionnel">Professionnel</option>
						<option value="formel">Formel</option>
					</select>
				</div>
				<div>
					<label class="text-xs font-medium text-surface-600">Signature par defaut</label>
					<input type="text" bind:value={ctx.defaultSignature} placeholder="L'equipe Le Studio" class="input preset-outlined-surface-200 mt-1 w-full text-sm" />
				</div>
				<div>
					<label class="text-xs font-medium text-surface-600">Signature avis negatifs</label>
					<input type="text" bind:value={ctx.negativeSignature} placeholder="Jacky, fondateur" class="input preset-outlined-surface-200 mt-1 w-full text-sm" />
				</div>
			</div>

			<!-- Contact -->
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="text-xs font-medium text-surface-600">Email (contact public)</label>
					<input type="email" bind:value={ctx.contactEmail} placeholder="contact@business.ch" class="input preset-outlined-surface-200 mt-1 w-full text-sm" />
				</div>
				<div>
					<label class="text-xs font-medium text-surface-600">Telephone (optionnel)</label>
					<input type="text" bind:value={ctx.contactPhone} placeholder="+41 22 123 45 67" class="input preset-outlined-surface-200 mt-1 w-full text-sm" />
				</div>
			</div>

			<!-- Services -->
			<div>
				<label class="text-xs font-medium text-surface-600">Services cles</label>
				<div class="mt-1 flex flex-wrap gap-1.5">
					{#each ctx.keyServices as service, i}
						<span class="inline-flex items-center gap-1 rounded-full bg-surface-100 px-2.5 py-1 text-xs text-surface-700">
							{service}
							<button onclick={() => removeFromArray(ctx.keyServices, i)} class="text-surface-400 hover:text-red-500">&times;</button>
						</span>
					{/each}
				</div>
				<div class="mt-1.5 flex gap-2">
					<input type="text" bind:value={newService} placeholder="Ajouter un service..." class="input preset-outlined-surface-200 flex-1 text-sm"
						onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addToArray(ctx.keyServices, newService, () => newService = ''); } }}
					/>
					<button onclick={() => addToArray(ctx.keyServices, newService, () => newService = '')} class="btn preset-outlined-surface-200 text-xs" disabled={!newService.trim()}>+</button>
				</div>
			</div>

			<!-- Values -->
			<div>
				<label class="text-xs font-medium text-surface-600">Valeurs</label>
				<div class="mt-1 flex flex-wrap gap-1.5">
					{#each ctx.values as val, i}
						<span class="inline-flex items-center gap-1 rounded-full bg-surface-100 px-2.5 py-1 text-xs text-surface-700">
							{val}
							<button onclick={() => removeFromArray(ctx.values, i)} class="text-surface-400 hover:text-red-500">&times;</button>
						</span>
					{/each}
				</div>
				<div class="mt-1.5 flex gap-2">
					<input type="text" bind:value={newValue} placeholder="Ajouter une valeur..." class="input preset-outlined-surface-200 flex-1 text-sm"
						onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addToArray(ctx.values, newValue, () => newValue = ''); } }}
					/>
					<button onclick={() => addToArray(ctx.values, newValue, () => newValue = '')} class="btn preset-outlined-surface-200 text-xs" disabled={!newValue.trim()}>+</button>
				</div>
			</div>

			<!-- Team members -->
			<div>
				<label class="text-xs font-medium text-surface-600">Equipe</label>
				{#if ctx.teamMembers.length > 0}
					<div class="mt-1 flex flex-wrap gap-1.5">
						{#each ctx.teamMembers as member, i}
							<span class="inline-flex items-center gap-1 rounded-full bg-surface-100 px-2.5 py-1 text-xs">
								<span class="text-surface-700">{member.name}</span>
								{#if member.role}
									<span class="text-surface-400">· {member.role}</span>
								{/if}
								<button onclick={() => removeMember(i)} class="ml-1 text-surface-400 hover:text-red-500">&times;</button>
							</span>
						{/each}
					</div>
				{/if}
				<div class="mt-1.5 flex gap-2">
					<input type="text" bind:value={newMemberName} placeholder="Prenom" class="input preset-outlined-surface-200 w-1/3 text-sm"
						onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMember(); } }}
					/>
					<input type="text" bind:value={newMemberRole} placeholder="Role (optionnel)" class="input preset-outlined-surface-200 flex-1 text-sm"
						onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMember(); } }}
					/>
					<button onclick={addMember} class="btn preset-outlined-surface-200 text-xs" disabled={!newMemberName.trim()}>+</button>
				</div>
			</div>

			<!-- SEO -->
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="text-xs font-medium text-surface-600">Mots-cles SEO</label>
					<div class="mt-1 flex flex-wrap gap-1.5">
						{#each ctx.seoKeywords as kw, i}
							<span class="inline-flex items-center gap-1 rounded-full bg-primary-50 px-2.5 py-1 text-xs text-primary-700">
								{kw}
								<button onclick={() => removeFromArray(ctx.seoKeywords, i)} class="text-primary-400 hover:text-red-500">&times;</button>
							</span>
						{/each}
					</div>
					<div class="mt-1.5 flex gap-2">
						<input type="text" bind:value={newKeyword} placeholder="Mot-cle..." class="input preset-outlined-surface-200 flex-1 text-sm"
							onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addToArray(ctx.seoKeywords, newKeyword, () => newKeyword = ''); } }}
						/>
						<button onclick={() => addToArray(ctx.seoKeywords, newKeyword, () => newKeyword = '')} class="btn preset-outlined-surface-200 text-xs" disabled={!newKeyword.trim()}>+</button>
					</div>
				</div>
				<div>
					<label class="text-xs font-medium text-surface-600">Zone geographique SEO</label>
					<input type="text" bind:value={ctx.geoZone} placeholder="Geneve, quartier des Eaux-Vives" class="input preset-outlined-surface-200 mt-1 w-full text-sm" />
				</div>
			</div>

			<!-- Save button -->
			<div class="flex items-center gap-3 pt-2">
				<button
					onclick={saveContext}
					class="btn preset-filled-primary-500 text-sm"
					disabled={ctxSaving || !ctx.businessName || !ctx.businessType || !ctx.locality}
				>
					{ctxSaving ? 'Sauvegarde...' : 'Sauvegarder le profil'}
				</button>
				{#if ctxMessage}
					<span class="text-xs text-surface-500">{ctxMessage}</span>
				{/if}
			</div>
		</div>
	</div>

	<!-- ── Google Indexing API ──────────────────────────────────── -->
	<div class="card mt-6 p-6">
		<div class="mb-4 flex items-center justify-between">
			<div>
				<h2 class="text-lg font-semibold">Indexation Google</h2>
				<p class="text-xs text-surface-500">Soumet des URLs a la Google Indexing API (service account).</p>
			</div>
			{#if idxCred}
				<button onclick={removeIndexingCredentials} class="btn preset-outlined-error-500 text-xs">Supprimer la config</button>
			{/if}
		</div>

		{#if idxCred}
			<div class="mb-4 rounded-md bg-surface-50 p-3 text-sm">
				<div class="font-medium">Service account connecte</div>
				<div class="mt-1 font-mono text-xs text-surface-600 break-all">{idxCred.serviceAccountEmail}</div>
				<div class="mt-2 text-xs text-surface-500">
					Ajoute cet email comme <b>Proprietaire</b> dans Google Search Console &gt; Parametres &gt; Utilisateurs et autorisations.
				</div>
			</div>
		{/if}

		<div class="space-y-3">
			<div>
				<label class="text-xs font-medium text-surface-600">Service account JSON {idxCred ? '(colle pour remplacer)' : '(obligatoire)'}</label>
				<textarea
					bind:value={idxJson}
					rows="4"
					placeholder={'{"type":"service_account","client_email":"...","private_key":"..."}'}
					class="textarea preset-outlined-surface-200 mt-1 w-full font-mono text-xs"
				></textarea>
			</div>

			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="text-xs font-medium text-surface-600">Site URL (propriete Search Console)</label>
					<input type="text" bind:value={idxSiteUrl} placeholder="https://barberconcept.ch" class="input preset-outlined-surface-200 mt-1 w-full text-sm" />
				</div>
				<div>
					<label class="text-xs font-medium text-surface-600">Sitemap URL</label>
					<input type="text" bind:value={idxSitemapUrl} placeholder="https://barberconcept.ch/sitemap.xml" class="input preset-outlined-surface-200 mt-1 w-full text-sm" />
				</div>
			</div>

			<div>
				<label class="text-xs font-medium text-surface-600">Template d'URL publique (auto-submit)</label>
				<input type="text" bind:value={idxTemplate} placeholder="https://barberconcept.ch/blog/{'{slug}'}" class="input preset-outlined-surface-200 mt-1 w-full text-sm" />
				<p class="mt-1 text-xs text-surface-400">Utilise <code>{'{slug}'}</code> comme placeholder. Laisse vide pour desactiver l'auto-submit.</p>
			</div>

			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={idxAutoSubmit} class="checkbox" />
				<span>Soumettre automatiquement a la publication d'un contenu</span>
			</label>

			<div class="flex items-center gap-3 pt-1">
				<button onclick={saveIndexingCredentials} class="btn preset-filled-primary-500 text-sm" disabled={idxSaving}>
					{idxSaving ? 'Sauvegarde...' : (idxCred ? 'Mettre a jour' : 'Enregistrer')}
				</button>
				{#if idxMessage}
					<span class="text-xs text-surface-500">{idxMessage}</span>
				{/if}
			</div>
		</div>

		{#if idxCred}
			<div class="mt-6 border-t border-surface-200 pt-4">
				<h3 class="mb-2 text-sm font-semibold">Soumettre une URL</h3>
				<div class="flex flex-wrap items-center gap-2">
					<input type="text" bind:value={idxManualUrl} placeholder="https://barberconcept.ch/..." class="input preset-outlined-surface-200 min-w-[260px] flex-1 text-sm" />
					<select bind:value={idxManualType} class="select preset-outlined-surface-200 text-sm">
						<option value="URL_UPDATED">URL_UPDATED</option>
						<option value="URL_DELETED">URL_DELETED</option>
					</select>
					<button onclick={submitManualUrl} class="btn preset-filled-primary-500 text-sm" disabled={idxSubmitting || !idxManualUrl.trim()}>
						{idxSubmitting ? 'Envoi...' : 'Soumettre'}
					</button>
					<button onclick={submitFromSitemap} class="btn preset-outlined-primary-500 text-sm" disabled={idxSitemapBusy}>
						{idxSitemapBusy ? 'Traitement...' : 'Indexer depuis sitemap'}
					</button>
				</div>
			</div>

			<div class="mt-6 border-t border-surface-200 pt-4">
				<div class="mb-2 flex items-center justify-between">
					<h3 class="text-sm font-semibold">Soumissions <span class="text-surface-500 font-normal">({idxSubsTotal} au total)</span></h3>
					{#if idxSubsTotal > idxSubsPageSize}
						<span class="text-xs text-surface-500">
							{idxSubsOffset + 1}–{Math.min(idxSubsOffset + idxSubsPageSize, idxSubsTotal)} sur {idxSubsTotal}
						</span>
					{/if}
				</div>
				{#if idxSubs.length === 0}
					<p class="text-xs text-surface-500">Aucune soumission pour l'instant.</p>
				{:else}
					<div class="overflow-x-auto">
						<table class="table w-full text-xs">
							<thead>
								<tr>
									<th class="text-left">Date</th>
									<th class="text-left">URL</th>
									<th class="text-left">Type</th>
									<th class="text-left">Source</th>
									<th class="text-left">Statut</th>
									<th class="text-left">HTTP</th>
								</tr>
							</thead>
							<tbody>
								{#each idxSubs as s (s.id)}
									<tr>
										<td class="whitespace-nowrap text-surface-500">{new Date(s.submittedAt).toLocaleString('fr-CH')}</td>
										<td class="max-w-[320px] truncate font-mono" title={s.url}>{s.url}</td>
										<td>{s.type}</td>
										<td class="text-surface-500">{s.source ?? '-'}</td>
										<td>
											<span class={s.status === 'success' ? 'text-green-600' : 'text-red-600'}>{s.status}</span>
										</td>
										<td class="text-surface-500">{s.httpStatus ?? '-'}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if idxSubsTotal > idxSubsPageSize}
						<div class="mt-3 flex items-center justify-end gap-2">
							<button
								onclick={() => goToSubsPage(idxSubsOffset - idxSubsPageSize)}
								class="btn preset-outlined-surface-200 text-xs"
								disabled={idxSubsOffset === 0}
							>
								Precedent
							</button>
							<button
								onclick={() => goToSubsPage(idxSubsOffset + idxSubsPageSize)}
								class="btn preset-outlined-surface-200 text-xs"
								disabled={idxSubsOffset + idxSubsPageSize >= idxSubsTotal}
							>
								Suivant
							</button>
						</div>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
</div>
