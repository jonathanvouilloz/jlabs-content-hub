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
	<div class="card preset-outlined-surface-200 p-8">
		<header class="mb-8 text-center">
			<h1 class="text-2xl font-bold text-surface-900">Content Hub</h1>
			<p class="mt-1 text-sm text-surface-500">Jon Labs</p>
		</header>

		<form onsubmit={handleSubmit} class="space-y-4">
			<label class="label">
				<span class="text-sm font-medium text-surface-700">Email</span>
				<input
					type="email"
					bind:value={email}
					required
					autocomplete="email"
					class="input preset-outlined-surface-200 w-full"
					placeholder="jonathan@jonlabs.ch"
				/>
			</label>

			<label class="label">
				<span class="text-sm font-medium text-surface-700">Mot de passe</span>
				<input
					type="password"
					bind:value={password}
					required
					autocomplete="current-password"
					class="input preset-outlined-surface-200 w-full"
				/>
			</label>

			{#if error}
				<p class="text-sm text-red-600">{error}</p>
			{/if}

			<button
				type="submit"
				disabled={loading}
				class="btn preset-filled-primary-500 w-full"
			>
				{loading ? 'Connexion...' : 'Se connecter'}
			</button>
		</form>
	</div>
</div>
