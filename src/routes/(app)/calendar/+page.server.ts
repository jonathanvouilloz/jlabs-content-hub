import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, projects } from '$lib/server/db/schema.js';
import { eq, and, gte, lt, isNull, desc, asc } from 'drizzle-orm';

export const load: PageServerLoad = async ({ url }) => {
	// Parse month param (default: current month)
	const monthParam = url.searchParams.get('month');
	const now = new Date();
	let year: number;
	let month: number;

	if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
		const [y, m] = monthParam.split('-').map(Number);
		year = y;
		month = m;
	} else {
		year = now.getFullYear();
		month = now.getMonth() + 1;
	}

	const monthStr = `${year}-${String(month).padStart(2, '0')}`;
	const startDate = `${monthStr}-01`;

	// Compute next month start
	const nextMonth = month === 12 ? 1 : month + 1;
	const nextYear = month === 12 ? year + 1 : year;
	const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

	// Filters
	const projectFilter = url.searchParams.get('project');
	const typeFilter = url.searchParams.get('type');
	const statusFilter = url.searchParams.get('status');

	const baseConditions = [];
	if (projectFilter) baseConditions.push(eq(contents.projectId, projectFilter));
	if (typeFilter) baseConditions.push(eq(contents.type, typeFilter));
	if (statusFilter) baseConditions.push(eq(contents.status, statusFilter));

	// Query 1: Contents for the selected month
	const monthConditions = [
		gte(contents.plannedDate, startDate),
		lt(contents.plannedDate, endDate),
		...baseConditions
	];

	const monthContents = await db
		.select({
			id: contents.id,
			title: contents.title,
			type: contents.type,
			status: contents.status,
			plannedDate: contents.plannedDate,
			createdAt: contents.createdAt,
			projectName: projects.name,
			projectColor: projects.color
		})
		.from(contents)
		.leftJoin(projects, eq(contents.projectId, projects.id))
		.where(and(...monthConditions))
		.orderBy(asc(contents.plannedDate));

	// Query 2: Unplanned contents (no planned_date)
	const unplannedConditions = [isNull(contents.plannedDate), ...baseConditions];

	const unplanned = await db
		.select({
			id: contents.id,
			title: contents.title,
			type: contents.type,
			status: contents.status,
			plannedDate: contents.plannedDate,
			createdAt: contents.createdAt,
			projectName: projects.name,
			projectColor: projects.color
		})
		.from(contents)
		.leftJoin(projects, eq(contents.projectId, projects.id))
		.where(and(...unplannedConditions))
		.orderBy(desc(contents.createdAt))
		.limit(20);

	// Query 3: Projects list for filter dropdown
	const projectsList = await db
		.select({ id: projects.id, name: projects.name, color: projects.color })
		.from(projects)
		.where(eq(projects.archived, false));

	return {
		monthContents,
		unplanned,
		projects: projectsList,
		filters: {
			month: monthStr,
			project: projectFilter,
			type: typeFilter,
			status: statusFilter
		},
		year,
		month
	};
};
