-- FIND-003 — Cycle de vie, déduplication et snooze (BACKLOG E05). Phase expand, additif, idempotent.
-- Miroir fidèle de src/lib/server/db/schema.ts (table `findings`). Appliqué par scripts/apply-find-003.ts.
-- Aucune table créée, aucune donnée touchée, aucun DROP : 5 colonnes + 1 index partiel.
--
-- Ces colonnes portent le cycle de vie que DATA-005 avait laissé ouvert :
--   - `snoozed_until`/`snooze_reason` : la veille, avec son échéance et sa cause ;
--   - `consecutive_misses` : combien de fenêtres CONSÉCUTIVES le finding n'a plus été matché
--     (une seule absence ne résout jamais — confirmation multi-fenêtres, SPEC §10.3) ;
--   - `reopen_count` : les récidives (signal de qualité consommé plus tard par FIND-010) ;
--   - `dismissal_category` : la nature du « non » humain (faux positif, wont_fix…).
--
-- ⚠ Colonnes temporelles = `text` au format DB 'YYYY-MM-DD HH:MM:SS' (cf. src/lib/server/timestamps.ts).
--   Tout prédicat SQL sur `snoozed_until` doit CASTER (`snoozed_until::timestamp`) : une comparaison
--   lexicale est fausse dès que deux formats coexistent dans la colonne.

ALTER TABLE "seostats"."findings" ADD COLUMN IF NOT EXISTS "snoozed_until" text;
ALTER TABLE "seostats"."findings" ADD COLUMN IF NOT EXISTS "snooze_reason" text;
ALTER TABLE "seostats"."findings" ADD COLUMN IF NOT EXISTS "consecutive_misses" integer NOT NULL DEFAULT 0;
ALTER TABLE "seostats"."findings" ADD COLUMN IF NOT EXISTS "reopen_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "seostats"."findings" ADD COLUMN IF NOT EXISTS "dismissal_category" text;

-- Index PARTIEL : la passe d'expiration de veille ne touche que les findings snoozés.
CREATE INDEX IF NOT EXISTS "idx_findings_snoozed_until"
	ON "seostats"."findings" ("snoozed_until")
	WHERE status = 'snoozed';
