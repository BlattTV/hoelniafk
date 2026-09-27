/**
 * Configurable rule engine. All recognition of verification mails, link codes
 * and reward messages is driven by rules.yaml – there is no provider- or
 * server-specific scraping code in the application.
 */
import fs from 'node:fs';
import YAML from 'yaml';
import { ValidationError } from './errors.js';

export type MailCategory = 'verification' | 'security' | 'account' | 'info';

export interface MailRule {
  id: string;
  /** Display name of the provider, e.g. "Discord". */
  provider: string;
  category: MailCategory;
  /** Sender globs. "*.discord.com" matches discord.com and all subdomains; patterns with "@" match full addresses. */
  senders: string[];
  subjectContains: string[];
  bodyContains: string[];
  /** Regexes to extract a code; first capture group (or named group "code") wins. */
  codePatterns: string[];
}

export interface LinkingRuleSet {
  id: string;
  type: 'linking';
  /** Regex with named group "code". */
  linkCode: string[];
  linked: string[];
  error: string[];
  unlinked: string[];
}

export interface RewardRuleSet {
  id: string;
  type: 'rewards';
  /** Regex with named group "stars" – sets the absolute value. */
  set: string[];
  /** Regex with named group "delta" – adds stars. */
  add: string[];
  eligible: string[];
  notEligible: string[];
}

export type ChatRuleSet = LinkingRuleSet | RewardRuleSet;

export interface RulesConfig {
  mailRules: MailRule[];
  defaultCodePatterns: string[];
  chatRules: ChatRuleSet[];
}

function arr(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

function checkRegex(src: string, where: string): string {
  try {
    new RegExp(src, 'i');
  } catch (e) {
    throw new ValidationError(`Invalid regex in ${where}: ${(e as Error).message}`);
  }
  return src;
}

export function parseRules(text: string): RulesConfig {
  const raw = (YAML.parse(text) ?? {}) as Record<string, any>;
  const mailRules: MailRule[] = [];
  for (const [id, r] of Object.entries<any>(raw.mailRules ?? {})) {
    const rule: MailRule = {
      id,
      provider: String(r?.provider ?? id.charAt(0).toUpperCase() + id.slice(1)),
      category: (r?.category ?? 'verification') as MailCategory,
      senders: arr(r?.senders).map((s) => s.toLowerCase()),
      subjectContains: arr(r?.subjectContains).map((s) => s.toLowerCase()),
      bodyContains: arr(r?.bodyContains).map((s) => s.toLowerCase()),
      codePatterns: arr(r?.codePatterns).map((p) => checkRegex(p, `mailRules.${id}.codePatterns`)),
    };
    if (!['verification', 'security', 'account', 'info'].includes(rule.category)) {
      throw new ValidationError(`mailRules.${id}.category must be verification|security|account|info`);
    }
    if (!rule.senders.length && !rule.subjectContains.length && !rule.bodyContains.length) {
      throw new ValidationError(`mailRules.${id} needs at least one of senders/subjectContains/bodyContains`);
    }
    mailRules.push(rule);
  }
  const chatRules: ChatRuleSet[] = [];
  for (const [id, r] of Object.entries<any>(raw.chatRules ?? {})) {
    if (r?.type === 'linking') {
      chatRules.push({
        id,
        type: 'linking',
        linkCode: arr(r.linkCode).map((p) => checkRegex(p, `chatRules.${id}.linkCode`)),
        linked: arr(r.linked).map((p) => checkRegex(p, `chatRules.${id}.linked`)),
        error: arr(r.error).map((p) => checkRegex(p, `chatRules.${id}.error`)),
        unlinked: arr(r.unlinked).map((p) => checkRegex(p, `chatRules.${id}.unlinked`)),
      });
    } else if (r?.type === 'rewards') {
      chatRules.push({
        id,
        type: 'rewards',
        set: arr(r.set).map((p) => checkRegex(p, `chatRules.${id}.set`)),
        add: arr(r.add).map((p) => checkRegex(p, `chatRules.${id}.add`)),
        eligible: arr(r.eligible).map((p) => checkRegex(p, `chatRules.${id}.eligible`)),
        notEligible: arr(r.notEligible).map((p) => checkRegex(p, `chatRules.${id}.notEligible`)),
      });
    } else {
      throw new ValidationError(`chatRules.${id}.type must be "linking" or "rewards"`);
    }
  }
  return {
    mailRules,
    defaultCodePatterns: arr(raw.defaultCodePatterns).map((p) => checkRegex(p, 'defaultCodePatterns')),
    chatRules,
  };
}

export function loadRules(file: string): RulesConfig {
  return parseRules(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------- mail rules

export function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

export function senderMatches(pattern: string, address: string): boolean {
  const addr = address.toLowerCase().trim();
  if (pattern.includes('@')) return globToRegex(pattern).test(addr);
  const domain = addr.includes('@') ? addr.slice(addr.lastIndexOf('@') + 1) : addr;
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return domain === base || globToRegex(pattern).test(domain);
  }
  return globToRegex(pattern).test(domain);
}

export interface MailClassification {
  ruleId: string;
  provider: string;
  category: MailCategory;
}

export interface ClassifiableMail {
  from: string;
  subject: string;
  text?: string;
}

export function classifyMail(rules: RulesConfig, mail: ClassifiableMail): MailClassification | null {
  const subject = (mail.subject ?? '').toLowerCase();
  const body = (mail.text ?? '').toLowerCase();
  for (const r of rules.mailRules) {
    if (r.senders.length && !r.senders.some((p) => senderMatches(p, mail.from ?? ''))) continue;
    if (r.subjectContains.length && !r.subjectContains.some((s) => subject.includes(s))) continue;
    // Rules with body conditions can only match once the body is loaded.
    if (r.bodyContains.length && (mail.text === undefined || !r.bodyContains.some((s) => body.includes(s)))) continue;
    return { ruleId: r.id, provider: r.provider, category: r.category };
  }
  return null;
}

/** Extract verification codes from a mail body using the matching rule's patterns (or the defaults). */
export function extractCodes(rules: RulesConfig, ruleId: string | null, subject: string, text: string): string[] {
  const rule = rules.mailRules.find((r) => r.id === ruleId);
  const patterns = rule?.codePatterns.length ? rule.codePatterns : rules.defaultCodePatterns;
  const found = new Set<string>();
  const haystack = `${subject}\n${text}`;
  for (const p of patterns) {
    const re = new RegExp(p, 'gim');
    for (const m of haystack.matchAll(re)) {
      const code = m.groups?.code ?? m[1] ?? m[0];
      if (code) found.add(code.trim());
      if (found.size >= 5) break;
    }
  }
  return [...found];
}

// ---------------------------------------------------------------- chat rules

export type ChatEvent =
  | { kind: 'linkCode'; ruleSet: string; code: string }
  | { kind: 'linked'; ruleSet: string }
  | { kind: 'unlinked'; ruleSet: string }
  | { kind: 'linkError'; ruleSet: string; message: string }
  | { kind: 'starsSet'; ruleSet: string; stars: number }
  | { kind: 'starsAdd'; ruleSet: string; delta: number }
  | { kind: 'eligible'; ruleSet: string; eligible: boolean };

/** Strip Minecraft § formatting codes. */
export function stripFormatting(s: string): string {
  return s.replace(/§[0-9a-fk-or]/gi, '');
}

export function parseChatLine(rules: RulesConfig, activeRuleSets: string[], rawLine: string): ChatEvent[] {
  const line = stripFormatting(rawLine);
  const out: ChatEvent[] = [];
  for (const rs of rules.chatRules) {
    if (!activeRuleSets.includes(rs.id)) continue;
    if (rs.type === 'linking') {
      for (const p of rs.linkCode) {
        const m = new RegExp(p, 'i').exec(line);
        const code = m?.groups?.code ?? m?.[1];
        if (code) {
          out.push({ kind: 'linkCode', ruleSet: rs.id, code });
          break;
        }
      }
      if (rs.linked.some((p) => new RegExp(p, 'i').test(line))) out.push({ kind: 'linked', ruleSet: rs.id });
      if (rs.unlinked.some((p) => new RegExp(p, 'i').test(line))) out.push({ kind: 'unlinked', ruleSet: rs.id });
      if (rs.error.some((p) => new RegExp(p, 'i').test(line))) out.push({ kind: 'linkError', ruleSet: rs.id, message: line.slice(0, 200) });
    } else {
      for (const p of rs.set) {
        const m = new RegExp(p, 'i').exec(line);
        const v = m?.groups?.stars ?? m?.[1];
        if (v !== undefined && !Number.isNaN(Number(v))) {
          out.push({ kind: 'starsSet', ruleSet: rs.id, stars: Number(v) });
          break;
        }
      }
      for (const p of rs.add) {
        const m = new RegExp(p, 'i').exec(line);
        const v = m?.groups?.delta ?? m?.[1];
        if (v !== undefined && !Number.isNaN(Number(v))) {
          out.push({ kind: 'starsAdd', ruleSet: rs.id, delta: Number(v) });
          break;
        }
      }
      if (rs.eligible.some((p) => new RegExp(p, 'i').test(line))) out.push({ kind: 'eligible', ruleSet: rs.id, eligible: true });
      if (rs.notEligible.some((p) => new RegExp(p, 'i').test(line))) out.push({ kind: 'eligible', ruleSet: rs.id, eligible: false });
    }
  }
  return out;
}
