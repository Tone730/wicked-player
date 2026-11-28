'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PremiumStoreError,
  readCommunityStore,
  readCodesStore,
  readRewardsStore,
} = require('../lib/premium-store');
const { redeemPremiumCode, PremiumRedemptionError } = require('../lib/premium-redemptions');
const { redeemPremiumGift, GiftError } = require('../lib/premium-gifts');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-store-'));
}

test('a community document with invalid JSON is rejected instead of read as empty', () => {
  const dir = tempDir();
  const file = path.join(dir, 'community.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => readCommunityStore(file), (error) => error instanceof PremiumStoreError && error.status === 503);
});

test('a community document with an array profile map is rejected', () => {
  const dir = tempDir();
  const file = path.join(dir, 'community.json');
  fs.writeFileSync(file, JSON.stringify({ profiles: [], premiumRedemptions: {} }));
  assert.throws(() => readCommunityStore(file), (error) => error instanceof PremiumStoreError);
});

test('a community document that is an array is rejected', () => {
  const dir = tempDir();
  const file = path.join(dir, 'community.json');
  fs.writeFileSync(file, JSON.stringify([1, 2, 3]));
  assert.throws(() => readCommunityStore(file), (error) => error instanceof PremiumStoreError);
});

test('a missing community file starts empty and missing sections are initialized', () => {
  const dir = tempDir();
  const state = readCommunityStore(path.join(dir, 'community.json'));
  assert.deepEqual(state.profiles, {});
  assert.deepEqual(state.premiumRedemptions, {});
  assert.deepEqual(state.premiumCodeRedemptions, {});
  assert.deepEqual(state.giftRequests, {});
});

test('a reward store with a broken issued list is rejected instead of reset', () => {
  const dir = tempDir();
  const file = path.join(dir, 'rewards.json');
  fs.writeFileSync(file, JSON.stringify({ issued: { nope: true } }));
  assert.throws(() => readRewardsStore(file), (error) => error instanceof PremiumStoreError);
});

test('a reward store that is an array is rejected', () => {
  const dir = tempDir();
  const file = path.join(dir, 'rewards.json');
  fs.writeFileSync(file, JSON.stringify([]));
  assert.throws(() => readRewardsStore(file), (error) => error instanceof PremiumStoreError);
});

test('a code store that is an array is rejected', () => {
  const dir = tempDir();
  const file = path.join(dir, 'codes.json');
  fs.writeFileSync(file, JSON.stringify(['ABC12345']));
  assert.throws(() => readCodesStore(file), (error) => error instanceof PremiumStoreError);
});

test('a redemption against a broken community store fails instead of granting premium', () => {
  const community = { profiles: [] };
  assert.throws(() => redeemPremiumCode({
    community,
    codes: { ABC234XY: { type: 'premium', days: 30 } },
    code: 'ABC234XY',
    user: 'listener',
    id: 'store-shape-test',
  }), (error) => error instanceof PremiumStoreError && error.status === 503);
  /* Nothing may be granted when the store shape is broken. */
  assert.deepEqual(community.profiles, []);
});

test('a gift against a broken community store fails instead of granting premium', () => {
  const community = { profiles: {} };
  community.premiumRedemptions = [];
  assert.throws(() => redeemPremiumGift({
    community,
    users: { sender: {}, recipient: {} },
    sender: 'sender',
    recipient: 'recipient',
    days: 7,
    id: 'store-shape-gift',
    requestId: 'req-abcdef123456',
  }), (error) => error instanceof PremiumStoreError);
  assert.equal(community.profiles.recipient, undefined);
});

test('a code store that is not an object fails the redemption', () => {
  assert.throws(() => redeemPremiumCode({
    community: { profiles: {} },
    codes: ['ABC234XY'],
    code: 'ABC234XY',
    user: 'listener',
    id: 'store-shape-codes',
  }), (error) => error instanceof PremiumStoreError);
});

test('a plain legacy code still grants 30 days', () => {
  const now = Date.now();
  const state = { profiles: {} };
  const result = redeemPremiumCode({
    community: state,
    codes: { LEGACY1: true },
    code: 'LEGACY1',
    user: 'listener',
    now,
    id: 'legacy-code-test',
  });
  assert.equal(result.redemption.days, 30);
  assert.equal(state.profiles.listener.premiumUntil, now + 30 * 86400000);
});

test('a code whose duration cannot be established fails closed', () => {
  const state = { profiles: {} };
  assert.throws(() => redeemPremiumCode({
    community: state,
    codes: { UNKNOWN1: { note: 'no duration here' } },
    code: 'UNKNOWN1',
    user: 'listener',
    id: 'unknown-duration-test',
  }), (error) => error instanceof PremiumRedemptionError && error.status === 503 && error.code === 'CODE_METADATA_UNKNOWN');
  assert.equal(state.profiles.listener, undefined);
});

test('a gift without an idempotency key is rejected by the route contract', () => {
  const authSource = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8');
  assert.match(authSource, /if \(!requestId \|\|/);
  assert.match(authSource, /INVALID_REQUEST_ID/);
  assert.ok(GiftError);
});
