/**
 * Live takeover: packets for the game are checked by the id in their bytes (not only by the parsed
 * name) – a cookie request labelled differently upstream must never reach the game ("Failed to decode
 * packet 'clientbound/minecraft:cookie_request'" on 1.21.11 behind Velocity/ViaVersion).
 */
import { describe, expect, it } from 'vitest';
import { rawPacketName } from '../src/runtime/host/takeover.js';

describe('raw packet ids (1.21.11)', () => {
  it('maps configuration and play ids like the game does', () => {
    expect(rawPacketName('1.21.11', 'configuration', Buffer.from([0x00, 0x05, 0x61]))).toBe('cookie_request');
    expect(rawPacketName('1.21.11', 'configuration', Buffer.from([0x07, 0x00]))).toBe('registry_data');
    expect(rawPacketName('1.21.11', 'configuration', Buffer.from([0x13]))).toBe('code_of_conduct');
    expect(rawPacketName('1.21.11', 'play', Buffer.from([0x15, 0x00]))).toBe('cookie_request');
    expect(rawPacketName('1.21.11', 'play', Buffer.from([0x00]))).toBe('bundle_delimiter');
  });
  it('unknown ids / versions give null (the packet is not passed on)', () => {
    expect(rawPacketName('1.21.11', 'configuration', Buffer.from([0x7f]))).toBeNull();
    expect(rawPacketName('0.0.1', 'play', Buffer.from([0x01]))).toBeNull();
  });
});
