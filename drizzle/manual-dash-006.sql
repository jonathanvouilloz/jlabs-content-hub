-- DASH-006 lot 2 — Journal des pauses d'automatisation. Phase expand, additif, idempotent.
-- Miroir fidèle de `automationPauses` dans src/lib/server/db/schema.ts.
-- Appliqué par scripts/apply-dash-006.ts. Aucune donnée touchée, aucun DROP.
--
-- Pourquoi une table, et pas une colonne ailleurs :
--   une pause est une DÉCISION (qui, quand, pourquoi, jusqu'à quand), pas une configuration.
--   Les deux endroits où on aurait spontanément voulu l'écrire la détruisent :
--     - `project_projections.payload.schedules.enabled` est une projection RECOMPILÉE
--       (`source_hash`, `status current|stale`). Une pause écrite là serait effacée SANS BRUIT
--       à la compilation suivante — un monitoring qui redémarre tout seul sans que personne
--       l'ait décidé est exactement l'inverse de ce que ce lot promet.
--     - `system_settings` est un KV qui se réécrit sur place : le geste précédent disparaît,
--       donc l'acceptation « pause et reprise sont auditables » devient infalsifiable.
--
-- APPEND-ONLY STRICT, calqué sur `finding_events` (SPEC §7.7) : jamais d'UPDATE, jamais de
-- DELETE. L'état effectif d'une cible se DÉRIVE de son dernier événement (`pause-state.ts`).
-- L'historique n'est pas une colonne tenue à jour à côté de la vérité — il EST la vérité.
--
-- Trois portées, une seule mécanique (`scope` + la cible correspondante) :
--   - 'project_cadence' (project_id + cadence) — « suspendre le hebdo de barberconcept » ;
--   - 'project'         (project_id)           — « geler ce client » ;
--   - 'provider'        (provider)             — « couper GSC », transverse à tous les projets.
--   Une cadence est en pause si l'une des DEUX PREMIÈRES la couvre : union, pas préséance —
--   rien à arbitrer, donc rien qui puisse diverger entre l'écran et le scheduler.
--   Une pause 'provider' ne suspend AUCUNE cadence : le run s'ouvre, seuls les jobs de ce
--   provider sont sautés. C'est l'acceptation « la désactivation d'un provider n'annule pas
--   les autres steps », littéralement.
--
-- ⚠️ AUCUNE contrainte d'unicité, VOLONTAIREMENT. Rejouer le même geste ne doit pas ÉCHOUER,
--    il ne doit RIEN ÉCRIRE : l'idempotence est portée par la transaction de
--    `recordPauseDecision` (qui relit l'état dérivé avant d'insérer), comme `approveProposal`.
--    Une contrainte transformerait un double clic en erreur au lieu d'un non-événement.
--
-- ⚠️ `until` est une ÉCHÉANCE, pas un état : son expiration se dérive à la LECTURE (même
--    discipline que `findings.snoozed_until`). Aucun job de réveil, aucune écriture au passage
--    de l'heure — donc aucun moyen qu'une pause « expirée en base » et une pause « expirée à
--    l'écran » se contredisent.
--
-- ⚠️ `project_id` est NULLABLE, et c'est porteur : NULL ⇔ scope = 'provider'. Une pause
--    provider n'appartient à aucun projet — l'attacher à l'un d'eux la rendrait invisible
--    depuis les cinq autres, alors qu'elle les coupe tous.
--
-- La table naît VIDE : appliquer ce DDL ne change aucun comportement.
-- Écart d'introspection ATTENDU : 59 → 60 tables `seostats`, et exactement celle-ci.

CREATE TABLE IF NOT EXISTS "seostats"."automation_pauses" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"project_id" text,
	"cadence" text,
	"provider" text,
	"event_type" text NOT NULL,
	"reason" text NOT NULL,
	"until" text,
	"actor" text NOT NULL DEFAULT 'system',
	"payload_json" text,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "automation_pauses_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id")
);

-- L'ordre EXACT du `DISTINCT ON` de `loadPauseStates` : dernier événement par cible, en une
-- requête, sans jamais scanner le journal entier.
CREATE INDEX IF NOT EXISTS "idx_automation_pauses_key"
	ON "seostats"."automation_pauses" ("scope", "project_id", "cadence", "provider", "created_at");

-- « Qu'a-t-on suspendu, et quand » : l'historique chronologique, toutes cibles confondues.
CREATE INDEX IF NOT EXISTS "idx_automation_pauses_created"
	ON "seostats"."automation_pauses" ("created_at");
