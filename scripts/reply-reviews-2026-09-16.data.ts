const SIG = "\n\nL'équipe Barber Concept";
export type Mention = { name: string; sentiment: 'positive' | 'neutral' | 'negative' };
export type ReviewPreparation = { reviewId:string; authorName:string; locationLabel:string; createTime:string; commentSha256:string; mentions:Mention[]; reply:string };
export const REVIEW_PREPARATIONS: ReviewPreparation[] = [{
  reviewId:'AbFvOqlyAn6Tba-_9laYZZgUaw8DWS1-bYdf8QbxV75vAdEXLA1zxNJYHbnxIEp6ksCMDkyBRiy4_w', authorName:'Wael GHL', locationLabel:'Barber Concept Rive', createTime:'2026-09-14T12:03:58.901807Z', commentSha256:'65a8cd26046d6c32112b8740580e7358e177ef876cb2aee8e275460cf0e07953', mentions:[{name:'Ilias',sentiment:'positive'}], reply:`Merci Wael pour ce super retour ! Ilias sera ravi de savoir que sa précision et son travail t'ont convaincu. À très vite à Barber Concept Rive !${SIG}`
}];
