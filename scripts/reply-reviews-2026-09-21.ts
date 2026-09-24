import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { REVIEW_PREPARATIONS } from './reply-reviews-2026-09-21.data.js';
neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent');
const APPLY = process.argv.includes('--drafts-only');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const project = await pool.query<{id:string}>("select id from seostats.projects where slug='barberconcept'").then(r=>r.rows[0]);
if (!project) throw new Error('Projet absent');
const ids = REVIEW_PREPARATIONS.map(x=>x.reviewId);
type Row={review_id:string;author_name:string;location_label:string;rating:number;comment:string;create_time:string;mentioned_employees:string|null;draft_reply:string|null;replied_at:string|null;remote_reply_at:string|null};
const rows = await pool.query<Row>(`select review_id,author_name,location_label,rating,comment,create_time,mentioned_employees,draft_reply,replied_at,remote_reply_at from seostats.gmb_reviews where project_id=$1 and review_id=any($2::text[])`,[project.id,ids]).then(r=>r.rows);
if(rows.length!==ids.length) throw new Error(`Lot incomplet ${rows.length}/${ids.length}`);
const byId=new Map(rows.map(r=>[r.review_id,r]));
const expected=(item:(typeof REVIEW_PREPARATIONS)[number])=>item.mentions===null?null:JSON.stringify(item.mentions);
for(const item of REVIEW_PREPARATIONS){const row=byId.get(item.reviewId)!;if(row.author_name!==item.authorName||row.location_label!==item.locationLabel||row.rating!==5||row.create_time!==item.createTime||createHash('sha256').update(row.comment??'','utf8').digest('hex')!==item.commentSha256)throw new Error(`Snapshot divergent ${item.reviewId}`);if(row.replied_at||row.remote_reply_at)throw new Error(`Déjà publié ${item.reviewId}`);if(row.mentioned_employees!==null&&row.mentioned_employees!==expected(item))throw new Error(`Mentions divergentes ${item.reviewId}`);if(row.draft_reply!==null&&row.draft_reply!==item.reply)throw new Error(`Brouillon divergent ${item.reviewId}`)}
console.log(APPLY?'=== DRAFTS-ONLY — aucun PUT ===':'=== DRY-RUN — aucune écriture ===');
for(const item of REVIEW_PREPARATIONS){console.log(`- ${item.locationLabel} | ${item.authorName} | mentions=${item.mentions===null?`non attribuée: ${item.unresolvedMention}`:item.mentions.length?item.mentions.map(m=>`${m.name}:${m.sentiment}`).join(', '):'[]'}`);console.log(`  → ${item.reply.replace(/\n+/g,' ⏎ ')}`)}
if(!APPLY){console.log(JSON.stringify({mode:'dry-run',reviews:ids.length,unresolved:REVIEW_PREPARATIONS.filter(x=>x.mentions===null).length}));await pool.end();process.exit(0)}
const client=await pool.connect();let written=0,matching=0;try{await client.query('begin');for(const item of REVIEW_PREPARATIONS){const row=byId.get(item.reviewId)!;if(row.mentioned_employees===expected(item)&&row.draft_reply===item.reply){matching++;continue}const result=await client.query(`update seostats.gmb_reviews set mentioned_employees=$1,draft_reply=$2 where project_id=$3 and review_id=$4 and mentioned_employees is null and draft_reply is null and replied_at is null and remote_reply_at is null`,[expected(item),item.reply,project.id,item.reviewId]);if(result.rowCount!==1)throw new Error(`Écriture concurrente ${item.reviewId}`);written++}await client.query('commit');console.log(JSON.stringify({mode:'drafts-only',written,alreadyMatching:matching}))}catch(e){await client.query('rollback');throw e}finally{client.release();await pool.end()}
