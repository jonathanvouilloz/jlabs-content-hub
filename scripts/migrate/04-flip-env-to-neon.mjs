// Phase 6 (partiel) — repointer le .env local Turso → Neon. Idempotent, préserve l'ancien en commentaire.
// N'imprime AUCUN secret. Usage: node scripts/migrate/04-flip-env-to-neon.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from 'dotenv';

const ENV = new URL('../../.env', import.meta.url);
const INVOICES_ENV = new URL('../../../invoices/.env', import.meta.url);

// Récupère le DATABASE_URL Neon depuis invoices/.env (même base neondb)
const inv = {};
config({ path: INVOICES_ENV, processEnv: inv, quiet: true });
const neonUrl = (inv.DATABASE_URL || '').trim();
if (!neonUrl.startsWith('postgresql')) throw new Error('DATABASE_URL Neon introuvable dans invoices/.env');

let txt = readFileSync(ENV, 'utf8');
const lines = txt.split(/\r?\n/);
const stamp = '2026-07-21 migration Turso→Neon';
let flippedUrl = false, flippedToken = false, alreadyNeon = false;

const out = lines.map((line) => {
  if (/^DATABASE_URL=/.test(line)) {
    if (/^DATABASE_URL=postgresql/.test(line)) { alreadyNeon = true; return line; }
    flippedUrl = true;
    return `# [${stamp}] ancien Turso -> ${line}\nDATABASE_URL=${neonUrl}`;
  }
  if (/^DATABASE_AUTH_TOKEN=/.test(line)) {
    flippedToken = true;
    return `# [${stamp}] Turso, inutile sur Neon -> ${line}`;
  }
  return line;
});

if (alreadyNeon) { console.log('DATABASE_URL déjà postgresql (Neon) — rien à faire.'); process.exit(0); }
writeFileSync(ENV, out.join('\n'));
console.log('DATABASE_URL Turso -> Neon :', flippedUrl ? 'OK' : 'ligne introuvable');
console.log('DATABASE_AUTH_TOKEN commenté :', flippedToken ? 'OK' : 'absent');
console.log('protocole DATABASE_URL désormais :', neonUrl.split('://')[0]);
