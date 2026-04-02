<script lang="ts">
	import { invalidateAll } from '$app/navigation';
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
		showType = true,
		showBatchActions = true
	}: {
		contents: ContentItem[];
		showType?: boolean;
		showBatchActions?: boolean;
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
</script>

<!-- Batch actions bar -->
{#if showBatchActions && selected.size > 0}
	<div class="mb-3 flex items-center gap-3 rounded-lg bg-primary-50 px-4 py-2">
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

{#if contents.length > 0}
	<div class="overflow-hidden rounded-lg border border-surface-200 bg-white">
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
					{#if showType}
						<th class="w-12 px-4 py-3">Type</th>
					{/if}
					<th class="px-4 py-3">Titre</th>
					<th class="px-4 py-3">Statut</th>
					<th class="px-4 py-3">Date planifiee</th>
				</tr>
			</thead>
			<tbody>
				{#each contents as item}
					<tr class="border-b border-surface-100 transition-colors hover:bg-surface-50 {selected.has(item.id) ? 'bg-primary-50/50' : ''}">
						<td class="px-4 py-3">
							<input
								type="checkbox"
								checked={selected.has(item.id)}
								onchange={() => toggleOne(item.id)}
								class="rounded"
							/>
						</td>
						{#if showType}
							<td class="px-4 py-3">
								{#if item.type === 'linkedin'}
									<span title="LinkedIn">
										<svg class="h-5 w-5" viewBox="0 0 24 24" fill="#0A66C2"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
									</span>
								{:else if item.type === 'article'}
									<span title="Article">
										<svg class="h-5 w-5 text-surface-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
									</span>
								{:else if item.type === 'gmb'}
									<span title="Google My Business">
										<svg class="h-5 w-5" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#EA4335"/><circle cx="12" cy="9" r="2.5" fill="white"/></svg>
									</span>
								{:else}
									<span class="text-xs text-surface-400">{item.type}</span>
								{/if}
							</td>
						{/if}
						<td class="px-4 py-3">
							<a href="/content/{item.id}" class="font-medium text-surface-900 hover:text-primary-600">
								{item.title}
							</a>
						</td>
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
	<div class="rounded-lg border border-dashed border-surface-300 p-12 text-center">
		<p class="text-surface-500">Aucun contenu</p>
	</div>
{/if}
