<script lang="ts">
	import { page } from '$app/stores';

	let { data, children } = $props();

	const navItems = [
		{ href: `/projects/${data.project.slug}`, label: 'Dashboard', icon: 'grid', connection: null },
		{ href: `/projects/${data.project.slug}/articles`, label: 'Articles', icon: 'document', connection: null },
		{ href: `/projects/${data.project.slug}/linkedin`, label: 'LinkedIn', icon: 'linkedin', connection: 'linkedin' as const },
		{ href: `/projects/${data.project.slug}/gmb`, label: 'GMB', icon: 'gmb', connection: 'gmb' as const }
	];

	function isActive(href: string): boolean {
		if (href === `/projects/${data.project.slug}`) {
			return $page.url.pathname === href;
		}
		return $page.url.pathname.startsWith(href);
	}

	function isConnected(key: 'linkedin' | 'gmb'): boolean {
		return data.connections[key];
	}
</script>

<div class="flex min-h-0 flex-1">
	<!-- Project sidebar -->
	<aside class="flex w-[220px] flex-shrink-0 flex-col border-r border-surface-200 bg-white">
		<!-- Back link -->
		<div class="px-4 pt-4 pb-2">
			<a
				href="/projects"
				class="inline-flex items-center gap-1.5 text-xs text-surface-400 transition-colors hover:text-surface-700"
			>
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
				Projets
			</a>
		</div>

		<!-- Project name -->
		<div class="border-b border-surface-200 px-4 pb-4">
			<div class="flex items-center gap-2.5">
				<span class="h-3 w-3 rounded-full flex-shrink-0" style="background-color: {data.project.color};"></span>
				<span class="text-sm font-semibold text-surface-900 truncate">{data.project.name}</span>
			</div>
		</div>

		<!-- Navigation -->
		<nav class="flex-1 px-3 py-3">
			{#each navItems as item}
				{@const active = isActive(item.href)}
				{@const connected = item.connection ? isConnected(item.connection) : null}
				<a
					href={item.href}
					class="mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors
						{active
							? 'bg-primary-50 text-primary-700'
							: connected === false
								? 'text-surface-300 hover:bg-surface-50 hover:text-surface-500'
								: 'text-surface-600 hover:bg-surface-100 hover:text-surface-900'}"
				>
					<!-- Icons -->
					{#if item.icon === 'grid'}
						<svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
					{:else if item.icon === 'document'}
						<svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
					{:else if item.icon === 'linkedin'}
						<svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
					{:else if item.icon === 'gmb'}
						<svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="currentColor"/><circle cx="12" cy="9" r="2.5" fill="white"/></svg>
					{/if}

					<span class="flex-1 truncate">{item.label}</span>

					<!-- Green dot for connected services -->
					{#if connected === true}
						<span class="h-2 w-2 rounded-full bg-green-500 flex-shrink-0"></span>
					{/if}
				</a>
			{/each}

			<!-- Separator -->
			<div class="my-2 border-t border-surface-100"></div>

			<!-- Settings -->
			<a
				href="/projects/{data.project.slug}/settings"
				class="mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors
					{$page.url.pathname.startsWith(`/projects/${data.project.slug}/settings`)
						? 'bg-primary-50 text-primary-700'
						: 'text-surface-600 hover:bg-surface-100 hover:text-surface-900'}"
			>
				<svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
				<span class="truncate">Parametres</span>
			</a>
		</nav>
	</aside>

	<!-- Main content area -->
	<main class="flex-1 overflow-auto p-8">
		{@render children()}
	</main>
</div>
