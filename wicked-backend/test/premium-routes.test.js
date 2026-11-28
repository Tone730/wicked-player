'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const authSource = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8').replace(/\r\n/g, '\n');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('member gifts persist the grant before reporting success', () => {
  const route = section(authSource, "router.post('/api/premium/gift'", '/* Both sides can verify');
  assert.ok(route.indexOf('atomicWriteJSON(COMM_FILE, comm)') < route.indexOf('res.json('));
  assert.match(route, /status\(503\)/);
  assert.match(route, /premiumRedemptionEmitter/);
});

test('premium code redemption commits consumption before reporting success', () => {
  const route = section(authSource, 'router.post("/api/reward/redeem"', '/* ---------- premium gifting');
  assert.ok(route.indexOf('atomicWriteJSON(COMM_FILE, comm)') < route.indexOf('res.json('));
  assert.match(route, /status\(503\)/);
  assert.match(route, /premiumCodeRedemptions|redeemPremiumCode/);
});

test('automatic reward redemption persists the premium grant before success', () => {
  const helper = section(serverSource, 'function commitPremiumReward(', 'const REWARD_TYPES = [');
  assert.ok(helper.indexOf('atomicWriteJSON(communityFile, comm)') < helper.indexOf("io.to('admins').emit('premium:redemption'"));
  assert.match(helper, /status: 503/);
  assert.match(helper, /redeemPremiumReward/);
  assert.match(helper, /premium:redemption/);
  const route = section(serverSource, "app.post('/api/reward/issue'", "app.get('/api/config/discord-invite'");
  assert.match(route, /commitPremiumReward/);
  assert.match(route, /status\(503\)/);
  assert.match(route, /pending_redemption/);
});

test('only premium and jackpot rewards are redeemed automatically', () => {
  assert.match(serverSource, /function isPremiumRewardType\(type\) \{\s*return type === 'premium' \|\| type === 'jackpot';/);
  const route = section(serverSource, "app.post('/api/reward/issue'", "app.get('/api/config/discord-invite'");
  assert.match(route, /isPremiumRewardType\(finalType\.type\)/);
  assert.doesNotMatch(route, /'mega'/);
});

test('the admin claim endpoint trusts committed receipts, not the reward type', () => {
  const route = section(serverSource, "app.post('/api/admin/reward/claim'", 'RECOMMEND (Auto-DJ)');
  assert.match(route, /receipts\[rw\.redemptionId\]/);
  assert.match(route, /alreadyRedeemed = Boolean\(receipt\)/);
  assert.doesNotMatch(route, /rw\.autoRedeemed \|\| receipt/);
  assert.doesNotMatch(route, /rw\.type === 'premium'/);
});

test('an automatic reward without a receipt is retried instead of being stranded', () => {
  const route = section(serverSource, "app.post('/api/admin/reward/claim'", 'RECOMMEND (Auto-DJ)');
  assert.match(route, /if \(rw\.redemptionId && !receipt\)/);
  assert.match(route, /commitPremiumReward\(d, rw, req/);
  assert.match(route, /REWARD_NOT_REDEEMED/);
  /* A failed retry must leave the reward retryable, never claimed. */
  assert.ok(route.indexOf("rw.status = 'failed'") < route.indexOf('res.json({ ok: true, alreadyRedeemed: true, reward: rw })'));
});

test('a delayed reward retry grants the full duration from the commit time', () => {
  const helper = section(serverSource, 'function commitPremiumReward(', 'const REWARD_TYPES = [');
  assert.doesNotMatch(helper, /now: Number\(rw\.at\)/);
  assert.match(helper, /\n\s+now,\n/);
});

test('the gift route requires an idempotency key', () => {
  const route = section(authSource, "router.post('/api/premium/gift'", '/* Both sides can verify');
  assert.match(route, /if \(!requestId \|\| !\/\^\[A-Za-z0-9_-\]\{8,64\}\$\/\.test\(requestId\)\)/);
  assert.match(route, /INVALID_REQUEST_ID/);
});

test('referral rewards use the committed receipt as the idempotency key', () => {
  const route = section(authSource, "router.post('/api/referrals/apply'", '/* premium request:');
  assert.match(route, /const redemptionId = `referral:\$\{owner\}:\$\{count\}`/);
  assert.match(route, /comm\.premiumRedemptions\[redemptionId\]/);
  assert.match(route, /if \(!saveUsers\(\)\)/);
  assert.match(route, /readCommunityStrict\(\)/);
  /* A failed community write rolls the referral back instead of acknowledging it. */
  assert.match(route, /ref\.referralCount = previousCount/);
});

test('community writers never fall back to an empty document', () => {
  assert.doesNotMatch(authSource, /readJsonSafe\(COMM_FILE/);
  assert.doesNotMatch(authSource, /fs\.writeFileSync\(COMM_FILE/);
  const communitySource = fs.readFileSync(path.join(__dirname, '..', 'community.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(communitySource, /class CommunityStoreError/);
  assert.match(communitySource, /refusing to write while the store is unreadable/);
  assert.match(communitySource, /router\.use\(\(error, _req, res, next\) => \{/);
  assert.match(communitySource, /status\(503\)/);
});

test('authoritative stores are read with the schema-checked readers', () => {
  assert.match(authSource, /readCommunityStrict/);
  assert.match(authSource, /readCodesStore\(CODES_FILE/);
  assert.match(authSource, /readRewardsStore\(/);
  assert.match(serverSource, /readRewardsStore\(rewardsFile\)/);
  assert.match(serverSource, /readCommunityStore\(communityFile\)/);
  assert.match(serverSource, /readCodesStore\(codesFile\)/);
});

test('the admin feed includes committed premium receipts and legacy history', () => {
  const route = section(authSource, 'router.get("/admin/api/redemptions"', 'router.post("/admin/api/premium-request/decide"');
  assert.match(route, /listPremiumRedemptions/);
  assert.match(route, /listGiftRedemptions/);
});
