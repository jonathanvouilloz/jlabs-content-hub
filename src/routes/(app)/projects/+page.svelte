<script lang="ts">
	let { data } = $props();
</script>

<div>
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-surface-900">Projets</h1>
		<a href="/projects/new" class="btn preset-filled-primary-500 text-sm">Nouveau projet</a>
	</div>

	{#if data.projects.length > 0}
		<div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.projects as project}
				<a
					href="/projects/{project.slug}"
					class="block rounded-lg border border-surface-200 bg-white p-6 transition-shadow hover:shadow-md"
				>
					<div class="flex items-center gap-3">
						<span class="h-3 w-3 rounded-full" style="background-color: {project.color};"></span>
						<h2 class="text-lg font-semibold text-surface-900">{project.name}</h2>
					</div>
					{#if project.description}
						<p class="mt-2 text-sm text-surface-500 line-clamp-2">{project.description}</p>
					{/if}
					<div class="mt-4 flex gap-4 text-xs text-surface-400">
						<span>{project.total} contenus</span>
						<span>{project.drafts ?? 0} drafts</span>
						<span>{project.published ?? 0} publies</span>
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
