/**
 * Barber Concept — avis des 1er et 2 septembre 2026 (Europe/Zurich).
 *
 * Source : collecte complète des 6 fiches le 02.09.2026 à 22:31 locale.
 * Périmètre : 2026-09-01 00:00 inclus → 2026-09-03 00:00 exclu.
 * Les deux mentions « Ilias » restent explicitement non attribuées : ce nom
 * n'apparaît pas dans le roster canonique. Elles seront présentées au propriétaire.
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
  createTime: string;
  commentSha256: string;
  mentions: Mention[] | null;
  unresolvedMentionTokens: string[];
  reply: string;
};

export const REVIEW_PREPARATIONS: ReviewPreparation[] = [
  {
    reviewId: 'AbFvOqlLDkKxK7t8-2h4s3vF1xA2y9mKPkKLIu9dk1MveyNRQBzXrw5tgYSYs7Ky9uOFpLA7yUJo',
    authorName: 'Catharina Guedes',
    locationLabel: 'Barber Concept Cornavin',
    createTime: '2026-08-31T22:03:09.168143Z',
    commentSha256: 'c06ae609d4536979804effb8de9be4a7d5e96cfb8bc90fdf3c28697d3ca2ab9c',
    mentions: [{ name: 'Felipe', sentiment: 'positive' }],
    unresolvedMentionTokens: [],
    reply: `Merci Catharina pour ton retour ! Felipe sera ravi de savoir que la coupe de ton fils t'a plu. À très vite à Barber Concept Cornavin !${SIG}`
  },
  {
    reviewId: 'AbFvOqk71WwTBqhSOSxMQzMfGToatIWrJ7YLXKTbL3YyaVzQdMhfdcSsIK9qeVR2cMXFM3jAhqWxdg',
    authorName: 'Valentine Nguyen',
    locationLabel: 'Barber Concept Rive',
    createTime: '2026-09-01T11:15:09.409962Z',
    commentSha256: '14c99e959c7a5784afee519f0eaba4338627b833dab184ba22c790670689053b',
    mentions: null,
    unresolvedMentionTokens: ['Ilias'],
    reply: `Merci pour ton retour ! On est ravis que ta coupe et ton passage à Barber Concept Rive t'aient plu. Merci pour ta recommandation et à très vite !${SIG}`
  },
  {
    reviewId: 'AbFvOqlXRomkNsJxK_Szd1xxJqam-EY4XQFjFSIW5lXxViK-qYqwUW0OqW6Oe7ZGSXYfq5BmWVhP',
    authorName: 'Hugo Luis',
    locationLabel: 'Barber Concept Cornavin',
    createTime: '2026-09-01T11:58:44.159602Z',
    commentSha256: '5e336fbb7ff24c1178d2fb9b01d7d3983fa22a308e1de6a527d6b2e9aa0f6748',
    mentions: [{ name: 'Felipe', sentiment: 'positive' }],
    unresolvedMentionTokens: [],
    reply: `Merci Hugo pour ce superbe retour ! Felipe sera ravi de savoir que son écoute et son travail t'ont fait vivre une belle expérience. À très vite à Barber Concept Cornavin !${SIG}`
  },
  {
    reviewId: 'AbFvOqm5WvYKcY66mBWafiXOY9Z5kqzRh4Pb31OUAqMPNaHpt7TWgB_l_MJEIpZQThA16qtM05yhgg',
    authorName: 'Yuxi Guess',
    locationLabel: 'Barber Concept - Sion',
    createTime: '2026-09-01T12:31:16.797300Z',
    commentSha256: '291bfe96c5b00c89f344bc1236552239809b6d2b210a50efbd010be1c2ac17b6',
    mentions: [
      { name: 'Santos', sentiment: 'positive' },
      { name: 'Emanuel', sentiment: 'positive' }
    ],
    unresolvedMentionTokens: [],
    reply: `Agradecemos o teu comentário, Yuxi! O Santos e o Emanuel vão ficar muito felizes por saber que gostaste do trabalho deles. Até breve na Barber Concept Sion!${SIG}`
  },
  {
    reviewId: 'AbFvOqksGGhnDfh0aUQGlcnnzfOiE29Y1CFjxn9rct4FaOylMSl7XbugPz1DFm2vpLURjDpdVH5aaw',
    authorName: 'Shaun Bowman',
    locationLabel: 'Barber Concept Rive',
    createTime: '2026-09-01T14:29:57.389716Z',
    commentSha256: 'e134166fafb4e08e81ba5521eca340ee0653f42225645e9303d8133ed086628f',
    mentions: null,
    unresolvedMentionTokens: ['Ilias'],
    reply: `Merci Shaun pour ton retour ! On est ravis que ton passage à Barber Concept Rive t'ait plu. À très vite au salon !${SIG}`
  },
  {
    reviewId: 'AbFvOqk8qf35z41IiZ1xaTq_p7ggDlsYDhCsyyhk6hAheXnxUnE4qfvQBmjPACjYKu7dGzZUwofY5g',
    authorName: 'Chris Pro',
    locationLabel: 'Barber Concept Rive',
    createTime: '2026-09-01T15:33:55.746379Z',
    commentSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    mentions: [],
    unresolvedMentionTokens: [],
    reply: `Merci Chris pour ces 5 étoiles ! À très vite à Barber Concept Rive !${SIG}`
  },
  {
    reviewId: 'AbFvOqkfYYxgyVSbdI0i1JNBcLWG7rbQ_2ZnWuKr3zTAt4TMUHRfd20d-uOiZmorzffl8CD54JfK',
    authorName: 'Joyce Mundemba',
    locationLabel: 'Barber Concept - Lausanne',
    createTime: '2026-09-02T14:30:18.086929Z',
    commentSha256: '3fa380d536a07b0005f6d5dcb322fbed1034c90f9b0524e6704d0dc9b6bafd88',
    mentions: [{ name: 'Raphaël', sentiment: 'positive' }],
    unresolvedMentionTokens: [],
    reply: `Merci Joyce pour ce superbe retour ! Raphaël sera ravi de lire que sa précision et ses finitions t'ont convaincue. À très vite à Barber Concept Lausanne !${SIG}`
  },
  {
    reviewId: 'AbFvOql59iLB-ZCFws9vxmO01jb4H8fSOVHUE4L5kB6QXSGilt8fCx0qKF5b0iRIe3iWOYhJ_Zu86g',
    authorName: 'Yann Seba',
    locationLabel: 'Barber Concept - Lausanne',
    createTime: '2026-09-02T15:37:19.899556Z',
    commentSha256: '9c71d54acd2a28b9845a2459a0b399528aae7d46bc00f8c263bb781f66ff84ff',
    mentions: [{ name: 'Raphaël', sentiment: 'positive' }],
    unresolvedMentionTokens: [],
    reply: `Merci Yann pour ton retour qui fait plaisir ! Raphaël sera ravi de savoir que sa coupe t'a régalé. À très vite à Barber Concept Lausanne !${SIG}`
  }
];
