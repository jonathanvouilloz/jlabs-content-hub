/**
 * Barber Concept — résolution Ilias, 2 septembre 2026.
 *
 * Jonathan confirme qu'Ilias est un nouveau barbier actif à Rive.
 * Cet artefact complète sans modifier le lot initial du 2 septembre.
 */
const SIG = "\n\nL'équipe Barber Concept";

export const ILIAS_REVIEW_PREPARATIONS = [
  {
    reviewId: 'AbFvOqk71WwTBqhSOSxMQzMfGToatIWrJ7YLXKTbL3YyaVzQdMhfdcSsIK9qeVR2cMXFM3jAhqWxdg',
    authorName: 'Valentine Nguyen',
    locationLabel: 'Barber Concept Rive',
    createTime: '2026-09-01T11:15:09.409962Z',
    commentSha256: '14c99e959c7a5784afee519f0eaba4338627b833dab184ba22c790670689053b',
    previousDraft: `Merci pour ton retour ! On est ravis que ta coupe et ton passage à Barber Concept Rive t'aient plu. Merci pour ta recommandation et à très vite !${SIG}`,
    mentions: [{ name: 'Ilias', sentiment: 'positive' as const }],
    reply: `Merci pour ton retour ! Ilias sera ravi de savoir que sa coupe et son accueil t'ont plu. Merci pour ta recommandation et à très vite à Barber Concept Rive !${SIG}`
  },
  {
    reviewId: 'AbFvOqksGGhnDfh0aUQGlcnnzfOiE29Y1CFjxn9rct4FaOylMSl7XbugPz1DFm2vpLURjDpdVH5aaw',
    authorName: 'Shaun Bowman',
    locationLabel: 'Barber Concept Rive',
    createTime: '2026-09-01T14:29:57.389716Z',
    commentSha256: 'e134166fafb4e08e81ba5521eca340ee0653f42225645e9303d8133ed086628f',
    previousDraft: `Merci Shaun pour ton retour ! On est ravis que ton passage à Barber Concept Rive t'ait plu. À très vite au salon !${SIG}`,
    mentions: [{ name: 'Ilias', sentiment: 'positive' as const }],
    reply: `Merci Shaun pour ton retour ! Ilias sera ravi de lire ton message. À très vite à Barber Concept Rive !${SIG}`
  }
];
