<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ProjectPill from '$lib/components/ProjectPill.svelte';
	import { renderMarkdown } from '$lib/utils/content.js';
	import { formatDate } from '$lib/utils/dates.js';
	import { isBatchFormat, parseLinkedInBatch, buildFinalText, type LinkedInPost } from '$lib/utils/linkedin.js';
	import { suggestDates } from '$lib/utils/linkedin-schedule.js';

	let { data } = $props();

	const TYPE_LABELS: Record<string, string> = {
		article: 'Article',
		linkedin: 'LinkedIn',
		gmb: 'GMB'
	};

	let renderedBody = $derived(
		data.content.type === 'gmb'
			? null
			: renderMarkdown(data.content.body)
	);

	let parsedMeta = $derived(() => {
		try { return data.content.meta ? JSON.parse(data.content.meta) : null; }
		catch { return null; }
	});

	let parsedTags = $derived(() => {
		try { return data.content.tags ? JSON.parse(data.content.tags) : []; }
		catch { return []; }
	});

	async function changeStatus(newStatus: string) {
		await fetch(`/api/content/${data.content.id}/status`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev-api-key' },
			body: JSON.stringify({ status: newStatus })
		});
		invalidateAll();
	}

	async function deleteComment(commentId: string) {
		await fetch(`/api/comments/${commentId}`, {
			method: 'DELETE',
			headers: { Authorization: 'Bearer dev-api-key' }
		});
		invalidateAll();
	}

	// GMB publish + location targeting
	let publishing = $state(false);
	let gmbPublishResults = $state<{ locationId: string; label: string; success: boolean; error?: string }[]>([]);

	// Parse target_locations from meta
	let gmbTargetLocations = $derived(() => {
		const meta = parsedMeta();
		if (meta?.target_locations?.length) return meta.target_locations as string[];
		return null; // null = all locations
	});

	// Parse published post IDs (supports legacy string + JSON map)
	let gmbPublishedMap = $derived(() => {
		const raw = data.content.gmbPostId;
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, string>;
		} catch { /* legacy single string */ }
		return { _legacy: raw } as Record<string, string>;
	});

	// Editable location targeting
	let targetAll = $state(true);
	let selectedLocations = $state<Set<string>>(new Set());
	let savingTarget = $state(false);

	$effect(() => {
		const targets = gmbTargetLocations();
		if (targets) {
			targetAll = false;
			selectedLocations = new Set(targets);
		} else {
			targetAll = true;
			selectedLocations = new Set();
		}
	});

	function toggleAll() {
		targetAll = true;
		selectedLocations = new Set();
	}

	function toggleLocation(locId: string) {
		targetAll = false;
		const next = new Set(selectedLocations);
		if (next.has(locId)) {
			next.delete(locId);
			if (next.size === 0) targetAll = true;
		} else {
			next.add(locId);
		}
		selectedLocations = next;
	}

	function hasTargetChanged(): boolean {
		const current = gmbTargetLocations();
		if (targetAll && current === null) return false;
		if (targetAll && current !== null) return true;
		if (!targetAll && current === null) return true;
		if (!current) return true;
		if (selectedLocations.size !== current.length) return true;
		return !current.every((id: string) => selectedLocations.has(id));
	}

	async function saveTargetLocations() {
		savingTarget = true;
		const currentMeta = parsedMeta() || {};
		let newMeta: Record<string, unknown>;
		if (targetAll) {
			const { target_locations: _, ...rest } = currentMeta;
			newMeta = rest;
		} else {
			newMeta = { ...currentMeta, target_locations: [...selectedLocations] };
		}
		await fetch(`/api/content/${data.content.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ meta: Object.keys(newMeta).length > 0 ? newMeta : null })
		});
		savingTarget = false;
		invalidateAll();
	}

	async function publishGmbNow() {
		publishing = true;
		gmbPublishResults = [];
		try {
			const res = await fetch(`/api/gmb/publish/${data.content.id}`, { method: 'POST' });
			const json = await res.json();
			if (json.results) gmbPublishResults = json.results;
			invalidateAll();
		} catch { /* ignore */ }
		publishing = false;
	}

	// CMS publish
	let publishingCms = $state(false);
	let cmsPublishError = $state('');

	async function publishToCms() {
		publishingCms = true;
		cmsPublishError = '';
		try {
			const res = await fetch(`/api/cms/publish/${data.content.id}`, { method: 'POST' });
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			invalidateAll();
		} catch (err) {
			cmsPublishError = (err as Error).message;
		}
		publishingCms = false;
	}

	// LinkedIn publish
	let publishingLinkedin = $state(false);
	let linkedinPublishError = $state('');

	async function publishToLinkedin() {
		publishingLinkedin = true;
		linkedinPublishError = '';
		try {
			const res = await fetch(`/api/linkedin/publish/${data.content.id}`, { method: 'POST' });
			const json = await res.json();
			if (!res.ok) throw new Error(json.error);
			invalidateAll();
		} catch (err) {
			linkedinPublishError = (err as Error).message;
		}
		publishingLinkedin = false;
	}

	// LinkedIn post review (individual post with hooks in meta)
	interface LinkedinHooks { main: string; A: string; B: string; }
	let linkedinMeta = $derived(() => {
		if (data.content.type !== 'linkedin' || !data.content.meta) return null;
		try {
			const m = JSON.parse(data.content.meta);
			if (m.hooks) return m as { hooks: LinkedinHooks; strategy?: string; articleUrl?: string };
			return null;
		} catch { return null; }
	});

	let selectedHook = $state<'main' | 'A' | 'B' | 'custom'>('main');
	let customHook = $state('');
	let editingLinkedin = $state(false);
	let editedLinkedinBody = $state('');
	let approvingLinkedin = $state(false);

	function getLinkedinPreview(): string {
		const meta = linkedinMeta();
		if (!meta) return data.content.body;
		if (editedLinkedinBody) return editedLinkedinBody;
		if (selectedHook === 'main') return meta.hooks.main;
		if (selectedHook === 'custom' && customHook) {
			return buildFinalText(
				{ day: '', emoji: '', title: '', mainHook: meta.hooks.main, hookA: meta.hooks.A, hookB: meta.hooks.B, strategy: '' },
				'custom', customHook
			);
		}
		return buildFinalText(
			{ day: '', emoji: '', title: '', mainHook: meta.hooks.main, hookA: meta.hooks.A, hookB: meta.hooks.B, strategy: '' },
			selectedHook
		);
	}

	async function approveLinkedinPost() {
		approvingLinkedin = true;
		try {
			const finalBody = editedLinkedinBody || getLinkedinPreview();
			await fetch(`/api/content/${data.content.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev-api-key' },
				body: JSON.stringify({ body: finalBody, meta: null })
			});
			await fetch(`/api/content/${data.content.id}/status`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev-api-key' },
				body: JSON.stringify({ status: 'approved' })
			});
			invalidateAll();
		} catch { /* ignore */ }
		approvingLinkedin = false;
	}

	// GMB parsed body
	let gmbData = $derived(() => {
		if (data.content.type !== 'gmb') return null;
		try { return JSON.parse(data.content.body); }
		catch { return null; }
	});

	// Planned date editing
	let editingDate = $state(false);
	let newPlannedDate = $state('');

	function startEditDate() {
		// Convert ISO to datetime-local format
		const d = data.content.plannedDate;
		newPlannedDate = d ? d.slice(0, 16) : '';
		editingDate = true;
	}

	async function savePlannedDate() {
		const isoDate = newPlannedDate ? new Date(newPlannedDate).toISOString() : null;
		await fetch(`/api/content/${data.content.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev-api-key' },
			body: JSON.stringify({ plannedDate: isoDate })
		});
		editingDate = false;
		invalidateAll();
	}
</script>

<div>
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<div class="flex items-center gap-3">
				{#if data.project}
					<ProjectPill name={data.project.name} color={data.project.color} />
				{/if}
				<span class="text-xs text-surface-400">{TYPE_LABELS[data.content.type] ?? data.content.type}</span>
			</div>
			<h1 class="mt-2 text-2xl font-bold text-surface-900">{data.content.title}</h1>
		</div>
		<div class="flex items-center gap-3">
			{#if data.cmsConnection && data.content.type === 'article'}
				{#if data.content.cmsItemId}
					<span class="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
						<span class="h-2 w-2 rounded-full bg-green-500"></span>
						Publie sur {data.cmsConnection.cmsType === 'webflow' ? 'Webflow' : data.cmsConnection.cmsType}
					</span>
				{:else if data.content.status === 'approved' || data.content.status === 'review'}
					<button
						onclick={publishToCms}
						class="btn preset-filled-primary-500 text-xs"
						disabled={publishingCms}
					>
						{publishingCms ? 'Publication...' : `Publier sur ${data.cmsConnection.cmsType === 'webflow' ? 'Webflow' : data.cmsConnection.cmsType}`}
					</button>
				{/if}
			{/if}
			{#if data.content.type === 'linkedin' && data.linkedinConnected}
				{#if data.content.status === 'published'}
					<span class="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
						<span class="h-2 w-2 rounded-full bg-blue-500"></span>
						Publie sur LinkedIn
					</span>
				{:else if data.content.status === 'approved' || data.content.status === 'review'}
					<button
						onclick={publishToLinkedin}
						class="btn preset-filled-primary-500 text-xs"
						disabled={publishingLinkedin}
					>
						{publishingLinkedin ? 'Publication...' : 'Publier sur LinkedIn'}
					</button>
				{/if}
			{:else if data.content.type === 'linkedin' && !data.linkedinConnected}
				<a href="/api/auth/linkedin" class="btn preset-outlined-surface-200 text-xs">
					Connecter LinkedIn
				</a>
			{/if}
			<StatusBadge status={data.content.status} interactive onchange={changeStatus} />
		</div>
	</div>

	{#if cmsPublishError}
		<div class="mt-2 rounded-md bg-red-50 px-4 py-2 text-xs text-red-600">{cmsPublishError}</div>
	{/if}
	{#if linkedinPublishError}
		<div class="mt-2 rounded-md bg-red-50 px-4 py-2 text-xs text-red-600">{linkedinPublishError}</div>
	{/if}

	<!-- Metadata -->
	<div class="mt-4 flex flex-wrap items-center gap-4 text-xs text-surface-400">
		{#if data.content.plannedDate}
			<span>
				Planifie : {formatDate(data.content.plannedDate)}
				{#if data.content.type === 'gmb' && data.content.status !== 'published'}
					{#if editingDate}
						<input
							type="datetime-local"
							bind:value={newPlannedDate}
							class="ml-1 rounded border border-surface-200 px-1.5 py-0.5 text-xs"
						/>
						<button onclick={savePlannedDate} class="ml-1 text-primary-600 hover:underline">OK</button>
						<button onclick={() => editingDate = false} class="ml-1 text-surface-400 hover:underline">Annuler</button>
					{:else}
						<button onclick={startEditDate} class="ml-1 text-primary-600 hover:underline">modifier</button>
					{/if}
				{/if}
			</span>
		{:else if data.content.type === 'gmb' && data.content.status !== 'published'}
			<span>
				Pas de date planifiee
				{#if editingDate}
					<input
						type="datetime-local"
						bind:value={newPlannedDate}
						class="ml-1 rounded border border-surface-200 px-1.5 py-0.5 text-xs"
					/>
					<button onclick={savePlannedDate} class="ml-1 text-primary-600 hover:underline">OK</button>
					<button onclick={() => editingDate = false} class="ml-1 text-surface-400 hover:underline">Annuler</button>
				{:else}
					<button onclick={startEditDate} class="ml-1 text-primary-600 hover:underline">ajouter</button>
				{/if}
			</span>
		{/if}
		{#if data.content.publishedAt}
			<span>Publie : {formatDate(data.content.publishedAt)}</span>
		{/if}
		<span>Cree : {formatDate(data.content.createdAt)}</span>
		{#if data.content.type === 'gmb' && data.publishLogsCount > 0}
			<a
				href="/projects/{data.project.slug}/gmb-logs?contentId={data.content.id}"
				class="text-primary-600 hover:underline"
			>
				Logs ({data.publishLogsCount})
			</a>
		{/if}
	</div>

	{#if parsedTags().length > 0}
		<div class="mt-3 flex flex-wrap gap-1.5">
			{#each parsedTags() as tag}
				<span class="rounded-full bg-surface-100 px-2 py-0.5 text-xs text-surface-600">{tag}</span>
			{/each}
		</div>
	{/if}

	<!-- Body -->
	<div class="mt-8">
		{#if data.content.type === 'linkedin' && linkedinMeta() != null}
			<!-- LinkedIn Post Review (individual with hook selection) -->
			<div class="rounded-lg border border-surface-200 bg-white p-6">
				{#if linkedinMeta()?.strategy}
					<p class="text-xs text-surface-400 italic mb-4">{linkedinMeta()?.strategy}</p>
				{/if}
				{#if linkedinMeta()?.articleUrl}
					<a href={linkedinMeta()?.articleUrl} target="_blank" rel="noopener" class="text-xs text-primary-600 hover:underline mb-4 inline-block">
						Article lie
					</a>
				{/if}

				<!-- Hook selection -->
				<div>
					<p class="text-xs font-medium text-surface-600 mb-2">Accroche :</p>
					<div class="space-y-1.5">
						<label class="flex items-start gap-2 cursor-pointer">
							<input type="radio" value="main" bind:group={selectedHook} class="mt-1" />
							<div>
								<span class="text-xs font-medium text-surface-700">Principale</span>
								<p class="text-xs text-surface-500 line-clamp-2">{linkedinMeta()?.hooks.main.split('\n')[0]}</p>
							</div>
						</label>
						{#if linkedinMeta()?.hooks.A}
							<label class="flex items-start gap-2 cursor-pointer">
								<input type="radio" value="A" bind:group={selectedHook} class="mt-1" />
								<div>
									<span class="text-xs font-medium text-surface-700">Alternative A</span>
									<p class="text-xs text-surface-500 line-clamp-2">{linkedinMeta()?.hooks.A}</p>
								</div>
							</label>
						{/if}
						{#if linkedinMeta()?.hooks.B}
							<label class="flex items-start gap-2 cursor-pointer">
								<input type="radio" value="B" bind:group={selectedHook} class="mt-1" />
								<div>
									<span class="text-xs font-medium text-surface-700">Alternative B</span>
									<p class="text-xs text-surface-500 line-clamp-2">{linkedinMeta()?.hooks.B}</p>
								</div>
							</label>
						{/if}
						<label class="flex items-start gap-2 cursor-pointer">
							<input type="radio" value="custom" bind:group={selectedHook} class="mt-1" />
							<span class="text-xs font-medium text-surface-700">Personnalisee</span>
						</label>
						{#if selectedHook === 'custom'}
							<textarea
								bind:value={customHook}
								placeholder="Ecris ton accroche..."
								class="input preset-outlined-surface-200 w-full text-sm mt-1"
								rows="2"
							></textarea>
						{/if}
					</div>
				</div>

				<!-- Post preview / edit -->
				<div class="mt-4">
					<div class="flex items-center justify-between mb-2">
						<p class="text-xs font-medium text-surface-600">Apercu du post :</p>
						<button
							onclick={() => {
								if (!editingLinkedin) editedLinkedinBody = getLinkedinPreview();
								editingLinkedin = !editingLinkedin;
							}}
							class="text-xs text-primary-600 hover:underline"
						>
							{editingLinkedin ? 'Apercu' : 'Modifier'}
						</button>
					</div>
					{#if editingLinkedin}
						<textarea
							bind:value={editedLinkedinBody}
							class="input preset-outlined-surface-200 w-full text-sm font-mono"
							rows="12"
						></textarea>
					{:else}
						<div class="rounded-md border border-surface-100 bg-surface-50 p-4 text-sm text-surface-700 whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto">
							{getLinkedinPreview()}
						</div>
					{/if}
				</div>

				<!-- Approve button -->
				{#if data.content.status === 'draft'}
					<div class="mt-4">
						<button
							onclick={approveLinkedinPost}
							class="btn preset-filled-primary-500 text-sm"
							disabled={approvingLinkedin}
						>
							{approvingLinkedin ? 'Validation...' : 'Approuver ce post'}
						</button>
					</div>
				{/if}
			</div>
		{:else if data.content.type === 'gmb' && gmbData()}
			{@const gmb = gmbData()}
			<!-- GMB Post display -->
			<div class="rounded-lg border border-surface-200 bg-white p-6">
				<div class="flex items-start justify-between gap-4">
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<span class="rounded-full bg-surface-100 px-2.5 py-0.5 text-xs font-medium text-surface-600">
								{gmb.type || 'whats_new'}
							</span>
							{#if gmb.cta}
								<span class="rounded-full bg-primary-50 px-2.5 py-0.5 text-xs text-primary-700">
									{gmb.cta.action}
								</span>
							{/if}
						</div>

						<p class="mt-3 text-sm leading-relaxed text-surface-700">{gmb.content}</p>

						{#if gmb.cta?.url}
							<div class="mt-3">
								<a href={gmb.cta.url} target="_blank" rel="noopener" class="text-xs text-primary-600 hover:underline">
									{gmb.cta.url}
								</a>
							</div>
						{/if}

						{#if gmb.event_start_date || gmb.event_end_date}
							<div class="mt-3 flex gap-3 text-xs text-surface-400">
								{#if gmb.event_start_date}
									<span>Debut : {formatDate(gmb.event_start_date)}</span>
								{/if}
								{#if gmb.event_end_date}
									<span>Fin : {formatDate(gmb.event_end_date)}</span>
								{/if}
							</div>
						{/if}

						{#if gmb.image_prompt}
							<details class="mt-3">
								<summary class="cursor-pointer text-xs text-surface-400">Image prompt</summary>
								<p class="mt-1 text-xs text-surface-500">{gmb.image_prompt}</p>
							</details>
						{/if}
					</div>

					{#if data.content.status !== 'published'}
						<button
							onclick={publishGmbNow}
							class="btn preset-filled-primary-500 shrink-0 text-xs"
							disabled={publishing || data.gmbLocations.length === 0}
						>
							{publishing ? 'Publication...' : 'Publier maintenant'}
						</button>
					{:else if data.content.gmbPostId}
						<span class="text-xs text-green-600">Publie sur Google</span>
					{/if}
				</div>
			</div>

			<!-- Location targeting -->
			{#if data.gmbLocations.length > 0}
				<div class="mt-4 rounded-lg border border-surface-200 bg-white p-4">
					<h3 class="text-xs font-semibold text-surface-600">Locations cibles</h3>

					{#if data.content.status === 'published'}
						<!-- Read-only after publication -->
						<div class="mt-2 flex flex-wrap gap-1.5">
							{#if gmbTargetLocations() === null}
								<span class="rounded-full bg-primary-50 px-2.5 py-0.5 text-xs font-medium text-primary-700">
									Toutes les locations ({data.gmbLocations.length})
								</span>
							{:else}
								{#each data.gmbLocations as loc}
									{#if gmbTargetLocations()?.includes(loc.gmbLocationId)}
										<span class="rounded-full bg-primary-50 px-2.5 py-0.5 text-xs font-medium text-primary-700">
											{loc.label}
										</span>
									{/if}
								{/each}
							{/if}
						</div>

						{#if gmbPublishedMap()}
							<div class="mt-3 space-y-1">
								<p class="text-xs font-medium text-surface-500">Statut par location</p>
								{#each data.gmbLocations as loc}
									{@const postId = gmbPublishedMap()?.[loc.gmbLocationId]}
									<div class="flex items-center gap-2 text-xs">
										{#if postId}
											<span class="h-2 w-2 rounded-full bg-green-500"></span>
											<span class="text-surface-700">{loc.label}</span>
											<span class="text-surface-400">Publie</span>
										{:else if gmbTargetLocations() === null || gmbTargetLocations()?.includes(loc.gmbLocationId)}
											<span class="h-2 w-2 rounded-full bg-red-400"></span>
											<span class="text-surface-700">{loc.label}</span>
											<span class="text-red-400">Non publie</span>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					{:else}
						<!-- Editable before publication -->
						<div class="mt-2 space-y-1.5">
							<label class="flex items-center gap-2 cursor-pointer">
								<input
									type="checkbox"
									checked={targetAll}
									onchange={toggleAll}
									class="rounded border-surface-300"
								/>
								<span class="text-sm text-surface-700 font-medium">Toutes les locations ({data.gmbLocations.length})</span>
							</label>

							<div class="ml-1 border-l-2 border-surface-100 pl-4 space-y-1">
								{#each data.gmbLocations as loc}
									<label class="flex items-center gap-2 cursor-pointer">
										<input
											type="checkbox"
											checked={targetAll || selectedLocations.has(loc.gmbLocationId)}
											disabled={targetAll}
											onchange={() => toggleLocation(loc.gmbLocationId)}
											class="rounded border-surface-300"
										/>
										<span class="text-sm {targetAll ? 'text-surface-400' : 'text-surface-700'}">{loc.label}</span>
										{#if loc.address}
											<span class="text-xs text-surface-400">{loc.address}</span>
										{/if}
									</label>
								{/each}
							</div>
						</div>

						{#if hasTargetChanged()}
							<div class="mt-3">
								<button
									onclick={saveTargetLocations}
									class="btn preset-filled-primary-500 text-xs"
									disabled={savingTarget}
								>
									{savingTarget ? 'Sauvegarde...' : 'Sauvegarder le ciblage'}
								</button>
							</div>
						{/if}
					{/if}
				</div>
			{:else if data.content.type === 'gmb'}
				<div class="mt-4 rounded-md bg-amber-50 px-4 py-3 text-xs text-amber-700">
					Aucune location GMB assignee a ce projet. Configurez les locations dans les parametres du projet.
				</div>
			{/if}

			<!-- Publish results (after clicking publish) -->
			{#if gmbPublishResults.length > 0}
				<div class="mt-4 rounded-lg border border-surface-200 bg-white p-4">
					<h3 class="text-xs font-semibold text-surface-600">Resultats de publication</h3>
					<div class="mt-2 space-y-1">
						{#each gmbPublishResults as r}
							<div class="flex items-center gap-2 text-xs">
								{#if r.success}
									<span class="h-2 w-2 rounded-full bg-green-500"></span>
									<span class="text-surface-700">{r.label}</span>
									<span class="text-green-600">OK</span>
								{:else}
									<span class="h-2 w-2 rounded-full bg-red-500"></span>
									<span class="text-surface-700">{r.label}</span>
									<span class="text-red-500">{r.error ?? 'Echec'}</span>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Raw JSON (collapsible) -->
			<details class="mt-4">
				<summary class="cursor-pointer text-sm font-medium text-surface-500">JSON brut</summary>
				<pre class="mt-2 rounded-lg bg-surface-50 p-4 text-xs overflow-auto">{JSON.stringify(gmb, null, 2)}</pre>
			</details>
		{:else if renderedBody}
			<div class="prose prose-sm max-w-none rounded-lg border border-surface-200 bg-white p-6">
				{@html renderedBody}
			</div>
		{/if}
	</div>

	<!-- Meta JSON -->
	{#if parsedMeta()}
		<details class="mt-6">
			<summary class="cursor-pointer text-sm font-medium text-surface-500">Metadonnees</summary>
			<pre class="mt-2 rounded-lg bg-surface-50 p-4 text-xs overflow-auto">{JSON.stringify(parsedMeta(), null, 2)}</pre>
		</details>
	{/if}

	<!-- Comments -->
	<div class="mt-10">
		<h2 class="text-lg font-semibold text-surface-900">
			Commentaires ({data.comments.length})
		</h2>

		{#if data.comments.length > 0}
			<div class="mt-4 space-y-3">
				{#each data.comments as comment}
					<div class="rounded-lg border border-surface-200 bg-white p-4">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium text-surface-900">{comment.authorName}</span>
								<span class="text-xs text-surface-400">{comment.authorEmail}</span>
							</div>
							<div class="flex items-center gap-2">
								<span class="text-xs text-surface-400">{formatDate(comment.createdAt)}</span>
								<button
									onclick={() => deleteComment(comment.id)}
									class="text-xs text-red-500 hover:text-red-700"
								>
									Supprimer
								</button>
							</div>
						</div>
						<p class="mt-2 text-sm text-surface-600">{comment.body}</p>
					</div>
				{/each}
			</div>
		{:else}
			<p class="mt-4 text-sm text-surface-400">Aucun commentaire</p>
		{/if}
	</div>

	<!-- Status history -->
	{#if data.history.length > 0}
		<div class="mt-10">
			<h2 class="text-lg font-semibold text-surface-900">Historique</h2>
			<div class="mt-4 space-y-2">
				{#each data.history as entry}
					<div class="flex items-center gap-3 text-xs text-surface-400">
						<span>{formatDate(entry.changedAt)}</span>
						<span>
							{#if entry.fromStatus}
								{entry.fromStatus} → {entry.toStatus}
							{:else}
								Cree en {entry.toStatus}
							{/if}
						</span>
						<span class="text-surface-300">par {entry.changedBy}</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Back link -->
	{#if data.project}
		<div class="mt-10">
			<a href="/projects/{data.project.slug}" class="text-sm text-primary-600 hover:underline">
				← Retour a {data.project.name}
			</a>
		</div>
	{/if}
</div>
