<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { AlertTriangle, ArrowLeft, Ban, RotateCw } from 'lucide-svelte';
	import {
		CLASS_LABEL,
		KIND_LABEL,
		OUTCOME_LABEL,
		STATUS_LABEL,
		formatDbTime,
		formatDbTimestamp,
		formatDuration,
		formatRelative
	} from '$lib/utils/job-format.js';

	let { data } = $props();

	let reason = $state('');
	let busy = $state(false);
	let feedback = $state<{ tone: 'ok' | 'error'; message: string } | null>(null);

	const STATUS_TONE: Record<string, string> = {
		dead: 'bg-red-50 text-red-700 border-red-200',
		running: 'bg-blue-50 text-blue-700 border-blue-200',
		queued: 'bg-surface-50 text-surface-700 border-surface-200',
		failed: 'bg-amber-50 text-amber-700 border-amber-200',
		skipped: 'bg-violet-50 text-violet-700 border-violet-200',
		cancelled: 'bg-surface-50 text-surface-500 border-surface-200',
		succeeded: 'bg-emerald-50 text-emerald-700 border-emerald-200'
	};

	/** Raison d'une décision humaine, telle que `requeueDeadJob`/`cancelJob` l'ont journalisée. */
	function metadataReason(raw: string | null): string {
		if (!raw) return '';
		try {
			const parsed = JSON.parse(raw) as { reason?: unknown };
			return typeof parsed.reason === 'string' && parsed.reason ? parsed.reason : '';
		} catch {
			return '';
		}
	}

	async function act(action: 'requeue' | 'cancel') {
		if (!reason.trim()) {
			feedback = { tone: 'error', message: 'Une raison est requise — elle part dans le journal.' };
			return;
		}
		busy = true;
		feedback = null;
		try {
			const res = await fetch(`/api/ops/jobs/${data.job.id}/${action}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: reason.trim() })
			});
			const body = await res.json();
			if (!res.ok) {
				feedback = { tone: 'error', message: body.error ?? 'Action refusée.' };
				return;
			}
			reason = '';
			feedback = {
				tone: 'ok',
				message:
					action === 'requeue'
						? `Job remis en file (reprise n°${body.requeuedCount}). ` +
							`Il repartira au prochain tick (≤ 1 h).` +
							(body.warning ? ` ${body.warning}` : '')
						: `Job annulé.` +
							(body.wasRunning
								? ' Il tournait : le worker le découvrira à son prochain battement (≤ ~100 s) et interrompra son travail.'
								: '')
			};
			await invalidateAll();
		} catch (err) {
			feedback = { tone: 'error', message: err instanceof Error ? err.message : String(err) };
		} finally {
			busy = false;
		}
	}
</script>

<div class="mx-auto max-w-5xl">
	<a href="/jobs" class="mb-4 inline-flex items-center gap-1 text-xs text-surface-500 hover:text-surface-900">
		<ArrowLeft class="h-3 w-3" /> Retour à la file
	</a>

	<!-- En-tête -->
	<div class="rounded-lg border border-surface-200 bg-white p-5">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<div class="flex items-center gap-2">
					<h1 class="text-lg font-semibold text-surface-900">{data.job.type}</h1>
					<span
						class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold {STATUS_TONE[
							data.job.status
						] ?? 'bg-surface-50 text-surface-600 border-surface-200'}"
					>
						{STATUS_LABEL[data.job.status] ?? data.job.status}
					</span>
				</div>
				<p class="mt-1 font-mono text-[11px] text-surface-400">{data.job.id}</p>
			</div>
			<a
				href="/projects/{data.job.projectSlug}"
				class="rounded-md border border-surface-200 px-3 py-1.5 text-xs font-medium text-surface-600 hover:bg-surface-50"
			>
				{data.job.projectName}
			</a>
		</div>

		<dl class="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
			<div>
				<dt class="text-[10px] font-semibold uppercase tracking-wider text-surface-400">Tentatives</dt>
				<dd class="mt-0.5 tabular-nums text-surface-900">{data.job.attempts}/{data.job.maxAttempts}</dd>
			</div>
			<div>
				<dt class="text-[10px] font-semibold uppercase tracking-wider text-surface-400">Reports (quota)</dt>
				<dd class="mt-0.5 tabular-nums text-surface-900">{data.job.deferrals}</dd>
			</div>
			<div>
				<dt class="text-[10px] font-semibold uppercase tracking-wider text-surface-400">Reprises manuelles</dt>
				<dd class="mt-0.5 tabular-nums text-surface-900">{data.job.requeuedCount}</dd>
			</div>
			<div>
				<dt class="text-[10px] font-semibold uppercase tracking-wider text-surface-400">Priorité</dt>
				<dd class="mt-0.5 tabular-nums text-surface-900">{data.job.priority}</dd>
			</div>
			<div>
				<dt class="text-[10px] font-semibold uppercase tracking-wider text-surface-400">Créé (UTC)</dt>
				<dd class="mt-0.5 text-surface-600">{formatDbTimestamp(data.job.createdAt)}</dd>
			</div>
			<div>
				<dt class="text-[10px] font-semibold uppercase tracking-wider text-surface-400">Modifié (UTC)</dt>
				<dd class="mt-0.5 text-surface-600">{formatDbTimestamp(data.job.updatedAt)}</dd>
			</div>
			<div>
				<dt class="text-[10px] font-semibold uppercase tracking-wider text-surface-400">Disponible</dt>
				<dd class="mt-0.5 text-surface-600">
					{data.job.status === 'queued' ? formatRelative(data.job.availableAt, data.now) : '—'}
				</dd>
			</div>
			<div>
				<dt class="text-[10px] font-semibold uppercase tracking-wider text-surface-400">Bail</dt>
				<dd class="mt-0.5 truncate text-surface-600" title={data.job.leaseOwner ?? ''}>
					{data.job.leaseOwner ?? '—'}
				</dd>
			</div>
		</dl>
	</div>

	<!-- Verdict -->
	{#if data.explanation}
		<div
			class="mt-4 rounded-lg border p-4 {data.explanation.willRepeat
				? 'border-amber-200 bg-amber-50'
				: 'border-surface-200 bg-surface-50'}"
		>
			<div class="flex gap-3">
				{#if data.explanation.willRepeat}
					<AlertTriangle class="h-4 w-4 flex-shrink-0 text-amber-600" />
				{/if}
				<div>
					<p class="text-sm font-medium text-surface-900">{data.explanation.verdict}</p>
					<p class="mt-1 text-xs text-surface-600">{data.explanation.action}</p>
					{#if data.job.errorMessage}
						<pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-surface-200 bg-white p-2 text-[11px] text-surface-600">{data.job.errorMessage.slice(0, 1000)}</pre>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	<!-- Actions -->
	{#if data.canCancel || data.canRequeue}
		<div class="mt-4 rounded-lg border border-surface-200 bg-white p-4">
			<h2 class="text-sm font-semibold text-surface-900">Actions d'exploitation</h2>
			<p class="mt-0.5 text-xs text-surface-400">
				La raison est obligatoire : elle est écrite au journal avec ton identité. Le payload du job
				n'est modifiable par aucune action.
			</p>

			<div class="mt-3 flex flex-wrap items-center gap-2">
				<input
					bind:value={reason}
					placeholder="Raison (ex. « permission Google corrigée »)"
					class="min-w-64 flex-1 rounded-md border border-surface-200 px-3 py-1.5 text-xs text-surface-900"
				/>
				{#if data.canRequeue}
					<button
						onclick={() => act('requeue')}
						disabled={busy}
						class="flex items-center gap-1.5 rounded-md bg-primary-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-600 disabled:opacity-50"
					>
						<RotateCw class="h-3.5 w-3.5" /> Relancer
					</button>
				{/if}
				{#if data.canCancel}
					<button
						onclick={() => act('cancel')}
						disabled={busy}
						class="flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
					>
						<Ban class="h-3.5 w-3.5" /> Annuler
					</button>
				{/if}
			</div>

			{#if feedback}
				<p class="mt-3 text-xs {feedback.tone === 'ok' ? 'text-emerald-700' : 'text-red-700'}">
					{feedback.message}
				</p>
			{/if}

			<p class="mt-3 text-[11px] text-surface-400">
				La file est drainée au tick horaire (<code>/api/cron/tick</code>) : un job relancé repart
				donc au plus tard dans l'heure. Pour ne pas attendre :
				<code>npx tsx scripts/worker.ts --once</code>.
			</p>
		</div>
	{/if}

	<!-- Dépendances (JOB-004) — dérivées, jamais stockées -->
	{#if data.dependencies.rows.length > 0}
		<div class="mt-4 rounded-lg border border-surface-200 bg-white p-4">
			<h2 class="text-sm font-semibold text-surface-900">Dépendances</h2>
			<p class="mt-0.5 text-xs text-surface-400">
				Ce job n'est réclamable qu'une fois ses prérequis <strong>obligatoires</strong> réussis.
				Un prérequis <em>optionnel</em> en échec ne le bloque pas. Cet état est recalculé à chaque
				affichage — il ne peut pas diverger de ce que la file appliquera.
			</p>

			{#if data.dependencies.blocked}
				<p class="mt-2 rounded border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-medium text-violet-700">
					⏸ Retenu par la garde de réclamation : {data.dependencies.label}. Ce job n'est pas
					coincé — il attend son tour.
				</p>
			{/if}

			<ul class="mt-3 space-y-1.5">
				{#each data.dependencies.rows as dep (dep.jobId)}
					<li class="flex items-center gap-2 text-xs">
						<span class="w-4 text-center">
							{#if dep.satisfied}✅{:else if dep.status === 'queued' || dep.status === 'running'}⏳{:else}⛔{/if}
						</span>
						<a href="/jobs/{dep.jobId}" class="font-medium text-surface-900 hover:text-primary-600 hover:underline">
							{dep.jobType}
						</a>
						<span class="text-surface-500">
							{dep.status ? (STATUS_LABEL[dep.status] ?? dep.status) : 'introuvable'}
						</span>
						<span class="text-[10px] text-surface-400">
							{dep.required ? '(obligatoire)' : '(optionnel)'}
						</span>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- Chronologie -->
	<div class="mt-4 rounded-lg border border-surface-200 bg-white p-4">
		<h2 class="text-sm font-semibold text-surface-900">Chronologie des tentatives</h2>
		<p class="mt-0.5 text-xs text-surface-400">
			Journal append-only — c'est lui qui fait foi, pas le compteur de tentatives (une reprise le
			remet à zéro). Heures en UTC.
		</p>

		{#if data.attempts.length === 0}
			<p class="mt-3 text-xs text-surface-500">
				Aucune tentative journalisée (job antérieur au journal, ou jamais réclamé).
			</p>
		{:else}
			<ol class="mt-3 space-y-2">
				{#each data.attempts as a (a.id)}
					<li class="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-surface-100 bg-surface-50 px-3 py-2 text-xs">
						<span class="font-semibold tabular-nums text-surface-500">#{a.attemptNo}</span>
						<span class="font-medium text-surface-900">{OUTCOME_LABEL[a.outcome] ?? a.outcome}</span>
						<span class="font-mono text-[11px] text-surface-500">{a.workerId}</span>
						<span class="text-surface-500">
							{formatDbTime(a.startedAt)} → {formatDbTime(a.finishedAt)}
							{#if a.durationMs !== null}<span class="text-surface-400"> ({formatDuration(a.durationMs)})</span>{/if}
						</span>
						{#if a.abandonKind}
							<span class="rounded bg-white px-1.5 py-0.5 text-[10px] text-surface-600">
								{KIND_LABEL[a.abandonKind] ?? a.abandonKind}
							</span>
						{/if}
						{#if a.errorClass}
							<span class="rounded bg-white px-1.5 py-0.5 text-[10px] text-surface-600">
								{CLASS_LABEL[a.errorClass] ?? a.errorClass}
							</span>
						{/if}
						{#if a.errorCode}
							<span class="text-[11px] text-surface-500">{a.errorCode}</span>
						{/if}
						{#if a.heartbeatCount > 0}
							<span class="text-[11px] text-surface-400">{a.heartbeatCount} battements</span>
						{/if}
						{#if metadataReason(a.metadataJson)}
							<span class="w-full text-[11px] italic text-surface-600">« {metadataReason(a.metadataJson)} »</span>
						{/if}
					</li>
				{/each}
			</ol>
		{/if}
	</div>

	<!-- Payload, lecture seule -->
	<div class="mt-4 rounded-lg border border-surface-200 bg-white p-4">
		<h2 class="text-sm font-semibold text-surface-900">Payload &amp; identité</h2>
		<dl class="mt-2 space-y-2 text-xs">
			<div>
				<dt class="text-[10px] font-semibold uppercase tracking-wider text-surface-400">Clé d'idempotence</dt>
				<dd class="mt-0.5 break-all font-mono text-[11px] text-surface-600">{data.job.idempotencyKey}</dd>
			</div>
			{#if data.job.runId}
				<div>
					<dt class="text-[10px] font-semibold uppercase tracking-wider text-surface-400">Run</dt>
					<dd class="mt-0.5 font-mono text-[11px] text-surface-600">{data.job.runId}</dd>
				</div>
			{/if}
			<div>
				<dt class="text-[10px] font-semibold uppercase tracking-wider text-surface-400">
					Payload (lecture seule)
				</dt>
				<dd class="mt-0.5">
					<pre class="max-h-64 overflow-auto rounded border border-surface-200 bg-surface-50 p-2 text-[11px] text-surface-600">{data
							.job.payloadJson ?? '—'}</pre>
				</dd>
			</div>
		</dl>
	</div>
</div>
