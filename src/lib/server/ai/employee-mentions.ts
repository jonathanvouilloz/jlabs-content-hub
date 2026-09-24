import { getClient, getReportModel } from './llm.js';
import type { EmployeeMentionsRoster } from '../reviews/employee-mentions-state.js';

/** Extraction dédiée : aucun brouillon de réponse, aucun travail détaché. */
export async function extractEmployeeMentionCandidates(input: {
	comment: string;
	locationId: string;
	roster: EmployeeMentionsRoster;
	signal: AbortSignal;
}): Promise<unknown> {
	if (input.signal.aborted) throw new DOMException('Extraction annulée', 'AbortError');
	const roster = input.roster.employees
		.filter((employee) => employee.active && employee.locations.includes(input.locationId))
		.map((employee) => ({ name: employee.displayName, aliases: employee.aliases }));
	if (roster.length === 0 || input.comment.trim() === '') return [];

	const response = await getClient().chat.completions.create({
		model: getReportModel(),
		max_tokens: 250,
		stream: false,
		messages: [
			{ role: 'system', content: 'Extrais uniquement les personnes explicitement citées dans un avis. Retourne JSON {"mentions":[{"name": string, "sentiment":"positive"|"neutral"|"negative"}]}. Tu peux retourner un nom hors roster seulement s’il est explicitement cité; ne devine jamais.' },
			{ role: 'user', content: JSON.stringify({ roster, review: input.comment }) }
		]
	} as Parameters<ReturnType<typeof getClient>['chat']['completions']['create']>[0] & { stream: false }, { signal: input.signal });
	const raw = response.choices[0]?.message?.content;
	if (!raw) return [];
	try {
		return (JSON.parse(raw) as { mentions?: unknown }).mentions ?? [];
	} catch {
		return [];
	}
}
