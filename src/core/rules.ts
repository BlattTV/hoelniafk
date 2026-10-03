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
  /** Regexes for sidebar scoreboard lines, named group "stars" – the balance as the server shows it. */
  scoreboard: string[];
  /** Sidebar line that is only the label ("⭐ Sterne") – the balance is the number in the line below. */
  scoreboardLabel: string[];
  eligible: string[];
  notEligible: string[];
  /** Reward was handed out. */
  received: string[];
  /** Reward is pending / waiting for a condition. */
  waiting: string[];
  /** Server reports the Discord link state relevant for rewards. */
  discordLinked: string[];
  discordNotLinked: string[];
}

/** renew: the session (Minecraft token / chat keys) expired – renew it in the background and reconnect at once. */
export type ReconnectAction = 'retry' | 'delay' | 'block' | 'renew';

export interface ReconnectRule {
  /** Case-insensitive regexes matched against the kick/disconnect reason. */
  match: string[];
  action: ReconnectAction;
  /** For action "delay": minimum delay before the next attempt. */
  delaySec?: number;
  label: string;
}

export interface ReconnectPolicy {
  baseDelaySec: number;
  maxDelaySec: number;
  /** Online for this long → the failure counter resets. */
  stableAfterSec: number;
  /** Retries after a runtime crash use the base delay without escalation. */
  rules: ReconnectRule[];
}

export type ChatRuleSet = LinkingRuleSet | RewardRuleSet;

export interface RulesConfig {
  mailRules: MailRule[];
  defaultCodePatterns: string[];
  chatRules: ChatRuleSet[];
  reconnect: ReconnectPolicy;
}

export const DEFAULT_RECONNECT: ReconnectPolicy = {
  baseDelaySec: 10,
  maxDelaySec: 600,
  stableAfterSec: 300,
  rules: [],
};

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

/** Star balance in the sidebar – used when a rules.yaml has no "scoreboard" section (same as the shipped file). */
export const DEFAULT_SCOREBOARD = [
  "(Sterne|Stars?)\\s*[:»>|=\\-–]*\\s*(?<stars>\\d[\\d.,']*)",
  "(?<stars>\\d[\\d.,']*)\\s*(Sterne|Stars?)\\b",
  "[⭐★✦✧✪✯☆]\\s*[:»>|=\\-–]*\\s*(?<stars>\\d[\\d.,']*)",
];
export const DEFAULT_SCOREBOARD_LABEL = ['^\\W*(Sterne|Stars?)\\W*$'];

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
        // an older rules.yaml (kept because it was edited) has no scoreboard section: built-in patterns
        scoreboard: (r.scoreboard === undefined ? DEFAULT_SCOREBOARD : arr(r.scoreboard)).map((p) => checkRegex(p, `chatRules.${id}.scoreboard`)),
        scoreboardLabel: (r.scoreboardLabel === undefined ? DEFAULT_SCOREBOARD_LABEL : arr(r.scoreboardLabel)).map((p) => checkRegex(p, `chatRules.${id}.scoreboardLabel`)),
        eligible: arr(r.eligible).map((p) => checkRegex(p, `chatRules.${id}.eligible`)),
        notEligible: arr(r.notEligible).map((p) => checkRegex(p, `chatRules.${id}.notEligible`)),
        received: arr(r.received).map((p) => checkRegex(p, `chatRules.${id}.received`)),
        waiting: arr(r.waiting).map((p) => checkRegex(p, `chatRules.${id}.waiting`)),
        discordLinked: arr(r.discordLinked).map((p) => checkRegex(p, `chatRules.${id}.discordLinked`)),
        discordNotLinked: arr(r.discordNotLinked).map((p) => checkRegex(p, `chatRules.${id}.discordNotLinked`)),
      });
    } else {
      throw new ValidationError(`chatRules.${id}.type must be "linking" or "rewards"`);
    }
  }
  const rc = raw.reconnect ?? {};
  const reconnect: ReconnectPolicy = {
    baseDelaySec: Number(rc.baseDelaySec ?? DEFAULT_RECONNECT.baseDelaySec),
    maxDelaySec: Number(rc.maxDelaySec ?? DEFAULT_RECONNECT.maxDelaySec),
    stableAfterSec: Number(rc.stableAfterSec ?? DEFAULT_RECONNECT.stableAfterSec),
    rules: (Array.isArray(rc.rules) ? rc.rules : []).map((r: any, i: number) => {
      const action = String(r?.action ?? 'retry') as ReconnectAction;
      if (!['retry', 'delay', 'block', 'renew'].includes(action)) throw new ValidationError(`reconnect.rules[${i}].action must be retry|delay|block|renew`);
      return {
        match: arr(r?.match).map((p) => checkRegex(p, `reconnect.rules[${i}].match`)),
        action,
        delaySec: r?.delaySec !== undefined ? Number(r.delaySec) : undefined,
        label: String(r?.label ?? action),
      };
    }),
  };
  if (!(reconnect.baseDelaySec > 0) || !(reconnect.maxDelaySec >= reconnect.baseDelaySec)) {
    throw new ValidationError('reconnect: baseDelaySec must be > 0 and maxDelaySec >= baseDelaySec');
  }
  return {
    mailRules,
    defaultCodePatterns: arr(raw.defaultCodePatterns).map((p) => checkRegex(p, 'defaultCodePatterns')),
    chatRules,
    reconnect,
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
  | { kind: 'eligible'; ruleSet: string; eligible: boolean }
  | { kind: 'received'; ruleSet: string }
  | { kind: 'waiting'; ruleSet: string }
  | { kind: 'rewardDiscord'; ruleSet: string; linked: boolean };

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
      if (rs.notEligible.some((p) => new RegExp(p, 'i').test(line))) out.push({ kind: 'eligible', ruleSet: rs.id, eligible: false });
      else if (rs.eligible.some((p) => new RegExp(p, 'i').test(line))) out.push({ kind: 'eligible', ruleSet: rs.id, eligible: true });
      if (rs.received.some((p) => new RegExp(p, 'i').test(line))) out.push({ kind: 'received', ruleSet: rs.id });
      if (rs.waiting.some((p) => new RegExp(p, 'i').test(line))) out.push({ kind: 'waiting', ruleSet: rs.id });
      if (rs.discordNotLinked.some((p) => new RegExp(p, 'i').test(line))) out.push({ kind: 'rewardDiscord', ruleSet: rs.id, linked: false });
      else if (rs.discordLinked.some((p) => new RegExp(p, 'i').test(line))) out.push({ kind: 'rewardDiscord', ruleSet: rs.id, linked: true });
    }
  }
  return out;
}

/** One sidebar line: its text and the score number (hidden = the server shows no number). */
export interface ScoreboardLine {
  text: string;
  value: number;
  hidden?: boolean;
}

/** Number as servers print it ("1.234", "1,234", "1 234", "12k" is not a number of stars). */
function starsNumber(s: string): number | null {
  const digits = s.replace(/[.,\s']/g, '');
  if (!/^\d{1,12}$/.test(digits)) return null;
  return Number(digits);
}

/**
 * The star balance shown in the sidebar scoreboard (first matching line). Each line is tried as the
 * player sees it ("Sterne: 1.234") and – when the server shows the score number – with the number
 * appended ("Sterne" with score 1234).
 */
export function parseScoreboard(rules: RulesConfig, activeRuleSets: string[], lines: ScoreboardLine[]): { stars: number; ruleSet: string; line: string } | null {
  for (const rs of rules.chatRules) {
    if (rs.type !== 'rewards' || !activeRuleSets.includes(rs.id)) continue;
    const res = (rs.scoreboard ?? []).map((p) => new RegExp(p, 'i'));
    const labels = (rs.scoreboardLabel ?? []).map((p) => new RegExp(p, 'i'));
    const clean = (s: string) => stripFormatting(s).replace(/\s+/g, ' ').trim();
    for (const [i, l] of lines.entries()) {
      const text = clean(l.text);
      // "⭐ Sterne" with the number in the next line
      if (labels.some((re) => re.test(text)) && lines[i + 1]) {
        const next = clean(lines[i + 1].text);
        const n = starsNumber(next.replace(/^[^\d]*/, '').replace(/[^\d.,' ]+.*$/, '').trim());
        if (n !== null) return { stars: n, ruleSet: rs.id, line: `${text} ${next}`.slice(0, 200) };
      }
      const tries = l.hidden ? [text] : [text, `${text} ${l.value}`];
      for (const t of tries) {
        for (const re of res) {
          const m = re.exec(t);
          const v = m?.groups?.stars ?? m?.[1];
          const n = v === undefined ? null : starsNumber(v);
          if (n !== null) return { stars: n, ruleSet: rs.id, line: t.slice(0, 200) };
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- reconnect policy

export interface ReconnectDecision {
  action: ReconnectAction;
  delaySec: number;
  label: string;
}

/**
 * Decides how to react to a session end. `failures` is the number of consecutive
 * failed attempts (0 after a stable online period).
 */
export function decideReconnect(policy: ReconnectPolicy, reason: string, failures: number, crash = false): ReconnectDecision {
  const text = reason ?? '';
  for (const r of policy.rules) {
    if (r.match.some((p) => new RegExp(p, 'i').test(text))) {
      if (r.action === 'block') return { action: 'block', delaySec: 0, label: r.label };
      // Expired session: renew right away – twice in a row means the renewal itself does not help.
      if (r.action === 'renew') return failures <= 2 ? { action: 'renew', delaySec: 0, label: r.label } : { action: 'block', delaySec: 0, label: `${r.label} (renewal did not help)` };
      if (r.action === 'delay') {
        const d = Math.max(r.delaySec ?? policy.baseDelaySec, backoff(policy, failures));
        return { action: 'delay', delaySec: Math.min(d, Math.max(policy.maxDelaySec, r.delaySec ?? 0)), label: r.label };
      }
      return { action: 'retry', delaySec: backoff(policy, failures), label: r.label };
    }
  }
  return { action: 'retry', delaySec: crash ? policy.baseDelaySec : backoff(policy, failures), label: crash ? 'runtime crash' : 'disconnect' };
}

function backoff(policy: ReconnectPolicy, failures: number): number {
  const exp = policy.baseDelaySec * 2 ** Math.min(Math.max(failures - 1, 0), 10);
  const jitter = 0.85 + Math.random() * 0.3;
  return Math.round(Math.min(exp, policy.maxDelaySec) * jitter);
}
