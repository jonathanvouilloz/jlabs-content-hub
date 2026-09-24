export interface MonthlyReviewRecap {
	projectName: string;
	periodKey: string;
	periodLabel: string;
	recipient: string;
	generatedDate: string;
	timezone: string;
	sourceSyncedAt: string;
	summary: {
		reviews: number;
		average: number;
		ratingCounts: Record<1 | 2 | 3 | 4 | 5, number>;
		reviewsWithMentions: number;
		mentionItems: number;
		collaborators: number;
		deletedReviews: number;
	};
	history: Array<{ label: string; reviews: number; average: number }>;
	locations: Array<{ salon: string; reviews: number; average: number; mentions: number }>;
	employees: Array<{
		name: string;
		salons: string;
		mentions: number;
		deleted: number;
		visible: number;
		positive: number;
		neutral: number;
		negative: number;
	}>;
	negativeReviews: Array<{
		date: string;
		salon: string;
		rating: number;
		author: string;
		excerpt: string;
		visible: boolean;
		analysis: string;
	}>;
	deletedReviews: Array<{
		date: string;
		salon: string;
		author: string;
		rating: number;
		employees: string[];
	}>;
	replyCoverage: {
		visibleReviews: number;
		remotelyAnswered: number;
		pending: number;
		divergent: number;
	};
	arbitrations: Array<{ title: string; body: string }>;
	annex: Array<{
		salon: string;
		employee: string;
		mentions: Array<{
			date: string;
			author: string;
			rating: number;
			excerpt: string;
			deleted: boolean;
			sentiment: 'positive' | 'neutral' | 'negative';
		}>;
	}>;
	noMentionReviews: Array<{
		date: string;
		salon: string;
		author: string;
		rating: number;
		excerpt: string | null;
		deleted: boolean;
	}>;
	methodNote: string;
}

function decimal(value: number, digits = 2): string {
	return value.toLocaleString('fr-CH', {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	});
}

function tableCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function percentage(part: number, total: number): string {
	if (total === 0) return '0,0';
	return decimal((part / total) * 100, 1);
}

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
	return value === 1 ? singular : pluralForm;
}

export function stripGoogleTranslation(comment: string): string {
	const originalMarker = '\n\n(Original)\n';
	const originalIndex = comment.lastIndexOf(originalMarker);
	if (originalIndex >= 0) return comment.slice(originalIndex + originalMarker.length).trim();
	return comment.split('\n\n(Translated by Google)\n', 1)[0].trim();
}

export function renderMonthlyReviewRecapMarkdown(data: MonthlyReviewRecap): string {
	const periodWithDe = /^[aeiouyàâäéèêëîïôöùûü]/i.test(data.periodLabel)
		? `d’${data.periodLabel}`
		: `de ${data.periodLabel}`;
	const ratingRows = ([5, 4, 3, 2, 1] as const)
		.filter((rating) => data.summary.ratingCounts[rating] > 0)
		.map((rating) => {
			const count = data.summary.ratingCounts[rating];
			return `| ${rating} ${plural(rating, 'étoile')} | ${count} (${percentage(count, data.summary.reviews)} %) |`;
		})
		.join('\n');
	const historyRows = data.history
		.map((row) => `| ${row.label} | ${row.reviews} | ${decimal(row.average)} |`)
		.join('\n');
	const locationRows = data.locations
		.map((row) => `| ${tableCell(row.salon)} | ${row.reviews} | ${decimal(row.average)} | ${row.mentions} |`)
		.join('\n');
	const employeeRows = data.employees
		.map((row) => `| **${tableCell(row.name)}** | ${tableCell(row.salons)} | ${row.mentions} | ${row.deleted} | ${row.visible} |`)
		.join('\n');
	const positive = data.employees.reduce((total, row) => total + row.positive, 0);
	const neutral = data.employees.reduce((total, row) => total + row.neutral, 0);
	const negative = data.employees.reduce((total, row) => total + row.negative, 0);
	const negativeBlocks = data.negativeReviews.length > 0
		? data.negativeReviews.map((review) => [
			`**${review.date} — ${review.salon} — ${review.rating} ${plural(review.rating, 'étoile')} — ${review.author}**`,
			`> « ${review.excerpt} »`,
			'',
			review.analysis
		].join('\n')).join('\n\n')
		: 'Aucun avis de 1 à 3 étoiles sur la période.';
	const deletedRows = data.deletedReviews
		.map((review) => `| ${review.date} | ${tableCell(review.salon)} | ${tableCell(review.author)} | ${review.rating}★ | ${review.employees.length > 0 ? review.employees.map(tableCell).join(', ') : '—'} |`)
		.join('\n');
	const arbitrationBlocks = data.arbitrations.length > 0
		? data.arbitrations.map((item) => `**${item.title}** — ${item.body}`).join('\n\n')
		: 'Aucun arbitrage nécessaire.';
	const annexBlocks = data.annex.map((group) => {
		const lines = group.mentions.map((mention) => {
			const deleted = mention.deleted ? ' **[supprimé]**' : '';
			const sentiment = mention.sentiment === 'positive' ? '' : ` **[${mention.sentiment}]**`;
			return `- ${mention.date}, ${tableCell(mention.author)}, ${mention.rating}★ : « ${mention.excerpt} »${deleted}${sentiment}`;
		});
		return `**${group.employee} — ${group.mentions.length} ${plural(group.mentions.length, 'mention')}**\n${lines.join('\n')}`;
	}).join('\n\n');
	const noMentionLines = data.noMentionReviews.map((review) => {
		const excerpt = review.excerpt ? ` : « ${review.excerpt} »` : ' (sans texte)';
		return `- ${review.date}, ${tableCell(review.salon)}, ${tableCell(review.author)}, ${review.rating}★${excerpt}${review.deleted ? ' **[supprimé]**' : ''}`;
	}).join('\n');
	const pendingText = data.replyCoverage.pending > 0
		? `${data.replyCoverage.pending} ${plural(data.replyCoverage.pending, 'avis reste', 'avis restent')} en attente, signalé${data.replyCoverage.pending > 1 ? 's' : ''} dans les points à arbitrer.`
		: 'Aucun avis visible ne reste en attente.';

	return `---
type: livrable-client
projet: ${data.projectName.toLowerCase().replace(/\s+/g, '')}
date: "${data.generatedDate}"
periode: "${data.periodKey}"
destinataire: ${data.recipient}
description: >
  Email récapitulatif mensuel des avis Google et des mentions nominatives d'employés,
  ${data.periodLabel} ${data.periodKey.slice(0, 4)}.
tags: [gmb, avis, employes]
---

**Objet :** ${data.projectName} — récap avis Google ${data.periodLabel} ${data.periodKey.slice(0, 4)} et mentions par collaborateur

---

Bonjour,

Voici le récapitulatif des avis Google ${periodWithDe} pour les six salons, avec le détail des mentions nominatives par collaborateur.

${data.arbitrations.length > 0 ? `${data.arbitrations.length} ${plural(data.arbitrations.length, 'point demande', 'points demandent')} votre arbitrage avant que les primes soient calculées, ${data.arbitrations.length > 1 ? 'ils sont signalés' : 'il est signalé'} en fin de message.` : 'Aucun point ne demande d’arbitrage pour cette période.'}

---

## 1. Le mois en chiffres

**${data.summary.reviews} avis reçus en ${data.periodLabel}, note moyenne ${decimal(data.summary.average)}/5.**

| | |
|---|---|
| Avis reçus | ${data.summary.reviews} |
| Note moyenne | ${decimal(data.summary.average)} / 5 |
${ratingRows}
| Avis citant un collaborateur par son nom | ${data.summary.reviewsWithMentions} |
| Mentions nominatives au total | ${data.summary.mentionItems} |
| Collaborateurs cités | ${data.summary.collaborators} |

| Mois | Avis | Moyenne |
|---|---|---|
${historyRows}

> **Méthode.** ${data.methodNote} Source resynchronisée le ${data.sourceSyncedAt}.

**Par salon**

| Salon | Avis | Moyenne | Mentions nominatives |
|---|---|---|---|
${locationRows}

---

## 2. Mentions par collaborateur

Une mention = un avis dans lequel le client cite le prénom du collaborateur. Les alias ne sont regroupés que lorsqu'ils ont été validés dans le roster canonique.

La colonne « supprimés » est expliquée au point 4 : ce sont des avis reçus en ${data.periodLabel} mais qui ne sont plus en ligne aujourd'hui.

| Collaborateur | Salon | Mentions | dont supprimés | Reste visible |
|---|---|---|---|---|
${employeeRows}
| **Total** | | **${data.summary.mentionItems}** | **${data.employees.reduce((total, row) => total + row.deleted, 0)}** | **${data.employees.reduce((total, row) => total + row.visible, 0)}** |

Sur les ${data.summary.mentionItems} mentions classifiées, **${positive} sont positives**, ${neutral} ${plural(neutral, 'est neutre', 'sont neutres')} et ${negative} ${plural(negative, 'est négative', 'sont négatives')}.

---

## 3. Les avis négatifs

${negativeBlocks}

---

## 4. Avis supprimés

${data.summary.deletedReviews} ${plural(data.summary.deletedReviews, `avis reçu en ${data.periodLabel}`, `avis reçus en ${data.periodLabel}`)} ne ${data.summary.deletedReviews === 1 ? 'figure' : 'figurent'} plus sur les fiches Google au moment de la synchronisation finale.

| Date | Salon | Auteur | Note | Collaborateur cité |
|---|---|---|---|---|
${deletedRows || '| — | — | — | — | — |'}

---

## 5. Points à arbitrer

${arbitrationBlocks}

---

## 6. Réponses aux avis

**${data.replyCoverage.remotelyAnswered} avis visibles sur ${data.replyCoverage.visibleReviews} ont une réponse vérifiée chez Google.** ${pendingText}

Divergences entre le hub et Google : ${data.replyCoverage.divergent}.

---

Je reste à disposition pour toute question sur le détail.

Bien à vous,
Jonathan

---
---

# Annexe — détail des mentions, avis par avis

Les avis marqués **[supprimé]** ne sont plus en ligne.

${annexBlocks}

## Avis sans mention nominative attribuable — ${data.noMentionReviews.length}

Ces avis comptent dans le volume et la note du mois, mais ne citent personne de manière attribuable.

${noMentionLines}
`;
}
