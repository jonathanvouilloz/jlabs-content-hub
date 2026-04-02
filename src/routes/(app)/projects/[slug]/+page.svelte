<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import ContentTable from '$lib/components/ContentTable.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/utils/dates.js';

	let { data } = $props();

	const STATUSES = [
		{ value: '', label: 'Tous statuts' },
		{ value: 'draft', label: 'Draft' },
		{ value: 'review', label: 'Review' },
		{ value: 'approved', label: 'Approved' },
		{ value: 'published', label: 'Published' }
	];

	function applyFilter(value: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (value) params.set('status', value);
		else params.delete('status');
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

	<!-- Stats cards -->
	<div class="mt-6 grid grid-cols-4 gap-4">
		<div class="rounded-lg border border-surface-200 bg-white p-4">
			<p class="text-xs font-medium uppercase text-surface-500">Total</p>
			<p class="mt-1 text-2xl font-bold text-surface-900">{data.typeCounts.all}</p>
		</div>
		<div class="rounded-lg border border-surface-200 bg-white p-4">
			<p class="text-xs font-medium uppercase text-surface-500">Articles</p>
			<p class="mt-1 text-2xl font-bold text-surface-900">{data.typeCounts.article}</p>
		</div>
		<div class="rounded-lg border border-surface-200 bg-white p-4">
			<p class="text-xs font-medium uppercase text-surface-500">LinkedIn</p>
			<p class="mt-1 text-2xl font-bold text-surface-900">{data.typeCounts.linkedin}</p>
		</div>
		<div class="rounded-lg border border-surface-200 bg-white p-4">
			<p class="text-xs font-medium uppercase text-surface-500">GMB</p>
			<p class="mt-1 text-2xl font-bold text-surface-900">{data.typeCounts.gmb}</p>
		</div>
	</div>

	<!-- Prochaines publications -->
	{#if data.upcoming.length > 0}
		<div class="mt-6">
			<h2 class="text-sm font-semibold text-surface-900">Prochaines publications</h2>
			<div class="mt-3 space-y-2">
				{#each data.upcoming as item}
					<div class="flex items-center justify-between rounded-lg border border-surface-200 bg-white px-4 py-3">
						<div class="flex items-center gap-3">
							{#if item.type === 'linkedin'}
								<span title="LinkedIn">
									<svg class="h-4 w-4" viewBox="0 0 24 24" fill="#0A66C2"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
								</span>
							{:else if item.type === 'article'}
								<span title="Article">
									<svg class="h-4 w-4 text-surface-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
								</span>
							{:else if item.type === 'gmb'}
								<span title="Google My Business">
									<svg class="h-4 w-4" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#EA4335"/><circle cx="12" cy="9" r="2.5" fill="white"/></svg>
								</span>
							{/if}
							<a href="/content/{item.id}" class="text-sm font-medium text-surface-900 hover:text-primary-600">
								{item.title}
							</a>
						</div>
						<div class="flex items-center gap-3">
							<StatusBadge status={item.status} />
							<span class="text-xs text-surface-400">
								{item.plannedDate ? formatDate(item.plannedDate) : ''}
							</span>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Status filter + content count -->
	<div class="mt-6 flex items-center justify-between">
		<h2 class="text-sm font-semibold text-surface-900">Tous les contenus</h2>
		<div class="flex items-center gap-3">
			<select
				class="input preset-outlined-surface-200 w-40 text-sm"
				value={data.filters.status ?? ''}
				onchange={(e) => applyFilter((e.target as HTMLSelectElement).value)}
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

	<!-- Content table -->
	<div class="mt-4">
		<ContentTable contents={data.contents} projectSlug={data.project.slug} showType={true} showBatchActions={true} />
	</div>
</div>
