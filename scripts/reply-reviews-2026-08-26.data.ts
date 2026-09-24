/**
 * Lot Barber Concept préparé le 2026-08-26.
 *
 * Périmètre : tous les avis collectés des semaines locales (Europe/Zurich)
 * du 17 et du 24 août 2026. Les mentions sont enregistrées indépendamment
 * du statut de réponse ; seuls les 13 avis encore en attente ont un brouillon.
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
    reviewId: 'AbFvOqlEcwQ870fm7norZrCA0Cv135_0VuKqUJZ2BwxiFd7gSsnz7vil4wFLvDkwXDlp2gmcu2DlOw',
    authorName: 'Nilay',
    locationLabel: 'Barber Concept - Eaux Vives',
    mentions: [{ name: 'Jasko', sentiment: 'positive' }]
  },
  {
    reviewId: 'AbFvOqkNGlCGFRksqliONBvvz4Q2LzuKdpuKw8CrCndpURaqdQuETBm5dhf_muKl4GX5bvRRzkqM',
    authorName: 'julien marolleau',
    locationLabel: 'Barber Concept Rive',
    mentions: []
  },
  {
    reviewId: 'AbFvOqmae9O5s-eSkMDvgr5UJClqZL_lP9tKheneD3VWj0wTr0XWhFsstyJMr4H9mK7LI5TqMzJiAg',
    authorName: 'Jay Cee',
    locationLabel: 'Barber Concept Rive',
    mentions: []
  },
  {
    reviewId: 'AbFvOqnU1qXGAawGUiXlhhkYCv6qziStGNWsjqUNmnTucXjB0odBajNUKYhdIa1b_ChhnZmRDDlv',
    authorName: 'lc13 gaming',
    locationLabel: 'Barber Concept Rive',
    mentions: [{ name: 'Noé', sentiment: 'positive' }]
  },
  {
    reviewId: 'AbFvOqno4aIrnplvhdvC_G5jP3hsZxUe6XK6AKnvetq7468-TLPGL9gYCznWYrt8TpumbGkWGJmL',
    authorName: 'Alexander Vazquez',
    locationLabel: 'Barber Concept Rive',
    mentions: [{ name: 'Noé', sentiment: 'positive' }]
  },
  {
    reviewId: 'AbFvOqkaj0wn2d1j3hKtqV26boduSeLZnaFDWRkKtkYpDUpObw6t0zJBozmVjkQLZ_50mRQrXn-n',
    authorName: 'Ivanoslt 7',
    locationLabel: 'Barber Concept Cornavin',
    mentions: [{ name: 'Enzo', sentiment: 'positive' }]
  },
  {
    reviewId: 'AbFvOqngA6bb8sHVuFIeI2SOyGDplHkzOk9o9hOmT7umzRFO_maAOoDK9_3ZE0GmBFMChScSTuvJ',
    authorName: 'Timsko',
    locationLabel: 'Barber Concept - Eaux Vives',
    mentions: [{ name: 'Moss', sentiment: 'positive' }]
  },
  {
    reviewId: 'AbFvOqkKdOMwBQGerQ3Rxw_SJ7D7lI5tVv2wyKhDloqmqotkGwDKYZ0k5O9mIcCWCFdLwZlSGd2l9A',
    authorName: 'Keny Duvigneau',
    locationLabel: 'Barber Concept - Lausanne',
    mentions: [{ name: 'Raphaël', sentiment: 'positive' }],
    reply: `Merci Keny pour ton retour ! Raphaël sera ravi de savoir que tu as passé un bon moment et que la coupe t'a plu. À bientôt à Barber Concept Lausanne !${SIG}`
  },
  {
    reviewId: 'AbFvOqmcffdWFs2x9_Rdg5AloFBeMSPFTcPec20Pikd9DRTFNEqmJ6bciFLiqvojXXb-bz-rFT7S1g',
    authorName: 'Jérémie Domingos',
    locationLabel: 'Barber Concept - Lausanne',
    mentions: [{ name: 'Wesley', sentiment: 'positive' }],
    reply: `Merci Jérémie pour ta recommandation ! Wesley sera ravi de lire que sa coupe et l'accueil t'ont plu. À très vite à Barber Concept Lausanne !${SIG}`
  },
  {
    reviewId: 'AbFvOqkrrGuj7DDaRIard2bsS9Yu1jk2dgs29pe_hY7m1ByVQzty6Pi8VmlTu9E1o9gw7ox0d3romw',
    authorName: 'Gabriela Guzman',
    locationLabel: 'Barber Concept Rive',
    mentions: [{ name: 'Noé', sentiment: 'positive' }],
    reply: `Merci Gabriela pour ce superbe retour ! Noé sera ravi de lire les mots de ton fils. À très vite à Barber Concept Rive !${SIG}`
  },
  {
    reviewId: 'AbFvOqn71AN8lUMFmfqhU85dgjYYhXzbKrfecDpQSpelnjm47WUDkC6HvTMVwjOpNivyTRXiuAugXA',
    authorName: 'Francesco Gesuele',
    locationLabel: 'Barber Concept Jonction Genève',
    mentions: [{ name: 'Mohammed', sentiment: 'positive' }],
    reply: `Merci Francesco pour ton retour ! Mohammed sera ravi de savoir que sa coupe t'a pleinement satisfait. À bientôt à Barber Concept Jonction !${SIG}`
  },
  {
    reviewId: 'AbFvOqnKQHHimb2dMMgxpaaKohsjPvCKG2nIjXdeWkbyjAXDDEkpOg6mJ0CjEfkA1CEFE6kT7hsWqQ',
    authorName: 'Aziz Benmosbah',
    locationLabel: 'Barber Concept Jonction Genève',
    mentions: [{ name: 'Mohammed', sentiment: 'positive' }],
    reply: `Merci Aziz pour ta fidélité et ta confiance ! Mohammed sera ravi de lire que son écoute et son efficacité font la différence. À très vite à Barber Concept Jonction !${SIG}`
  },
  {
    reviewId: 'AbFvOqlQd5ZxrARXLTlkoOeD6a6orj-uYlr4TfPgJGTL2ES8fMnr1q4mp6uH-mGOE-S-Mitl3-7f',
    authorName: 'Eyros Pavese',
    locationLabel: 'Barber Concept Jonction Genève',
    mentions: [{ name: 'HK', sentiment: 'positive' }],
    reply: `Merci Eyros pour ton retour ! HK sera ravi de lire qu'il est toujours au top. À très vite à Barber Concept Jonction !${SIG}`
  },
  {
    reviewId: 'AbFvOqkfvUM1rm3pnNPu7Nk1fWB0iaGwaqYv9G6K37wifRSsTqHBkWnJB8ADT6dT9tP_jRh374Ocpw',
    authorName: 'Alex A',
    locationLabel: 'Barber Concept Jonction Genève',
    mentions: [],
    reply: `Merci Alex pour les 5 étoiles ! À très bientôt à Barber Concept Jonction.${SIG}`
  },
  {
    reviewId: 'AbFvOqnai1pRWU_S8uya3awoBHV_MiGNuTWDCxntlORTfrVQNt0auGnzF_NSdGgGB6Vv2wiZRY6LDw',
    authorName: 'Sélim Fathi',
    locationLabel: 'Barber Concept Jonction Genève',
    mentions: [{ name: 'Mohammed', sentiment: 'positive' }],
    reply: `Merci Sélim pour ton retour ! Mohammed sera ravi de savoir que sa coupe t'a plu. À bientôt à Barber Concept Jonction !${SIG}`
  },
  {
    reviewId: 'AbFvOql2P8XOdoc7LGMBl-57caEnnFH2W_2zlBgVUR_3oGTTLTZ9EYKu3cLaTeqmc8sL-6lnCn0X',
    authorName: 'Benjamin Pycke',
    locationLabel: 'Barber Concept Jonction Genève',
    mentions: [{ name: 'HK', sentiment: 'positive' }],
    reply: `Merci Benjamin pour ta fidélité ! HK sera ravi de lire que tu n'es jamais déçu de ses coupes. À très vite à Barber Concept Jonction !${SIG}`
  },
  {
    reviewId: 'AbFvOqmbUeP2JU6u-uj-Ath_zptDoBw9L0y3S2cDnARxwQTzA7TyBLeWmPoJ7ertPqT-tkOIm-CwCw',
    authorName: 'Lucas Alves',
    locationLabel: 'Barber Concept Jonction Genève',
    mentions: [
      { name: 'HK', sentiment: 'positive' },
      { name: 'Moha', sentiment: 'positive' }
    ],
    reply: `Merci Lucas pour ta fidélité et ta recommandation ! HK et Moha seront ravis de lire que leurs coupes et l'ambiance du salon te plaisent toujours autant. À très vite à Barber Concept Jonction !${SIG}`
  },
  {
    reviewId: 'AbFvOqnzVZFovXQMV7Nz2c9dwBZymH0n4UOOL8zwpREpc8ZuN8iU4lJY4EVzK9DJe9n231pCdYBD_w',
    authorName: 'tiavina franck',
    locationLabel: 'Barber Concept - Eaux Vives',
    mentions: [{ name: 'Moss', sentiment: 'positive' }],
    reply: `Merci Tiavina pour ton retour ! Moss sera ravi de savoir que la coupe et l'accueil t'ont plu. Au plaisir de te revoir lors de ton prochain passage à Genève !${SIG}`
  },
  {
    reviewId: 'AbFvOqnYH5YpaFgHrifX5fdsyiUIFm_9wkhPQovMiWKARmndzrKI6SEmqrHBMYGBH7_kiW5UbLMO',
    authorName: 'Riley Zimmermann',
    locationLabel: 'Barber Concept - Eaux Vives',
    mentions: [{ name: 'Moss', sentiment: 'positive' }],
    reply: `Merci Riley pour ta recommandation ! Moss sera ravi de lire que son écoute et sa coupe t'ont convaincu. À très vite à Barber Concept Eaux-Vives !${SIG}`
  },
  {
    reviewId: 'AbFvOqlTtngfn5cSgyN9bWgfyyP5XUHhpGu768w1nmRA7qlQof06m-HPX2JhIRIX-30ZjkQWIt8pGQ',
    authorName: 'Diana Reshani',
    locationLabel: 'Barber Concept - Eaux Vives',
    mentions: [{ name: 'Moss', sentiment: 'positive' }],
    reply: `Merci Diana pour ce superbe retour ! Moss sera ravi de lire que ses coupes te plaisent toujours autant. À très vite à Barber Concept Eaux-Vives !${SIG}`
  }
];
