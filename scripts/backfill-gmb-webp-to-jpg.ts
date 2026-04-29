import 'dotenv/config';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq, and, like } from 'drizzle-orm';
import { put, del } from '@vercel/blob';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as schema from '../src/lib/server/db/schema.js';

const { contents, projects } = schema;

const EXECUTE = process.argv.includes('--execute');
const PROJECT_SLUG = 'barberconcept';

const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
if (!blobToken) {
	throw new Error('BLOB_READ_WRITE_TOKEN not set in env');
}

const client = createClient({
	url: process.env.DATABASE_URL!,
	authToken: process.env.DATABASE_AUTH_TOKEN
});
const db = drizzle(client, { schema });

function banner(label: string) {
	console.log('\n' + '─'.repeat(60));
	console.log(label);
	console.log('─'.repeat(60));
}

function deriveBlobPathnameFromUrl(url: string): string {
	// Vercel Blob public URL: https://{store}.public.blob.vercel-storage.com/{pathname}
	const u = new URL(url);
	return u.pathname.replace(/^\/+/, '');
}

function convertWebpToJpg(webpBytes: Buffer): Buffer {
	const tmp = mkdtempSync(join(tmpdir(), 'gmb-bf-'));
	const inPath = join(tmp, 'in.webp');
	const outPath = join(tmp, 'out.jpg');
	try {
		writeFileSync(inPath, webpBytes);
		execFileSync(
			'python',
			[
				'-c',
				[
					'import sys',
					'from PIL import Image',
					`img = Image.open(r"${inPath}")`,
					'if img.mode in ("RGBA","LA","P"):',
					'    bg = Image.new("RGB", img.size, (0,0,0))',
					'    bg.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else None)',
					'    img = bg',
					'else:',
					'    img = img.convert("RGB")',
					`img.save(r"${outPath}", "JPEG", quality=88, optimize=True)`
				].join('\n')
			],
			{ stdio: ['ignore', 'inherit', 'inherit'] }
		);
		return readFileSync(outPath);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function main() {
	banner(`Backfill GMB webp → jpg (project: ${PROJECT_SLUG}) ${EXECUTE ? '[EXECUTE]' : '[DRY RUN]'}`);

	const project = await db
		.select({ id: projects.id, name: projects.name })
		.from(projects)
		.where(eq(projects.slug, PROJECT_SLUG))
		.get();
	if (!project) throw new Error(`Project not found: ${PROJECT_SLUG}`);

	const rows = await db
		.select({ id: contents.id, slug: contents.slug, body: contents.body, status: contents.status })
		.from(contents)
		.where(
			and(
				eq(contents.projectId, project.id),
				eq(contents.type, 'gmb'),
				like(contents.body, '%.webp%')
			)
		);

	console.log(`Found ${rows.length} GMB posts referencing .webp\n`);

	let converted = 0;
	let skipped = 0;
	let errors = 0;

	for (const row of rows) {
		let body: { image_url?: string; [k: string]: unknown };
		try {
			body = JSON.parse(row.body);
		} catch {
			console.log(`✗ ${row.slug}: body is not valid JSON, skip`);
			errors++;
			continue;
		}

		const oldUrl = body.image_url;
		if (!oldUrl || !oldUrl.endsWith('.webp')) {
			console.log(`- ${row.slug}: no .webp image_url (image_url=${oldUrl ?? 'null'}), skip`);
			skipped++;
			continue;
		}

		const oldPathname = deriveBlobPathnameFromUrl(oldUrl);
		const newPathname = oldPathname.replace(/\.webp$/i, '.jpg');

		console.log(`→ ${row.slug}`);
		console.log(`  old: ${oldPathname}`);
		console.log(`  new: ${newPathname}`);

		if (!EXECUTE) {
			converted++;
			continue;
		}

		try {
			const res = await fetch(oldUrl);
			if (!res.ok) throw new Error(`fetch ${oldUrl} → ${res.status}`);
			const webpBytes = Buffer.from(await res.arrayBuffer());

			const jpgBytes = convertWebpToJpg(webpBytes);
			console.log(`  convert: ${webpBytes.length}B webp → ${jpgBytes.length}B jpg`);

			const uploaded = await put(newPathname, jpgBytes, {
				access: 'public',
				contentType: 'image/jpeg',
				token: blobToken,
				addRandomSuffix: false,
				allowOverwrite: true
			});
			console.log(`  upload: ${uploaded.url}`);

			body.image_url = uploaded.url;
			await db
				.update(contents)
				.set({ body: JSON.stringify(body), updatedAt: new Date().toISOString() })
				.where(eq(contents.id, row.id));
			console.log(`  db: image_url updated`);

			await del(oldUrl, { token: blobToken });
			console.log(`  delete: old webp removed from Blob`);

			converted++;
		} catch (e) {
			console.error(`  ✗ error: ${(e as Error).message}`);
			errors++;
		}
	}

	banner('Summary');
	console.log(`Converted : ${converted}${EXECUTE ? '' : ' (planned, dry run)'}`);
	console.log(`Skipped   : ${skipped}`);
	console.log(`Errors    : ${errors}`);
	if (!EXECUTE) {
		console.log('\nRe-run with --execute to apply changes.');
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
