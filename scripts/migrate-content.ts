import 'dotenv/config';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import * as schema from '../src/lib/server/db/schema.js';

const { projects, contents, statusHistory } = schema;

// ── DB connection ──────────────────────────────────────────────────
const client = createClient({
	url: process.env.DATABASE_URL!,
	authToken: process.env.DATABASE_AUTH_TOKEN
});
const db = drizzle(client, { schema });

// ── Helpers ────────────────────────────────────────────────────────
function createId(): string {
	return randomBytes(12).toString('hex');
}

function slugify(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)/g, '');
}

function parseFrontmatter(content: string): { data: Record<string, any>; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) return { data: {}, body: content };

	const raw = match[1];
	const body = match[2];
	const data: Record<string, any> = {};

	let currentKey = '';
	let currentValue = '';
	let inMultiline = false;
	let inImage = false;
	const imageData: Record<string, string> = {};

	for (const line of raw.split('\n')) {
		const trimmed = line.trimEnd();

		// Nested object (image:)
		if (/^\w+:$/.test(trimmed)) {
			if (currentKey && !inImage) data[currentKey] = parseYamlValue(currentValue.trim());
			if (trimmed === 'image:') {
				inImage = true;
				inMultiline = false;
				currentKey = '';
				currentValue = '';
				continue;
			}
		}

		if (inImage) {
			const nestedMatch = trimmed.match(/^\s+(\w+):\s*(.*)$/);
			if (nestedMatch) {
				imageData[nestedMatch[1]] = parseYamlValue(nestedMatch[2]) as string;
				continue;
			} else if (!/^\s/.test(trimmed) && trimmed !== '') {
				data['image'] = imageData;
				inImage = false;
				// fall through to process this line
			} else {
				continue;
			}
		}

		// Multiline (schema: |)
		if (inMultiline) {
			if (/^\s/.test(line) || line.trim() === '') {
				currentValue += line + '\n';
				continue;
			} else {
				data[currentKey] = currentValue.trim();
				inMultiline = false;
			}
		}

		const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
		if (kvMatch) {
			if (currentKey && !inMultiline) data[currentKey] = parseYamlValue(currentValue.trim());
			currentKey = kvMatch[1];
			currentValue = kvMatch[2];
			if (currentValue === '|') {
				inMultiline = true;
				currentValue = '';
			}
		}
	}

	if (inImage) data['image'] = imageData;
	if (currentKey) data[currentKey] = inMultiline ? currentValue.trim() : parseYamlValue(currentValue.trim());

	return { data, body: content }; // body = full file (frontmatter + content)
}

function parseYamlValue(val: string): string | string[] | number | boolean {
	if (val.startsWith('[') && val.endsWith(']')) {
		return val
			.slice(1, -1)
			.split(',')
			.map((s) => s.trim().replace(/^["']|["']$/g, ''));
	}
	if (val.startsWith('"') && val.endsWith('"')) return val.slice(1, -1);
	if (val.startsWith("'") && val.endsWith("'")) return val.slice(1, -1);
	if (val === 'true') return true;
	if (val === 'false') return false;
	if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val; // date as string
	if (/^\d+$/.test(val)) return parseInt(val, 10);
	return val;
}

const ROOT = join(import.meta.dirname, '..');

// ── Projects ───────────────────────────────────────────────────────
const PROJECT_DEFS = [
	{ name: 'Barber Concept', slug: 'barberconcept', color: '#E63946', description: 'Barbershops en Suisse romande' },
	{ name: 'Physio Pommier', slug: 'physiopommier', color: '#2A9D8F', description: 'Cabinet de physiotherapie' }
];

async function ensureProjects(): Promise<Map<string, string>> {
	const slugToId = new Map<string, string>();

	for (const def of PROJECT_DEFS) {
		const existing = await db.query.projects.findFirst({
			where: eq(projects.slug, def.slug)
		});

		if (existing) {
			slugToId.set(def.slug, existing.id);
			console.log(`  Projet existant: ${def.name} (${existing.id})`);
		} else {
			const id = createId();
			const accessToken = randomBytes(16).toString('hex');
			await db.insert(projects).values({
				id,
				name: def.name,
				slug: def.slug,
				description: def.description,
				color: def.color,
				accessToken
			});
			slugToId.set(def.slug, id);
			console.log(`  Projet cree: ${def.name} (${id})`);
		}
	}

	return slugToId;
}

// ── Articles ───────────────────────────────────────────────────────
async function migrateArticles(projectSlug: string, projectId: string): Promise<number> {
	const articlesDir = join(ROOT, projectSlug, 'articles');
	const files = await findMarkdownFiles(articlesDir);
	let count = 0;

	for (const filePath of files) {
		const raw = await readFile(filePath, 'utf-8');
		const { data } = parseFrontmatter(raw);

		const title = data.title as string;
		if (!title) {
			console.log(`  SKIP (pas de titre): ${filePath}`);
			continue;
		}

		const slug = slugify(title);
		const pubDate = data.pubDate ? String(data.pubDate) : null;
		const githubPath = relative(ROOT, filePath).replace(/\\/g, '/');

		const meta: Record<string, any> = {};
		if (data.description) meta.seo_description = data.description;
		if (data.author) meta.author = data.author;
		if (data.category) meta.category = data.category;
		if (data.image) meta.image = data.image;
		if (data.schema) meta.schema = data.schema;

		const id = createId();
		await db.insert(contents).values({
			id,
			projectId,
			type: 'article',
			title,
			slug,
			body: raw,
			status: 'published',
			plannedDate: pubDate,
			publishedAt: pubDate,
			tags: JSON.stringify(data.tags ?? []),
			meta: JSON.stringify(meta),
			githubSynced: true,
			githubPath
		});

		await db.insert(statusHistory).values({
			id: createId(),
			contentId: id,
			fromStatus: null,
			toStatus: 'published',
			changedBy: 'migration'
		});

		count++;
		console.log(`  Article: ${title} → ${slug}`);
	}

	return count;
}

async function findMarkdownFiles(dir: string): Promise<string[]> {
	const results: string[] = [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...(await findMarkdownFiles(fullPath)));
			} else if (entry.name.endsWith('.md')) {
				results.push(fullPath);
			}
		}
	} catch {
		// directory doesn't exist
	}
	return results;
}

// ── GMB ────────────────────────────────────────────────────────────
async function migrateGmb(projectSlug: string, projectId: string): Promise<number> {
	const gmbDir = join(ROOT, projectSlug, 'gmb');
	const files = await findJsonFiles(gmbDir);
	let count = 0;

	for (const filePath of files) {
		const raw = await readFile(filePath, 'utf-8');
		const posts: any[] = JSON.parse(raw);
		const githubPath = relative(ROOT, filePath).replace(/\\/g, '/');

		for (const post of posts) {
			const title = post.title as string;
			if (!title) continue;

			const scheduledDate = post.scheduled_at ? post.scheduled_at.split('T')[0] : null;
			const slug = slugify(title);

			const meta: Record<string, any> = {};
			if (post.type) meta.gmb_type = post.type;
			if (post.cta) meta.cta = post.cta;
			if (post.image_template) meta.image_template = post.image_template;
			if (post.image_style) meta.image_style = post.image_style;
			if (post.image_text) meta.image_text = post.image_text;
			if (post.image_prompt) meta.image_prompt = post.image_prompt;

			const id = createId();
			await db.insert(contents).values({
				id,
				projectId,
				type: 'gmb',
				title,
				slug,
				body: JSON.stringify(post),
				status: 'published',
				plannedDate: scheduledDate,
				publishedAt: scheduledDate,
				tags: '[]',
				meta: JSON.stringify(meta),
				githubSynced: true,
				githubPath
			});

			await db.insert(statusHistory).values({
				id: createId(),
				contentId: id,
				fromStatus: null,
				toStatus: 'published',
				changedBy: 'migration'
			});

			count++;
			console.log(`  GMB: ${title}`);
		}
	}

	return count;
}

async function findJsonFiles(dir: string): Promise<string[]> {
	const results: string[] = [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...(await findJsonFiles(fullPath)));
			} else if (entry.name.endsWith('.json')) {
				results.push(fullPath);
			}
		}
	} catch {
		// directory doesn't exist
	}
	return results;
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
	console.log('=== Migration contenu existant ===\n');

	console.log('1. Projets...');
	const slugToId = await ensureProjects();

	let totalArticles = 0;
	let totalGmb = 0;

	for (const [slug, id] of slugToId) {
		console.log(`\n2. Articles ${slug}...`);
		totalArticles += await migrateArticles(slug, id);

		console.log(`\n3. GMB ${slug}...`);
		totalGmb += await migrateGmb(slug, id);
	}

	console.log(`\n=== Termine ===`);
	console.log(`Projets: ${slugToId.size}`);
	console.log(`Articles: ${totalArticles}`);
	console.log(`GMB: ${totalGmb}`);
	console.log(`Total: ${totalArticles + totalGmb} contenus migres`);

	process.exit(0);
}

main().catch((err) => {
	console.error('Erreur migration:', err);
	process.exit(1);
});
