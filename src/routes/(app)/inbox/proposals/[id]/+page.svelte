<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { ArrowLeft, Check, MessageSquare, X } from 'lucide-svelte';
	import { formatDbTimestamp, formatDuration } from '$lib/utils/job-format.js';
	import {
		ACTION_LABEL,
		FINDING_EVENT_LABEL,
		FINDING_TYPE_LABEL,
		LEVEL_APPROVER,
		LEVEL_LABEL,
		PROPOSAL_STATUS_LABEL,
		RISK_LABEL,
		SEVERITY_LABEL,
		prettyJson,
		shortHash
	} from '$lib/utils/proposal-format.js';

	let { data } = $props();

	let reason = $state('');
	let busy = $state<string | null>(null);
	let feedback = $state<{ ok: boolean; message: string } | null>(null);

	async function decide(kind: 'approve' | 'reject' | 'changes') {
		if (kind !== 'approve' && !reason.trim()) {
			feedback = { ok: false, message: 'Une raison est requise pour refuser ou demander une révision.' };
			return;
		}
		busy = kind;
		feedback = null;
		try {
			const url =
				kind === 'approve'
					? `/api/ops/proposals/${data.proposal.id}/approve`
					: `/api/ops/proposals/${data.proposal.id}/decide`;
			const body =
				kind === 'approve'
					? // Le hash AFFICHÉ est renvoyé : si le run hebdomadaire a modifié la
						// proposition entre-temps, le serveur refuse au lieu d'approuver
						// autre chose que ce qui a été lu.
						{ payloadHash: data.proposal.payloadHash }
					: {
							mode: kind === 'changes' ? 'changes' : 'reject',
							reason: reason.trim(),
							payloadHash: data.proposal.payloadHash
						};
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const payload = await res.json();
			if (!res.ok) {
				feedback = { ok: false, message: payload.error ?? 'Refus du serveur.' };
				return;
			}
			feedback = { ok: true, message: payload.note ?? 'Décision enregistrée.' };
			reason = '';
			await invalidateAll();
		} catch (e) {
			feedback = { ok: false, message: e instanceof Error ? e.message : String(e) };
		} finally {
			busy = null;
		}
	}

	const payload = $derived(prettyJson(data.proposal.payloadJson));
	const inputs = $derived(prettyJson(data.proposal.inputHashesJson));
	const evidence = $derived(prettyJson(data.finding?.evidenceJson));
	const impact = $derived(prettyJson(data.finding?.impactEstimateJson));
</script>

<div class="mx-auto max-w-5xl">
	<a href="/inbox" class="inline-flex items-center gap-1 text-xs text-surface-500 hover:text-surface-900">
		<ArrowLeft class="h-3 w-3" />
		Inbox
	</a>

	<div class="mt-3 flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-xl font-semibold text-surface-900">
				{ACTION_LABEL[data.proposal.actionType] ?? data.proposal.actionType}
			</h1>
			<p class="mt-0.5 text-xs text-surface-500">
				{data.proposal.projectName ?? data.proposal.projectSlug ?? '—'}
				· proposée par <span class="font-medium">{data.proposal.proposedBy}</span>
				· {formatDbTimestamp(data.proposal.createdAt)} UTC
			</p>
		</div>
		<span class="rounded-full border border-surface-200 bg-surface-50 px-3 py-1 text-xs font-semibold text-surface-700">
			{PROPOSAL_STATUS_LABEL[data.proposal.status] ?? data.proposal.status}
		</span>
	</div>

	<!-- Verdict : où en est cette proposition, et ce qu'il y a à faire -->
	<div class="mt-4 rounded-lg border border-surface-200 bg-white p-3">
		<p class="text-sm font-medium text-surface-900">{data.explanation.verdict}</p>
		<p class="mt-0.5 text-xs text-surface-500">{data.explanation.action}</p>
	</div>

	<div class="mt-4 grid gap-4 lg:grid-cols-3">
		<!-- Ce qui est proposé -->
		<div class="lg:col-span-2 space-y-4">
			<div class="rounded-lg border border-surface-200 bg-white">
				<div class="border-b border-surface-100 px-3 py-2 text-xs font-medium text-surface-900">
					Ce qui est proposé
				</div>
				<dl class="divide-y divide-surface-100 text-xs">
					<div class="flex gap-3 px-3 py-2">
						<dt class="w-40 flex-shrink-0 text-surface-500">Cible</dt>
						<dd class="break-all text-surface-900">{data.proposal.target ?? '—'}</dd>
					</div>
					<div class="flex gap-3 px-3 py-2">
						<dt class="w-40 flex-shrink-0 text-surface-500">Niveau requis</dt>
						<dd class="text-surface-900">
							{LEVEL_LABEL[data.proposal.requiredApprovalLevel] ?? data.proposal.requiredApprovalLevel}
							<div class="text-[11px] text-surface-400">
								{LEVEL_APPROVER[data.proposal.requiredApprovalLevel] ?? ''}
							</div>
						</dd>
					</div>
					<div class="flex gap-3 px-3 py-2">
						<dt class="w-40 flex-shrink-0 text-surface-500">Risque de l'action</dt>
						<dd class="text-surface-900">
							{RISK_LABEL[data.proposal.riskLevel ?? 'inconnu'] ?? data.proposal.riskLevel}
							<span class="text-[11px] text-surface-400">
								— il vient de ce que l'action fait, pas de la gravité du problème.
							</span>
						</dd>
					</div>
					<div class="flex gap-3 px-3 py-2">
						<dt class="w-40 flex-shrink-0 text-surface-500">Hash du payload</dt>
						<dd class="font-mono text-[11px] text-surface-700">
							{data.proposal.payloadHash}
							<div class="font-sans text-[11px] text-surface-400">
								Toute approbation est liée à CE hash : si le payload change, elle tombe.
							</div>
						</dd>
					</div>
					{#if data.proposal.rationale}
						<div class="flex gap-3 px-3 py-2">
							<dt class="w-40 flex-shrink-0 text-surface-500">Pourquoi</dt>
							<dd class="text-surface-900">{data.proposal.rationale}</dd>
						</div>
					{/if}
					{#if data.proposal.expectedImpact}
						<div class="flex gap-3 px-3 py-2">
							<dt class="w-40 flex-shrink-0 text-surface-500">Impact attendu</dt>
							<dd class="text-surface-900">{data.proposal.expectedImpact}</dd>
						</div>
					{/if}
				</dl>
				{#if payload}
					<div class="border-t border-surface-100 px-3 py-2">
						<div class="text-[11px] font-medium text-surface-600">Payload (hashé, stable)</div>
						<pre class="mt-1 overflow-x-auto rounded bg-surface-50 p-2 text-[11px] text-surface-700">{payload}</pre>
					</div>
				{/if}
				{#if inputs}
					<div class="border-t border-surface-100 px-3 py-2">
						<div class="text-[11px] font-medium text-surface-600">Signature des entrées (traçabilité)</div>
						<pre class="mt-1 overflow-x-auto rounded bg-surface-50 p-2 text-[11px] text-surface-700">{inputs}</pre>
					</div>
				{/if}
			</div>

			<!-- Les preuves : elles viennent du finding, pas de la proposition -->
			{#if data.finding}
				<div class="rounded-lg border border-surface-200 bg-white">
					<div class="flex items-center justify-between border-b border-surface-100 px-3 py-2">
						<span class="text-xs font-medium text-surface-900">Source : le finding</span>
						<a href="/inbox/findings/{data.finding.id}" class="text-[11px] text-primary-600 hover:underline">
							Ouvrir le finding
						</a>
					</div>
					<div class="px-3 py-2 text-xs">
						<div class="font-medium text-surface-900">{data.finding.title}</div>
						<div class="mt-0.5 text-[11px] text-surface-400">
							{FINDING_TYPE_LABEL[data.finding.type] ?? data.finding.type}
							· sévérité {SEVERITY_LABEL[data.finding.severity] ?? data.finding.severity}
							· priorité {data.finding.priorityScore}
							· vu {data.finding.occurrenceCount} fois
						</div>
						{#if evidence}
							<div class="mt-2 text-[11px] font-medium text-surface-600">
								Preuves (déterministes, produites par le détecteur)
							</div>
							<pre class="mt-1 overflow-x-auto rounded bg-surface-50 p-2 text-[11px] text-surface-700">{evidence}</pre>
						{/if}
						{#if impact}
							<div class="mt-2 text-[11px] font-medium text-surface-600">Impact estimé</div>
							<pre class="mt-1 overflow-x-auto rounded bg-surface-50 p-2 text-[11px] text-surface-700">{impact}</pre>
						{/if}
					</div>
				</div>
			{:else}
				<p class="text-xs text-surface-400">
					Cette proposition n'a pas de finding source : ses raisons ne sont pas rattachables à des
					preuves détectées.
				</p>
			{/if}
		</div>

		<!-- Décider -->
		<div class="space-y-4">
			<div class="rounded-lg border border-surface-200 bg-white p-3">
				<div class="text-xs font-medium text-surface-900">Décider</div>

				{#if data.abilities.approve || data.abilities.reject || data.abilities.requestChanges}
					<textarea
						bind:value={reason}
						rows="3"
						placeholder="Raison (obligatoire pour refuser ou demander une révision)"
						class="mt-2 w-full rounded-md border border-surface-200 px-2 py-1.5 text-xs text-surface-900"
					></textarea>

					<div class="mt-2 flex flex-col gap-1.5">
						{#if data.abilities.approve}
							<button
								onclick={() => decide('approve')}
								disabled={busy !== null}
								class="flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
							>
								<Check class="h-3 w-3" />
								{busy === 'approve' ? 'Approbation…' : 'Approuver'}
							</button>
						{/if}
						{#if data.abilities.requestChanges}
							<button
								onclick={() => decide('changes')}
								disabled={busy !== null}
								class="flex items-center justify-center gap-1.5 rounded-md border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 transition-colors hover:bg-violet-100 disabled:opacity-50"
							>
								<MessageSquare class="h-3 w-3" />
								Demander une révision
							</button>
						{/if}
						{#if data.abilities.reject}
							<button
								onclick={() => decide('reject')}
								disabled={busy !== null}
								class="flex items-center justify-center gap-1.5 rounded-md border border-surface-200 px-3 py-1.5 text-xs font-medium text-surface-700 transition-colors hover:bg-surface-50 disabled:opacity-50"
							>
								<X class="h-3 w-3" />
								Rejeter
							</button>
						{/if}
					</div>
				{:else}
					<p class="mt-1 text-[11px] text-surface-400">
						Aucune décision n'est possible dans cet état.
					</p>
				{/if}

				{#if feedback}
					<p class="mt-2 text-[11px] {feedback.ok ? 'text-emerald-700' : 'text-red-700'}">
						{feedback.message}
					</p>
				{/if}
			</div>

			<!-- Ce qui a déjà été décidé -->
			<div class="rounded-lg border border-surface-200 bg-white">
				<div class="border-b border-surface-100 px-3 py-2 text-xs font-medium text-surface-900">
					Approbations
				</div>
				{#if data.approvals.length === 0}
					<p class="px-3 py-2 text-[11px] text-surface-400">Aucune approbation à ce jour.</p>
				{:else}
					<ul class="divide-y divide-surface-100">
						{#each data.approvals as a (a.id)}
							<li class="px-3 py-2 text-[11px]">
								<div class="flex items-center justify-between gap-2">
									<span class="font-medium text-surface-900">{a.approverId ?? a.approverType}</span>
									<span class={a.valid ? 'text-emerald-700' : 'text-surface-400'}>
										{a.valid ? 'valide' : a.status}
									</span>
								</div>
								<div class="text-surface-400">
									{formatDbTimestamp(a.createdAt)} UTC · {a.method} · hash
									<span class="font-mono">{shortHash(a.approvedPayloadHash, 8)}</span>
									{#if !a.valid && a.approvedPayloadHash !== data.proposal.payloadHash}
										<!-- Distinction essentielle : « il y a eu une décision, elle est
										     tombée avec le payload » ≠ « il n'y a jamais eu de décision ». -->
										<span class="text-amber-700">— portait un autre payload</span>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			{#if data.agentRuns.length > 0}
				<div class="rounded-lg border border-surface-200 bg-white">
					<div class="border-b border-surface-100 px-3 py-2 text-xs font-medium text-surface-900">
						Runs d'agent
					</div>
					<ul class="divide-y divide-surface-100">
						{#each data.agentRuns as r (r.id)}
							<li class="px-3 py-2 text-[11px] text-surface-500">
								<span class="font-medium text-surface-900">{r.agentVersion ?? r.agent}</span>
								· {r.status} · {formatDbTimestamp(r.createdAt)} UTC
								{#if r.durationMs}· {formatDuration(r.durationMs)}{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	</div>

	<!-- Journal du finding : qui a décidé quoi, et pourquoi -->
	{#if data.findingEvents.length > 0}
		<div class="mt-4 rounded-lg border border-surface-200 bg-white">
			<div class="border-b border-surface-100 px-3 py-2 text-xs font-medium text-surface-900">
				Journal du finding
			</div>
			<ul class="divide-y divide-surface-100">
				{#each data.findingEvents as e (e.id)}
					<li class="flex flex-wrap gap-x-2 px-3 py-1.5 text-[11px]">
						<span class="w-32 flex-shrink-0 text-surface-400">{formatDbTimestamp(e.createdAt)}</span>
						<span class="font-medium text-surface-900">{FINDING_EVENT_LABEL[e.eventType] ?? e.eventType}</span>
						<span class="text-surface-400">{e.actor}</span>
						{#if e.reason}<span class="text-surface-600">— {e.reason}</span>{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
