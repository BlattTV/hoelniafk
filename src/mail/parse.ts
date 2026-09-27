import { simpleParser } from 'mailparser';

export interface ParsedAttachment {
  index: number;
  filename: string;
  contentType: string;
  size: number;
}

export interface ParsedMessage {
  from: string;
  fromName: string | null;
  to: string[];
  subject: string;
  date: string | null;
  text: string;
  html: string | null;
  links: Array<{ url: string; text: string }>;
  attachments: ParsedAttachment[];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

export function extractLinks(html: string | null, text: string): Array<{ url: string; text: string }> {
  const seen = new Map<string, string>();
  if (html) {
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = m[1].replace(/&amp;/g, '&').trim();
      if (!/^https?:\/\//i.test(url)) continue;
      const label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!seen.has(url)) seen.set(url, label || url);
    }
  }
  for (const m of text.matchAll(URL_RE)) if (!seen.has(m[0])) seen.set(m[0], m[0]);
  return [...seen.entries()].slice(0, 100).map(([url, t]) => ({ url, text: t.slice(0, 200) }));
}

export async function parseMessage(source: Buffer): Promise<ParsedMessage & { rawAttachments: Array<{ content: Buffer }> }> {
  const p = await simpleParser(source, { skipImageLinks: true });
  const addrList = (v: any): string[] => {
    const arr = Array.isArray(v) ? v : v ? [v] : [];
    return arr.flatMap((x: any) => (x.value ?? []).map((a: any) => String(a.address ?? '').toLowerCase())).filter(Boolean);
  };
  const text = p.text ?? '';
  const html = typeof p.html === 'string' ? p.html : null;
  return {
    from: p.from?.value?.[0]?.address?.toLowerCase() ?? '',
    fromName: p.from?.value?.[0]?.name || null,
    to: [...addrList(p.to), ...addrList(p.cc)],
    subject: p.subject ?? '',
    date: p.date ? p.date.toISOString() : null,
    text,
    html,
    links: extractLinks(html, text),
    attachments: p.attachments.map((a, index) => ({
      index,
      filename: a.filename ?? `attachment-${index + 1}`,
      contentType: a.contentType,
      size: a.size,
    })),
    rawAttachments: p.attachments.map((a) => ({ content: a.content })),
  };
}
