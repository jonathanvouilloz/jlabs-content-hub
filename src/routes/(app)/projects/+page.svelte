<script lang="ts">
	let { data } = $props();
</script>

<div>
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-surface-900">Projets</h1>
		<a href="/projects/new" class="btn preset-filled-primary-500 text-sm">Nouveau projet</a>
	</div>

	{#if data.projects.length > 0}
		<div class="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
			{#each data.projects as project}
				<a href="/projects/{project.slug}" class="group overflow-hidden rounded-xl border border-surface-200 bg-white shadow-sm transition-shadow hover:shadow-md">
					{#if project.image}
						<img src={project.image} alt={project.name} class="h-32 w-full object-cover" />
					{:else}
						<div class="flex h-32 w-full items-center justify-center text-2xl font-bold text-white/80" style="background-color: {project.color};">
							{project.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
						</div>
					{/if}
					<div class="p-4">
						<div class="flex items-center gap-2">
							<span class="h-2.5 w-2.5 rounded-full" style="background-color: {project.color};"></span>
							<h2 class="text-sm font-semibold text-surface-900">{project.name}</h2>
						</div>
						{#if project.description}
							<p class="mt-1.5 text-xs text-surface-500 line-clamp-2">{project.description}</p>
						{/if}
						<div class="mt-3 flex gap-3 text-xs text-surface-400">
							<span>{project.total} contenus</span>
							<span>{project.drafts ?? 0} drafts</span>
						</div>
					</div>
				</a>
			{/each}
		</div>
	{:else}
		<div class="mt-6 rounded-lg border border-dashed border-surface-300 p-12 text-center">
			<p class="text-surface-500">Aucun projet</p>
			<a href="/projects/new" class="mt-2 inline-block text-sm text-primary-600 hover:underline">
				Creer un premier projet
			</a>
		</div>
	{/if}
</div>
