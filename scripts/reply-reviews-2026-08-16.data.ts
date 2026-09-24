/**
 * Réponses aux avis Google barberconcept restés sans réponse au 2026-08-16.
 *
 * Voix : tutoiement, prénom du client, prénom du barbier cité (uniquement si présent dans
 * l'« Équipe publiable » de docs/business/profile.md), signature « L'équipe Barber Concept ».
 * Règle absolue : aucune personne absente du tableau n'est nommée (d'où pas de prénom sur les
 * avis citant « Dams » ou « Benger »). Les 26 avis ici sont des 5★ auto-publiables ; le 1★
 * Antoine De Burra (accusation sur Noé) est une escalade humaine, hors de ce lot.
 */
const SIG = "\n\nL'équipe Barber Concept";

export const REPLIES: { reviewId: string; reply: string }[] = [
  {
    reviewId:
      "AbFvOqkrh0NHXHdQqA2mccVVlR0QMVRrFVx621hdiGKqV6C_Zt6_2jjHWxTMgwOnHDl9hUWfTXYMYQ",
    reply: `Merci Adriel pour les 5 étoiles ! À très bientôt à Barber Concept Lausanne pour ta prochaine coupe.${SIG}`,
  },
  {
    reviewId:
      "AbFvOqkR4KPrSPhFznaielWOfHu9a51oX85sbduwOg_sGSBDJD89BjDvEOnyAmUWpNLEezYLQOdu",
    reply: `Merci Elliot pour ce super retour ! Brandon sera content de lire que l'accueil et le résultat sont toujours au rendez-vous. À très vite à Barber Concept Cornavin !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqlm14MWfsHKKAlGEhLSwUonrDftOeUL9NQrsavsqGBx8CulZxc3xTbfOoGzT0oN_qR9z7N7uw",
    reply: `Merci spartak pour les 5 étoiles ! Ravi que ta coupe t'ait plu. À très vite à Barber Concept Jonction.${SIG}`,
  },
  {
    reviewId:
      "AbFvOqlUXujotSnEJSDSBbzsrC8-rZnSujsRKocE8-0xo0r3NvZFqHZZIGD8sM7JQi2BWk_0T_I80A",
    reply: `Merci Bruno pour ce retour ! Alexis sera content de lire que la qualité et l'accueil (eau ou café, au choix 😉) sont au rendez-vous. À bientôt à Barber Concept Sion !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqnZ5HFOruqPx1azbGTr555SUwz0zHOOYbQIOA68UyVMC0deLYPHiFBAVhA8KekgK2O9GVYv8A",
    reply: `Merci Mickael ! Jasko te passe le bonjour, content qu'il ait su t'accueillir même en retard. À très vite à Barber Concept Eaux-Vives !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqnB0We_WQQezmFUUVr-b2l_w5w-Lvq50l9Np7rc9NcVIDKS7Za6DgWRloymjPTT1Hc9-2dH",
    reply: `Merci Arthur pour les 5 étoiles ! À bientôt à Barber Concept Sion.${SIG}`,
  },
  {
    reviewId:
      "AbFvOqmYePO3uJpVS6WmKWPjBC8LobWeCac73pA1bAUGn0BlbiG8JDfWHxLrLXHcVX_QsvPLhUv9zw",
    reply: `Merci Jose pour ton retour ! Ravi que ta première visite chez nous t'ait plu, Jasko te remercie. À très vite à Barber Concept Eaux-Vives !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqnISVt_A9B_6ysWXKo8pPpAbbvFlth7N_SniYiG_EATi-6ziOoxz9ZCmppd7Njso5YPvBqM",
    reply: `Merci Luke pour les 5 étoiles ! À très bientôt à Barber Concept Rive.${SIG}`,
  },
  {
    reviewId:
      "AbFvOqlu2s-_DpRJxnhTceOB0FMsEXnn0pOGrdMcDCTCFDgWZWGkGZzq1UrI-pyftC0u4B8On13MAw",
    reply: `Merci Sherif ! Jessy sera content de lire ton message. À très vite à Barber Concept Rive.${SIG}`,
  },
  {
    reviewId:
      "AbFvOqnPKG2cps3jEpq8SoTQxVU1HDnELghEfF8bWnkkNbwqSP2UqzRDpIreuRAxwlyNA1qcvAgEqw",
    reply: `Merci Leandro ! Giuseppe te remercie. À bientôt à Barber Concept Lausanne.${SIG}`,
  },
  {
    reviewId:
      "AbFvOqkj8G3plmdF5p6es_zBP5RxYM9m9QIEBOo7W8KJV4TCXteZEkxdKETx5MMG2xpAu2oypiL1NA",
    reply: `Merci Carolina pour ce retour détaillé ! Raphaël sera content de lire que son écoute et sa précision ont fait la différence. À bientôt à Barber Concept Lausanne !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqmik9tgl0BSaSLRL2zHhE6VDftZOR3i87a0VWUubqengXiPoFmyolJ5R3JpYUxYFuGtWJjnYA",
    reply: `Merci Holden ! Giuseppe est ravi de t'avoir régalé. À très vite à Barber Concept Lausanne.${SIG}`,
  },
  {
    reviewId:
      "AbFvOqk-evUCPXrlT0U7tF6GR5xXrPSI2TAZNGN9PJi9CgWYJUBJh85vhoxoE6kxbABl7XBLAuDc5w",
    reply: `Merci Baran ! Toute l'équipe de Barber Concept Lausanne te remercie pour les recommandations. À très bientôt !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqm_C4Fn2csQoNcssitVBecpuXCpjFRh9xY6L-jV4nPmpkA66s2JsQGTbp3q-I13_yc6-XLlxQ",
    reply: `Merci Ylli ! Moha sera content de lire ton retour. À bientôt à Barber Concept Lausanne.${SIG}`,
  },
  {
    reviewId:
      "AbFvOqmXKX8KLQpLJmP2tQk7uJTnAWbkoQX-zod5WaVreEDZ4IhgvS8XTl0K7Kl1AhYQq9Zr021HDw",
    reply: `Merci pour ce retour ! Ravi que la coupe, les prix et l'ambiance t'aient plu. À très vite à Barber Concept Sion !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqk8HhwkuJg_FMcDppR-VU_R96nGLykviIdgAbict4WZfaMh9dB0RGk5ooSEzXtQtgwZra-57g",
    reply: `Merci Jasmina ! Ravi d'avoir pu te sauver la mise à la dernière minute. À très vite à Barber Concept Eaux-Vives !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqnmtTe_1V6NgvzKndOX_IblTeh7Rp3hxzQaq4pbPPojFAx3V1qH1UyZGfEpC3edtrA4Yvzx",
    reply: `Merci Chris ! Noé te remercie, super content que la coupe t'ait plu. À très vite à Barber Concept Rive 👍🏽${SIG}`,
  },
  {
    reviewId:
      "AbFvOql1c5rluC3vdM7zTBW5bN28MewbRIghj2U-HRSAQoCOHZotYQbV-IW5B9W8FUPM8NtTljBHCA",
    reply: `Merci Florence ! Alexis te remercie. À bientôt à Barber Concept Sion !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqmbNAQ52oh1sY5TiwJn0krCbdKyDTHXJq1da8dXmIgmCHgV7bG-ixpxpf-S0IHSEjIRao3fIg",
    reply: `Merci Maxime ! Emanuel est ravi de lire ton message. À très vite à Barber Concept Sion !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqlGZ8TD6A99hSNoEoiIYwoMPEpaPMGbzTbEb1DCvDOVbBNUet4SdDqnUmnrR7yyFGF9s3YiYQ",
    reply: `Merci pour ce retour ! Big up à Alexis, on lui transmet. À très vite à Barber Concept Sion !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqnOjWvUTWneTdQ30PrJ8FOdiQZmgJewiG2QMXKe_bnduEGzR3zrikrf70owomqQBRFbB60Sjw",
    reply: `Merci khandj pour ce retour ! Alexis sera content de lire que sa précision et l'ambiance ont fait la différence. À bientôt à Barber Concept Sion !${SIG}`,
  },
  {
    reviewId:
      "AbFvOql462krWXNKQHQ_9WexyUxRGRsSAuxBiLazqDS9p51OeMsBdz49KPlVEGK_1dAcPmshSjrLdA",
    reply: `Merci pour ce retour ! Alexis est très pro en effet, on lui transmet. À bientôt à Barber Concept Sion !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqkneIfIjT0uziAUunPl1e50hcsC3TOigxSMCsgKwCQGhWISi0_WR2pCMP3FR_oND9D59ws0Ig",
    reply: `Merci Lyam pour ce retour ! Mohammed sera ravi de lire que tu as retrouvé confiance et l'envie de revenir. À très vite à Barber Concept Jonction !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqlYaPnTKQ_XzEWH0EO4j1B21aEYQlPYGcPi5rbMAPcHD-ZS2osDGLKpL1US7fSTDHBItNmO",
    reply: `Merci Issa ! Muguy est ravi d'avoir trouvé la coupe qu'il te fallait. À très vite à Barber Concept Eaux-Vives !${SIG}`,
  },
  {
    reviewId:
      "AbFvOqmIAMBQ3oMYg30Ts8477viw2lkkEsPCrSIt7U2Ib-J2MCsoCmwORMzCT-E2hwkSzCCQrorx",
    reply: `Merci Noé pour les 5 étoiles ! À très vite à Barber Concept Rive.${SIG}`,
  },
  {
    reviewId:
      "AbFvOql6pQzOvQAt-bHhG5vd6OmAP4-FmB5SstIH3m58jMRvX1kil4oacOgtwETYwItBguiPq8D9Ug",
    reply: `Merci Kenjy pour les 5 étoiles ! À très bientôt à Barber Concept Lausanne.${SIG}`,
  },
];
