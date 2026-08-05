import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	// Base Neon partagée avec invoices. On ne migre QUE `seostats` ; `core` est
	// possédé par invoices et déclaré ici en miroir lecture-seule (pour la FK cross-schéma).
	schemaFilter: ['seostats'],
	dbCredentials: {
		url: process.env.DATABASE_URL!
	}
});
