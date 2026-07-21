import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { sql } from 'drizzle-orm';
import { Octokit } from 'octokit';
import * as schema from '../src/lib/server/db/schema.js';

const { contents, comments, statusHistory, cmsConnections } = schema;

const EXECUTE = process.argv.includes('--execute');
const PRESERVE_GITHUB_PREFIX = 'content/physiopommier/';
const COMMIT_MESSAGE = '[hub] chore: cleanup contenu (preservation physiopommier)';

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const db = drizzle(pool, { schema });

const octokit = new Octokit({ auth: process.env.GITHUB_PAT });
const repo = { owner: process.env.GITHUB_OWNER!, repo: process.env.GITHUB_REPO! };

function banner(label: string) {
	console.log('\n' + '─'.repeat(60));
	console.log(label);
	console.log('─'.repeat(60));
}

async function dbCounts() {
	const [c] = await db.select({ n: sql<number>`count(*)` }).from(contents);
	const [cm] = await db.select({ n: sql<number>`count(*)` }).from(comments);
	const [sh] = await db.select({ n: sql<number>`count(*)` }).from(statusHistory);
	const [cms] = await db.select({ n: sql<number>`count(*)` }).from(cmsConnections);
	const byType = await db
		.select({ type: contents.type, n: sql<number>`count(*)` })
		.from(contents)
		.groupBy(contents.type);
	return {
		contents: Number(c.n),
		comments: Number(cm.n),
		statusHistory: Number(sh.n),
		cmsConnections: Number(cms.n),
		byType: byType.map((r) => ({ type: r.type, n: Number(r.n) }))
	};
}

async function listGithubContentTree(): Promise<{ toDelete: string[]; preserved: string[] }> {
	const { data: ref } = await octokit.rest.git.getRef({ ...repo, ref: 'heads/main' });
	const headSha = ref.object.sha;
	const { data: commit } = await octokit.rest.git.getCommit({ ...repo, commit_sha: headSha });
	const { data: tree } = await octokit.rest.git.getTree({
		...repo,
		tree_sha: commit.tree.sha,
		recursive: 'true'
	});
	if (tree.truncated) {
		throw new Error('GitHub tree truncated — too many files; cannot enumerate safely.');
	}
	const toDelete: string[] = [];
	const preserved: string[] = [];
	for (const item of tree.tree) {
		if (item.type !== 'blob' || !item.path) continue;
		if (!item.path.startsWith('content/')) continue;
		if (item.path.startsWith(PRESERVE_GITHUB_PREFIX)) preserved.push(item.path);
		else toDelete.push(item.path);
	}
	return { toDelete, preserved };
}

async function bulkDeleteOnGithub(paths: string[]) {
	const { data: ref } = await octokit.rest.git.getRef({ ...repo, ref: 'heads/main' });
	const headSha = ref.object.sha;
	const { data: parentCommit } = await octokit.rest.git.getCommit({
		...repo,
		commit_sha: headSha
	});

	const { data: newTree } = await octokit.rest.git.createTree({
		...repo,
		base_tree: parentCommit.tree.sha,
		tree: paths.map((p) => ({
			path: p,
			mode: '100644',
			type: 'blob',
			sha: null
		}))
	});

	const { data: newCommit } = await octokit.rest.git.createCommit({
		...repo,
		message: COMMIT_MESSAGE,
		tree: newTree.sha,
		parents: [headSha]
	});

	await octokit.rest.git.updateRef({
		...repo,
		ref: 'heads/main',
		sha: newCommit.sha
	});

	console.log(`Single commit ${newCommit.sha.slice(0, 7)} pushed to main`);
}

async function main() {
	console.log(`Mode: ${EXECUTE ? 'EXECUTE (destructive)' : 'DRY-RUN (read-only)'}`);
	console.log(`DB: ${process.env.DATABASE_URL}`);
	console.log(`GitHub: ${repo.owner}/${repo.repo}`);

	banner('DB counts (before)');
	const before = await dbCounts();
	console.log(JSON.stringify(before, null, 2));

	banner('GitHub content tree');
	const { toDelete, preserved } = await listGithubContentTree();
	console.log(`Files to DELETE: ${toDelete.length}`);
	console.log(`Files PRESERVED (${PRESERVE_GITHUB_PREFIX}): ${preserved.length}`);
	if (toDelete.length > 0) {
		console.log('\nFirst 20 paths to delete:');
		toDelete.slice(0, 20).forEach((p) => console.log(`  - ${p}`));
		if (toDelete.length > 20) console.log(`  ... +${toDelete.length - 20} more`);
	}
	if (preserved.length > 0) {
		console.log('\nFirst 10 preserved:');
		preserved.slice(0, 10).forEach((p) => console.log(`  - ${p}`));
		if (preserved.length > 10) console.log(`  ... +${preserved.length - 10} more`);
	}

	if (!EXECUTE) {
		banner('DRY-RUN — no changes made');
		console.log('Re-run with --execute to apply.');
		return;
	}

	banner('EXECUTING DB deletes');
	await db.delete(comments);
	console.log('comments cleared');
	await db.delete(statusHistory);
	console.log('status_history cleared');
	await db.delete(contents);
	console.log('contents cleared');
	await db.delete(cmsConnections);
	console.log('cms_connections cleared');

	banner('EXECUTING GitHub bulk delete');
	if (toDelete.length === 0) {
		console.log('Nothing to delete on GitHub.');
	} else {
		await bulkDeleteOnGithub(toDelete);
	}

	banner('DB counts (after)');
	const after = await dbCounts();
	console.log(JSON.stringify(after, null, 2));

	banner('Done');
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
