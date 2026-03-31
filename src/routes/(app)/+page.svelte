<script lang="ts">
	let { data } = $props();
</script>

<div>
	<h1 class="text-2xl font-bold text-surface-900">Dashboard</h1>
	<p class="mt-1 text-surface-500">Bienvenue, {data.user.name}</p>

	<div class="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
		<div class="card preset-outlined-surface-200 p-6">
			<p class="text-sm font-medium text-surface-500">Projets</p>
			<p class="mt-2 text-3xl font-bold text-surface-900">--</p>
		</div>
		<div class="card preset-outlined-surface-200 p-6">
			<p class="text-sm font-medium text-surface-500">Drafts</p>
			<p class="mt-2 text-3xl font-bold text-surface-900">--</p>
		</div>
		<div class="card preset-outlined-surface-200 p-6">
			<p class="text-sm font-medium text-surface-500">En review</p>
			<p class="mt-2 text-3xl font-bold text-surface-900">--</p>
		</div>
		<div class="card preset-outlined-surface-200 p-6">
			<p class="text-sm font-medium text-surface-500">Publies</p>
			<p class="mt-2 text-3xl font-bold text-surface-900">--</p>
		</div>
	</div>
</div>
