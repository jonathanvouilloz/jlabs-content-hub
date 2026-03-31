import matter from 'gray-matter';
import { marked } from 'marked';

export function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
	const { data, content } = matter(raw);
	return { data, content };
}

export function renderMarkdown(md: string): string {
	return marked.parse(md, { async: false }) as string;
}
