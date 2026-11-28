'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const enhance = fs.readFileSync(path.join(__dirname, '..', 'dist', 'enhance.js'), 'utf8');
const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-2kADS7Vh-p4.js'), 'utf8');

test('the gift panel shows automatic redemption and a visible gift receipt', () => {
  assert.match(enhance, /\/api\/premium\/gifts/);
  assert.match(enhance, /wpGiftHistory/);
  assert.match(enhance, /Redeemed automatically/i);
  assert.match(enhance, /redeemedAt/);
});

test('gift history renders usernames as text instead of executable markup', () => {
  assert.match(enhance, /\.textContent\s*=/);
  assert.doesNotMatch(enhance, /innerHTML\s*=\s*[^;]*gift\.user/);
});

test('premium listening rewards are presented as automatically redeemed', () => {
  assert.match(bundle, /Premium rewards are redeemed automatically/i);
  assert.match(bundle, /View \/ claim reward/);
  assert.match(enhance, /redeemed automatically/i);
  assert.match(enhance, /data\.redemptions/);
});

test('the reward drop toast does not send automatic rewards to Discord', () => {
  assert.match(bundle, /d\.autoRedeemed\?" - redeemed automatically!":" - claim it on Discord!"/);
});

test('automatic reward state comes from the authoritative reward endpoint', () => {
  assert.match(enhance, /\/api\/rewards/);
  assert.match(enhance, /record\.autoRedeemed === true/);
  assert.match(enhance, /record\.status === 'redeemed'/);
  assert.match(enhance, /MutationObserver/);
  assert.match(enhance, /wpMarkRewardRows/);
});

test('every reward row is handled, not only the first match', () => {
  assert.ok(!enhance.includes("find((b) => /view / claim reward"));
  assert.match(enhance, /document\.addEventListener\('click'/);
  assert.match(enhance, /closest\('\.reward-row'\)/);
});

test('gift requests carry an idempotency key', () => {
  assert.match(enhance, /requestId: giftRequestId\(target, days\)/);
  assert.match(enhance, /randomUUID/);
});
