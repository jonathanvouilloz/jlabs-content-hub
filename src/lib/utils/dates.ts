export function formatDate(date: string | Date, locale = 'fr-CH'): string {
	const d = new Date(date);
	const dayName = d.toLocaleDateString(locale, { weekday: 'long' });
	const hasTime = typeof date === 'string' && (date.includes('T') || date.includes(' ')) && d.getHours() + d.getMinutes() > 0;

	const options: Intl.DateTimeFormatOptions = {
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	};

	if (hasTime) {
		options.hour = '2-digit';
		options.minute = '2-digit';
	}

	const rest = d.toLocaleDateString(locale, options);
	return `${dayName.charAt(0).toUpperCase() + dayName.slice(1)} ${rest}`;
}

export function toYYYYMM(date: string | Date): { yyyy: string; mm: string } {
	const d = new Date(date);
	return {
		yyyy: d.getFullYear().toString(),
		mm: (d.getMonth() + 1).toString().padStart(2, '0')
	};
}
