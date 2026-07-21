# HANDOFF — 2026-07-22 (DATA-006)

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · décision UI → [DECISIONS.md](DECISIONS.md) (2026-07-21).

## Reprendre ici
E00 sur `feat/cockpit` — fondations + IDX-008 + DATA-001→006 + MIGRATE/backfill exécuté en DB réelle. **DATA-006 FAIT (2026-07-22)** : `action_proposals` + `proposal_approvals` + `agent_runs` (SPEC §7.8/§7.9/§12) posées et **appliquées sur Neon**. Couche décision→action : une proposition porte un `payload_hash` (sha256) auquel l'approbation se lie ; **approbation = table dédiée** (hash lié + périmètre + token one-time + expiration) ; exécution/vérification **non séparées** (`execution_job_id` → table `jobs`, `verification_status`). Invariants dans le module pur `proposal-state.ts` : `canActorApprove` (agent ≤ L2, **L4 = user seul**) + `isApprovalValid` (hash égal + non expiré). Write-helper `proposals.ts` (createProposal idempotent, approveProposal transactionnel, updateProposalPayload invalide l'approbation, agent runs). `npm run test` = **115/115** · `check` = **0 err / 42 warn** · introspection = **50 tables, zéro dérive**. **Prochain = DATA-007** (`review_automation_policies` : modes draft_only/guarded_auto/manual, seuils, version, kill switch) et/ou **DATA-008** (rétention/purge, débloqué), puis la chaîne agentique aval (1er détecteur + agent réel). **CONTRACT différé** (l'app lit encore `gsc_query_page_data` + `gmb_insights_daily` ; recoupements `publish_logs`/`gmb_reviews`/`ai_jobs` non touchés). `ai_jobs → jobs` reste **écarté** (voir feature file § Décisions).
Commits : `256c1a2` IDX-008 · `d7484a9` DATA-001 · `b6df05e` DATA-002 · `1ab115f` DATA-003 · `7d3ae9c` DATA-004 · `4696919` migrate/backfill · `7cb94c1` fix chunk · `f9432ce` DATA-005 · `4c24bc9` docs DATA-005 · _(DATA-006 : à committer)_.
