// Design tokens — single source of truth for the Content Hub UI

// ─── Status ──────────────────────────────────────────────────

export type Status = 'draft' | 'review' | 'approved' | 'published';

export const STATUS = {
	draft: {
		label: 'Draft',
		bg: 'bg-surface-100',
		text: 'text-surface-600',
		dot: 'bg-surface-400',
		icon: 'file-edit' as const
	},
	review: {
		label: 'Review',
		bg: 'bg-amber-50',
		text: 'text-amber-700',
		dot: 'bg-amber-500',
		icon: 'eye' as const
	},
	approved: {
		label: 'Approved',
		bg: 'bg-blue-50',
		text: 'text-blue-700',
		dot: 'bg-blue-500',
		icon: 'check-circle' as const
	},
	published: {
		label: 'Published',
		bg: 'bg-emerald-50',
		text: 'text-emerald-700',
		dot: 'bg-emerald-500',
		icon: 'globe' as const
	}
} as const;

export function statusConfig(status: string) {
	return STATUS[status as Status] ?? STATUS.draft;
}

// ─── Content types ───────────────────────────────────────────

export const CONTENT_TYPE = {
	article: { label: 'Article', icon: 'file-text' as const },
	linkedin: { label: 'LinkedIn', icon: 'linkedin' as const },
	gmb: { label: 'GMB', icon: 'map-pin' as const }
} as const;

export type ContentType = keyof typeof CONTENT_TYPE;

export function contentTypeConfig(type: string) {
	return CONTENT_TYPE[type as ContentType] ?? CONTENT_TYPE.article;
}

// ─── Rating ──────────────────────────────────────────────────

export function ratingColor(rating: number): string {
	if (rating >= 4) return 'text-emerald-500';
	if (rating === 3) return 'text-amber-500';
	return 'text-red-500';
}
