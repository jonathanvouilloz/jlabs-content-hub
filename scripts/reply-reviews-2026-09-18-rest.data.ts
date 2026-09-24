const SIG = "\n\nL'équipe Barber Concept";
export type Mention = { name: string; sentiment: 'positive' | 'neutral' | 'negative' };
export type ReviewPreparation = { reviewId:string; authorName:string; locationLabel:string; createTime:string; commentSha256:string; mentions:Mention[]; reply:string };
export const REVIEW_PREPARATIONS: ReviewPreparation[] = [
 {reviewId:'AbFvOqka-DpH5IFjsMOVvxANT04LWtr7HVy60B6Qqbco2s5PaP5dx1qI6DhaJvzEiQnILrcv2PzSFA',authorName:'camaret2913',locationLabel:'Barber Concept Rive',createTime:'2026-09-16T18:19:09.806741Z',commentSha256:'40c0504e36e3b5f8fd6a0dc8bfb19563a517e0396167d439a97f31ff5fe671a1',mentions:[{name:'Noé',sentiment:'positive'}],reply:`Merci pour ta fidélité et ce superbe retour ! Noé sera ravi de savoir que son travail et sa gentillesse te plaisent à chaque passage. À très vite à Barber Concept Rive !${SIG}`},
 {reviewId:'AbFvOqlrocMwOpYwfcxJvvEa6bpHchYhJU9nL2iR4QqrAMCapmjqQrY3-lExLxclIoa25cAoaquQ',authorName:'Ahmed Rafik',locationLabel:'Barber Concept Cornavin',createTime:'2026-09-17T08:10:27.010149Z',commentSha256:'cd76d1998af041b5330cca3c3af145d470578f4710897ca12644809408c0b6c5',mentions:[{name:'Enzo',sentiment:'positive'}],reply:`Merci Ahmed pour ce super retour ! Enzo sera ravi de savoir que son travail te plaît à chaque fois. À très vite à Barber Concept Cornavin !${SIG}`},
];
