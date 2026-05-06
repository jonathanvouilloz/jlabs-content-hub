<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { authClient } from '$lib/auth-client.js';
	import {
		LayoutDashboard,
		Calendar,
		FolderOpen,
		Plus,
		LogOut,
		ChevronDown,
		ChevronRight,
		FileText,
		MapPin,
		Star,
		Settings,
		BarChart3,
		ScrollText,
		TrendingUp
	} from 'lucide-svelte';
	import LinkedinIcon from '$lib/components/ui/LinkedinIcon.svelte';
	import SyncToast from '$lib/components/SyncToast.svelte';

	let { data, children } = $props();

	let collapsed = $state(false);
	let mobileOpen = $state(false);

	// Detect current project from URL
	let currentProjectSlug = $derived(() => {
		const match = $page.url.pathname.match(/^\/projects\/([^/]+)/);
		return match ? match[1] : null;
	});

	let expandedProject = $state<string | null>(null);

	// Auto-expand current project
	$effect(() => {
		const slug = currentProjectSlug();
		if (slug) expandedProject = slug;
	});

	function isActive(href: string): boolean {
		if (href === '/') return $page.url.pathname === '/';
		return $page.url.pathname === href || $page.url.pathname.startsWith(href + '/');
	}

	function isExactActive(href: string): boolean {
		return $page.url.pathname === href;
	}

	async function handleLogout() {
		await authClient.signOut();
		goto('/login');
	}

	function toggleProject(slug: string) {
		expandedProject = expandedProject === slug ? null : slug;
	}

	// Project sub-nav items
	function projectNav(slug: string) {
		return [
			{ href: `/projects/${slug}`, label: 'Vue d\'ensemble', icon: BarChart3, exact: true, linkedin: false },
			{ href: `/projects/${slug}/articles`, label: 'Articles', icon: FileText, exact: false, linkedin: false },
			{ href: `/projects/${slug}/linkedin`, label: 'LinkedIn', icon: null, exact: false, linkedin: true },
			{ href: `/projects/${slug}/gmb`, label: 'GMB', icon: MapPin, exact: false, linkedin: false },
			{ href: `/projects/${slug}/gmb-logs`, label: 'Logs GMB', icon: ScrollText, exact: false, linkedin: false },
			{ href: `/projects/${slug}/reviews`, label: 'Avis Google', icon: Star, exact: false, linkedin: false },
			{ href: `/projects/${slug}/seo-data`, label: 'SEO data', icon: TrendingUp, exact: false, linkedin: false },
			{ href: `/projects/${slug}/settings`, label: 'Parametres', icon: Settings, exact: false, linkedin: false }
		];
	}
</script>

<!-- Mobile overlay -->
{#if mobileOpen}
	<button
		class="fixed inset-0 z-40 bg-black/20 lg:hidden"
		onclick={() => (mobileOpen = false)}
		aria-label="Fermer le menu"
	></button>
{/if}

<div class="flex h-screen bg-surface-50">
	<!-- Sidebar -->
	<aside
		class="fixed inset-y-0 left-0 z-50 flex flex-col border-r border-surface-200 bg-white transition-all duration-200
			{collapsed ? 'w-14' : 'w-60'}
			{mobileOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0 lg:static"
	>
		<!-- Logo -->
		<div class="flex h-14 flex-shrink-0 items-center border-b border-surface-100 {collapsed ? 'justify-center px-0' : 'px-4'}">
			<a href="/" class="flex items-center gap-2">
				<div class="flex h-7 w-7 items-center justify-center rounded-md bg-primary-500 text-xs font-bold text-white flex-shrink-0">
					JL
				</div>
				{#if !collapsed}
					<span class="text-sm font-semibold text-surface-900">Content Hub</span>
				{/if}
			</a>
		</div>

		<!-- Main nav -->
		<nav class="flex-1 overflow-y-auto {collapsed ? 'px-1.5' : 'px-2.5'} py-3">
			<!-- Dashboard -->
			<a
				href="/"
				class="mb-0.5 flex items-center gap-2.5 rounded-md {collapsed ? 'justify-center px-0 py-2' : 'px-2.5 py-1.5'} text-sm font-medium transition-colors
					{isExactActive('/') ? 'bg-surface-100 text-surface-900' : 'text-surface-500 hover:bg-surface-50 hover:text-surface-900'}"
				title={collapsed ? 'Dashboard' : undefined}
			>
				<LayoutDashboard size={16} class="flex-shrink-0" />
				{#if !collapsed}<span>Dashboard</span>{/if}
			</a>

			<!-- Calendar -->
			<a
				href="/calendar"
				class="mb-0.5 flex items-center gap-2.5 rounded-md {collapsed ? 'justify-center px-0 py-2' : 'px-2.5 py-1.5'} text-sm font-medium transition-colors
					{isActive('/calendar') ? 'bg-surface-100 text-surface-900' : 'text-surface-500 hover:bg-surface-50 hover:text-surface-900'}"
				title={collapsed ? 'Calendrier' : undefined}
			>
				<Calendar size={16} class="flex-shrink-0" />
				{#if !collapsed}<span>Calendrier</span>{/if}
			</a>

			<!-- Separator -->
			<div class="my-3 border-t border-surface-100"></div>

			<!-- Projects section -->
			{#if !collapsed}
				<div class="mb-1.5 flex items-center justify-between px-2.5">
					<span class="text-[10px] font-semibold uppercase tracking-wider text-surface-400">Projets</span>
					<a
						href="/projects/new"
						class="rounded p-0.5 text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-700"
						title="Nouveau projet"
					>
						<Plus size={14} />
					</a>
				</div>
			{:else}
				<div class="mb-1.5 flex justify-center">
					<a
						href="/projects"
						class="rounded p-1 text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-700"
						title="Projets"
					>
						<FolderOpen size={16} />
					</a>
				</div>
			{/if}

			<!-- Project list -->
			{#each data.sidebarProjects as project}
				{@const isExpanded = expandedProject === project.slug}
				{@const isInProject = currentProjectSlug() === project.slug}

				{#if collapsed}
					<a
						href="/projects/{project.slug}"
						class="mb-0.5 flex justify-center rounded-md py-2 transition-colors
							{isInProject ? 'bg-surface-100' : 'hover:bg-surface-50'}"
						title={project.name}
					>
						<span class="h-3 w-3 rounded-full flex-shrink-0" style="background-color: {project.color};"></span>
					</a>
				{:else}
					<!-- Project header -->
					<button
						onclick={() => toggleProject(project.slug)}
						class="mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors
							{isInProject ? 'text-surface-900' : 'text-surface-600 hover:bg-surface-50 hover:text-surface-900'}"
					>
						{#if isExpanded}
							<ChevronDown size={12} class="flex-shrink-0 text-surface-400" />
						{:else}
							<ChevronRight size={12} class="flex-shrink-0 text-surface-400" />
						{/if}
						<span class="h-2.5 w-2.5 rounded-full flex-shrink-0" style="background-color: {project.color};"></span>
						<span class="truncate">{project.name}</span>
					</button>

					<!-- Sub-nav -->
					{#if isExpanded}
						<div class="mb-1 ml-[18px] border-l border-surface-100 pl-2">
							{#each projectNav(project.slug) as item}
								{@const active = item.exact ? isExactActive(item.href) : isActive(item.href)}
								<a
									href={item.href}
									class="mb-px flex items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors
										{active ? 'bg-surface-100 font-medium text-surface-900' : 'text-surface-500 hover:bg-surface-50 hover:text-surface-800'}"
								>
									{#if item.linkedin}
									<LinkedinIcon size={14} />
								{:else if item.icon}
									<item.icon size={14} class="flex-shrink-0" />
								{/if}
									<span class="truncate">{item.label}</span>
								</a>
							{/each}
						</div>
					{/if}
				{/if}
			{/each}
		</nav>

		<!-- User section -->
		<div class="flex-shrink-0 border-t border-surface-100 {collapsed ? 'p-1.5' : 'p-3'}">
			{#if collapsed}
				<button
					onclick={handleLogout}
					class="flex w-full justify-center rounded-md py-2 text-surface-400 transition-colors hover:bg-surface-50 hover:text-surface-700"
					title="Deconnexion"
				>
					<LogOut size={16} />
				</button>
			{:else}
				<div class="flex items-center gap-2.5">
					<div class="flex h-7 w-7 items-center justify-center rounded-full bg-surface-200 text-xs font-medium text-surface-600 flex-shrink-0">
						{data.user.name?.charAt(0) ?? 'J'}
					</div>
					<span class="flex-1 truncate text-sm text-surface-600">{data.user.name}</span>
					<button
						onclick={handleLogout}
						class="rounded p-1 text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-700"
						title="Deconnexion"
					>
						<LogOut size={14} />
					</button>
				</div>
			{/if}
		</div>
	</aside>

	<!-- Mobile hamburger -->
	<button
		onclick={() => (mobileOpen = !mobileOpen)}
		class="fixed left-3 top-3 z-30 rounded-md bg-white p-2 shadow-sm border border-surface-200 lg:hidden"
		aria-label="Menu"
	>
		<svg class="h-5 w-5 text-surface-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
		</svg>
	</button>

	<!-- Main content -->
	<main class="flex-1 flex flex-col overflow-hidden">
		<div class="flex-1 overflow-auto px-6 py-6 lg:px-8">
			{@render children()}
		</div>
	</main>
</div>

<SyncToast />
