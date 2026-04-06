<script lang="ts">
	import { Plus } from 'lucide-svelte';

	let { data } = $props();
</script>

<div>
	<div class="flex items-center justify-between">
		<h1 class="text-xl font-semibold text-surface-900">Projets</h1>
		<a
			href="/projects/new"
			class="inline-flex items-center gap-1.5 rounded-md bg-primary-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary-600"
		>
			<Plus size={14} />
			Nouveau projet
		</a>
	</div>

	{#if data.projects.length > 0}
		<div class="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.projects as project}
				<a
					href="/projects/{project.slug}"
					class="group flex items-center gap-4 rounded-lg border border-surface-200 bg-white p-4 transition-all hover:border-surface-300 hover:shadow-sm"
				>
					{#if project.image}
						<img src={project.image} alt={project.name} class="h-12 w-12 rounded-md object-cover flex-shrink-0" />
					{:else}
						<div
							class="flex h-12 w-12 items-center justify-center rounded-md text-sm font-bold text-white/90 flex-shrink-0"
							style="background-color: {project.color};"
						>
							{project.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
						</div>
					{/if}
					<div class="min-w-0 flex-1">
						<h2 class="text-sm font-semibold text-surface-900">{project.name}</h2>
						{#if project.description}
							<p class="mt-0.5 truncate text-xs text-surface-400">{project.description}</p>
						{/if}
						<div class="mt-1 flex gap-3 text-xs text-surface-400">
							<span>{project.total} contenus</span>
							{#if (project.drafts ?? 0) > 0}
								<span>{project.drafts} drafts</span>
							{/if}
							{#if (project.published ?? 0) > 0}
								<span class="text-emerald-500">{project.published} publies</span>
							{/if}
						</div>
					</div>
				</a>
			{/each}
		</div>
	{:else}
		<div class="mt-6 rounded-lg border border-dashed border-surface-200 py-12 text-center">
			<p class="text-sm text-surface-400">Aucun projet</p>
			<a href="/projects/new" class="mt-2 inline-block text-sm text-primary-600 hover:underline">
				Creer un premier projet
			</a>
		</div>
	{/if}
</div>
