const SIG = "\n\nL'équipe Barber Concept";
export type Mention = { name: string; sentiment: 'positive' | 'neutral' | 'negative' };
export type ReviewPreparation = { reviewId:string; authorName:string; locationLabel:string; createTime:string; commentSha256:string; mentions:Mention[]; reply:string };
export const REVIEW_PREPARATIONS: ReviewPreparation[] = [
  { reviewId:'AbFvOqkRIdUTAEpo4JdqaN-ntoRPK-rudOFGZ5xg1LMc34-ExpTuYEuFetA-yTwhgjy5puSVgZd9Fw', authorName:'raph', locationLabel:'Barber Concept - Sion', createTime:'2026-09-09T08:59:16.288215Z', commentSha256:'dd09fb6366de8ecee48e0de8edb419a73d1269bce2513f92b262bab0461afd78', mentions:[], reply:`Merci pour ton retour ! À très vite à Barber Concept Sion !${SIG}` },
  { reviewId:'AbFvOqmWHgLgme_6wb1EoqFC5O6fB1Me86Dq8P6suUXp9T_GtdMBjt6ERCQnsagSsBCtAV0QjNBwNA', authorName:'Kadir Turan', locationLabel:'Barber Concept - Eaux Vives', createTime:'2026-09-12T12:00:51.897231Z', commentSha256:'7e084fec0215439878846418a021ad36dfbb9effe5a71d0d7cbd529db485da57', mentions:[{name:'Jasko',sentiment:'positive'}], reply:`Merci Kadir pour ton retour ! Jasko sera ravi de savoir qu'il a su réaliser exactement ce que tu voulais. À très vite à Barber Concept Eaux-Vives !${SIG}` },
];
