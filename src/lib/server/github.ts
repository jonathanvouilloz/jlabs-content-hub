import { Octokit } from 'octokit';
import { GITHUB_PAT, GITHUB_OWNER, GITHUB_REPO } from '$env/static/private';

const octokit = new Octokit({ auth: GITHUB_PAT });

const repo = { owner: GITHUB_OWNER, repo: GITHUB_REPO };

export function buildGitHubPath(
	projectSlug: string,
	type: string,
	slug: string,
	date: string | null
): string {
	const d = date ? new Date(date) : new Date();
	const yyyy = d.getFullYear().toString();
	const mm = (d.getMonth() + 1).toString().padStart(2, '0');
	const ext = type === 'gmb' ? 'json' : 'md';
	const filename = type === 'article' ? `${slug}.${ext}` : `${date?.slice(0, 10) ?? yyyy}-${slug}.${ext}`;
	return `${projectSlug}/${type === 'article' ? 'articles' : type}/${yyyy}/${mm}/${filename}`;
}

async function getFileSha(path: string): Promise<string | null> {
	try {
		const { data } = await octokit.rest.repos.getContent({ ...repo, path });
		if (!Array.isArray(data) && 'sha' in data) return data.sha;
		return null;
	} catch {
		return null;
	}
}

export async function pushFileToGitHub(
	path: string,
	content: string,
	message: string
): Promise<boolean> {
	try {
		const sha = await getFileSha(path);
		await octokit.rest.repos.createOrUpdateFileContents({
			...repo,
			path,
			message,
			content: Buffer.from(content).toString('base64'),
			...(sha ? { sha } : {})
		});
		return true;
	} catch (error) {
		console.error(`GitHub push failed for ${path}:`, error);
		return false;
	}
}

export async function deleteFileFromGitHub(
	path: string,
	message: string
): Promise<boolean> {
	try {
		const sha = await getFileSha(path);
		if (!sha) return false;
		await octokit.rest.repos.deleteFile({
			...repo,
			path,
			message,
			sha
		});
		return true;
	} catch (error) {
		console.error(`GitHub delete failed for ${path}:`, error);
		return false;
	}
}
