/**
 * Les 85 réponses aux avis de juillet 2026 — barberconcept.
 *
 * Séparé du script pour que le TEXTE se relise sans le mécanisme, et se corrige sans risquer
 * la logique de publication.
 *
 * Règles appliquées (docs/brand/identity.md, voice.md, business/profile.md, channels/gmb.md) :
 *  - tutoiement partout SAUF sur les deux avis négatifs (1★ Cornavin, 2★ Sion), au vouvoiement ;
 *  - nom PUBLIC du salon (Cornavin, Eaux-Vives, Jonction, Rive, Lausanne, Sion), jamais le
 *    libellé Google (« Barber Concept - Eaux Vives ») ;
 *  - « salon », jamais « atelier » ; aucun prix cité ; aucun em dash ;
 *  - Issam (#27) et Santos (#19, #34, #36) sont nommés sur ARBITRAGE EXPLICITE de Jonathan
 *    (2026-08-01), en dérogation à la règle de profile.md : ils sont cités par les clients
 *    eux-mêmes et les réponses déjà publiées en juillet les nommaient. À ajouter au tableau
 *    « Équipe publiable » ; sans ça la dérogation se reperd au prochain lot.
 *  - Heinok (#33) reste sans prénom : `HK` est le seul nom d'usage autorisé, et rien ne prouve
 *    encore que les deux désignent la même personne.
 *  - Kavind a quitté l'enseigne, il n'est nommé nulle part.
 *  - langue de l'avis : FR par défaut, EN (#12, #25, #53), PT (#39, #61, #76).
 *
 * Les 13 premières entrées reprennent le brouillon déjà présent en base, inchangé.
 */

const SIG = "\n\nL'équipe Barber Concept";
const SIG_EN = '\n\nThe Barber Concept team';
const SIG_PT = '\n\nA equipa Barber Concept';

export const REPLIES: { reviewId: string; reply: string }[] = [
	// ── Brouillons déjà en base (rattrapage : le hub les dit envoyés, Google ne les montre pas) ──
	{
		reviewId:
			'AbFvOqnB1j4mrv5gpYNRpZuHB4FcV_1a_Mnm1_g3pnHvkouw6RyA7o8LKZLkIuPs_eALzkWyo5cPcg',
		reply: `Merci Karim pour ce retour ! Ravi que tu aies apprécié le passage chez nous à Barber Concept Rive. Imrane sera content de lire ton message, à très bientôt !${SIG}`
	},
	{
		reviewId: 'AbFvOqk6srS2ewDYLDRSap6U02MWp4safeb3yBFe0B0BaXafuZyasly72_-mRT00uDV55RgAF8_R',
		reply: `Bonjour Henos, merci pour ce retour ! Content que la coupe t'ait plu à Barber Concept Lausanne. À bientôt pour ta prochaine séance.${SIG}`
	},
	{
		reviewId: 'AbFvOqnvDhSLG6GzmJpI379DJ-Ynp9BC2lJ7PIoUKxgi6sSSmvH8TNh1nkgQ3YfX9jUzcJL5PXoO',
		reply: `Merci beaucoup Nathan pour ce retour enthousiaste sur Barber Concept Lausanne ! Ravi que l'accueil et le professionnalisme de Wesley et de l'équipe aient fait la différence. À très bientôt pour ta prochaine coupe !${SIG}`
	},
	{
		reviewId: 'AbFvOqkVBwjXWMvMM_F6RvEEAotK9ubuS8k_ZTIBpTaRvni1ejA8d3ocCkcWNeU017zKK1vDQnUHvQ',
		reply: `Merci beaucoup Simon pour ce retour ! On est ravis que Giuseppe et Wesley t'aient offert une coupe à la hauteur de tes attentes à Barber Concept Lausanne. À très bientôt pour ta prochaine séance !${SIG}`
	},
	{
		reviewId: 'AbFvOqlsSJxULKQWOuPPV6tZOXDOy29NvDKv7R56_8kyo9Ervnon3wgnBK185gBsA0gnbbhyK4jLcQ',
		reply: `Bonjour Kami, nous sommes sincèrement désolés d'apprendre ce qui s'est passé chez Barber Concept Cornavin. Une coupe abîmée et des coupures dans la barbe sont tout simplement inacceptables, et nous comprenons votre déception. Nous prenons ce retour très au sérieux. Pouvez-vous nous écrire à contact@barberconcept.ch avec la date et l'heure de votre visite ? Nous souhaitons examiner ce qui s'est passé et trouver une solution avec vous.${SIG}`
	},
	{
		reviewId: 'AbFvOql23WajlCG-GCY-2-UgytrMmw_n6gu_WF7gs1ecC-U4f--jKs50bbKhYJzzprI_24gc1t-7',
		reply: `Merci Gabriel pour ces 5 étoiles ! C'est toujours un plaisir de t'accueillir à Barber Concept Rive. À très vite pour ta prochaine coupe.${SIG}`
	},
	{
		reviewId: 'AbFvOqnJm1r_4gyBaXCf3soOn5okNyEFKodHTZPkAnMDy5UfDUKsE9u9dJ0uPQ3OesEQzeNTad5wcA',
		reply: `Merci Zzuui pour ces 5 étoiles, ça fait plaisir ! À bientôt à Barber Concept Lausanne pour ta prochaine coupe.${SIG}`
	},
	// ── 2★ Sion, le seul avis ancien réellement sans réponse ──
	{
		reviewId: 'AbFvOqm_zaojAQkim94_5VxllHVsUFXjo3P2L55mdZL2FAB6LuV7onfTuxlNqulkMD1BW8QsJJPagw',
		reply: `Bonjour Micael, merci d'avoir pris le temps de détailler ce qui s'est passé. Un imprévu qui fait sauter un rendez-vous, ça arrive. Vous laisser repartir sans chercher de solution avec vous, non, et c'est là qu'on a manqué le coche. Nous revoyons avec l'équipe de Sion la façon de gérer ces cas, en particulier quand le rendez-vous a été pris par téléphone. Écrivez-nous à contact@barberconcept.ch à votre retour de vacances, nous aimerions vous recevoir dans de meilleures conditions.${SIG}`
	},
	{
		reviewId: 'AbFvOqkfY_4DtyvuJKBL7vzlnKaIjnu6eueD8aIvpTZvZKIPXv3wlvQMBZJKKC_Rk-H3VR-m9wmWZA',
		reply: `Ça c'est du vrai conseil de barbier, Abel ! Ouss adore prendre le temps d'expliquer et de t'orienter vers ce qui te va vraiment. Ravi que tu sois reparti avec ton fade et tes waves. Merci pour les étoiles, à très vite à Barber Concept Rive !${SIG}`
	},
	{
		reviewId: 'AbFvOqlzFOH0t45O04z3onLyfwfWSMDWXoIyq3TL9BPusNjthIgWomgHukq_CNtheZW1OR5JU3zucw',
		reply: `Merci Dina ! Ouss met un point d'honneur à prendre son temps sur chaque coupe, content que ça se ressente. On te dit à bientôt à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOqnIw3KAkhweX-WLKJ79Wn7ruCyKXil2EAdaAwepfWEdE6WapSMri4k_-qkPwQZ_9kWHan6YGA',
		reply: `Moha va prendre le melon là 😄 Merci Jonathan, on lui transmet ! À bientôt à Barber Concept Lausanne.${SIG}`
	},
	{
		reviewId: 'AbFvOqnhidl67Ygn0J7lpa6e5MPT-pjiD6GnOlLNOjjjtTOvqj2WVsf1l9JkPuykm-AzabR_qCB0HA',
		reply: `Thanks a lot for stopping by! Glad we could take care of you as a walk-in and that the shave and beard trim were on point. See you next time for that cut at Barber Concept Eaux-Vives!${SIG_EN}`
	},
	{
		reviewId: 'AbFvOqnmqTuL-TY_U-XPFACFv1On6LPwA1XGVDZkd_oqSgWe6OJ0qb533MLXrvXcJxvsht7vD6-hqg',
		reply: `Des dégradés millimétrés, c'est la signature de Raphaël ! Merci Aaron, zéro regret c'est le plus beau des compliments. À bientôt à Barber Concept Lausanne.${SIG}`
	},
	{
		reviewId: 'AbFvOqltf9wJqpVbrK5E-qjxE8BPURUk4u2oxdFMHVnUvDO93x_2fKIKgo0Oiscz8xvKAK2oAEiD',
		reply: `Merci Maria pour ce mot ! Content que le passage à Barber Concept Rive t'ait plu. À très vite pour la prochaine coupe !${SIG}`
	},

	// ── Nouvelles réponses ──
	{
		reviewId: 'AbFvOql6pQzOvQAt-bHhG5vd6OmAP4-FmB5SstIH3m58jMRvX1kil4oacOgtwETYwItBguiPq8D9Ug',
		reply: `Merci Kenjy pour les 5 étoiles ! À très vite à Barber Concept Lausanne.${SIG}`
	},
	{
		reviewId: 'AbFvOqkN-OZ_bF4o4VnbTp7EDo4_J5mTbMGslYTH-ttwMJ5Eh-_XDfwR_8bY1SRDI2DvAu82cOgePA',
		reply: `Fidèle à Noé depuis un moment, ça se lit dans ton message ! Merci Hugo, on lui transmet. À très vite à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOqmmNmg56PD2PDmnlGaiLvyzOOw8byROcFU2s8HkH5zmtYoHkyQqbOw2n6arIKMb_sjf366s',
		reply: `Une coupe toute neuve pour ton fils et elle lui va bien, c'est exactement ce qu'on cherche 😊 Merci Déborah, Thomas et Jessy vont être contents de lire ça. À bientôt à Barber Concept Rive !${SIG}`
	},
	{
		reviewId: 'AbFvOqmIAMBQ3oMYg30Ts8477viw2lkkEsPCrSIt7U2Ib-J2MCsoCmwORMzCT-E2hwkSzCCQrorx',
		reply: `Avec plaisir ! Merci pour le retour, on transmet à Noé. À la prochaine à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOqmO3alFDH7uvzNjCiQ99l4eqqzosgm4rfESG1U6eLQQ-wg3t6wSh5MniJuWMOGWd55PpOA7',
		reply: `Merci Daniel pour la recommandation ! Content que le travail de Santos ait été à la hauteur, on lui transmet. À très vite à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOqnTYcLYGF3UAwoHcsx2IbxGsLyw7Z_0J6HGs5JtD1xyYj1C-uGrjw0rLe78dyC8ygMFVpRr',
		reply: `L'énergie d'Enzo et une coupe propre, c'est le combo qu'on aime ! Merci Yoan, on lui passe le message. À bientôt à Barber Concept Cornavin.${SIG}`
	},
	{
		reviewId: 'AbFvOqm7Gorc2ApLZfsS29XSERZ3ljzl0Ag0zE613aSy1RS8qB-jERnBvgFEGhY1ByXJpHpJuwXytw',
		reply: `Belle découverte, on prend ! Merci Kevin, Ouss sera content de lire ça. À très vite à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOqk0FncBnefvDXFHVpph80fRVcHATN7dk8p4qBMjQQpX-KI3QzyhwKxHuTudYNFK0W5qXmVI',
		reply: `Merci Alex pour ce retour détaillé, ça fait vraiment plaisir. HK et Moha prennent le temps avec chaque client, et on est content que ça se ressente jusque dans l'ambiance. On leur transmet. À très vite à Barber Concept Jonction !${SIG}`
	},
	{
		reviewId: 'AbFvOqlpDPw17-momWtDuoXvGfvUEu1Pq33xh3fTqUhg2tPA6ohdH1NJDwBzssoJA8tSjm0xuElvgQ',
		reply: `Une résurrection, rien que ça 🙏🏻 Noé va adorer ! Merci Dean, à très vite à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOql6EbOHOMaF8zhVps4d-0LF-Yof0ljci2O902T8QorJdDV9HjsZJj9Aoz4iO_M1WIyKLMkZ',
		reply: `Le chantier était de taille apparemment 😄 Merci Evan, on transmet à Noé. À la prochaine à Barber Concept Rive !${SIG}`
	},
	{
		reviewId: 'AbFvOqmp8iV6YRsTc7JrF-d00Gt41wnFjRw79uzFYC6abitqBgbkDJWYmS3Alws4BrG1tMJLsgJizA',
		reply: `The LeBron of barbers, Jessy is going to love that one! Thanks Hunter, see you next time at Barber Concept Rive.${SIG_EN}`
	},
	{
		reviewId: 'AbFvOqn3OOkj0M-w1hmwf52rqpR10bJlXRgavA7z0AkNcPrpld_wv7j4mliW1MhsStg3FU3BRgffCw',
		reply: `Merci Afonso ! Emanuel sera content de lire ça 👌 À très vite à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOqkMNx9-0Q16Boz9sEwWL4auLM2hi9hPo1103hmMu1wFCXuY3yCOJXfwv52CIsD_j2-r35o1',
		reply: `Merci pour ce retour ! Content que la prestation d'Issam ait été à la hauteur, on lui transmet. À bientôt à Barber Concept Eaux-Vives.${SIG}`
	},
	{
		reviewId: 'AbFvOqmgFfT12Y6BWoaJuHYlVokG96MLfaHuwRJEOlfk3Afn8TBoBIEsOUynpzZ-t48X85zgrJDWGA',
		reply: `Bien conseillé et une coupe parfaite, c'est tout ce qu'on demande ! Merci pour la reco, on transmet à Moha. À très vite à Barber Concept Jonction.${SIG}`
	},
	{
		reviewId: 'AbFvOqkMTnFyCuARrHkOuF9skYpMABEM3uQutWMhQFHqBQfQ82ZGqGPaPRo7KXj-xYB66-iiHL36tw',
		reply: `Un fils content en sortant du fauteuil, c'est la meilleure des notes ! Merci, on transmet à Noé. À bientôt à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOqlyjiUM_PyaqtcqaucGZO9Muej3H8XXGzgGz91DRgNB_GDqdPqk1IhWQxH_bCYNSVg7fvKuGg',
		reply: `Merci Elmir pour ce retour complet, ça fait plaisir à lire. Mohcen prend vraiment le temps de comprendre ce que tu veux avant de sortir la tondeuse, et ça se voit sur les dégradés. On lui transmet. À très vite à Barber Concept Sion !${SIG}`
	},
	{
		reviewId: 'AbFvOqlk_GGuvz1XtcNfbptYnw0YlFd7AoZgVQkzmdd-3OPFZQRkyZqfWJTBCHdPJWsmkWpXLpR3Xw',
		reply: `Les yeux fermés, on valide ! Merci Andrea, Moss va être content. À bientôt à Barber Concept Eaux-Vives.${SIG}`
	},
	{
		reviewId: 'AbFvOqmOQSpBrylX4n1OJzq2ZbNJ5tnp8lkb53F354y7J5X_D5Ji2kuQaE31VjMyEG0co4HCCQMbEg',
		reply: `Toujours à l'heure et des coupes au point, c'est la marque de Mohammed ! Merci Pietro pour la fidélité, on lui transmet. À très vite à Barber Concept Jonction.${SIG}`
	},
	{
		reviewId: 'AbFvOqkSsQ-vCAKuVkTYYw6qQMM9Xz8OAkMG_gCyiWPvR55nxPPRLQ6oYxBYv5qSRMulJnG0kw4Ynw',
		reply: `Prendre le temps de bien faire, c'est ce qu'on demande à toute l'équipe de la Jonction. Merci Odis, on transmet le message ! À bientôt à Barber Concept Jonction.${SIG}`
	},
	{
		reviewId: 'AbFvOqkk5VHU7BRWkj2bq33bklJY8ndNsVuHvBzGKhW_ccJKZ-8fWKb9ok0pcKaxCLVkwz2W7lhEAQ',
		reply: `Merci pour le retour ! On transmet à Santos, ça lui fera plaisir. À très vite à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOqkebdY4Ew_tMEXPH72FFL-0GC0CayhfYj5MfEjZuhJycQCrJMkGFqRKK9GCylu22gS1tTPfwg',
		reply: `5 étoiles pour Emanuel, on lui transmet ⭐️ Merci Luca, à bientôt à Barber Concept Sion !${SIG}`
	},
	{
		reviewId: 'AbFvOqku12qO8b0fty6KrDui177fOBKuyzuod8QCa_QaYJkxbk7SajQ6pw8f-zS8pDf0E36C2dVieA',
		reply: `Merci Kevin ! L'ambiance du salon de Sion, on la soigne autant que les coupes. Content que tu ne sois jamais déçu, on transmet à Santos et à l'équipe. À très vite !${SIG}`
	},
	{
		reviewId: 'AbFvOqmKqCh1p8VRM1YXGEUXNQQOi12mNsBZ9hqFC65TrzYIjiIZ3r4mbf6ha5Kbq3A7Bn4gHA3mbg',
		reply: `Efficace et propre, c'est exactement ce que HK vise ! Merci Victor, on lui passe le message. À bientôt à Barber Concept Jonction.${SIG}`
	},
	{
		reviewId: 'AbFvOqlL3MCnflHOqtoGPVdi1nG7Qdwau1LbYKl-5dnlYO9r7_XTNJrznEPw6QSYI_1fZPmVTqHyMA',
		reply: `Merci Flo ! HK va être content de lire ça, et l'ambiance de la Jonction c'est un peu son truc aussi. À très vite !${SIG}`
	},
	{
		reviewId: 'AbFvOqkY0OM8qjbmw-v_bNELYCxIe7Ku-AHbX3Qy08RI7FOhAgCRMS1Q1CuArlirTWjRCEUWZtxaeg',
		reply: `Obrigado Ricardo! Vamos passar a mensagem ao Emanuel, vai ficar contente. Até à próxima no Barber Concept Sion!${SIG_PT}`
	},
	{
		reviewId: 'AbFvOqkhU3iaegZAhehN6AD_c6BwWICwWUdgEYtbX8Haj9uo8tVA9zQ4xZEj00uR8iNg8a2md49RTQ',
		reply: `Merci Mehdi ! Une coupe exactement comme tu la voulais, c'est le travail de Mohcen qui parle. On lui transmet ⭐ À très vite à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOqmXufFPSBLZuSQ7fxuAELynmG0IVPqMQZq9PoTF1UoHqky3M7FZd0ySpbnSibWOBBQH34Bh',
		reply: `Merci Nathan ! On transmet à Emanuel, à très vite à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOqmliSwn4_DY0lgXKVc1dcyQsQcWDcCK_9Y9pp-lnJU-oW7csdKH2el9wBkYBaKTjL9v8rAwjw',
		reply: `Fidèle à Raphaël depuis La Chaux-de-Fonds, ça c'est du sérieux ! Merci Tidjane, 6 étoiles sur 5 on prend volontiers. On lui transmet, à très vite à Barber Concept Lausanne.${SIG}`
	},
	{
		reviewId: 'AbFvOqk1usr-gd9XalG37AiCl6wg0GGVE5Zb-F1xV2_lXwUUWTYUT0c7EIk9luAttv8EkGtbFTSgBg',
		reply: `Merci Alane ! Thomas sera content de lire ça, et on soigne le salon autant que les coupes. À bientôt à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOqknPcFAdBZMV7lUGLlmLcNyYPY3pX72RnUy65m4bYtx84sBz-8UPrpL5gWytr2m7LTJAjBsWA',
		reply: `Comme d'habitude, c'est la meilleure chose qu'on puisse lire ! Merci Jordan, on transmet à Moss. À très vite aux Eaux-Vives.${SIG}`
	},
	{
		reviewId: 'AbFvOqmRHg2691JkwJzCEhuNvdtZMftS8jJwZzLI_Y2wPowi1F8_vuNXAHH61FWCXLeJspDgtXsVug',
		reply: `Merci Rémi pour la reco ! On transmet à Thomas. À la prochaine à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOqnNvA5aY8g0HIPBpUXJKntHYRNpMhfAmTcfkQTw7szWDw_v40Ry3wiJXOku6u4TLB4H9rowPw',
		reply: `Sympa et une coupe nette, Thomas coche les deux 👍 Merci Ali, à bientôt à Barber Concept Rive !${SIG}`
	},
	{
		reviewId: 'AbFvOqkyksuSFSUn2NUfxJMH6Ng7FVq3J0jToRElA2KCAvrSfAI_8opGldygwdtHbkPSIldCXj5QDw',
		reply: `Merci Brian ! Moss va apprécier. À très vite à Barber Concept Eaux-Vives.${SIG}`
	},
	{
		reviewId: 'AbFvOqk_l0nCP2vLKQt7RCERjI3HEKC6GYtQemhWuuiXRZwaSXp_TEo5Dw8VDA3LlJsxSnnUKy4f-g',
		reply: `Deux ans dans le même fauteuil, c'est la meilleure preuve qu'on puisse avoir ! Merci Ismael, on transmet à Jasko. À très vite aux Eaux-Vives.${SIG}`
	},
	{
		reviewId: 'AbFvOqnaTlQRsMBGPrrrgN82U5xh49BlKRPXKH86fwtoHt76gDmhgIkr1O9UMAeFylE9Lt4ZHigQ6w',
		reply: `Les meilleurs tapers de Genève, Muguy va encadrer le message ! Merci Luciano, à bientôt à Barber Concept Eaux-Vives.${SIG}`
	},
	{
		reviewId: 'AbFvOqmex3ykEhWzt8Uo1fbMMrNEF3kSMqjDNv9cBN0OcD2fE-nt0VzP3ekD-O8hIUHqWV92fhl0Ag',
		reply: `Merci Amine ! On transmet à Wesley, ça va lui faire plaisir. À très vite à Barber Concept Lausanne.${SIG}`
	},
	{
		reviewId: 'AbFvOqkXzsPvMwFekauyzWZQ7vV4q7cyf7cw8mZpOEkMo-dUaQihSS3GJRdf4ZNv-zj5d3EaVvbLCw',
		reply: `Un frère content et qui compte revenir, on signe ! Merci Océane, Moss sera ravi de lire ça. À bientôt aux Eaux-Vives.${SIG}`
	},
	{
		reviewId: 'AbFvOqnAHjBMhvhbZnQlTHnaQe9_wXILfDwMQEGG8YUF5HEC3Wbs-K54rGhXKU7edxrPOY04MdDUjQ',
		reply: `Toujours bien, sans surprise, c'est ce qu'on cherche ! Merci Arthur, on transmet à Jasko. À très vite à Barber Concept Eaux-Vives.${SIG}`
	},
	{
		reviewId: 'AbFvOqljuLbpWG8-_CAkNAeD9Ng5UILPhA3paoUhO6LASzN7iF-_OIJHj5R1UbF3qpJzqZ7ELQOn5Q',
		reply: `Years in the same chair, that says it all! Thanks Patrick, we'll pass it on to Jasko. See you soon at Barber Concept Eaux-Vives.${SIG_EN}`
	},
	{
		reviewId: 'AbFvOqlb1Vd_bzKJ_CjFeN3oXwzXfrtf6CFxyvmwbMVSe4-1rdCQvJN6nU2CTvrY-sP1eQAxVUnU_A',
		reply: `Merci pour ce retour ! Jasko soigne autant le conseil que la coupe, content que ça se soit senti. On lui transmet, à bientôt à Barber Concept Eaux-Vives.${SIG}`
	},
	{
		reviewId: 'AbFvOqkSYmOziE2PhGu9hLOKOaBf2lCMmDw4runySFU1t1j82IIok9_z3snJ6DP0valKW1_f0iBrJQ',
		reply: `Merci Mehdi ! HK va apprécier la reco. À très vite à Barber Concept Jonction.${SIG}`
	},
	{
		reviewId: 'AbFvOqkHEuwf-dnOl2TYdne2h1J0zmXxCfQlXjd0OBaEWoj1OWZ0LccgKoZ6g0LE3Yd0JBqODm59ew',
		reply: `Toujours fidèle à Imrane, ça fait plaisir ! Merci Karim, on lui transmet. À très vite à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOqlVRzCqiQYCvK8FmTrMUvuc-TLEBVlH9qi9EboU8GM4kBgrcb92yEfM5rvswEgHQrVY3lzKIg',
		reply: `Merci Timéo ! On transmet à Imrane. À bientôt à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOqlZwnAgW4XRT4tU61MRlBliys0Bd607oVOJcvPYQ3xijj7u_Zhn4KV7KCHauaVph7LZ95B_rQ',
		reply: `Merci Yuar ! Wesley sera content de lire ça. À très vite à Barber Concept Lausanne.${SIG}`
	},
	{
		reviewId: 'AbFvOqnHu0tPjUP9y66HtemUFNj1hCeMEf9TziM-KXF0z_wcFdOKaAfpdgFfNsBE5r2hleB404tR',
		reply: `Merci Mael pour la reco ! Un bon accueil et pas d'attente inutile, c'est ce qu'on vise à Lausanne. À très vite !${SIG}`
	},
	{
		reviewId: 'AbFvOqmXhrkcQ_qyr54wRPYhr2coXjzZSY2C2hMjllgpA3EFIf6Lg3aFFTY7oiSg2qTdA7ORevh0',
		reply: `Un seul mot mais on a compris 😄 Merci Raffael, on transmet à Imrane. À bientôt à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOqlV6qI0jUN16hsPNx9qMSg6P6xoyRKcoTkKJHE90mX_D1Nt0zQ655ZrF1n82yIwj3NoJlbxEQ',
		reply: `Obrigado Kaylson! Vamos passar a mensagem ao Wesley. Até breve no Barber Concept Lausanne!${SIG_PT}`
	},
	{
		reviewId: 'AbFvOqlfTKvJ_hXDm_tRsYAntY-U6tulR4BxiIN3IQwQMUaij6YEseVuF15IodB67vJMDiZg6OW9NQ',
		reply: `Merci Amira ! Giuseppe sera content de lire ça, et surtout que la coupe soit à la hauteur. À très vite à Barber Concept Lausanne.${SIG}`
	},
	{
		reviewId: 'AbFvOqkFfNVj5aXollzhBv1TSveBmMkJm6Nt417A8afqYiYDcxRQof4CUf2cfe3lFY0hMDg9QweypQ',
		reply: `Message reçu ! Merci, on transmet à Imrane. À la prochaine à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOqkOjEerbjokv7Z2zn_bVb0XwCqMmLCzmKFBLIdI2pUd5UR85olHM7mOegkDXkQGTlTbHsnFug',
		reply: `Très très fort, on ne peut pas mieux dire ! Merci Maxime, Wesley va apprécier. À bientôt à Barber Concept Lausanne.${SIG}`
	},
	{
		reviewId: 'AbFvOqmfLHTUAqXcz1Us9CR3c99fwV9VhYgEomj4rxgzkeVp8o8q_liPq3CxctfCggp8NPRL68yy',
		reply: `Merci Dario ! Une coupe exactement comme tu la voulais, c'est le travail d'écoute de Wesley. On lui transmet, au plaisir de te revoir à Barber Concept Lausanne.${SIG}`
	},
	{
		reviewId: 'AbFvOqmC4euOEsuHpTskD0uQEjpXEuN-htauQGBwKpiYi7IDVSU3JV1C9BHnnyo7YPQskSfA86ORNA',
		reply: `Merci Muhsin ! On transmet à Oums, à très vite à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOqndmJv4SEpDUTuOV7eL8qSwkbBw7v8DsN0mh20FouKzAVgLq2rnA5BPTtFacwWkgPIUB5Hy_g',
		reply: `Merci Ibrahim ! Oums va être content de lire ça. À bientôt à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOqmtLg1gtQ__j4njDchDJ618xr9v5QhQPQmZ6lD9PLdZCWeenNYHrwAt0QmCQHMoD1sNeibO',
		reply: `Rien à redire, on prend 🔥 Merci Nolan, on transmet à l'équipe de Lausanne. À très vite !${SIG}`
	},
	{
		reviewId: 'AbFvOqlVJB3QexoObweTDRE-gx6CAfvZUbtv1v2GqtbzFlxnHCCxe_a70HdoNtanNtn2bzjguRPbTg',
		reply: `Un dégradé travaillé aux ciseaux, ça demande du temps et ça se voit ! Merci Alexandre, on transmet à Raphaël. À bientôt à Barber Concept Lausanne.${SIG}`
	},
	{
		reviewId: 'AbFvOqmLjjqwzZeDLqQfCo8C4MuPuJtbBFS2yYX5Slhs38kd9utjSUvpiPPt8H86sHM93DVdjdPvkQ',
		reply: `Merci David pour la fidélité ! On transmet à Oums. À très vite à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOqk30WDMxSNOSSwfvNczi3zdO2OMsS5jyTXSDuEsexE4KOq3zC-8f8vLQgfTeENdE8Ts0cKXxg',
		reply: `Merci Arion ! On transmet à Oums, ça va lui faire plaisir. À bientôt à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOqlwdE3k8J7PWTkjA2Om5pFvZ9aw4TUKC_wChAopSS1yhTcJFL4kk5ZMiQRve79B0U45U8JtJg',
		reply: `Un blanc polaire sur cheveux afro, c'est le genre de chantier que Raphaël adore ! Merci Camron, on lui transmet. À très vite à Barber Concept Lausanne.${SIG}`
	},
	{
		reviewId: 'AbFvOqmEvywDnx0BKvpDMXvrGcxBYs51oT2hnFBBNzScOP59boVaZXB80Cs2YznN0zxcqlfdyROt',
		reply: `Merci Frédéric pour les 5 étoiles ! À bientôt à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOql4JMAm0c5h4EedEgLhHLtEOjJfLEs9Xi7S76u99mxMIWR4kab1Sgy_rMSlltBH60ZDmfBrbg',
		reply: `Merci Théo ! Oums travaille avec beaucoup de soin, content que ça se voie sur le résultat. On lui transmet, à très vite à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOqlCiF7qYBioLXcHWVWlGbloNXNDaRorpP2i9i-c0AmBFk38NNXl21wRPusOutkAeACy0bYD',
		reply: `Suivre son barbier de La Chaux-de-Fonds à Lausanne, ça se mérite ! Merci Dweny, Raphaël va être touché. À très vite à Barber Concept Lausanne.${SIG}`
	},
	{
		reviewId: 'AbFvOqmTXbhNpr7tH7nMocayFJP9NQEDWdhY6VinNpPL84dUEbkOBL1t6_c8CkiQm5HQ09BBi_xNEw',
		reply: `Obrigado Daniela! O Emanuel vai ficar contente por ler isto. Até à próxima no Barber Concept Sion!${SIG_PT}`
	},
	{
		reviewId: 'AbFvOqkYOURwS2ctaQsZ-ECgi1EnGx9u4IGwGYNUQD1bDudNCoMCQnjxa8_-QVL6V9WeyrDuErYD',
		reply: `Merci Pedro pour les 5 étoiles ! À très vite à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOql4uNhYUfV_Kvs0DwyLDaqT3tSjca5aWNhvcWkI0OurJQZ3ctOy2XTxQHUSayoA6TP-flOPLw',
		reply: `Merci João ! L'énergie d'Emanuel avec ses clients, c'est ce qui revient le plus souvent dans les retours. On lui transmet, à bientôt à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOqlXZvKqJoViduPZZlUKKu-zc_Oqfw1XRrE2BJH_DHaxBGLfMnHIXLdOtL688cgSLuW1c_LDNA',
		reply: `Merci pour le retour 👍 On transmet à Oums. À bientôt à Barber Concept Sion !${SIG}`
	},
	{
		reviewId: 'AbFvOqlEP0KSwe7K210VcfNJhYvUewOuH2-H6EQCBfmvOKWCIom1KgeVBWdfmToSlbG3Yi1AokAL',
		reply: `Merci Oumar ! On transmet à Oums 😊 À très vite à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOqngmj4Dr7tjoRnD-iIwS2R7My2Cevu0u_p8xGqMKXr-qg4SkQnz2NXEbmY39m6ZomnWE-n5',
		reply: `Merci Rayan ! Alexis sera content de lire ça. À bientôt à Barber Concept Sion.${SIG}`
	},
	{
		reviewId: 'AbFvOqmiPLhSRTyQkO8o2ICsYNksnezzKh-oMOXnrk-kgFFR0xqzOzNNhkdPUtH10ov7A881mO_YFg',
		reply: `Merci Syrlaine ! On transmet à Raphaël et à toute l'équipe de Lausanne. À très vite !${SIG}`
	},
	{
		reviewId: 'AbFvOqkeXZBZkiaYrEdS2IZH3LJzIqNGJdwv4sKbdQLAgt3slcvigkI-XIuVhweZJHC3lRNGyiifjA',
		reply: `Merci pour la reco ! Jessy va être content de lire ça. À très vite à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOqln_G2C_ZxhdMCnu8J-kPu5ricc6X0h5EaeUjD1Th5XbmDcfYo38jcdHJ-XYUt8vgOJPbn_0Q',
		reply: `Merci Boula ! On transmet à Jessy. À la prochaine à Barber Concept Rive.${SIG}`
	},
	{
		reviewId: 'AbFvOqkvYN8469mzwhfHoNFeg9FNHK8vVdYdmdCpHiJkuB3ZpvSXhKj7hXHZcDrlMAoa0mpuTNpj',
		reply: `Toujours bien coupé, c'est la régularité de Felipe ! Merci João, on lui transmet. À bientôt à Barber Concept Cornavin.${SIG}`
	}
];
