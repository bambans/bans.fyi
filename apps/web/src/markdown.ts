import { marked } from 'marked';
import DOMPurify from 'dompurify';

export async function renderMarkdown(markdown: string): Promise<string> {
  const withLinks = markdown.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, label) => {
    const text = label || target;
    const path = normalizeWikiTarget(target);
    return `[${text}](#/file/${encodeURIComponent(path)})`;
  });

  const raw = await marked.parse(withLinks);
  return DOMPurify.sanitize(raw);
}

export function normalizeWikiTarget(target: string): string {
  const clean = String(target).trim().replace(/^content\//, '').replace(/\.md$/, '');
  if (clean === 'index') return 'content/index.md';
  if (clean.includes('/')) return `content/${clean}.md`;
  return `content/notes/${clean}.md`;
}

export function parseFrontmatter(markdown: string): Record<string, unknown> {
  if (!markdown.startsWith('---')) return {};
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return {};
  const raw = markdown.slice(3, end).trim();
  const data: Record<string, unknown> = {};

  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value.slice(1, -1).split(',').map((v) => v.trim()).filter(Boolean);
    } else {
      data[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  return data;
}
