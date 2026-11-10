'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { clampBounds, sanitizePlayerState, formatTime, mergeOverlaySettings } = require('../overlay-state.js');

const DISPLAYS = [
  { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },
];

test('clampBounds keeps an on-screen window untouched', () => {
  const b = clampBounds({ x: 100, y: 100, width: 440, height: 190 }, DISPLAYS);
  assert.deepStrictEqual(b, { x: 100, y: 100, width: 440, height: 190 });
});

test('clampBounds pulls an off-screen window back (monitor unplugged)', () => {
  const b = clampBounds({ x: 5000, y: 5000, width: 440, height: 190 }, DISPLAYS);
  assert.ok(b.x + b.width <= 1920 + 1920);
  assert.ok(b.y + b.height <= 1040);
  assert.ok(b.x >= 0 && b.y >= 0);
});

test('clampBounds handles negative coords', () => {
  const b = clampBounds({ x: -900, y: -50, width: 440, height: 190 }, DISPLAYS);
  assert.strictEqual(b.x, 0);
  assert.strictEqual(b.y, 0);
});

test('clampBounds enforces minimum size', () => {
  const b = clampBounds({ x: 10, y: 10, width: 10, height: 10 }, DISPLAYS);
  assert.ok(b.width >= 200);
  assert.ok(b.height >= 100);
});

test('clampBounds returns null for null input', () => {
  assert.strictEqual(clampBounds(null, DISPLAYS), null);
});

test('sanitizePlayerState normalizes good state', () => {
  const s = sanitizePlayerState({ playing: true, title: 'Song', artist: 'Artist', art: 'https://x/a.jpg', pos: 12.7, dur: 200 });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.hasTrack, true);
  assert.strictEqual(s.playing, true);
  assert.strictEqual(s.pos, 12.7);
  assert.strictEqual(s.dur, 200);
});

test('sanitizePlayerState handles garbage without throwing', () => {
  for (const bad of [null, undefined, 42, 'nope', {}, { title: 123, dur: 'abc', pos: -5 }]) {
    const s = sanitizePlayerState(bad);
    assert.strictEqual(typeof s.ok, 'boolean');
    assert.strictEqual(s.hasTrack, typeof bad === 'object' && bad !== null && !!bad.title);
  }
});

test('sanitizePlayerState marks no-track when title empty', () => {
  const s = sanitizePlayerState({ playing: true, title: '', artist: 'x' });
  assert.strictEqual(s.hasTrack, false);
  assert.strictEqual(s.playing, true);
});

test('sanitizePlayerState rejects non-http art urls', () => {
  const s = sanitizePlayerState({ title: 'x', art: 'file:///C:/evil.exe' });
  assert.strictEqual(s.art, null);
});

test('formatTime formats mm:ss and h:mm:ss', () => {
  assert.strictEqual(formatTime(0), '0:00');
  assert.strictEqual(formatTime(65), '1:05');
  assert.strictEqual(formatTime(3725), '1:02:05');
});

test('mergeOverlaySettings fills defaults and sanitizes', () => {
  const m = mergeOverlaySettings(undefined);
  assert.strictEqual(m.skin, 'winamp');
  assert.strictEqual(m.compact, false);
  assert.strictEqual(m.volume, 0.8);
  assert.strictEqual(m.bounds, null);
  const m2 = mergeOverlaySettings({ skin: 'xbox', compact: true, volume: 5, bounds: { x: 1, y: 2, width: 400, height: 160 } });
  assert.strictEqual(m2.skin, 'xbox');
  assert.strictEqual(m2.compact, true);
  assert.strictEqual(m2.volume, 1);
  assert.strictEqual(m2.bounds.width, 400);
});