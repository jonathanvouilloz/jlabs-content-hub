/**
 * GMB-002 — LA définition de « avis en attente », et la seule.
 *
 * Avant ce lot, onze endroits écrivaient `isNull(gmbReviews.repliedAt)` à la main : la page
 * projet, l'API projet, la file de brouillons IA, `/api/reviews/pending` (que le skill
 * `gmb-review-responder` consomme), l'accueil cross-projet, le rapport hebdo, deux vues de
 * fiche Google. Onze copies d'une règle, donc onze occasions de diverger — et elles
 * divergeaient déjà : le rapport hebdo comptait sans fenêtre ce que la page projet montrait
 * avec un tri.
 *
 * ⚠️ LE FOND DU CHANGEMENT : `replied_at` est un marqueur LOCAL (« le hub a envoyé »), et
 *    lui seul ne peut pas dire si un avis a une réponse. Une réponse écrite directement dans
 *    l'application Google Business n'y laisse aucune trace. Mesuré le 2026-07-28 :
 *    `physiopommier` porte un avis du 15 mars « en attente » depuis 4 mois et demi, avec un
 *    brouillon prêt — et personne ne peut dire s'il a été oublié ou s'il a déjà reçu sa
 *    réponse. « En attente » doit donc interroger les DEUX sources : ce que le hub croit
 *    avoir fait, ET ce que Google montre.
 *
 * Corollaire assumé : un avis dont `replied_at` est renseigné mais dont `remote_reply_at`
 * est vide **n'est pas** en attente ici. C'est la divergence GMB-007 (le hub croit avoir
 * répondu, Google ne le confirme pas) : elle mérite un traitement propre — relire la réponse
 * distante, alerter — mais certainement pas de rouvrir la file de réponse, ce qui produirait
 * une seconde réponse au même client. Le lot 2 la compte séparément (`divergent`).
 */
import { and, isNotNull, isNull, or } from 'drizzle-orm';
import { gmbReviews } from '../db/schema.js';

/**
 * Aucune réponse connue, ni locale ni distante. C'est ce qui appelle un geste.
 *
 * Utilisé par les écrans, l'API, la file de brouillons et le détecteur du lot 2 — sans quoi
 * un détecteur qui écrirait son propre SQL finirait par juger un état différent de celui que
 * l'écran affiche, et les deux se contrediraient sans que personne ne puisse arbitrer.
 */
export function pendingReviewFilter() {
	return and(isNull(gmbReviews.repliedAt), isNull(gmbReviews.remoteReplyAt));
}

/**
 * Une réponse existe, de l'une ou l'autre source. Strictement le complément du prédicat
 * ci-dessus : les deux partitionnent la table, sans trou ni recouvrement.
 *
 * `or` et non `and` : un avis répondu chez Google est répondu, que le hub l'ait su ou non.
 * L'inverse (exiger les deux) ferait réapparaître dans « à nettoyer » un avis parfaitement
 * traité dont Google n'a pas encore propagé la réponse.
 */
export function answeredReviewFilter() {
	return or(isNotNull(gmbReviews.repliedAt), isNotNull(gmbReviews.remoteReplyAt));
}
