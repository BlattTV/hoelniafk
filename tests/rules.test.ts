import { describe, expect, it } from 'vitest';
import { classifyMail, extractCodes, parseChatLine, parseRules, senderMatches } from '../src/core/rules.js';
import { TEST_RULES } from './helpers.js';

describe('mail rules', () => {
  it('matches sender globs', () => {
    expect(senderMatches('*.discord.com', 'noreply@discord.com')).toBe(true);
    expect(senderMatches('*.discord.com', 'noreply@mail.discord.com')).toBe(true);
    expect(senderMatches('*.discord.com', 'noreply@discord.com.evil.io')).toBe(false);
    expect(senderMatches('*.discord.com', 'x@notdiscord.com')).toBe(false);
    expect(senderMatches('noreply@*.example.com', 'noreply@a.example.com')).toBe(true);
  });

  it('classifies verification and security mails from config', () => {
    expect(classifyMail(TEST_RULES, { from: 'noreply@discord.com', subject: 'Verify your email' })).toMatchObject({ provider: 'Discord', category: 'verification' });
    expect(
      classifyMail(TEST_RULES, { from: 'account-security-noreply@accountprotection.microsoft.com', subject: 'Microsoft account security code' }),
    ).toMatchObject({ provider: 'Microsoft', category: 'security' });
    expect(classifyMail(TEST_RULES, { from: 'noreply@discord.com', subject: 'Your weekly digest' })).toBeNull();
    expect(classifyMail(TEST_RULES, { from: 'friend@gmail.com', subject: 'verify this' })).toBeNull();
  });

  it('supports the exact example from the specification', () => {
    const rules = parseRules(`
mailRules:
  discord:
    senders:
      - "*.discord.com"
    subjectContains:
      - "verify"
  microsoft:
    subjectContains:
      - "security code"
`);
    expect(classifyMail(rules, { from: 'a@discord.com', subject: 'Please VERIFY' })?.ruleId).toBe('discord');
    expect(classifyMail(rules, { from: 'x@y.z', subject: 'Your security code' })?.ruleId).toBe('microsoft');
  });

  it('extracts codes with rule-specific or default patterns', () => {
    expect(extractCodes(TEST_RULES, 'microsoft-security', 'Microsoft account security code', 'Please use the following security code: 482913.')).toEqual(['482913']);
    expect(extractCodes(TEST_RULES, 'discord', 'Verify', 'Your code: AB12CD')).toContain('AB12CD');
  });

  it('rejects invalid rule definitions', () => {
    expect(() => parseRules('mailRules:\n  x:\n    category: nope\n    senders: ["a"]')).toThrow();
    expect(() => parseRules('mailRules:\n  x: {}')).toThrow();
    expect(() => parseRules('chatRules:\n  x:\n    type: linking\n    linkCode: ["(unclosed"]')).toThrow(/Invalid regex/);
  });
});

describe('chat rules', () => {
  const active = ['hoelni-linking', 'hoelni-rewards'];
  it('detects link codes and link success', () => {
    expect(parseChatLine(TEST_RULES, active, '§aLink your account using code §eABC123')).toEqual([{ kind: 'linkCode', ruleSet: 'hoelni-linking', code: 'ABC123' }]);
    expect(parseChatLine(TEST_RULES, active, 'Discord linked successfully!')).toEqual([{ kind: 'linked', ruleSet: 'hoelni-linking' }]);
  });
  it('detects reward messages', () => {
    expect(parseChatLine(TEST_RULES, active, 'You have 24 stars')).toEqual([{ kind: 'starsSet', ruleSet: 'hoelni-rewards', stars: 24 }]);
    expect(parseChatLine(TEST_RULES, active, 'You received 3 stars for being online')).toEqual([{ kind: 'starsAdd', ruleSet: 'hoelni-rewards', delta: 3 }]);
  });
  it('only applies rule-sets enabled for the identity', () => {
    expect(parseChatLine(TEST_RULES, ['hoelni-rewards'], 'Link your account using code ABC123')).toEqual([]);
  });
});

describe('reconnect policy', () => {
  it('uses the configured rules from rules.yaml', async () => {
    const { decideReconnect } = await import('../src/core/rules.js');
    const { PROJECT_RULES } = await import('./helpers.js');
    const p = PROJECT_RULES.reconnect;
    expect(decideReconnect(p, 'You are banned from this server', 1).action).toBe('block');
    expect(decideReconnect(p, 'You are not white-listed on this server!', 1).action).toBe('block');
    expect(decideReconnect(p, 'You logged in from another location', 1).action).toBe('block');
    const throttled = decideReconnect(p, 'Connection throttled! Please wait before reconnecting.', 1);
    expect(throttled.action).toBe('delay');
    expect(throttled.delaySec).toBeGreaterThanOrEqual(60);
    const plain = decideReconnect(p, 'socketClosed', 1);
    expect(plain.action).toBe('retry');
    expect(plain.delaySec).toBeLessThanOrEqual(12);
  });

  it('backs off exponentially up to the maximum', async () => {
    const { decideReconnect } = await import('../src/core/rules.js');
    const p = { baseDelaySec: 10, maxDelaySec: 600, stableAfterSec: 300, rules: [] };
    const d = [1, 2, 3, 4, 10].map((f) => decideReconnect(p, 'x', f).delaySec);
    expect(d[1]).toBeGreaterThan(d[0]);
    expect(d[3]).toBeGreaterThan(d[2]);
    expect(d[4]).toBeLessThanOrEqual(600 * 1.15);
    expect(decideReconnect(p, 'x', 8, true).delaySec).toBeLessThanOrEqual(12); // crash: no escalation
  });
});
