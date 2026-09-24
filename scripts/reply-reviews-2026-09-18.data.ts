const SIG = "\n\nL'équipe Barber Concept";
export type Mention = { name: string; sentiment: 'positive' | 'neutral' | 'negative' };
export type ReviewPreparation = { reviewId:string; authorName:string; locationLabel:string; createTime:string; commentSha256:string; mentions:Mention[]; reply:string };
export const REVIEW_PREPARATIONS: ReviewPreparation[] = [{
  reviewId:'AbFvOqkT7_uIJWgJ6c0932T-jFXfCctUCIN9ouRCuR8ehPyXRocrKJ0enH4AvvKPFGRZG8rBElWL3A', authorName:'Sami A', locationLabel:'Barber Concept Jonction Genève', createTime:'2026-09-18T10:29:40.453419Z', commentSha256:'b7edc8d20640359b4aedd3f27bb09c8dfe875b5d62f0a6ed7496790a4d24d434', mentions:[{name:'Mohammed',sentiment:'positive'}], reply:`Merci Sami pour ta fidélité et ce superbe retour ! Mohammed sera ravi de savoir que son professionnalisme et ses coupes te plaisent depuis tout ce temps. À très vite à Barber Concept Jonction !${SIG}`
}];
