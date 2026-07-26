/**
 * Câblage d'un projet sur sa propriété Search Console — création + credential, en un geste.
 *
 * Le chemin produit (UI `/projects/new` puis l'onglet settings) passe par
 * `POST /api/projects`, donc par un serveur ET par `VITE_API_KEY` — absent du `.env`, si bien
 * que l'UI envoie `dev-api-key` et se prend un 401. Ce runner fait la même chose sans serveur,
 * et surtout il est REJOUABLE : chaque nouveau client se câble par une ligne de commande au lieu
 * d'une manipulation à la main dont personne ne garde la trace.
 *
 * **Le secret ne transite jamais par un fichier.** Le service account est déjà en base, chiffré,
 * pour les projets existants — tous partagent `indexing-api@jonlabs.iam.gserviceaccount.com`.
 * `--copy-credential-from` le lit sur un projet source, le déchiffre EN MÉMOIRE et le re-chiffre
 * avec un IV neuf pour le projet cible. Aucun JSON sur le disque, aucun secret dans un log :
 * seul `client_email` est affiché. C'est ce qui rend inutile toute idée de « poser le JSON dans
 * le repo et gitignorer ».
 *
 * Idempotent : un projet déjà créé est réutilisé, une credential déjà posée est mise à jour.
 *
 * Lister (à blanc) : npx tsx scripts/wire-project-gsc.ts --slug=… --name=… --site=… --dry-run
 * Câbler           : npx tsx scripts/wire-project-gsc.ts \
 *                      --slug=lecureux \
 *                      --name="Lécureux Conseil" \
 *                      --site=sc-domain:lecureux-conseil.ch \
 *                      --sitemap=https://lecureux-conseil.ch/sitemap.xml \
 *                      --copy-credential-from=jonlabs
 * Options          : --color=#00D9A3
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import { indexingCredentials, projects } from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { decryptWith, encryptWith } from '../src/lib/server/crypto-core.js';
import { createId } from '../src/lib/server/utils.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}
if (!process.env.ENCRYPTION_KEY) {
	console.error('ENCRYPTION_KEY absente (.env) : le service account est illisible. Abandon.');
	process.exit(1);
}
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const SLUG = arg('slug');
const NAME = arg('name');
const SITE_URL = arg('site') ?? null;
const SITEMAP_URL = arg('sitemap') ?? null;
const SOURCE = arg('copy-credential-from') ?? 'jonlabs';
const COLOR = arg('color') ?? '#00D9A3';

if (!SLUG) {
	console.error('--slug=<slug canonique> est obligatoire (cf. cerveau/_system/projects.yaml).');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

/**
 * La ligne `projects`, créée si besoin. `access_token` est le jeton du portail client
 * (`/view/{slug}`) : il est tiré comme le fait `POST /api/projects`, 24 octets aléatoires,
 * pour qu'un projet câblé par script soit indiscernable d'un projet câblé par l'UI.
 */
async function ensureProject(): Promise<{ id: string; created: boolean }> {
	const existing = await db.select().from(projects).where(eq(projects.slug, SLUG!)).limit(1);
	if (existing[0]) return { id: existing[0].id, created: false };

	if (!NAME) {
		throw new Error(`Projet "${SLUG}" inexistant : --name="…" est requis pour le créer.`);
	}

	// `projects.slug` est contraint par `projects_slug_fk` → `core.entities(slug)` : le registre
	// partagé fait foi (loi n°3). Sans ce contrôle, l'échec remonte en violation de FK brute, qui
	// ne dit ni quelle table ni quel geste — alors que le correctif tient en une ligne de seed.
	const entity = await db.execute(
		sql`select 1 from core.entities where slug = ${SLUG} limit 1`
	);
	const found = Array.isArray(entity) ? entity.length : ((entity as { rows?: unknown[] }).rows?.length ?? 0);
	if (!found) {
		throw new Error(
			`Slug "${SLUG}" absent de core.entities — le registre partagé le refuse.\n` +
				`  → ajoute-le dans invoices/scripts/seed.ts puis lance : cd ../invoices && npm run db:seed`
		);
	}

	const id = createId();
	if (!DRY_RUN) {
		await db.insert(projects).values({
			id,
			name: NAME,
			slug: SLUG!,
			color: COLOR,
			accessToken: randomBytes(24).toString('hex')
		});
	}
	return { id, created: true };
}

/**
 * Recopie le service account du projet source vers le projet cible.
 *
 * Déchiffrer puis re-chiffrer plutôt que copier le chiffré tel quel : le format porte un IV par
 * valeur, et réutiliser l'IV d'une autre ligne serait un mauvais réflexe à laisser dans le repo,
 * même sans conséquence ici. Le plaintext ne quitte pas la fonction.
 */
async function ensureCredential(projectId: string): Promise<{ email: string; created: boolean }> {
	const source = await db
		.select({ id: projects.id, slug: projects.slug })
		.from(projects)
		.where(eq(projects.slug, SOURCE))
		.limit(1);
	if (!source[0]) throw new Error(`Projet source "${SOURCE}" introuvable (--copy-credential-from).`);

	const srcCred = await db
		.select()
		.from(indexingCredentials)
		.where(eq(indexingCredentials.projectId, source[0].id))
		.limit(1);
	if (!srcCred[0]) throw new Error(`Le projet source "${SOURCE}" n'a pas de credential GSC.`);

	const plaintext = decryptWith(ENCRYPTION_KEY, srcCred[0].serviceAccountJson);
	const reEncrypted = encryptWith(ENCRYPTION_KEY, plaintext);
	const email = srcCred[0].serviceAccountEmail;

	const existing = await db
		.select()
		.from(indexingCredentials)
		.where(eq(indexingCredentials.projectId, projectId))
		.limit(1);

	if (existing[0]) {
		if (!DRY_RUN) {
			await db
				.update(indexingCredentials)
				.set({
					serviceAccountEmail: email,
					serviceAccountJson: reEncrypted,
					siteUrl: SITE_URL,
					sitemapUrl: SITEMAP_URL,
					updatedAt: new Date().toISOString()
				})
				.where(eq(indexingCredentials.projectId, projectId));
		}
		return { email, created: false };
	}

	if (!DRY_RUN) {
		await db.insert(indexingCredentials).values({
			id: createId(),
			projectId,
			serviceAccountEmail: email,
			serviceAccountJson: reEncrypted,
			siteUrl: SITE_URL,
			sitemapUrl: SITEMAP_URL,
			autoSubmitOnPublish: false
		});
	}
	return { email, created: true };
}

async function main(): Promise<void> {
	console.log(`${SLUG} · source credential : ${SOURCE}${DRY_RUN ? ' · DRY-RUN' : ''}`);
	console.log('');

	const project = await ensureProject();
	console.log(`projet       ${project.created ? 'créé' : 'déjà là'} · id=${project.id}`);

	const cred = await ensureCredential(project.id);
	console.log(`credential   ${cred.created ? 'posée' : 'mise à jour'} · ${cred.email}`);
	console.log(`site_url     ${SITE_URL ?? '(aucun — la collecte GSC restera impossible)'}`);
	console.log(`sitemap_url  ${SITEMAP_URL ?? '(aucun)'}`);
	console.log('');
	console.log(
		DRY_RUN
			? '(dry-run) rien écrit.'
			: `Câblé. Vérifier : npx tsx scripts/collect-gsc.ts --project=${SLUG} --test-access`
	);
}

main()
	.catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exitCode = 1;
	})
	.finally(() => pool.end());
