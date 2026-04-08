<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { FileText, MapPin } from 'lucide-svelte';
	import LinkedinIcon from '$lib/components/ui/LinkedinIcon.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import { formatDate } from '$lib/utils/dates.js';

	interface ContentItem {
		id: string;
		title: string;
		type: string;
		status: string;
		plannedDate: string | null;
	}

	let {
		contents,
		projectSlug,
		showType = true,
		showBatchActions = true,
		selectedId = null,
		onselect
	}: {
		contents: ContentItem[];
		projectSlug: string;
		showType?: boolean;
		showBatchActions?: boolean;
		selectedId?: string | null;
		onselect?: (id: string) => void;
	} = $props();

	// ── Selection & batch ───────────────────────────────────────────
	let selected = $state<Set<string>>(new Set());
	let batchStatus = $state('');
	let batchLoading = $state(false);

	let allSelected = $derived(
		contents.length > 0 && selected.size === contents.length
	);

	function toggleAll() {
		if (allSelected) {
			selected = new Set();
		} else {
			selected = new Set(contents.map((c) => c.id));
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

	const nowIso = new Date().toISOString();
	function isOverdue(item: ContentItem) {
		return item.status !== 'published' && !!item.plannedDate && item.plannedDate < nowIso;
	}

	function handleRowClick(id: string) {
		if (onselect) {
			onselect(id);
		}
	}
</script>

<!-- Batch actions bar -->
{#if showBatchActions && selected.size > 0}
	<div class="mb-3 flex items-center gap-3 rounded-md bg-primary-50 px-4 py-2">
		<span class="text-sm font-medium text-primary-700">
			{selected.size} selectionne{selected.size > 1 ? 's' : ''}
		</span>
		<select
			bind:value={batchStatus}
			class="rounded-md border border-surface-200 bg-white px-2 py-1 text-xs text-surface-600 outline-none"
		>
			<option value="">Changer statut...</option>
			<option value="draft">Draft</option>
			<option value="review">Review</option>
			<option value="approved">Approved</option>
			<option value="published">Published</option>
		</select>
		<button
			onclick={applyBatchStatus}
			class="rounded-md bg-primary-500 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-primary-600"
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

{#if contents.length > 0}
	<div class="overflow-hidden rounded-lg border border-surface-200 bg-white">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-surface-100 bg-surface-50 text-left text-xs font-medium uppercase tracking-wider text-surface-400">
					{#if showBatchActions}
						<th class="w-10 px-4 py-2.5">
							<input
								type="checkbox"
								checked={allSelected}
								onchange={toggleAll}
								class="rounded"
							/>
						</th>
					{/if}
					{#if showType}
						<th class="w-10 px-3 py-2.5"></th>
					{/if}
					<th class="px-4 py-2.5">Titre</th>
					<th class="w-24 px-4 py-2.5">Statut</th>
					<th class="w-36 px-4 py-2.5">Date</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-surface-100">
				{#each contents as item}
					<tr
						class="transition-colors cursor-pointer
							{selectedId === item.id ? 'bg-primary-50' : selected.has(item.id) ? 'bg-primary-50/50' : 'hover:bg-surface-50'}"
						onclick={() => handleRowClick(item.id)}
					>
						{#if showBatchActions}
							<td class="px-4 py-2.5" onclick={(e) => e.stopPropagation()}>
								<input
									type="checkbox"
									checked={selected.has(item.id)}
									onchange={() => toggleOne(item.id)}
									class="rounded"
								/>
							</td>
						{/if}
						{#if showType}
							<td class="px-3 py-2.5">
								{#if item.type === 'linkedin'}
									<LinkedinIcon size={16} class="text-[#0A66C2]" />
								{:else if item.type === 'gmb'}
									<MapPin size={16} class="text-red-500" />
								{:else}
									<FileText size={16} class="text-surface-400" />
								{/if}
							</td>
						{/if}
						<td class="px-4 py-2.5">
							{#if onselect}
								<span class="font-medium text-surface-900">{item.title}</span>
							{:else}
								<a href="/projects/{projectSlug}/content/{item.id}" class="font-medium text-surface-900 hover:text-primary-600">
									{item.title}
								</a>
							{/if}
							{#if isOverdue(item)}
								<span class="ml-2 inline-flex items-center gap-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700 align-middle">
									<span class="h-1.5 w-1.5 rounded-full bg-red-500"></span>
									En retard
								</span>
							{/if}
						</td>
						<td class="px-4 py-2.5">
							<StatusBadge status={item.status} />
						</td>
						<td class="px-4 py-2.5 text-xs {isOverdue(item) ? 'text-red-600 font-medium' : 'text-surface-400'}" onclick={(e) => e.stopPropagation()}>
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
	<div class="rounded-lg border border-dashed border-surface-200 py-12 text-center">
		<p class="text-sm text-surface-400">Aucun contenu</p>
	</div>
{/if}
