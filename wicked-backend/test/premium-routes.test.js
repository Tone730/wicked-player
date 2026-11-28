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
  assert.match(route, /alreadyRedeemed = Boolean\(rw\.autoRedeemed \|\| receipt\)/);
  assert.doesNotMatch(route, /rw\.type === 'premium'/);
});

test('authoritative stores are read with the strict reader', () => {
  assert.match(authSource, /readCommunityStrict/);
  assert.match(authSource, /readJSONStrict\(CODES_FILE/);
  assert.match(serverSource, /readJSONStrict\(rewardsFile/);
  assert.match(serverSource, /readJSONStrict\(communityFile/);
});

test('the admin feed includes committed premium receipts and legacy history', () => {
  const route = section(authSource, 'router.get("/admin/api/redemptions"', 'router.post("/admin/api/premium-request/decide"');
  assert.match(route, /listPremiumRedemptions/);
  assert.match(route, /listGiftRedemptions/);
});
