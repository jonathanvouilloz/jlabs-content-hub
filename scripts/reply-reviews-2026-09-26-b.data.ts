const SIG = "\n\nL'équipe Barber Concept";
export type Mention = { name: string; sentiment: 'positive' | 'neutral' | 'negative' };
export type ReviewPreparation = { reviewId:string; authorName:string; locationLabel:string; createTime:string; commentSha256:string; mentions:Mention[] | null; unresolvedMention?:string; reply:string };
// Reliquat du 18/09 resté sans réponse, repéré au bilan de septembre.
export const REVIEW_PREPARATIONS: ReviewPreparation[] = [
 {reviewId:'AbFvOqlS-WvQCdP1a4HR0lZmG82XgkkPUZ4oF122YrBwWqwc5acnzBbs334Db1JreLTm1LoE_0A21Q',authorName:'Sofiane Mahjoubi',locationLabel:'Barber Concept Jonction Genève',createTime:'2026-09-18T10:11:00.623359Z',commentSha256:'f450304d6bd68d169889ffc48e00e29b155ccbe4f863d6a1edfffc9f80dde88c',mentions:[{name:'HK',sentiment:'positive'}],reply:`Merci Sofiane pour ta fidélité ! HK sera content de lire ça. À très vite à Barber Concept Jonction !${SIG}`},
 {reviewId:'AbFvOqmOXJaDXf-E1acDUfTzwvTltvJ5KTXwg8LVOIJtUjAZK4il5SNgwuucKI-6g16XfmrsmXfX',authorName:'Timothee Favre',locationLabel:'Barber Concept Rive',createTime:'2026-09-18T13:15:09.139388Z',commentSha256:'61c0a3474da86e472e4ddce53a8c66279c44a690cab545014fc1dcf19ec6f495',mentions:[],reply:`Merci Timothée pour ton retour ! Ravis que la coupe t'ait plu. À très vite à Barber Concept Rive !${SIG}`},
 {reviewId:'AbFvOqnJHfvZ4waULWdW2eionkEkkr73XkFhq1lWydqqLykvkN6u5bSHqFtb1p86Z0PgnpxZhC6b',authorName:'Théo Rombaldi',locationLabel:'Barber Concept Rive',createTime:'2026-09-18T15:38:23.250270Z',commentSha256:'5036cfe2cd12fa927ea0a4f247d860d32a75f90720efce15287bd87d0e3452b9',mentions:[{name:'Noé',sentiment:'positive'}],reply:`Merci Théo ! Noé sera ravi de lire ça. À très vite à Barber Concept Rive !${SIG}`},
];
