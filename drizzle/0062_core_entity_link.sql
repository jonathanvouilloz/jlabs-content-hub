-- Transition additive vers l'identité UUID stable. Le slug et sa FK historique restent en place.
BEGIN;

ALTER TABLE "seostats"."projects"
  ADD COLUMN IF NOT EXISTS "entity_id" uuid;

UPDATE "seostats"."projects" AS project
SET "entity_id" = entity."id"
FROM "core"."entities" AS entity
WHERE project."slug" = entity."slug"
  AND project."entity_id" IS NULL;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "seostats"."projects"
    WHERE "entity_id" IS NULL
  ) THEN
    RAISE EXCEPTION '0062_core_entity_link: projets orphelins après backfill entity_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'projects_entity_id_fk'
      AND conrelid = '"seostats"."projects"'::regclass
  ) THEN
    ALTER TABLE "seostats"."projects"
      ADD CONSTRAINT "projects_entity_id_fk"
      FOREIGN KEY ("entity_id")
      REFERENCES "core"."entities"("id")
      ON DELETE RESTRICT;
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS "idx_projects_entity_id"
  ON "seostats"."projects"("entity_id");

COMMIT;
