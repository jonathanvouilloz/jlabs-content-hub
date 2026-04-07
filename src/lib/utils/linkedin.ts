export interface LinkedInPost {
	day: string;
	emoji: string;
	title: string;
	mainHook: string;
	hookA: string;
	hookB: string;
	strategy: string;
	articleUrl?: string;
	imagePrompt?: string;
}

const DAY_MARKERS = [
	{ pattern: '## 🟢', day: 'lundi', emoji: '🟢', imageLabel: 'Lundi' },
	{ pattern: '## 🔵', day: 'mercredi', emoji: '🔵', imageLabel: 'Mercredi' },
	{ pattern: '## 🟣', day: 'vendredi', emoji: '🟣', imageLabel: 'Vendredi' }
];

/**
 * Detect if a content body is a LinkedIn batch (3 posts with variants)
 */
export function isBatchFormat(body: string): boolean {
	return body.includes('## 🟢') && body.includes('## 🔵') && body.includes('## 🟣');
}

/**
 * Parse a LinkedIn batch markdown into 3 structured posts
 */
export function parseLinkedInBatch(markdown: string): LinkedInPost[] {
	const posts: LinkedInPost[] = [];

	// Split body from image prompts section
	const imagesSplit = markdown.split('## 🖼️');
	const withoutImages = imagesSplit[0] || markdown;
	const imagesSection = imagesSplit.length > 1 ? imagesSplit.slice(1).join('## 🖼️') : '';

	for (let i = 0; i < DAY_MARKERS.length; i++) {
		const marker = DAY_MARKERS[i];
		const startIdx = withoutImages.indexOf(marker.pattern);
		if (startIdx === -1) continue;

		// Find end of this post section
		const nextMarker = DAY_MARKERS[i + 1];
		const endIdx = nextMarker
			? withoutImages.indexOf(nextMarker.pattern)
			: withoutImages.length;

		const section = withoutImages.slice(startIdx, endIdx).trim();

		// Extract title from the header line: "## 🟢 LUNDI — Le problème du mauvais produit barbe"
		const headerLine = section.split('\n')[0];
		const titleMatch = headerLine.match(/—\s*(.+)$/);
		const title = titleMatch ? titleMatch[1].trim() : marker.day;

		// Extract sections
		const mainHook = extractSection(section, '### Accroche principale', ['### Accroche alternative A', '### Accroche alternative B', '**Stratégie', '**Lien article', '**Rappel article']);
		const hookA = extractSection(section, '### Accroche alternative A', ['### Accroche alternative B', '**Stratégie', '**Lien article', '**Rappel article']);
		const hookB = extractSection(section, '### Accroche alternative B', ['**Stratégie', '**Lien article', '**Rappel article']);

		// Extract strategy
		const strategyMatch = section.match(/\*\*Strat[eé]gie\s*:\*\*\s*(.+)/);
		const strategy = strategyMatch ? strategyMatch[1].trim() : '';

		// Extract article URL
		const urlMatch = section.match(/\*\*(?:Lien article|Rappel article)\s*:\*\*\s*(https?:\/\/\S+)/);
		const articleUrl = urlMatch ? urlMatch[1].trim() : undefined;

		const imagePrompt = extractImagePrompt(imagesSection, marker.imageLabel);

		posts.push({
			day: marker.day,
			emoji: marker.emoji,
			title,
			mainHook: cleanPostText(mainHook),
			hookA: cleanHookText(hookA),
			hookB: cleanHookText(hookB),
			strategy,
			articleUrl,
			imagePrompt
		});
	}

	return posts;
}

/**
 * Build the final text ready for LinkedIn posting
 */
export function buildFinalText(
	post: LinkedInPost,
	selectedHook: 'main' | 'A' | 'B' | 'custom',
	customText?: string
): string {
	if (selectedHook === 'main') {
		return post.mainHook;
	}

	if (selectedHook === 'custom' && customText) {
		return replaceFirstParagraph(post.mainHook, customText);
	}

	const hookText = selectedHook === 'A' ? post.hookA : post.hookB;
	return replaceFirstParagraph(post.mainHook, hookText);
}

// ── Helpers ──────────────────────────────────────────────────────

function extractSection(text: string, startHeader: string, endHeaders: string[]): string {
	const startIdx = text.indexOf(startHeader);
	if (startIdx === -1) return '';

	const afterHeader = text.slice(startIdx + startHeader.length);

	let endIdx = afterHeader.length;
	for (const header of endHeaders) {
		const idx = afterHeader.indexOf(header);
		if (idx !== -1 && idx < endIdx) {
			endIdx = idx;
		}
	}

	return afterHeader.slice(0, endIdx).trim();
}

function cleanPostText(text: string): string {
	return text
		.replace(/^---\s*$/gm, '')              // Remove horizontal rules
		.replace(/^\*\*Strat[eé]gie.*$/gm, '')  // Remove strategy lines
		.replace(/^\*\*Lien article.*$/gm, '')   // Remove link lines
		.replace(/^\*\*Rappel article.*$/gm, '') // Remove reminder lines
		.trim();
}

function extractImagePrompt(imagesSection: string, dayLabel: string): string | undefined {
	if (!imagesSection) return undefined;
	const re = new RegExp(`###\\s*Image\\s+${dayLabel}\\s*\\r?\\n\`\`\`[^\\n]*\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\``, 'i');
	const match = imagesSection.match(re);
	return match ? match[1].trim() : undefined;
}

function cleanHookText(text: string): string {
	return text
		.replace(/^---\s*$/gm, '')
		.trim();
}

function replaceFirstParagraph(fullText: string, newFirstParagraph: string): string {
	// Split by double newline to find the first "paragraph"
	const doubleNewlineIdx = fullText.indexOf('\n\n');
	if (doubleNewlineIdx === -1) {
		return newFirstParagraph;
	}

	const rest = fullText.slice(doubleNewlineIdx);
	return newFirstParagraph + rest;
}
