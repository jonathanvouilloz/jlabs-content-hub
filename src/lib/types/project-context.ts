export interface TeamMember {
	name: string;
	role: string;
}

export interface ProjectContext {
	businessName: string;
	businessType: string;
	locality: string;
	keyServices: string[];
	tone: string;
	defaultSignature: string;
	negativeSignature: string;
	values: string[];
	contactEmail: string;
	contactPhone?: string;
	teamMembers: TeamMember[];
	seoKeywords: string[];
	geoZone: string;
}

export const DEFAULT_CONTEXT: ProjectContext = {
	businessName: '',
	businessType: '',
	locality: '',
	keyServices: [],
	tone: 'chaleureux',
	defaultSignature: '',
	negativeSignature: '',
	values: [],
	contactEmail: '',
	contactPhone: '',
	teamMembers: [],
	seoKeywords: [],
	geoZone: ''
};
