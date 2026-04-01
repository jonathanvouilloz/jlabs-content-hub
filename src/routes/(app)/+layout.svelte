<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { authClient } from '$lib/auth-client.js';
	import { Navigation } from '@skeletonlabs/skeleton-svelte';

	let { data, children } = $props();

	const navItems = [
		{ href: '/', label: 'Dashboard', icon: 'grid' },
		{ href: '/projects', label: 'Projets', icon: 'folder' },
		{ href: '/calendar', label: 'Calendrier', icon: 'calendar' }
	];

	async function handleLogout() {
		await authClient.signOut();
		goto('/login');
	}
</script>

<div class="flex min-h-screen bg-surface-50">
	<!-- Sidebar -->
	<aside class="flex w-64 flex-col border-r border-surface-200 bg-white">
		<div class="border-b border-surface-200 px-6 py-5">
			<h1 class="text-lg font-bold text-surface-900">Content Hub</h1>
			<p class="text-xs text-surface-500">Jon Labs</p>
		</div>

		<nav class="flex-1 px-3 py-4">
			{#each navItems as item}
				<a
					href={item.href}
					class="mb-1 flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors
						{$page.url.pathname === item.href
							? 'bg-primary-50 text-primary-700'
							: 'text-surface-600 hover:bg-surface-100 hover:text-surface-900'}"
				>
					{item.label}
				</a>
			{/each}
		</nav>

		<div class="border-t border-surface-200 px-3 py-4">
			<div class="flex items-center gap-3 px-3">
				<div class="flex h-8 w-8 items-center justify-center rounded-full bg-primary-500 text-sm font-medium text-white">
					{data.user.name?.charAt(0) ?? 'J'}
				</div>
				<div class="flex-1 min-w-0">
					<p class="truncate text-sm font-medium text-surface-900">{data.user.name}</p>
					<p class="truncate text-xs text-surface-500">{data.user.email}</p>
				</div>
			</div>
			<button
				onclick={handleLogout}
				class="mt-3 w-full rounded-lg px-3 py-2 text-left text-sm text-surface-500 hover:bg-surface-100 hover:text-surface-900 transition-colors"
			>
				Deconnexion
			</button>
		</div>
	</aside>

	<!-- Main content -->
	<main class="flex-1 overflow-auto">
		<div class="p-8">
			{@render children()}
		</div>
	</main>
</div>
