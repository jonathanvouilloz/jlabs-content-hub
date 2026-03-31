declare global {
	namespace App {
		interface Locals {
			user?: {
				id: string;
				email: string;
				name: string;
				image?: string | null;
				emailVerified: boolean;
				createdAt: Date;
				updatedAt: Date;
			};
			session?: {
				id: string;
				expiresAt: Date;
				token: string;
				userId: string;
				createdAt: Date;
				updatedAt: Date;
			};
		}
	}
}

export {};
