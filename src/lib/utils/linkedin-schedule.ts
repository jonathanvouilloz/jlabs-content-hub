/**
 * LinkedIn optimal posting times (2026 stats)
 *
 * Best days: Mardi, Mercredi, Jeudi
 * Star moment: Mardi 9h
 * Avoid: Lundi matin <9h, Vendredi >15h, weekends
 */

const OPTIMAL_SLOTS = [
	{ dayOfWeek: 2, hour: 9, minute: 0, label: 'Mardi 9h' },
	{ dayOfWeek: 3, hour: 10, minute: 0, label: 'Mercredi 10h' },
	{ dayOfWeek: 4, hour: 9, minute: 0, label: 'Jeudi 9h' }
];

/**
 * Suggest 3 optimal dates for LinkedIn posts
 * Returns the next Mardi 9h, Mercredi 10h, Jeudi 9h
 */
export function suggestDates(fromDate?: Date): { date: string; label: string }[] {
	const now = fromDate ?? new Date();
	const results: { date: string; label: string }[] = [];

	for (const slot of OPTIMAL_SLOTS) {
		const d = new Date(now);
		const currentDay = d.getDay(); // 0=Sun, 1=Mon, 2=Tue...
		let daysUntil = slot.dayOfWeek - currentDay;

		if (daysUntil < 0) {
			daysUntil += 7;
		} else if (daysUntil === 0) {
			// Same day — check if the time has passed
			const slotTime = new Date(d);
			slotTime.setHours(slot.hour, slot.minute, 0, 0);
			if (now >= slotTime) {
				daysUntil += 7;
			}
		}

		const target = new Date(d);
		target.setDate(target.getDate() + daysUntil);
		target.setHours(slot.hour, slot.minute, 0, 0);

		results.push({
			date: toLocalISOString(target),
			label: slot.label
		});
	}

	// Sort chronologically
	results.sort((a, b) => a.date.localeCompare(b.date));

	return results;
}

function toLocalISOString(d: Date): string {
	const pad = (n: number) => n.toString().padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
