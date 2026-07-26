<script lang="ts">
	import { page } from '$app/stores';

	let { children, data } = $props();

	/**
	 * DASH-003 — La barre d'onglets du cockpit projet (SPEC §13.2).
	 *
	 * ⚠️ Elle ne montre QUE ce qui existe. Les onglets de la SPEC encore sans read-model
	 * (Mots-clés, Rapports) ne sont pas affichés grisés : un onglet mort apprend à ne plus
	 * cliquer, et il ferait passer pour cassé ce qui n'est simplement pas encore écrit.
	 *
	 * « Indexation » y entre au lot 2 chantier 2 : `indexing-read.ts` et `index_selection` ont
	 * enfin un lecteur d'écran, donc l'onglet a le droit d'exister.
	 */
	const TABS = $derived([
		{ href: `/projects/${data.project.slug}`, label: "Vue d'ensemble", exact: true },
		{ href: `/projects/${data.project.slug}/windows`, label: 'Performance', exact: false },
		{ href: `/projects/${data.project.slug}/positions`, label: 'Positions', exact: false },
		{ href: `/projects/${data.project.slug}/indexing`, label: 'Indexation', exact: false },
		{ href: `/projects/${data.project.slug}/reviews`, label: 'Avis', exact: false },
		{ href: `/projects/${data.project.slug}/gmb-profile`, label: 'Présence locale', exact: false },
		{ href: `/projects/${data.project.slug}/content`, label: 'Contenus', exact: false },
		{ href: `/projects/${data.project.slug}/settings`, label: 'Paramètres', exact: false }
	]);

	const path = $derived($page.url.pathname);
	const isActive = (tab: { href: string; exact: boolean }) =>
		tab.exact ? path === tab.href : path.startsWith(tab.href);
</script>

<nav class="-mt-2 mb-4 flex gap-1 overflow-x-auto border-b border-surface-200" aria-label="Sections du projet">
	{#each TABS as tab (tab.href)}
		<a
			href={tab.href}
			aria-current={isActive(tab) ? 'page' : undefined}
			class="-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors
				{isActive(tab)
				? 'border-primary-600 font-medium text-surface-900'
				: 'border-transparent text-surface-500 hover:border-surface-300 hover:text-surface-800'}"
		>
			{tab.label}
		</a>
	{/each}
</nav>

{@render children()}
