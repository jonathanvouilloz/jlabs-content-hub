<script lang="ts">
	import { X, ExternalLink, Copy, Eye, Send } from 'lucide-svelte';
	import StatusBadge from './StatusBadge.svelte';
	import { renderMarkdown } from '$lib/utils/content.js';
	import { formatDate } from '$lib/utils/dates.js';
	import { contentTypeConfig } from '$lib/config/design-tokens.js';
	import { buildFinalText } from '$lib/utils/linkedin.js';

	interface Props {
		contentId: string;
		projectSlug: string;
		onclose: () => void;
	}

	let { contentId, projectSlug, onclose }: Props = $props();

	let content = $state<Record<string, unknown> | null>(null);
	let loading = $state(true);
	let error = $state('');

	async function fetchContent(id: string) {
		loading = true;
		error = '';
		try {
			const res = await fetch(`/api/content/${id}`);
			if (!res.ok) throw new Error('Erreur chargement');
			const json = await res.json();
			content = json.data ?? json;
		} catch (err) {
			error = (err as Error).message;
			content = null;
		}
		loading = false;
	}

	$effect(() => {
		if (contentId) {
			fetchContent(contentId);
			selectedHook = 'main';
			customHook = '';
			imagePromptModalOpen = false;
		}
	});

	// LinkedIn hook selector state
	let selectedHook = $state<'main' | 'A' | 'B' | 'custom'>('main');
	let customHook = $state('');
	let imagePromptModalOpen = $state(false);
	let copyFeedback = $state('');

	interface LinkedinMeta {
		hooks: { main: string; A: string; B: string };
		strategy?: string;
		articleUrl?: string;
		imagePrompt?: string | null;
	}

	let linkedinMeta = $derived(() => {
		if (content?.type !== 'linkedin') return null;
		const m = meta();
		if (!m || typeof m !== 'object' || !('hooks' in m)) return null;
		return m as LinkedinMeta;
	});

	let linkedinPreview = $derived(() => {
		const m = linkedinMeta();
		if (!m) return '';
		const fakePost = {
			day: '',
			emoji: '',
			title: '',
			mainHook: m.hooks.main,
			hookA: m.hooks.A,
			hookB: m.hooks.B,
			strategy: '',
			articleUrl: undefined
		};
		return buildFinalText(fakePost, selectedHook, customHook);
	});

	let publishingGmb = $state(false);
	let publishGmbFeedback = $state('');
	async function publishGmbNow() {
		if (!content || publishingGmb) return;
		publishingGmb = true;
		publishGmbFeedback = '';
		try {
			const res = await fetch(`/api/gmb/publish/${contentId}`, { method: 'POST' });
			const json = await res.json().catch(() => ({}));
			if (res.ok) {
				publishGmbFeedback = 'Publié';
				content = { ...content, status: 'published' };
			} else {
				publishGmbFeedback = json?.error || 'Erreur';
			}
		} catch {
			publishGmbFeedback = 'Erreur';
		}
		publishingGmb = false;
		setTimeout(() => { publishGmbFeedback = ''; }, 3000);
	}

	let updatingStatus = $state(false);
	async function changeStatus(newStatus: string) {
		if (!content || updatingStatus) return;
		updatingStatus = true;
		try {
			const res = await fetch(`/api/content/${contentId}/status`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: newStatus })
			});
			if (res.ok) {
				content = { ...content, status: newStatus };
			}
		} finally {
			updatingStatus = false;
		}
	}

	async function copyImagePrompt() {
		const prompt = linkedinMeta()?.imagePrompt;
		if (!prompt) return;
		try {
			await navigator.clipboard.writeText(prompt);
			copyFeedback = 'Copié !';
			setTimeout(() => { copyFeedback = ''; }, 2000);
		} catch {
			copyFeedback = 'Erreur';
			setTimeout(() => { copyFeedback = ''; }, 2000);
		}
	}

	// Strip frontmatter with regex (gray-matter needs Node.js, won't run in browser)
	function stripFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
		if (!match) return { meta: {}, body: raw };

		const yamlBlock = match[1];
		const body = match[2];

		// Simple YAML key-value parser (handles strings, arrays, objects)
		const meta: Record<string, unknown> = {};
		let currentKey = '';
		let currentObj: Record<string, string> | null = null;

		for (const line of yamlBlock.split('\n')) {
			// Nested object property (e.g. "  src: /path")
			if (currentKey && /^\s{2,}\w+:/.test(line)) {
				const [, k, v] = line.match(/^\s+(\w+):\s*(.*)$/) ?? [];
				if (k && currentObj) currentObj[k] = v?.replace(/^["']|["']$/g, '') ?? '';
				continue;
			}
			// End of nested object
			if (currentObj) {
				meta[currentKey] = currentObj;
				currentObj = null;
				currentKey = '';
			}

			const kvMatch = line.match(/^(\w+):\s*(.*)$/);
			if (!kvMatch) continue;
			const [, key, rawVal] = kvMatch;
			const val = rawVal.trim();

			if (val === '' || val === '|') {
				// Could be a multi-line value or nested object - start collecting
				currentKey = key;
				currentObj = {};
				// Check if it's actually a block scalar (schema: |)
				if (val === '|') {
					// Collect all indented lines as a single string
					const blockLines: string[] = [];
					const startIdx = yamlBlock.split('\n').indexOf(line);
					const allLines = yamlBlock.split('\n');
					for (let i = startIdx + 1; i < allLines.length; i++) {
						if (/^\s{2,}/.test(allLines[i])) {
							blockLines.push(allLines[i].replace(/^\s{2}/, ''));
						} else break;
					}
					if (blockLines.length > 0) {
						meta[key] = blockLines.join('\n');
						currentObj = null;
						currentKey = '';
					}
				}
			} else if (val.startsWith('[') && val.endsWith(']')) {
				// Array: [a, b, c]
				meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
			} else {
				meta[key] = val.replace(/^["']|["']$/g, '');
			}
		}
		if (currentObj && currentKey) meta[currentKey] = currentObj;

		return { meta, body };
	}

	let parsed = $derived(() => {
		if (!content) return { meta: {} as Record<string, unknown>, body: '' };
		const raw = content.body as string;
		if (!raw) return { meta: {}, body: '' };
		if (content.type === 'article') return stripFrontmatter(raw);
		return { meta: {}, body: raw };
	});

	let frontmatter = $derived(() => {
		const m = parsed().meta;
		return Object.keys(m).length > 0 ? m : null;
	});

	let renderedBody = $derived(() => {
		if (!content) return '';
		if (content.type === 'gmb') return '';
		try {
			return renderMarkdown(parsed().body);
		} catch { return ''; }
	});

	let gmbData = $derived(() => {
		if (!content || content.type !== 'gmb') return null;
		try { return JSON.parse(content.body as string); }
		catch { return null; }
	});

	let tags = $derived(() => {
		if (!content?.tags) return [];
		try { return JSON.parse(content.tags as string); }
		catch { return []; }
	});

	let meta = $derived(() => {
		if (!content?.meta) return null;
		try { return JSON.parse(content.meta as string); }
		catch { return null; }
	});
</script>

<div class="flex h-full flex-col rounded-lg border border-surface-200 bg-white">
	<!-- Preview header -->
	<div class="flex flex-shrink-0 items-center justify-between border-b border-surface-100 px-4 py-3">
		{#if content}
			<div class="flex items-center gap-2 min-w-0">
				<span class="text-xs text-surface-400">{contentTypeConfig(content.type as string).label}</span>
				<StatusBadge status={content.status as string} interactive onchange={changeStatus} />
			</div>
		{:else}
			<span></span>
		{/if}
		<div class="flex items-center gap-1 flex-shrink-0">
			{#if content && content.type === 'gmb' && content.status !== 'published'}
				<button
					onclick={publishGmbNow}
					disabled={publishingGmb}
					class="inline-flex items-center gap-1 rounded border border-primary-200 bg-primary-50 px-2 py-1 text-[11px] font-medium text-primary-700 transition-colors hover:bg-primary-100 disabled:opacity-50"
					title="Publier maintenant sur Google My Business"
				>
					<Send size={12} />
					{publishingGmb ? 'Publication...' : (publishGmbFeedback || 'Publier')}
				</button>
			{/if}
			<a
				href="/projects/{projectSlug}/content/{contentId}"
				class="rounded p-1 text-surface-400 transition-colors hover:bg-surface-50 hover:text-surface-700"
				title="Ouvrir en pleine page"
			>
				<ExternalLink size={14} />
			</a>
			<button
				onclick={onclose}
				class="rounded p-1 text-surface-400 transition-colors hover:bg-surface-50 hover:text-surface-700"
			>
				<X size={14} />
			</button>
		</div>
	</div>

	<!-- Preview body -->
	<div class="flex-1 overflow-y-auto px-5 py-4">
		{#if loading}
			<div class="space-y-3 animate-pulse">
				<div class="h-5 w-3/4 rounded bg-surface-100"></div>
				<div class="h-3 w-1/2 rounded bg-surface-100"></div>
				<div class="mt-6 space-y-2">
					<div class="h-3 w-full rounded bg-surface-100"></div>
					<div class="h-3 w-full rounded bg-surface-100"></div>
					<div class="h-3 w-5/6 rounded bg-surface-100"></div>
				</div>
			</div>
		{:else if error}
			<p class="text-sm text-red-500">{error}</p>
		{:else if content}
			<h2 class="text-lg font-semibold text-surface-900">{content.title}</h2>

			<!-- Dates -->
			<div class="mt-2 flex flex-wrap items-center gap-3 text-xs text-surface-400">
				{#if content.plannedDate}
					<span>Planifie : {formatDate(content.plannedDate as string)}</span>
				{/if}
				{#if content.publishedAt}
					<span>Publie : {formatDate(content.publishedAt as string)}</span>
				{/if}
				<span>Cree : {formatDate(content.createdAt as string)}</span>
			</div>

			{#if tags().length > 0}
				<div class="mt-2 flex flex-wrap gap-1">
					{#each tags() as tag}
						<span class="rounded bg-surface-100 px-1.5 py-0.5 text-[10px] text-surface-500">{tag}</span>
					{/each}
				</div>
			{/if}

			<!-- Article: technical details table -->
			{#if content.type === 'article' && frontmatter()}
				{@const fm = frontmatter()!}
				<div class="mt-4 overflow-hidden rounded-md border border-surface-200">
					<table class="w-full text-xs">
						<tbody class="divide-y divide-surface-100">
							{#if fm.title}
								<tr>
									<td class="bg-surface-50 px-3 py-1.5 font-medium text-surface-500 w-28">title</td>
									<td class="px-3 py-1.5 text-surface-700">{fm.title}</td>
								</tr>
							{/if}
							{#if fm.description}
								<tr>
									<td class="bg-surface-50 px-3 py-1.5 font-medium text-surface-500 w-28">description</td>
									<td class="px-3 py-1.5 text-surface-700">{fm.description}</td>
								</tr>
							{/if}
							{#if fm.pubDate}
								<tr>
									<td class="bg-surface-50 px-3 py-1.5 font-medium text-surface-500 w-28">pubDate</td>
									<td class="px-3 py-1.5 text-surface-700">{fm.pubDate}</td>
								</tr>
							{/if}
							{#if fm.author}
								<tr>
									<td class="bg-surface-50 px-3 py-1.5 font-medium text-surface-500 w-28">author</td>
									<td class="px-3 py-1.5 text-surface-700">{fm.author}</td>
								</tr>
							{/if}
							{#if fm.category}
								<tr>
									<td class="bg-surface-50 px-3 py-1.5 font-medium text-surface-500 w-28">category</td>
									<td class="px-3 py-1.5 text-surface-700">{fm.category}</td>
								</tr>
							{/if}
							{#if fm.tags}
								<tr>
									<td class="bg-surface-50 px-3 py-1.5 font-medium text-surface-500 w-28">tags</td>
									<td class="px-3 py-1.5 text-surface-700">
										{#if Array.isArray(fm.tags)}
											{fm.tags.join(', ')}
										{:else}
											{fm.tags}
										{/if}
									</td>
								</tr>
							{/if}
							{#if fm.image}
								<tr>
									<td class="bg-surface-50 px-3 py-1.5 font-medium text-surface-500 w-28">image</td>
									<td class="px-3 py-1.5 text-surface-700">
										{#if typeof fm.image === 'object' && fm.image !== null}
											{@const img = fm.image as Record<string, string>}
											<div class="space-y-0.5">
												{#if img.src}<div class="truncate">src: {img.src}</div>{/if}
												{#if img.alt}<div class="truncate text-surface-400">alt: {img.alt}</div>{/if}
											</div>
										{:else}
											{fm.image}
										{/if}
									</td>
								</tr>
							{/if}
							{#if fm.schema}
								<tr>
									<td class="bg-surface-50 px-3 py-1.5 font-medium text-surface-500 w-28 align-top">schema</td>
									<td class="px-3 py-1.5">
										<details>
											<summary class="cursor-pointer text-primary-600 hover:underline">JSON-LD</summary>
											<pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[10px] text-surface-500 bg-surface-50 rounded p-2">{fm.schema}</pre>
										</details>
									</td>
								</tr>
							{/if}
						</tbody>
					</table>
				</div>
			{/if}

			<!-- Meta JSON (for non-article, non-linkedin content with meta) -->
			{#if meta() && content.type !== 'article' && content.type !== 'linkedin'}
				<details class="mt-4">
					<summary class="cursor-pointer text-xs font-medium text-surface-500">Metadonnees</summary>
					<pre class="mt-1 rounded-md bg-surface-50 p-3 text-[10px] overflow-auto max-h-40">{JSON.stringify(meta(), null, 2)}</pre>
				</details>
			{/if}

			<!-- Content body -->
			<div class="mt-4">
				{#if content.type === 'gmb' && gmbData()}
					{@const gmb = gmbData()}
					<div class="space-y-3">
						<div class="flex items-center gap-2">
							<span class="rounded bg-surface-100 px-1.5 py-0.5 text-[10px] font-medium text-surface-600">
								{gmb.type || 'whats_new'}
							</span>
							{#if gmb.cta}
								<span class="rounded bg-primary-50 px-1.5 py-0.5 text-[10px] text-primary-700">
									{gmb.cta.action}
								</span>
							{/if}
						</div>
						<p class="text-sm leading-relaxed text-surface-700">{gmb.content}</p>
						{#if gmb.cta?.url}
							<a href={gmb.cta.url} target="_blank" rel="noopener" class="text-xs text-primary-600 hover:underline">
								{gmb.cta.url}
							</a>
						{/if}
					</div>
				{:else if content.type === 'linkedin' && linkedinMeta()}
					{@const lm = linkedinMeta()!}
					<div class="space-y-3">
						{#if lm.strategy}
							<p class="text-xs italic text-surface-400">{lm.strategy}</p>
						{/if}
						{#if lm.articleUrl}
							<a href={lm.articleUrl} target="_blank" rel="noopener" class="block text-xs text-primary-600 hover:underline">Article lié →</a>
						{/if}

						<!-- Hook selector -->
						<div>
							<p class="mb-1.5 text-xs font-medium text-surface-600">Accroche</p>
							<div class="space-y-1">
								<label class="flex items-start gap-2 cursor-pointer rounded p-1 hover:bg-surface-50">
									<input type="radio" value="main" bind:group={selectedHook} class="mt-0.5" />
									<div class="min-w-0 flex-1">
										<span class="text-[11px] font-medium text-surface-700">Principale</span>
										<p class="text-[11px] text-surface-500 line-clamp-1">{lm.hooks.main.split('\n')[0]}</p>
									</div>
								</label>
								{#if lm.hooks.A}
									<label class="flex items-start gap-2 cursor-pointer rounded p-1 hover:bg-surface-50">
										<input type="radio" value="A" bind:group={selectedHook} class="mt-0.5" />
										<div class="min-w-0 flex-1">
											<span class="text-[11px] font-medium text-surface-700">Alternative A</span>
											<p class="text-[11px] text-surface-500 line-clamp-1">{lm.hooks.A}</p>
										</div>
									</label>
								{/if}
								{#if lm.hooks.B}
									<label class="flex items-start gap-2 cursor-pointer rounded p-1 hover:bg-surface-50">
										<input type="radio" value="B" bind:group={selectedHook} class="mt-0.5" />
										<div class="min-w-0 flex-1">
											<span class="text-[11px] font-medium text-surface-700">Alternative B</span>
											<p class="text-[11px] text-surface-500 line-clamp-1">{lm.hooks.B}</p>
										</div>
									</label>
								{/if}
								<label class="flex items-start gap-2 cursor-pointer rounded p-1 hover:bg-surface-50">
									<input type="radio" value="custom" bind:group={selectedHook} class="mt-0.5" />
									<span class="text-[11px] font-medium text-surface-700">Personnalisée</span>
								</label>
								{#if selectedHook === 'custom'}
									<textarea
										bind:value={customHook}
										placeholder="Écris ton accroche..."
										class="w-full rounded border border-surface-200 p-2 text-xs"
										rows="2"
									></textarea>
								{/if}
							</div>
						</div>

						<!-- Final post preview -->
						<div>
							<p class="mb-1.5 text-xs font-medium text-surface-600">Aperçu du post</p>
							<div class="rounded-md border border-surface-100 bg-surface-50 p-3 text-xs leading-relaxed text-surface-700 whitespace-pre-wrap max-h-[40vh] overflow-y-auto">
								{linkedinPreview()}
							</div>
						</div>

						<!-- Image prompt actions -->
						{#if lm.imagePrompt}
							<div class="flex items-center gap-2 border-t border-surface-100 pt-3">
								<button
									onclick={copyImagePrompt}
									class="inline-flex items-center gap-1.5 rounded border border-surface-200 bg-white px-2.5 py-1 text-[11px] font-medium text-surface-700 hover:bg-surface-50"
								>
									<Copy size={12} />
									{copyFeedback || 'Copier prompt image'}
								</button>
								<button
									onclick={() => imagePromptModalOpen = true}
									class="inline-flex items-center gap-1.5 rounded border border-surface-200 bg-white px-2.5 py-1 text-[11px] font-medium text-surface-700 hover:bg-surface-50"
								>
									<Eye size={12} />
									Voir prompt
								</button>
							</div>
						{/if}
					</div>
				{:else if content.type === 'linkedin'}
					<div class="rounded-md bg-surface-50 p-4 text-sm leading-relaxed text-surface-700 whitespace-pre-wrap max-h-[50vh] overflow-y-auto">
						{content.body}
					</div>
				{:else if renderedBody()}
					<div class="prose prose-sm max-w-none max-h-[50vh] overflow-y-auto">
						{@html renderedBody()}
					</div>
				{:else}
					<p class="text-sm italic text-surface-400">Aucun contenu</p>
				{/if}
			</div>
		{/if}
	</div>
</div>

{#if imagePromptModalOpen && linkedinMeta()?.imagePrompt}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onclick={() => (imagePromptModalOpen = false)}
		role="presentation"
	>
		<div
			class="w-full max-w-2xl overflow-hidden rounded-lg bg-white shadow-xl"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
		>
			<div class="flex items-center justify-between border-b border-surface-100 px-4 py-3">
				<h3 class="text-sm font-semibold text-surface-900">Prompt image</h3>
				<div class="flex items-center gap-2">
					<button
						onclick={copyImagePrompt}
						class="inline-flex items-center gap-1.5 rounded border border-surface-200 bg-white px-2.5 py-1 text-[11px] font-medium text-surface-700 hover:bg-surface-50"
					>
						<Copy size={12} />
						{copyFeedback || 'Copier'}
					</button>
					<button
						onclick={() => (imagePromptModalOpen = false)}
						class="rounded p-1 text-surface-400 hover:bg-surface-50 hover:text-surface-700"
						aria-label="Fermer"
					>
						<X size={14} />
					</button>
				</div>
			</div>
			<div class="max-h-[70vh] overflow-y-auto p-4">
				<pre class="whitespace-pre-wrap font-sans text-xs text-surface-700">{linkedinMeta()?.imagePrompt}</pre>
			</div>
		</div>
	</div>
{/if}
