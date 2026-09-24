const SIG = "\n\nL'équipe Barber Concept";
export type Mention = { name: string; sentiment: 'positive' | 'neutral' | 'negative' };
export type ReviewPreparation = { reviewId:string; authorName:string; locationLabel:string; createTime:string; commentSha256:string; mentions:Mention[]; reply:string };
export const REVIEW_PREPARATIONS: ReviewPreparation[] = [{
 reviewId:'AbFvOqm3dYxqcH9J3eFx99YKnoPX25TxKlDkhnXWRrt6jPtg-M4JUjspiu6JDjQauH7mnUqCNgBz',authorName:'Kevin Schneeberger',locationLabel:'Barber Concept Jonction Genève',createTime:'2026-09-18T11:32:51.045930Z',commentSha256:'04a045bbc81d2d9ab01d7ad00551a246e524f49f9152f01cfc11c8822731e5c2',mentions:[{name:'HK',sentiment:'positive'}],reply:`Merci Kevin pour ton retour ! HK sera ravi de savoir que son travail t'a plu. À très vite à Barber Concept Jonction !${SIG}`
}];
