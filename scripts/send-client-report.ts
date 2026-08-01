/**
 * Envoie un récap markdown à un client, via Resend.
 *
 * DRY-RUN PAR DÉFAUT : sans `--execute`, le HTML est écrit sur disque pour relecture et
 * AUCUN email ne part.
 *
 *   npx tsx scripts/send-client-report.ts <fichier.md> --to <email>
 *   npx tsx scripts/send-client-report.ts <fichier.md> --to <email> --preview out.html
 *   npx tsx scripts/send-client-report.ts <fichier.md> --to <email> --execute
 *
 * Le fichier markdown porte son propre destinataire et son objet :
 *   - frontmatter `destinataire:` (surchargeable par --to)
 *   - première ligne `**Objet :** …` du corps
 *
 * ⚠️ Le seul domaine vérifié chez Resend est `factures.jonlabs.ch`. L'expéditeur porte donc
 *    un nom d'affichage explicite et un `reply_to` sur la vraie adresse, faute de quoi un
 *    récap d'avis arriverait depuis un sous-domaine de facturation sans autre indice.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { marked } from 'marked';
import { Resend } from 'resend';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const fichier = args.find((a) => a.endsWith('.md'));
const option = (nom: string) => {
	const i = args.indexOf(`--${nom}`);
	return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};

if (!fichier) {
	console.error('Usage : npx tsx scripts/send-client-report.ts <fichier.md> --to <email>');
	process.exit(1);
}

const brut = readFileSync(fichier, 'utf8');

// Frontmatter : on en tire le destinataire par défaut, puis on le retire du corps.
const fm = brut.match(/^---\n([\s\S]*?)\n---\n/);
const corpsBrut = fm ? brut.slice(fm[0].length) : brut;
const destinataire =
	option('to') ?? fm?.[1].match(/^destinataire:\s*(.+)$/m)?.[1].trim() ?? undefined;

if (!destinataire) {
	console.error('Destinataire absent (ni --to, ni `destinataire:` en frontmatter). Abandon.');
	process.exit(1);
}

// L'objet vit dans le markdown, pas dans un argument : le fichier reste la source unique.
const objetMatch = corpsBrut.match(/^\*\*Objet :\*\*\s*(.+)$/m);
if (!objetMatch) {
	console.error('Ligne `**Objet :** …` introuvable dans le markdown. Abandon.');
	process.exit(1);
}
const objet = objetMatch[1].trim();

// Le corps commence après la ligne d'objet et le séparateur qui la suit.
const corps = corpsBrut
	.slice(objetMatch.index! + objetMatch[0].length)
	.replace(/^\s*---\s*\n/, '')
	.trim();

const contenu = await marked.parse(corps);

const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:720px;margin:0 auto;padding:24px">
<style>
  h1{font-size:22px;margin:32px 0 12px;padding-bottom:8px;border-bottom:2px solid #800020}
  h2{font-size:18px;margin:28px 0 10px;color:#800020}
  h3{font-size:16px;margin:20px 0 8px}
  table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px}
  th{background:#0A0A0A;color:#fff;text-align:left;padding:8px 10px;font-weight:600}
  td{border-bottom:1px solid #e5e5e5;padding:7px 10px}
  tr:nth-child(even) td{background:#fafafa}
  blockquote{margin:12px 0;padding:10px 16px;border-left:3px solid #800020;background:#faf7f8;color:#333;font-style:italic}
  ul{padding-left:22px}
  li{margin:4px 0}
  hr{border:0;border-top:1px solid #e5e5e5;margin:28px 0}
  code{background:#f4f4f4;padding:1px 4px;border-radius:3px;font-size:13px}
</style>
${contenu}
</div>`;

const apercu = option('preview');
if (apercu) {
	writeFileSync(apercu, html, 'utf8');
	console.log(`Aperçu HTML écrit : ${apercu}`);
}

console.log(`De     : Jonathan Vouilloz <${process.env.FROM_EMAIL}>`);
console.log(`À      : ${destinataire}`);
console.log(`Répondre à : ${process.env.ADMIN_EMAIL}`);
console.log(`Objet  : ${objet}`);
console.log(`Taille : ${(html.length / 1024).toFixed(1)} kio de HTML`);

if (!EXECUTE) {
	console.log('\n=== DRY-RUN — aucun email envoyé. Ajouter --execute pour envoyer. ===');
	process.exit(0);
}

const resend = new Resend(process.env.RESEND_API_KEY);
const { data, error } = await resend.emails.send({
	from: `Jonathan Vouilloz <${process.env.FROM_EMAIL}>`,
	to: destinataire,
	replyTo: process.env.ADMIN_EMAIL!,
	subject: objet,
	html
});

if (error) {
	console.error('\n✗ Échec :', error);
	process.exit(1);
}
console.log(`\n✓ Envoyé. id Resend : ${data?.id}`);
