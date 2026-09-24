-- DATA-011 - Conserver le lien officiel Google de gestion/reponse de chaque avis.
-- Migration additive et rejouable. Le prochain collect:gmb_reviews remplit les lignes existantes.

ALTER TABLE "seostats"."gmb_reviews"
	ADD COLUMN IF NOT EXISTS "review_reply_url" text;
