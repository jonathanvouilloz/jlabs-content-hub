import { put } from '@vercel/blob';
import { env } from '$env/dynamic/private';

const SAFE_FILENAME_RE = /^[a-zA-Z0-9._-]+$/;

export function sanitizeFilename(name: string): string {
	const cleaned = name
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-zA-Z0-9._-]/g, '_');
	if (!SAFE_FILENAME_RE.test(cleaned) || cleaned === '.' || cleaned === '..') {
		throw new Error(`Invalid filename: ${name}`);
	}
	return cleaned;
}

export function buildGmbBlobPath(projectSlug: string, filename: string, date = new Date()): string {
	const cleanedSlug = projectSlug.replace(/[^a-zA-Z0-9_-]/g, '');
	if (!cleanedSlug) throw new Error(`Invalid project slug: ${projectSlug}`);
	const cleanedName = sanitizeFilename(filename);
	const yyyy = date.getUTCFullYear();
	const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
	return `gmb/${cleanedSlug}/${yyyy}/${mm}/${cleanedName}`;
}

export interface UploadInput {
	projectSlug: string;
	filename: string;
	data: Buffer | Blob | ArrayBuffer | Uint8Array;
	contentType: string;
	date?: Date;
}

export async function uploadGmbImage(input: UploadInput): Promise<{ url: string; pathname: string }> {
	if (!env.BLOB_READ_WRITE_TOKEN) {
		throw new Error('BLOB_READ_WRITE_TOKEN not configured');
	}
	const pathname = buildGmbBlobPath(input.projectSlug, input.filename, input.date);
	const blob = await put(pathname, input.data as Buffer | Blob, {
		access: 'public',
		contentType: input.contentType,
		token: env.BLOB_READ_WRITE_TOKEN,
		addRandomSuffix: false,
		allowOverwrite: true
	});
	return { url: blob.url, pathname: blob.pathname };
}
