/**
 * Rattrapage Barber Concept préparé le 2026-08-31.
 *
 * Périmètre : avis d'août 2026 (Europe/Zurich) sans classification de mentions
 * après une collecte Google complète des six fiches. Les mentions sont enregistrées
 * pour les avis actifs, déjà répondus ou supprimés. Les brouillons ne concernent que
 * les 25 avis actifs, 5★ et non ambigus encore sans réponse.
 *
 * Exclus volontairement :
 * - Hanae Nada (« imran ») : alias Imrane non validé ;
 * - Aaron Dos Reis de la fuente (« MUGY ») : alias Muguy non validé.
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
    reviewId: 'AbFvOqkvYN8469mzwhfHoNFeg9FNHK8vVdYdmdCpHiJkuB3ZpvSXhKj7hXHZcDrlMAoa0mpuTNpj',
    authorName: 'João Santos',
    locationLabel: 'Barber Concept Cornavin',
    mentions: [{ name: 'Felipe', sentiment: 'positive' }]
  },
  {
    reviewId: 'AbFvOqnNlnT0gfwVl7K353_n3fsgQVK0HGul1WPC4Dcyem23hb_UWJfVfafFP6mOVczOgngtB0Jd',
    authorName: 'Tu T',
    locationLabel: 'Barber Concept Cornavin',
    mentions: [{ name: 'Enzo', sentiment: 'positive' }],
    reply: `Merci pour ton retour ! Enzo sera ravi de savoir que son travail t'a plu. À très vite à Barber Concept Cornavin !${SIG}`
  },
  {
    reviewId: 'AbFvOqmig9k9I0XuwEqMEhhl-aYNoaBvTMHBTThWuM4twIrvM5SzM2MxElkhmFs39fb1YKrFAowd4Q',
    authorName: 'Tim MONGO',
    locationLabel: 'Barber Concept Cornavin',
    mentions: [{ name: 'Enzo', sentiment: 'positive' }],
    reply: `Merci Tim pour ta fidélité et ta recommandation ! Enzo sera ravi de lire que ses coupes te plaisent toujours autant. À très vite à Barber Concept Cornavin !${SIG}`
  },
  {
    reviewId: 'AbFvOqnhrJKJR_LILniDMhtmXOWJ3OXSR-pxzJ9O5XBHH951AcEkXFSU8vKXJigEAVjgxu8In4VaSg',
    authorName: 'vrv v3r',
    locationLabel: 'Barber Concept - Eaux Vives',
    mentions: [{ name: 'Issam', sentiment: 'positive' }],
    reply: `Merci pour ton retour ! Issam sera ravi de savoir que sa coupe t'a plu. À bientôt à Barber Concept Eaux-Vives !${SIG}`
  },
  {
    reviewId: 'AbFvOqkKpEArpmKnLn5OyuLd0J1aMG-3d5Qbag-EMClFoDPh-donktwks6sL4XqKNVP3uvpnTMXnlQ',
    authorName: 'Milo Sierro',
    locationLabel: 'Barber Concept - Lausanne',
    mentions: [{ name: 'Moha', sentiment: 'positive' }],
    reply: `Merci Milo pour ton retour ! Moha sera ravi de lire que son travail t'a plu. À très vite à Barber Concept Lausanne !${SIG}`
  },
  {
    reviewId: 'AbFvOqmZMJ6o02Pe_ueRlOYrIYtGWVnx_skTTeJcOXeLhwvWScXTZNGYi7TbNSFAqjRa0xpibVfvsg',
    authorName: 'Kilian',
    locationLabel: 'Barber Concept - Lausanne',
    mentions: [{ name: 'Moha', sentiment: 'positive' }],
    reply: `Merci Kilian pour ton retour ! Moha sera ravi de lire tes mots. À bientôt à Barber Concept Lausanne !${SIG}`
  },
  {
    reviewId: 'AbFvOqmLXw-tySyo-S8OxapEKYe3dHb5IpguAld9oMBZ7YR955yMDsZ3q0dl9aFGeStbANTq1YOT5A',
    authorName: 'Robin Guyaz',
    locationLabel: 'Barber Concept - Lausanne',
    mentions: [{ name: 'Raphaël', sentiment: 'positive' }],
    reply: `Merci Robin pour ce retour détaillé et ta recommandation ! Raphaël sera ravi de savoir que ses conseils et le rattrapage t'ont pleinement satisfait. À très vite à Barber Concept Lausanne !${SIG}`
  },
  {
    reviewId: 'AbFvOqly_CCWzAI_vNgBk3ND6Oi24yJnsY3PEF4yagHb0cX7lNNUWzpH8mZg46xxFlFU7fU5jREp',
    authorName: 'Josue',
    locationLabel: 'Barber Concept - Lausanne',
    mentions: [{ name: 'Giuseppe', sentiment: 'positive' }],
    reply: `Merci Josue pour ton retour ! Giuseppe sera ravi de savoir que sa coupe et son accueil t'ont plu. À très vite à Barber Concept Lausanne !${SIG}`
  },
  {
    reviewId: 'AbFvOqkt0S2RL5IeViaUoJyAHHmJ-E_lPZ_Ut3izec83Gs25DCk2WcNkyGdUJJHzFfdtDLXjSeVAyQ',
    authorName: 'Maxcyse',
    locationLabel: 'Barber Concept - Eaux Vives',
    mentions: [{ name: 'Issam', sentiment: 'positive' }],
    reply: `Merci Maxcyse pour ton retour ! Issam sera ravi de lire que tout était parfait. À très vite à Barber Concept Eaux-Vives !${SIG}`
  },
  {
    reviewId: 'AbFvOqkqmlpRF-7Oc5Q5T5jT0RifRlhHT7K7YgYqdJ9V2E4IKKe1AbEaxowa-7CDkKMZQlsZA_UK0w',
    authorName: 'Yanis Montmasson',
    locationLabel: 'Barber Concept Rive',
    mentions: [{ name: 'Jessy', sentiment: 'positive' }],
    reply: `Merci Yanis pour ta recommandation ! Jessy sera ravi de savoir que sa coupe t'a plu. À très vite à Barber Concept Rive !${SIG}`
  },
  {
    reviewId: 'AbFvOqloXcPuFmD_7I1OLp_OrJwdTSfXBE2vl7J7ZT17tcbrfnDT6yBDgksrCEiMQG-5d9b8sifd8g',
    authorName: 'Marco Dias Silva',
    locationLabel: 'Barber Concept Rive',
    mentions: [{ name: 'Thomas', sentiment: 'positive' }],
    reply: `Merci Marco pour ce superbe retour ! Thomas sera ravi de lire que son écoute, ses conseils et ta transformation t'ont pleinement convaincu. À très vite à Barber Concept Rive !${SIG}`
  },
  {
    reviewId: 'AbFvOqm-Jeay8nJRUkWQmNxVa1Xg_dLajk4bHX5kQzd_bfWXauHmYDByCrJwaO7z3EqeV8Wua5sceQ',
    authorName: 'nathan',
    locationLabel: 'Barber Concept Cornavin',
    mentions: [{ name: 'Enzo', sentiment: 'positive' }],
    reply: `Merci Nathan pour ce retour qui fait plaisir ! Enzo sera ravi de savoir que la coupe et l'expérience t'ont pleinement satisfait. À très vite à Barber Concept Cornavin !${SIG}`
  },
  {
    reviewId: 'AbFvOqkxIzwZ9NRqpXlI1KccMmJSsfYTUvjJ481tJYTe7REkvWdp-Vsu18QZzsF4dyF4d3YIrCoyiw',
    authorName: 'Bryan',
    locationLabel: 'Barber Concept Cornavin',
    mentions: [{ name: 'Brandon', sentiment: 'positive' }],
    reply: `Merci Bryan pour ta fidélité et ce superbe témoignage ! Brandon sera ravi de lire que son écoute, ses conseils et sa créativité font toujours la différence. À très vite à Barber Concept Cornavin !${SIG}`
  },
  {
    reviewId: 'AbFvOqks0jv9S8KUuvHCGitwfxOUg0CHeLMN0TWoE__lmM4AjYHQneXP_0V9p0gv-pfYzF9Xif-EIQ',
    authorName: 'Garden Juan',
    locationLabel: 'Barber Concept - Lausanne',
    mentions: [{ name: 'Wesley', sentiment: 'positive' }],
    reply: `Merci pour ton retour ! Wesley sera ravi de savoir que sa coupe était parfaite. À très vite à Barber Concept Lausanne !${SIG}`
  },
  {
    reviewId: 'AbFvOqkFXk5sHpVh_zWvs-5ADo7jCRm7L0XWE64TUTdT6cted0L_kHev_lST7SO0KOCEys4CAfS3PQ',
    authorName: 'Sarah soleils',
    locationLabel: 'Barber Concept - Eaux Vives',
    mentions: [
      { name: 'Issam', sentiment: 'positive' },
      { name: 'Muguy', sentiment: 'positive' }
    ],
    reply: `Merci Sarah pour ta confiance ! Issam et Muguy seront ravis de lire ton retour. À très vite à Barber Concept Eaux-Vives !${SIG}`
  },
  {
    reviewId: 'AbFvOqlzwBHThJodv7RRSq1OnmsyHwu4fYCXFGeZDDzClORNeAATgXc6qF90uT6_gk4OiPkn6yTilA',
    authorName: 'Thomas Faucoulanche',
    locationLabel: 'Barber Concept Rive',
    mentions: [{ name: 'Thomas', sentiment: 'positive' }],
    reply: `Merci Thomas pour ta recommandation ! Thomas sera ravi de lire que son travail t'a convaincu. À très vite à Barber Concept Rive !${SIG}`
  },
  {
    reviewId: 'AbFvOqmoPPohOBRJ8kAC7dceI3Po6R4UGnpcQn7FuXCu-cxUqbGForQ10eDqoRO8hGwpccJZh-BrVQ',
    authorName: 'Irfan Mmadi',
    locationLabel: 'Barber Concept Rive',
    mentions: [{ name: 'Imrane', sentiment: 'positive' }],
    reply: `Merci Irfan pour ta fidélité et ta recommandation ! Imrane sera ravi de lire que ses coupes te plaisent toujours autant. À très vite à Barber Concept Rive !${SIG}`
  },
  {
    reviewId: 'AbFvOqmQliNR2D4oINrX_BE2qn-lNksVvMptUnsGOnaf7NX_vHmWd8csAOpd94bmXjZZqZsL3yDogw',
    authorName: 'Abdala Hussein',
    locationLabel: 'Barber Concept - Lausanne',
    mentions: [{ name: 'Moha', sentiment: 'positive' }],
    reply: `Merci Abdala pour ton retour ! Moha sera ravi de lire tes mots. À très vite à Barber Concept Lausanne !${SIG}`
  },
  {
    reviewId: 'AbFvOqnVgV1cUAAXzqu69mwiFR9vg5omWwaWzXPvNmRZ3WMYnvbXiCfCV3HDKr60D0iDITKY-LLXCA',
    authorName: 'Clément Dos Santos',
    locationLabel: 'Barber Concept Jonction Genève',
    mentions: [{ name: 'Mohammed', sentiment: 'positive' }],
    reply: `Merci Clément pour ton retour ! Mohammed sera ravi de savoir que son accueil et sa coupe t'ont permis de repartir pleinement satisfait. À très vite à Barber Concept Jonction !${SIG}`
  },
  {
    reviewId: 'AbFvOqkjh9kGi1H_zCKHC6-ACgOqrX46Hg6DwPuzkLOelNAdksm3p1P14EVXMNzbimZDw-M7MxK_',
    authorName: 'Gabo',
    locationLabel: 'Barber Concept Cornavin',
    mentions: [{ name: 'Felipe', sentiment: 'positive' }],
    reply: `Merci Gabo pour ta recommandation ! Felipe sera ravi de lire que son écoute et sa bonne humeur font la différence. À très vite à Barber Concept Cornavin !${SIG}`
  },
  {
    reviewId: 'AbFvOqkSSjPD8vtpPvb5UWK6FDHoN7WlDsE9Awbb7lWRneegJOkAc5cxy5dfEXb3pA_81p50lb5Nqw',
    authorName: 'FLUIDZ YZ',
    locationLabel: 'Barber Concept - Eaux Vives',
    mentions: [{ name: 'Muguy', sentiment: 'positive' }],
    reply: `Merci pour ton retour ! Muguy sera ravi de savoir que sa coupe t'a plu. À très vite à Barber Concept Eaux-Vives !${SIG}`
  },
  {
    reviewId: 'AbFvOql0YVScxj552O_5bP6-M6hF6bpJlXbNEnwVMzStHikKhzlGOFpISDmr0LTGEOh6zvse7lxfDA',
    authorName: 'Ludovic Silva',
    locationLabel: 'Barber Concept - Sion',
    mentions: [{ name: 'Oums', sentiment: 'positive' }],
    reply: `Merci Ludovic pour ton retour ! Oums sera ravi de lire que sa coupe et son accueil t'ont plu. À très vite à Barber Concept Sion !${SIG}`
  },
  {
    reviewId: 'AbFvOqn2Du1ZeUY0X1oQHmh22Jr8skxxSK6VCfYIC0ie2vLk6cp9eGqeyGMIdIg19dHx8qt4Gnx6',
    authorName: 'Rayan Krasniqi',
    locationLabel: 'Barber Concept - Sion',
    mentions: [{ name: 'Oums', sentiment: 'positive' }],
    reply: `Merci Rayan pour ton retour ! Oums sera ravi de lire tes mots. À très vite à Barber Concept Sion !${SIG}`
  },
  {
    reviewId: 'AbFvOqkWBYfKEhV-3aT0_HaIAae7fwx3yoE1dJH7DuSKaHCWdeM4wlj0KbkvsGfqLh1CXF9rEeRmdQ',
    authorName: 'Julien Feliciano',
    locationLabel: 'Barber Concept - Sion',
    mentions: [],
    reply: `Merci Julien pour les 5 étoiles ! À très bientôt à Barber Concept Sion.${SIG}`
  },
  {
    reviewId: 'AbFvOqkpnXJnjVDes5jB6Ajz6RU4QZbfO6fKZRPWakefcXSLRxIER1wDw3JULNXFWj5JRrCIUYaW',
    authorName: 'Alltech',
    locationLabel: 'Barber Concept - Sion',
    mentions: [
      { name: 'Santos', sentiment: 'positive' },
      { name: 'Emanuel', sentiment: 'positive' }
    ],
    reply: `Obrigado pelo teu feedback e pela recomendação! Santos e Emanuel vão ficar muito felizes em saber que tiveste uma excelente experiência. Até breve no Barber Concept Sion!${SIG}`
  },
  {
    reviewId: 'AbFvOqmNjgE6yalHUfSuhJg0-5LpgSQ6rkh5XYLy6KTP_FTodV5X0YSe4lblkaBHihs2IysTiamv',
    authorName: 'Tom',
    locationLabel: 'Barber Concept - Sion',
    mentions: [{ name: 'Oums', sentiment: 'positive' }],
    reply: `Merci Tom pour ton retour ! Oums sera ravi de savoir que sa coupe et son accueil t'ont plu. À très vite à Barber Concept Sion !${SIG}`
  },
  {
    reviewId: 'AbFvOql6wxo8MZCmO4955_quGLyr1OuU9tJjcZIDBAIaEJnoFPeSzfZjn78r-L8Af3ccF8-LJTEdSg',
    authorName: 'Charlie Maiano',
    locationLabel: 'Barber Concept Rive',
    mentions: [{ name: 'Thomas', sentiment: 'positive' }]
  }
];
