/**
 * Rattrapage Barber Concept préparé le 2026-09-01.
 *
 * Périmètre : les 6 avis d'août 2026 (Europe/Zurich) encore en attente de réponse
 * (visibles, 5★, sans réponse vérifiée) après la collecte complète du 01.09.
 *
 * Alias validés par Jonathan le 2026-09-01 (roster canonique) :
 * - « imran » → Imrane (Rive)
 * - « MUGY » → Muguy (Eaux-Vives)
 * - « Brandon » → Brandon (Cornavin)
 * - « Raphaël » → Raphaël (Lausanne)
 *
 * Les mentions sont enregistrées pour les 6 avis ; les brouillons concernent les
 * 6 avis actifs, 5★, non ambigus, encore sans réponse.
 *
 * ⚠️ Catharina Guedes (Cornavin, « Felipe ») est EXCLUE : son avis est daté
 * 2026-08-31T22:03Z = 00:03 le 01.09 en Europe/Zurich → avis de septembre, pas d'août.
 */
const SIG = "\n\nL'équipe Barber Concept";

export type Mention = {
  name: string;
  sentiment: 'positive' | 'neutral' | 'negative';
};

export type ReviewPreparation = {
  reviewId: string;
  authorName: string;
  locationLabel: string;
  mentions: Mention[];
  reply?: string;
};

export const REVIEW_PREPARATIONS: ReviewPreparation[] = [
  {
    reviewId: 'AbFvOqnrDGckh411Azcbkf3K-QyYyGNjoja2iPkwqu0JvTQqg30qBOGndcMFOW1v-gGSF4ZB-g8WcQ',
    authorName: 'Hanae Nada',
    locationLabel: 'Barber Concept Rive',
    mentions: [{ name: 'Imrane', sentiment: 'positive' }],
    reply: `Merci Hanae pour ton retour ! Imrane sera ravi de savoir que sa coupe t'a plu. À très vite à Barber Concept Rive !${SIG}`
  },
  {
    reviewId: 'AbFvOqm5Pzaq39aZgzo5QBd--iWlWXSk8syi2-wX07puo46Rr9p9aWMhqDd7n-4krovYChsYWtqb0g',
    authorName: 'Aaron Dos Reis de la fuente',
    locationLabel: 'Barber Concept - Eaux Vives',
    mentions: [{ name: 'Muguy', sentiment: 'positive' }],
    reply: `Merci Aaron pour ton retour ! Muguy sera ravi de lire que sa coupe t'a plu. À très vite à Barber Concept Eaux-Vives !${SIG}`
  },
  {
    reviewId: 'AbFvOqkLRPXo9DeIIaK7jrcjglc_-V21DbktLI--UOkKZVTElGKaEqEkSE_8dP5kv4xpWBE2qEE2NA',
    authorName: 'Alexande Silva',
    locationLabel: 'Barber Concept Cornavin',
    mentions: [{ name: 'Brandon', sentiment: 'positive' }],
    reply: `Merci Alexande pour ta confiance et ce superbe témoignage ! Brandon sera ravi de lire que son écoute et son travail te donnent entièrement confiance. À très vite à Barber Concept Cornavin !${SIG}`
  },
  {
    reviewId: 'AbFvOqn23nKvOmlfu4CXJXNOVU1mDKqDfml8NcG3yuer2zcKGIeQGX0k5QkcVkI0c4beBD6OjG9UFA',
    authorName: 'Taho Melun Follot',
    locationLabel: 'Barber Concept - Lausanne',
    mentions: [{ name: 'Raphaël', sentiment: 'positive' }],
    reply: `Merci Taho pour ce retour qui fait plaisir ! Raphaël sera ravi de savoir que sa coupe t'a rendu trop frais 😄 À très vite à Barber Concept Lausanne !${SIG}`
  },
  {
    reviewId: 'AbFvOqnQkEu5u_47Y4HXq5Q6k4muCsaF3VhJtXtl2tQ9PcC9CI7z1EmTl3YI3_j36BVSDqgyX8vg',
    authorName: 'Ingrid Willener',
    locationLabel: 'Barber Concept Cornavin',
    mentions: [{ name: 'Brandon', sentiment: 'positive' }],
    reply: `Merci Ingrid pour ta fidélité ! Brandon sera ravi de savoir que chaque passage te donne toujours autant de satisfaction. À très vite à Barber Concept Cornavin !${SIG}`
  },
  {
    reviewId: 'AbFvOqnWVGV28IXnqiCtzgmK_Wr2-aykw9RHXmGyizthxrx7EV2aGPQjOuX3QPjsWe1fL8LtsDyxeg',
    authorName: 'Iván GD',
    locationLabel: 'Barber Concept Cornavin',
    mentions: [{ name: 'Brandon', sentiment: 'positive' }],
    reply: `Merci Iván pour ce superbe témoignage ! Brandon sera ravi de lire que son professionnalisme et son écoute te donnent entièrement confiance. À très vite à Barber Concept Cornavin !${SIG}`
  }
];
