<script lang="ts">
	import { page } from '$app/stores';
	import { invalidateAll } from '$app/navigation';
	import { Save, Plus, X, AlertTriangle, CheckCircle2, Loader2, Calendar } from 'lucide-svelte';

	type LayoutData = {
		profile: {
			regularHours?: string | null;
			specialHours?: string | null;
		} | null;
		locationIdParam: string;
	};

	let layout = $derived($page.data as LayoutData);

	const DAYS: { key: string; label: string }[] = [
		{ key: 'MONDAY', label: 'Lundi' },
		{ key: 'TUESDAY', label: 'Mardi' },
		{ key: 'WEDNESDAY', label: 'Mercredi' },
		{ key: 'THURSDAY', label: 'Jeudi' },
		{ key: 'FRIDAY', label: 'Vendredi' },
		{ key: 'SATURDAY', label: 'Samedi' },
		{ key: 'SUNDAY', label: 'Dimanche' }
	];

	type Slot = { open: string; close: string };
	type DayState = { closed: boolean; slots: Slot[] };

	type GooglePeriod = {
		openDay: string;
		closeDay?: string;
		openTime?: { hours?: number; minutes?: number };
		closeTime?: { hours?: number; minutes?: number };
	};

	type GoogleSpecial = {
		startDate?: { year: number; month: number; day: number };
		openTime?: { hours?: number; minutes?: number };
		endDate?: { year: number; month: number; day: number };
		closeTime?: { hours?: number; minutes?: number };
		closed?: boolean;
	};

	type SpecialUI = { date: string; closed: boolean; open: string; close: string };

	function fmtTime(t?: { hours?: number; minutes?: number }): string {
		const h = String(t?.hours ?? 0).padStart(2, '0');
		const m = String(t?.minutes ?? 0).padStart(2, '0');
		return `${h}:${m}`;
	}

	function parseRegular(raw: string | null | undefined): Record<string, DayState> {
		const base: Record<string, DayState> = Object.fromEntries(
			DAYS.map((d) => [d.key, { closed: true, slots: [] }])
		);
		if (!raw) return base;
		try {
			const parsed: { periods?: GooglePeriod[] } = JSON.parse(raw);
			for (const p of parsed.periods ?? []) {
				if (!base[p.openDay]) continue;
				base[p.openDay].closed = false;
				base[p.openDay].slots.push({ open: fmtTime(p.openTime), close: fmtTime(p.closeTime) });
			}
			return base;
		} catch {
			return base;
		}
	}

	function parseSpecial(raw: string | null | undefined): SpecialUI[] {
		if (!raw) return [];
		try {
			const parsed: { specialHourPeriods?: GoogleSpecial[] } = JSON.parse(raw);
			return (parsed.specialHourPeriods ?? []).map((s) => {
				const date = s.startDate
					? `${s.startDate.year}-${String(s.startDate.month).padStart(2, '0')}-${String(s.startDate.day).padStart(2, '0')}`
					: '';
				return {
					date,
					closed: s.closed ?? false,
					open: fmtTime(s.openTime),
					close: fmtTime(s.closeTime)
				};
			});
		} catch {
			return [];
		}
	}

	let days = $state<Record<string, DayState>>({});
	let specials = $state<SpecialUI[]>([]);
	let initialSerialized = $state('');
	let initialized = $state(false);

	$effect(() => {
		if (!initialized && layout.profile) {
			days = parseRegular(layout.profile.regularHours);
			specials = parseSpecial(layout.profile.specialHours);
			initialSerialized = JSON.stringify({ days, specials });
			initialized = true;
		}
	});

	let saving = $state(false);
	let savedAt = $state<Date | null>(null);
	let error = $state<string | null>(null);
	let showSpecials = $state(false);

	let dirty = $derived(JSON.stringify({ days, specials }) !== initialSerialized);

	function toggleDay(key: string) {
		days[key].closed = !days[key].closed;
		if (!days[key].closed && days[key].slots.length === 0) {
			days[key].slots.push({ open: '09:00', close: '18:00' });
		}
	}

	function addSlot(key: string) {
		if (days[key].slots.length >= 2) return;
		days[key].slots.push({ open: '14:00', close: '18:00' });
	}

	function removeSlot(key: string, idx: number) {
		days[key].slots.splice(idx, 1);
		if (days[key].slots.length === 0) days[key].closed = true;
	}

	function addSpecial() {
		const today = new Date().toISOString().slice(0, 10);
		specials.push({ date: today, closed: true, open: '09:00', close: '18:00' });
		showSpecials = true;
	}

	function removeSpecial(idx: number) {
		specials.splice(idx, 1);
	}

	function parseTime(t: string): { hours: number; minutes: number } {
		const [h, m] = t.split(':').map(Number);
		return { hours: h, minutes: m };
	}

	function parseDate(d: string): { year: number; month: number; day: number } | null {
		const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
		if (!m) return null;
		return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
	}

	async function save() {
		if (!dirty || saving) return;
		saving = true;
		error = null;

		// Construire payload Google
		const periods: GooglePeriod[] = [];
		for (const d of DAYS) {
			const state = days[d.key];
			if (state.closed) continue;
			for (const slot of state.slots) {
				periods.push({
					openDay: d.key,
					closeDay: d.key,
					openTime: parseTime(slot.open),
					closeTime: parseTime(slot.close)
				});
			}
		}

		const specialHourPeriods: GoogleSpecial[] = [];
		for (const s of specials) {
			const date = parseDate(s.date);
			if (!date) continue;
			const entry: GoogleSpecial = { startDate: date, endDate: date };
			if (s.closed) {
				entry.closed = true;
			} else {
				entry.openTime = parseTime(s.open);
				entry.closeTime = parseTime(s.close);
			}
			specialHourPeriods.push(entry);
		}

		try {
			const res = await fetch(
				`/api/projects/${$page.params.slug}/gmb-profile/${layout.locationIdParam}/hours`,
				{
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						regularHours: { periods },
						specialHours: { specialHourPeriods }
					})
				}
			);
			if (!res.ok) {
				const json = await res.json().catch(() => ({}));
				error = json.error ?? `Échec (${res.status})`;
			} else {
				savedAt = new Date();
				initialized = false;
				await invalidateAll();
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Erreur réseau';
		} finally {
			saving = false;
		}
	}
</script>

<div class="max-w-3xl">
	<form
		class="space-y-4 rounded-lg border border-surface-200 bg-white p-6"
		onsubmit={(e) => {
			e.preventDefault();
			save();
		}}
	>
		<h2 class="text-base font-semibold text-surface-900">Horaires d'ouverture</h2>

		<div class="space-y-2">
			{#each DAYS as day}
				{@const state = days[day.key]}
				{#if state}
					<div class="flex items-start gap-3 rounded-md border border-surface-200 px-3 py-2.5">
						<div class="flex w-28 flex-shrink-0 items-center gap-2 pt-1">
							<label class="inline-flex cursor-pointer items-center gap-2">
								<input
									type="checkbox"
									checked={!state.closed}
									onchange={() => toggleDay(day.key)}
									class="h-3.5 w-3.5"
								/>
								<span class="text-sm font-medium text-surface-700">{day.label}</span>
							</label>
						</div>

						<div class="flex-1">
							{#if state.closed}
								<span class="text-xs italic text-surface-400">Fermé</span>
							{:else}
								<div class="space-y-1.5">
									{#each state.slots as slot, idx}
										<div class="flex items-center gap-2">
											<input
												type="time"
												bind:value={slot.open}
												class="w-24 rounded-md border border-surface-200 bg-white px-2 py-1 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
											/>
											<span class="text-xs text-surface-400">–</span>
											<input
												type="time"
												bind:value={slot.close}
												class="w-24 rounded-md border border-surface-200 bg-white px-2 py-1 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
											/>
											<button
												type="button"
												onclick={() => removeSlot(day.key, idx)}
												class="rounded p-1 text-surface-400 hover:bg-surface-100 hover:text-rose-600"
												aria-label="Supprimer la plage"
											>
												<X size={12} />
											</button>
										</div>
									{/each}
									{#if state.slots.length < 2}
										<button
											type="button"
											onclick={() => addSlot(day.key)}
											class="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
										>
											<Plus size={11} />
											Ajouter une plage
										</button>
									{/if}
								</div>
							{/if}
						</div>
					</div>
				{/if}
			{/each}
		</div>

		<!-- Special hours accordion -->
		<details bind:open={showSpecials} class="rounded-md border border-surface-200">
			<summary class="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm font-medium text-surface-700 hover:bg-surface-50">
				<Calendar size={13} class="text-surface-400" />
				Horaires spéciaux ({specials.length})
			</summary>
			<div class="space-y-2 border-t border-surface-100 p-3">
				{#each specials as sp, idx (idx)}
					<div class="flex items-center gap-2 rounded-md border border-surface-200 px-3 py-2">
						<input
							type="date"
							bind:value={sp.date}
							class="rounded-md border border-surface-200 bg-white px-2 py-1 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
						/>
						<label class="inline-flex items-center gap-1 text-xs">
							<input type="checkbox" bind:checked={sp.closed} class="h-3 w-3" />
							Fermé
						</label>
						{#if !sp.closed}
							<input
								type="time"
								bind:value={sp.open}
								class="w-24 rounded-md border border-surface-200 bg-white px-2 py-1 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
							/>
							<span class="text-xs text-surface-400">–</span>
							<input
								type="time"
								bind:value={sp.close}
								class="w-24 rounded-md border border-surface-200 bg-white px-2 py-1 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
							/>
						{/if}
						<button
							type="button"
							onclick={() => removeSpecial(idx)}
							class="ml-auto rounded p-1 text-surface-400 hover:bg-surface-100 hover:text-rose-600"
							aria-label="Supprimer"
						>
							<X size={12} />
						</button>
					</div>
				{/each}
				<button
					type="button"
					onclick={addSpecial}
					class="inline-flex items-center gap-1 rounded-md border border-dashed border-surface-300 px-3 py-1.5 text-xs font-medium text-surface-600 hover:bg-surface-50"
				>
					<Plus size={12} />
					Ajouter un jour spécial (jour férié, fermeture exceptionnelle…)
				</button>
			</div>
		</details>

		{#if error}
			<div class="flex items-start gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
				<AlertTriangle size={14} class="mt-0.5 flex-shrink-0" />
				<span>{error}</span>
			</div>
		{/if}

		<div class="flex items-center justify-between border-t border-surface-100 pt-4">
			{#if savedAt && !dirty}
				<span class="inline-flex items-center gap-1 text-xs text-emerald-600">
					<CheckCircle2 size={12} />
					Enregistré
				</span>
			{:else if dirty}
				<span class="text-xs text-amber-600">Modifications non enregistrées</span>
			{:else}
				<span></span>
			{/if}
			<button
				type="submit"
				disabled={!dirty || saving}
				class="inline-flex items-center gap-1.5 rounded-md bg-primary-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{#if saving}
					<Loader2 size={14} class="animate-spin" />
					Enregistrement…
				{:else}
					<Save size={14} />
					Enregistrer
				{/if}
			</button>
		</div>
	</form>
</div>
