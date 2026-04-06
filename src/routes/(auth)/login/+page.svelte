<script lang="ts">
	import { authClient } from '$lib/auth-client.js';
	import { goto } from '$app/navigation';

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let loading = $state(false);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		error = '';
		loading = true;

		const result = await authClient.signIn.email({
			email,
			password
		});

		if (result.error) {
			error = result.error.message ?? 'Erreur de connexion';
			loading = false;
			return;
		}

		goto('/');
	}
</script>

<div class="w-full max-w-sm">
	<div class="rounded-lg border border-surface-200 bg-white p-8">
		<header class="mb-8 text-center">
			<div class="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-primary-500 text-sm font-bold text-white">
				JL
			</div>
			<h1 class="text-lg font-semibold text-surface-900">Content Hub</h1>
			<p class="mt-0.5 text-xs text-surface-400">Jon Labs</p>
		</header>

		<form onsubmit={handleSubmit} class="space-y-4">
			<div>
				<label for="email" class="mb-1 block text-sm font-medium text-surface-700">Email</label>
				<input
					id="email"
					type="email"
					bind:value={email}
					required
					autocomplete="email"
					class="h-10 w-full rounded-md border border-surface-200 bg-white px-3 text-sm text-surface-900 outline-none transition-colors focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
					placeholder="jonathan@jonlabs.ch"
				/>
			</div>

			<div>
				<label for="password" class="mb-1 block text-sm font-medium text-surface-700">Mot de passe</label>
				<input
					id="password"
					type="password"
					bind:value={password}
					required
					autocomplete="current-password"
					class="h-10 w-full rounded-md border border-surface-200 bg-white px-3 text-sm text-surface-900 outline-none transition-colors focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
				/>
			</div>

			{#if error}
				<p class="text-sm text-red-600">{error}</p>
			{/if}

			<button
				type="submit"
				disabled={loading}
				class="h-10 w-full rounded-md bg-primary-500 text-sm font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-50"
			>
				{loading ? 'Connexion...' : 'Se connecter'}
			</button>
		</form>
	</div>
</div>
