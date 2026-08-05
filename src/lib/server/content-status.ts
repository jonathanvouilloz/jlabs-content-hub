export interface SessionActor {
	user: { id: string; email: string };
}

export function resolveContentStatusActor(
	session: SessionActor | null,
	machine: { id: string } | null
): string | null {
	if (session?.user) return `user:${session.user.id}:${session.user.email}`;
	if (machine) return `machine:${machine.id}`;
	return null;
}

export function planContentStatusChange(fromStatus: string, toStatus: string): {
	changed: boolean;
	fromStatus: string;
	toStatus: string;
} {
	return { changed: fromStatus !== toStatus, fromStatus, toStatus };
}
