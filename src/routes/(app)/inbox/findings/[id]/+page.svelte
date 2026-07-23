<script lang="ts">
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { ArrowLeft } from 'lucide-svelte';
	import { formatDbTimestamp, formatRelative } from '$lib/utils/job-format.js';
	import {
		ACTION_LABEL,
		FINDING_EVENT_LABEL,
		FINDING_STATUS_LABEL,
		FINDING_TYPE_LABEL,
		PROPOSAL_STATUS_LABEL,
		SEVERITY_LABEL,
		prettyJson,
		priorityBand
	} from '$lib/utils/proposal-format.js';

	let { data } = $props();

	let reason = $state('');
	// Valeur INITIALE du formulaire, pas une valeur suivie : `untrack` le dit
	// explicitement, sinon une navigation entre findings écraserait une durée en
	// cours de saisie (et Svelte prévient à juste titre).
	let days = $state<number>(untrack(() => data.defaultSnoozeDays));
	let category = $state('false_positive');
	let busy = $state<string | null>(null);
	let feedback = $state<{ ok: boolean; message: string } | null>(null);

	async function act(action: string) {
		if (!reason.trim()) {
			// Exigée par l'endpoint aussi : c'est la raison qui rendra le taux de faux
			// positifs mesurable. La demander ici évite un aller-retour pour rien.
			feedback = { ok: false, message: 'Une raison est requise.' };
			return;
		}
		busy = action;
		feedback = null;
		try {
			const res = await fetch(`/api/ops/findings/${data.finding.id}/transition`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					action,
					reason: reason.trim(),
					...(action === 'snooze' ? { days } : {}),
					...(action === 'dismiss' ? { category } : {})
				})
			});
			const payload = await res.json();
			if (!res.ok) {
				feedback = { ok: false, message: payload.error ?? 'Refus du serveur.' };
				return;
			}
			feedback = {
				ok: true,
				message:
					payload.note ??
					(payload.snoozedUntil
						? `En veille jusqu'au ${formatDbTimestamp(payload.snoozedUntil)} UTC.`
						: 'Transition enregistrée.')
			};
			reason = '';
			await invalidateAll();
		} catch (e) {
			feedback = { ok: false, message: e instanceof Error ? e.message : String(e) };
		} finally {
			busy = null;
		}
	}

	const evidence = $derived(prettyJson(data.finding.evidenceJson));
	const impact = $derived(prettyJson(data.finding.impactEstimateJson));
</script>

<div class="mx-auto max-w-5xl">
	<a href="/inbox?tab=findings" class="inline-flex items-center gap-1 text-xs text-surface-500 hover:text-surface-900">
		<ArrowLeft class="h-3 w-3" />
		Inbox
	</a>

	<div class="mt-3 flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-xl font-semibold text-surface-900">{data.finding.title}</h1>
			<p class="mt-0.5 text-xs text-surface-500">
				{data.project.name ?? data.project.slug ?? '—'}
				· {FINDING_TYPE_LABEL[data.finding.type] ?? data.finding.type}
				· détecté par <span class="font-medium">{data.finding.detectorVersion ?? 'détecteur'}</span>
			</p>
		</div>
		<span class="rounded-full border border-surface-200 bg-surface-50 px-3 py-1 text-xs font-semibold text-surface-700">
			{FINDING_STATUS_LABEL[data.finding.status] ?? data.finding.status}
		</span>
	</div>

	<div class="mt-4 grid gap-4 lg:grid-cols-3">
		<div class="lg:col-span-2 space-y-4">
			<!-- Les faits -->
			<div class="rounded-lg border border-surface-200 bg-white">
				<div class="border-b border-surface-100 px-3 py-2 text-xs font-medium text-surface-900">
					Les faits
				</div>
				<dl class="divide-y divide-surface-100 text-xs">
					<div class="flex gap-3 px-3 py-2">
						<dt class="w-40 flex-shrink-0 text-surface-500">Entité</dt>
						<dd class="break-all text-surface-900">
							{data.finding.entityType} · {data.finding.entityKey}
						</dd>
					</div>
					<div class="flex gap-3 px-3 py-2">
						<dt class="w-40 flex-shrink-0 text-surface-500">Sévérité · priorité</dt>
						<dd class="text-surface-900">
							{SEVERITY_LABEL[data.finding.severity] ?? data.finding.severity}
							· {data.finding.priorityScore}
							<span class="text-surface-400">({priorityBand(data.finding.priorityScore)})</span>
							{#if data.finding.priorityScore < 60}
								<div class="text-[11px] text-surface-400">
									Sous 60 : le producteur de propositions ne le retiendra pas.
								</div>
							{/if}
						</dd>
					</div>
					<div class="flex gap-3 px-3 py-2">
						<dt class="w-40 flex-shrink-0 text-surface-500">Confiance</dt>
						<dd class="text-surface-900">{data.finding.confidenceScore}</dd>
					</div>
					<div class="flex gap-3 px-3 py-2">
						<dt class="w-40 flex-shrink-0 text-surface-500">Occurrences</dt>
						<dd class="text-surface-900">
							{data.finding.occurrenceCount} · vu pour la première fois
							{formatDbTimestamp(data.finding.firstSeenAt)}, la dernière
							{formatRelative(data.finding.lastSeenAt, data.now)}
						</dd>
					</div>
					<div class="flex gap-3 px-3 py-2">
						<dt class="w-40 flex-shrink-0 text-surface-500">Empreinte</dt>
						<dd class="break-all font-mono text-[11px] text-surface-600">
							<!-- Le séparateur d'empreinte (0x1F) est NON IMPRIMABLE : rendu tel
							     quel, deux dimensions se colleraient sans qu'on le voie. -->
							{data.finding.fingerprint.split(//).join(' ∷ ')}
						</dd>
					</div>
				</dl>

				{#if evidence}
					<div class="border-t border-surface-100 px-3 py-2">
						<div class="text-[11px] font-medium text-surface-600">
							Preuves — brutes, telles que le détecteur les a écrites
						</div>
						<pre class="mt-1 overflow-x-auto rounded bg-surface-50 p-2 text-[11px] text-surface-700">{evidence}</pre>
					</div>
				{/if}
				{#if impact}
					<div class="border-t border-surface-100 px-3 py-2">
						<div class="text-[11px] font-medium text-surface-600">Impact estimé</div>
						<pre class="mt-1 overflow-x-auto rounded bg-surface-50 p-2 text-[11px] text-surface-700">{impact}</pre>
					</div>
				{/if}
				<p class="border-t border-surface-100 px-3 py-2 text-[11px] text-surface-400">
					Aucune synthèse IA sur cette page : tout ce qui est affiché ici est déterministe et
					rattaché à sa source.
				</p>
			</div>

			<!-- Journal -->
			<div class="rounded-lg border border-surface-200 bg-white">
				<div class="border-b border-surface-100 px-3 py-2 text-xs font-medium text-surface-900">
					Journal
				</div>
				<ul class="divide-y divide-surface-100">
					{#each data.events as e (e.id)}
						<li class="flex flex-wrap gap-x-2 px-3 py-1.5 text-[11px]">
							<span class="w-32 flex-shrink-0 text-surface-400">{formatDbTimestamp(e.createdAt)}</span>
							<span class="font-medium text-surface-900">{FINDING_EVENT_LABEL[e.eventType] ?? e.eventType}</span>
							{#if e.fromStatus && e.toStatus}
								<span class="text-surface-400">{e.fromStatus} → {e.toStatus}</span>
							{/if}
							<span class="text-surface-400">{e.actor}</span>
							{#if e.reason}<span class="text-surface-600">— {e.reason}</span>{/if}
						</li>
					{/each}
				</ul>
			</div>
		</div>

		<div class="space-y-4">
			<!-- Contester / faire avancer -->
			<div class="rounded-lg border border-surface-200 bg-white p-3">
				<div class="text-xs font-medium text-surface-900">Décider</div>
				<textarea
					bind:value={reason}
					rows="3"
					placeholder="Raison (obligatoire)"
					class="mt-2 w-full rounded-md border border-surface-200 px-2 py-1.5 text-xs text-surface-900"
				></textarea>

				<div class="mt-2 flex flex-wrap gap-2">
					<label class="flex items-center gap-1 text-[11px] text-surface-500">
						Veille
						<input
							type="number"
							bind:value={days}
							min="1"
							class="w-16 rounded border border-surface-200 px-1.5 py-0.5 text-xs"
						/>
						j
					</label>
					<label class="flex items-center gap-1 text-[11px] text-surface-500">
						Motif d'écart
						<select bind:value={category} class="rounded border border-surface-200 px-1.5 py-0.5 text-xs">
							<option value="false_positive">faux positif</option>
							<option value="wont_fix">wont fix</option>
							<option value="by_design">par design</option>
							<option value="duplicate">doublon</option>
						</select>
					</label>
				</div>

				<div class="mt-2 flex flex-col gap-1.5">
					{#each data.actions as a (a.key)}
						<button
							onclick={() => act(a.key)}
							disabled={busy !== null}
							class="rounded-md border border-surface-200 px-3 py-1.5 text-xs font-medium text-surface-700 transition-colors hover:bg-surface-50 disabled:opacity-50"
						>
							{busy === a.key ? '…' : a.label}
						</button>
					{/each}
				</div>

				{#if data.finding.status === 'snoozed'}
					<p class="mt-2 text-[11px] text-surface-400">
						En veille : ni une re-détection ni une aggravation ne la rompent — seule l'échéance ou
						une décision explicite.
					</p>
				{/if}

				{#if feedback}
					<p class="mt-2 text-[11px] {feedback.ok ? 'text-emerald-700' : 'text-red-700'}">
						{feedback.message}
					</p>
				{/if}
			</div>

			<!-- Ce que ce finding a produit -->
			<div class="rounded-lg border border-surface-200 bg-white">
				<div class="border-b border-surface-100 px-3 py-2 text-xs font-medium text-surface-900">
					Propositions issues
				</div>
				{#if data.proposals.length === 0}
					<p class="px-3 py-2 text-[11px] text-surface-400">
						Aucune : soit le type de finding n'a pas encore d'action associée, soit sa priorité est
						sous le seuil du producteur.
					</p>
				{:else}
					<ul class="divide-y divide-surface-100">
						{#each data.proposals as p (p.id)}
							<li class="px-3 py-2 text-[11px]">
								<a href="/inbox/proposals/{p.id}" class="font-medium text-surface-900 hover:text-primary-600 hover:underline">
									{ACTION_LABEL[p.actionType] ?? p.actionType}
								</a>
								<div class="text-surface-400">
									{PROPOSAL_STATUS_LABEL[p.status] ?? p.status} · {p.requiredApprovalLevel} ·
									{formatDbTimestamp(p.updatedAt)}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>
</div>
