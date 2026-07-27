-- REP-004 lot 2 — La rétention du DÉTAIL d'un rapport publié. Additif, idempotent.
-- Miroir fidèle de `weeklyReports` dans src/lib/server/db/schema.ts.
-- Appliqué par scripts/apply-rep-004-lot2.ts. AUCUNE nouvelle table (61), aucune donnée touchée.
--
-- Le sujet : un rapport pèse ~28 kio de `payload_json`, et §7.11 range les rapports en
-- « sans limite, protégés ». Les deux tiennent ensemble si on cesse de confondre le RAPPORT
-- et son DÉTAIL : la ligne (créneau, statut, SLO, préparation, lignage) est le fait durable,
-- le payload est la matière. Ce fichier rend possible de retirer la matière SANS retirer le
-- fait — c'est l'acceptation « les liens restent valides après rétention du détail ».
--
-- ⚠️ LE POINT DU LOT EST LE CHECK, pas les colonnes. Rendre `payload_json` nullable crée un
--    état neuf — « ligne sans détail » — et cet état est dangereux exactement comme l'était
--    une section absente dans REP-001 : relu naïvement, un payload `NULL` se lirait « rapport
--    vide », c'est-à-dire douze sections non branchées pour un rapport qui en portait dix.
--    Le CHECK interdit la version muette de cet état : sans payload, la ligne DOIT porter
--    OÙ le détail est parti (`payload_archive_ref`), QUAND (`payload_purged_at`) et SON
--    EMPREINTE (`payload_digest`). Il n'existe donc aucune ligne dont le détail ait disparu
--    sans adresse. C'est la même discipline que `Availability<T>` côté code, posée en base :
--    on ne supprime pas un champ, on remplace un cas par un autre cas complet.
--
-- ⚠️ ON PURGE LE DÉTAIL, JAMAIS LA LIGNE. Aucun DELETE n'est prévu par ce lot, et deux
--    décisions antérieures en dépendaient déjà : `supersedes_id` n'a pas de FK (lot 1) et le
--    numéro de révision se dérive du `max`, jamais d'un `count(*)`. Purger des LIGNES ferait
--    mentir le second (la révision 4 s'appellerait 3 et heurterait l'unique) ; purger le
--    détail ne touche ni l'un ni l'autre.
--
-- ⚠️ `payload_archived_at` n'est pas déclaratif : il n'est écrit qu'après avoir RETROUVÉ le
--    fichier d'archive et comparé son SHA-256 à `payload_digest` (scripts/rep-004-archive.ts
--    --confirm). Sans cette vérification, la garde « on ne purge que ce qui est archivé »
--    ferait confiance à celui qui purge, et « rétention » finirait par vouloir dire « perte ».
--
-- Écart d'introspection ATTENDU : 61 → 61 tables `seostats` (aucune table créée), et sur
-- `weekly_reports` : 14 → 19 colonnes, `payload_json` passe NOT NULL → NULL, un CHECK de
-- plus (2 au total avec `weekly_reports_revision_reason_check`).

-- 1. Le détail devient retirable. Idempotent : DROP NOT NULL sur une colonne déjà nullable
--    ne lève pas.
ALTER TABLE "seostats"."weekly_reports"
	ALTER COLUMN "payload_json" DROP NOT NULL;

-- 2. Ce qui survit au détail : sa taille, son empreinte, son adresse, ses deux dates.
--    `payload_bytes` est mesuré AVANT la purge — c'est le fait qui la justifiait, et le seul
--    qui puisse encore dire ce que la ligne portait.
ALTER TABLE "seostats"."weekly_reports"
	ADD COLUMN IF NOT EXISTS "payload_bytes" integer;

ALTER TABLE "seostats"."weekly_reports"
	ADD COLUMN IF NOT EXISTS "payload_digest" text;

ALTER TABLE "seostats"."weekly_reports"
	ADD COLUMN IF NOT EXISTS "payload_archived_at" text;

ALTER TABLE "seostats"."weekly_reports"
	ADD COLUMN IF NOT EXISTS "payload_archive_ref" text;

ALTER TABLE "seostats"."weekly_reports"
	ADD COLUMN IF NOT EXISTS "payload_purged_at" text;

-- 3. LE CHECK. Trois états légaux, et un seul état interdit — celui du détail disparu sans
--    laisser d'adresse :
--      (a) détail présent, jamais purgé                → le cas nominal ;
--      (b) détail présent, archivé (pas encore purgé)  → couvert par (a) : archiver n'enlève rien ;
--      (c) détail absent + purgé + archivé + empreinte + adresse → la ligne purgée, complète.
--    Postgres n'a pas d'ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		 WHERE conname = 'weekly_reports_payload_presence_check'
		   AND conrelid = '"seostats"."weekly_reports"'::regclass
	) THEN
		ALTER TABLE "seostats"."weekly_reports"
			ADD CONSTRAINT "weekly_reports_payload_presence_check"
			CHECK (
				("payload_json" IS NOT NULL AND "payload_purged_at" IS NULL)
				OR (
					"payload_json" IS NULL
					AND "payload_purged_at" IS NOT NULL
					AND "payload_archived_at" IS NOT NULL
					AND "payload_archive_ref" IS NOT NULL
					AND "payload_digest" IS NOT NULL
				)
			);
	END IF;
END
$$;

-- Aucun index ajouté : la sélection des purgeables balaie `weekly_reports` en entier (une
-- ligne par semaine, quelques centaines à horizon de plusieurs années). Un index partiel sur
-- `payload_purged_at IS NULL` coûterait plus en écriture qu'il ne rapporterait sur un
-- balayage annuel.
