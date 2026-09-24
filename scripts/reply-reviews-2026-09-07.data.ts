/** Barber Concept — avis 5★ en attente du 3 au 7 septembre 2026 (Europe/Zurich). */
const SIG = "\n\nL'équipe Barber Concept";
export type Mention = { name: string; sentiment: 'positive' | 'neutral' | 'negative' };
export type ReviewPreparation = {
  reviewId: string; authorName: string; locationLabel: string; createTime: string;
  commentSha256: string; mentions: Mention[]; reply: string;
};
export const REVIEW_PREPARATIONS: ReviewPreparation[] = [
  {
    reviewId: 'AbFvOqnqplOzQSjXEAtYizDE8iBEeOgGO7uP_mpv21cWATw1AXBT2FvKdhgJaRlyTCm8mvOHxi7i', authorName: 'Tom Baril', locationLabel: 'Barber Concept Cornavin', createTime: '2026-09-03T07:47:53.078217Z', commentSha256: 'c4ce36424062e6207bc8879997889a23ff684b42dbe2fb714c9f306d79845815',
    mentions: [{ name: 'Enzo', sentiment: 'positive' }],
    reply: `Merci Tom pour ton retour ! Enzo sera ravi de savoir que sa coupe t'a plu. Merci pour ta recommandation et à très vite à Barber Concept Cornavin !${SIG}`
  },
  {
    reviewId: 'AbFvOqnwdD9F0diIew8LeGTioI7YkoFMmyJ5xJuEM88Htnh9VZQcwbi0vlWuAMEdaRJTPV-EYJRkxA', authorName: 'Alberto', locationLabel: 'Barber Concept - Lausanne', createTime: '2026-09-03T13:58:57.397957Z', commentSha256: 'e3423e9b6c01094eb409c1d97453eadcb9b36c6780ee327f345be5ca71736e37',
    mentions: [{ name: 'Moha', sentiment: 'positive' }],
    reply: `Merci Alberto pour ce super retour ! Moha et toute l'équipe seront ravis de te lire. À très vite à Barber Concept Lausanne !${SIG}`
  },
  {
    reviewId: 'AbFvOqnExnON2wljq-h2P1pO4ZuoVTEUvU7uDIIWMJIqUtW8SizuDBGwqPk9XfThn8RMJba6R3Q1', authorName: 'William Jean-Alexis', locationLabel: 'Barber Concept - Lausanne', createTime: '2026-09-03T15:08:13.263159Z', commentSha256: '1bd497d98c7165a55e880dfad20ff9b614f9aaabc4ee5f904f4bc91cbcb52feb',
    mentions: [{ name: 'Moha', sentiment: 'positive' }],
    reply: `Merci William pour ta confiance ! Moha sera ravi de savoir que sa maîtrise des cheveux bouclés t'a convaincu. À très vite à Barber Concept Lausanne !${SIG}`
  },
  {
    reviewId: 'AbFvOqkguG84Owixbjho2wk_JOqlNPwZa2xqBjMw79kgthlTj7rJJqQ-wbrmx_ss1z-Y1eEJACaxMA', authorName: 'Diogo Carneiro Silva', locationLabel: 'Barber Concept Cornavin', createTime: '2026-09-03T16:51:34.422766Z', commentSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    mentions: [], reply: `Merci Diogo pour ces 5 étoiles ! À très vite à Barber Concept Cornavin !${SIG}`
  },
  {
    reviewId: 'AbFvOqlEgWqVbcXojyhYtPVvqFv8QEJzrhtlZ6lmSDVidCbAOqTzY7G-mZixazI1QB73pblpxeQtWA', authorName: 'Jan Robel', locationLabel: 'Barber Concept - Eaux Vives', createTime: '2026-09-04T10:46:19.404865Z', commentSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    mentions: [], reply: `Merci Jan pour ces 5 étoiles ! À très vite à Barber Concept Eaux-Vives !${SIG}`
  },
  {
    reviewId: 'AbFvOqn9MbLZHYw7j71ym4bb1y5_K1ZYApcLZbJtRz4bzq2YvkZmUXxTYdy-Slbl6A6xJsKw1xC7', authorName: 'Nolan Monnier', locationLabel: 'Barber Concept Rive', createTime: '2026-09-04T18:50:24.101713Z', commentSha256: '0ec4472f3770ad337aa9e5f9fbdbafcc9cf620d57c72b459279e307ce3964304',
    mentions: [{ name: 'Ilias', sentiment: 'positive' }], reply: `Merci Nolan pour ce retour qui fait plaisir ! Ilias sera ravi de savoir que son travail t'a plu. À très vite à Barber Concept Rive !${SIG}`
  },
  {
    reviewId: 'AbFvOqnnI4EAc4BwayphZTQ3skQf8U3fFb8swIzQn-SMU5Q6MUK5SemnlSNKq8-eslR3d3QhKVKzXQ', authorName: 'Léo Roufaiel', locationLabel: 'Barber Concept - Eaux Vives', createTime: '2026-09-05T08:37:58.324149Z', commentSha256: 'b571a4f8c3314d1d06e43a9dfa58570434cd4293922bb23b4f5e4c91e221e4ee',
    mentions: [{ name: 'Issam', sentiment: 'positive' }], reply: `Merci Léo pour ton retour ! Issam sera ravi de savoir que son écoute et son travail t'ont plu. À très vite à Barber Concept Eaux-Vives !${SIG}`
  },
  {
    reviewId: 'AbFvOqnW7ko02Yw0hOJajQKcT64kUb3j-LFuHBMBTQKPEIe91LYMBOIZfCrd5D4YifXQ_5wUFp41tg', authorName: 'Léo', locationLabel: 'Barber Concept Jonction Genève', createTime: '2026-09-05T10:49:10.972953Z', commentSha256: '27288bbe975247c88af5a69853ee2dbddc55b9ec44b1baae8a6aa2feed10e507',
    mentions: [{ name: 'Ilias', sentiment: 'positive' }], reply: `Merci Léo pour ton retour ! Ilias sera ravi de lire que tu reviendras. À très vite chez Barber Concept !${SIG}`
  },
  {
    reviewId: 'AbFvOqmDTPpKxsiqzEeGMw9KJaozG-3YCgQ5JIhOQBDNxC70LeO8IxgcAmMYR-S2gc_185F3ptkq4g', authorName: 'Georges Ulric Mballa Bendia', locationLabel: 'Barber Concept - Lausanne', createTime: '2026-09-05T11:00:58.998503Z', commentSha256: 'ab1896c1c476a23c7cdbedbd240107d8170d38b6b54d45a4bdb6c85d18406981',
    mentions: [{ name: 'Raphaël', sentiment: 'positive' }], reply: `Merci Georges pour ce superbe retour ! Raphaël sera ravi de savoir que son écoute et son travail t'ont convaincu. À très vite à Barber Concept Lausanne !${SIG}`
  },
  {
    reviewId: 'AbFvOqmK5UPvwPf-23-7zFUQhmx5Hh3yEMCQgcsAWMDuAaPocPUZIgxR2Rf2mkL5zROouUrs4MQzTA', authorName: 'Issmail Saissi', locationLabel: 'Barber Concept Rive', createTime: '2026-09-05T12:39:34.567417Z', commentSha256: 'bba70f3328cab06697cf0114986e495d733a594bd8c32534910a15e2e59e324f',
    mentions: [{ name: 'Ilias', sentiment: 'positive' }], reply: `Merci Issmail pour ton retour détaillé ! Ilias sera ravi de savoir que son énergie, son écoute et sa précision t'ont plu. À très vite à Barber Concept Rive !${SIG}`
  },
  {
    reviewId: 'AbFvOqmecuYQ_y4eFk8-jvOFS37nO7wCBXFB6lNePwdJcbpEgWUF98t1XXNiIYsy8fnj0d8RVwYe', authorName: 'Smokpa', locationLabel: 'Barber Concept - Sion', createTime: '2026-09-06T08:34:51.247815Z', commentSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    mentions: [], reply: `Merci Smokpa pour ces 5 étoiles ! À très vite à Barber Concept Sion !${SIG}`
  }
];
