/** Classement sans publication de l'avis 1★ Ahmet Kaplan (Cornavin, 2026-09-07). */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent');
const APPLY = process.argv.includes('--apply');
const id = 'AbFvOqk2E0vgVkOrgukTu3SD8rLGjlvQJI7VHJYY07yheCUPGyETRdh5o7sj2kyjeUbvIClSeIlg';
const sha = 'd9d0bc8fcabe23137eb041139feef6be7c0374d94ff2ebde0f0f4ec0026c0119';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const project = await pool.query<{ id: string }>("select id from seostats.projects where slug = 'barberconcept'").then(r => r.rows[0]);
if (!project) throw new Error('Projet absent');
const row = await pool.query<{ rating:number; author_name:string; location_label:string; comment:string; mentioned_employees:string|null; replied_at:string|null; remote_reply_at:string|null }>(
  `select rating, author_name, location_label, comment, mentioned_employees, replied_at, remote_reply_at from seostats.gmb_reviews where project_id=$1 and review_id=$2`, [project.id,id]
).then(r=>r.rows[0]);
if (!row || row.rating !== 1 || row.author_name !== 'Ahmet Kaplan' || row.location_label !== 'Barber Concept Cornavin' || createHash('sha256').update(row.comment ?? '', 'utf8').digest('hex') !== sha) throw new Error('Snapshot Ahmet divergent');
if (row.replied_at || row.remote_reply_at) throw new Error('Avis déjà traité publiquement');
if (row.mentioned_employees !== null && row.mentioned_employees !== '[]') throw new Error('Mentions existantes divergentes');
if (!APPLY) { console.log(JSON.stringify({mode:'dry-run', review:id, mentions:[], publicReply:false})); await pool.end(); process.exit(0); }
if (row.mentioned_employees === '[]') { console.log(JSON.stringify({mode:'apply', written:0, alreadyMatching:1})); await pool.end(); process.exit(0); }
const updated = await pool.query(`update seostats.gmb_reviews set mentioned_employees='[]' where project_id=$1 and review_id=$2 and mentioned_employees is null and replied_at is null and remote_reply_at is null`,[project.id,id]);
if (updated.rowCount !== 1) throw new Error('Écriture concurrente');
console.log(JSON.stringify({mode:'apply', written:1, mentions:[], publicReply:false}));
await pool.end();
