<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { authClient } from '$lib/auth-client.js';

	let { data, children } = $props();

	const navItems = [
		{ href: '/', label: 'Dashboard' },
		{ href: '/projects', label: 'Projets' },
		{ href: '/calendar', label: 'Calendrier' }
	];

	let isInsideProject = $derived($page.url.pathname.match(/^\/projects\/[^/]+\/.+/) !== null || ($page.url.pathname.match(/^\/projects\/[^/]+$/) !== null && $page.url.pathname !== '/projects'));

	async function handleLogout() {
		await authClient.signOut();
		goto('/login');
	}
</script>

<div class="flex min-h-screen flex-col bg-surface-50">
	<!-- Top navbar -->
	<header class="flex h-14 flex-shrink-0 items-center border-b border-surface-200 bg-white px-6">
		<a href="/" class="flex items-center gap-2">
			<h1 class="text-sm font-bold text-surface-900">Content Hub</h1>
		</a>

		<nav class="ml-8 flex items-center gap-1">
			{#each navItems as item}
				<a
					href={item.href}
					class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors
						{$page.url.pathname === item.href || (item.href === '/projects' && $page.url.pathname.startsWith('/projects'))
							? 'bg-primary-50 text-primary-700'
							: 'text-surface-500 hover:bg-surface-100 hover:text-surface-900'}"
				>
					{item.label}
				</a>
			{/each}
		</nav>

		<div class="ml-auto flex items-center gap-3">
			<div class="flex items-center gap-2.5">
				<div class="flex h-7 w-7 items-center justify-center rounded-full bg-primary-500 text-xs font-medium text-white">
					{data.user.name?.charAt(0) ?? 'J'}
				</div>
				<span class="text-sm text-surface-600">{data.user.name}</span>
			</div>
			<button
				onclick={handleLogout}
				class="rounded-md px-2.5 py-1 text-xs text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-700"
			>
				Deconnexion
			</button>
		</div>
	</header>

	<!-- Main content -->
	{#if isInsideProject}
		<!-- When inside a project, render children directly (project layout handles its own sidebar) -->
		<div class="flex flex-1 min-h-0">
			{@render children()}
		</div>
	{:else}
		<main class="flex-1 overflow-auto">
			<div class="p-8">
				{@render children()}
			</div>
		</main>
	{/if}
</div>
