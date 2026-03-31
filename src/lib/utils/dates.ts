export function formatDate(date: string | Date, locale = 'fr-CH'): string {
	return new Date(date).toLocaleDateString(locale, {
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});
}

export function toYYYYMM(date: string | Date): { yyyy: string; mm: string } {
	const d = new Date(date);
	return {
		yyyy: d.getFullYear().toString(),
		mm: (d.getMonth() + 1).toString().padStart(2, '0')
	};
}
