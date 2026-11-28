'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PremiumRedemptionError,
  listPremiumRedemptions,
  redeemPremiumCode,
  redeemPremiumReward,
} = require('../lib/premium-redemptions');

function community() {
  return {
    profiles: {
      listener: { premium: false, premiumUntil: 0 },
      lifetime: { premium: true, premiumUntil: null },
      legacyLifetime: { premium: true },
    },
  };
}

test('a premium code is consumed and granted in the same community state', () => {
  const now = Date.now();
  const state = community();
  const codes = { ABC234XY: { type: 'premium', days: 30 } };

  const result = redeemPremiumCode({
    community: state,
    codes,
    code: 'abc234xy',
    user: 'listener',
    now,
    id: 'code-redemption-1',
  });

  assert.equal(result.redemption.kind, 'code');
  assert.equal(result.redemption.user, 'listener');
  assert.equal(result.redemption.days, 30);
  assert.equal(result.redemption.status, 'redeemed');
  assert.equal(result.redemption.until, now + 30 * 86400000);
  assert.equal(state.profiles.listener.premium, true);
  assert.equal(state.profiles.listener.premiumUntil, now + 30 * 86400000);
  assert.equal(state.premiumCodeRedemptions.ABC234XY.redemptionId, 'code-redemption-1');
  assert.equal(state.premiumRedemptions['code-redemption-1'].code, 'ABC234XY');
});

test('a legacy reward code keeps the duration of the reward that issued it', () => {
  const now = Date.now();
  const state = community();
  const result = redeemPremiumCode({
    community: state,
    codes: { JACKPOT1: true },
    code: 'JACKPOT1',
    user: 'listener',
    now,
    id: 'code-redemption-hint',
    hints: { JACKPOT1: { type: 'jackpot', days: 7 } },
  });
  assert.equal(result.redemption.days, 7);
  assert.equal(state.profiles.listener.premiumUntil, now + 7 * 86400000);
});

test('a premium code cannot be redeemed by another user', () => {
  const state = community();
  const codes = { ABC234XY: { type: 'premium', days: 30 } };
  redeemPremiumCode({
    community: state,
    codes,
    code: 'ABC234XY',
    user: 'listener',
    id: 'code-redemption-2',
  });

  assert.throws(() => redeemPremiumCode({
    community: state,
    codes,
    code: 'ABC234XY',
    user: 'lifetime',
    id: 'code-redemption-3',
  }), (error) => error instanceof PremiumRedemptionError && error.status === 409 && error.code === 'CODE_USED');
  assert.equal(Object.keys(state.premiumRedemptions).length, 1);
});

test('retrying the same code for the same user returns the original receipt', () => {
  const now = Date.now();
  const state = community();
  const codes = { ABC234XY: { type: 'premium', days: 30 } };
  const first = redeemPremiumCode({
    community: state,
    codes,
    code: 'ABC234XY',
    user: 'listener',
    id: 'code-redemption-retry',
    now,
  });
  const retry = redeemPremiumCode({
    community: state,
    codes,
    code: 'ABC234XY',
    user: 'listener',
    id: 'code-redemption-retry-2',
    now: now + 5000,
  });

  assert.equal(retry.idempotent, true);
  assert.equal(retry.redemption.id, first.redemption.id);
  assert.equal(state.profiles.listener.premiumUntil, now + 30 * 86400000);
  assert.equal(Object.keys(state.premiumRedemptions).length, 1);
});

test('a malformed code is rejected before any lookup', () => {
  const state = community();
  assert.throws(() => redeemPremiumCode({
    community: state,
    codes: {},
    code: 'x y',
    user: 'listener',
  }), (error) => error instanceof PremiumRedemptionError && error.status === 400 && error.code === 'CODE_INVALID');
  assert.equal(Object.keys(state.premiumRedemptions).length, 0);
});

test('retrying a reward redemption never extends premium twice', () => {
  const now = Date.now();
  const state = community();
  const first = redeemPremiumReward({
    community: state,
    user: 'listener',
    rewardCode: 'WK-ABC234',
    premiumCode: 'PREMIUM1',
    type: 'premium',
    now,
    id: 'reward-redemption-idempotent',
  });
  const retry = redeemPremiumReward({
    community: state,
    user: 'listener',
    rewardCode: 'WK-ABC234',
    premiumCode: 'PREMIUM1',
    type: 'premium',
    now: now + 9000,
    id: 'reward-redemption-idempotent',
  });

  assert.equal(retry.idempotent, true);
  assert.equal(retry.redemption.id, first.redemption.id);
  assert.equal(state.profiles.listener.premiumUntil, now + 30 * 86400000);
  assert.equal(Object.keys(state.premiumRedemptions).length, 1);
});

test('every receipt records who redeemed it and when', () => {
  const now = Date.now();
  const state = community();
  const reward = redeemPremiumReward({
    community: state,
    user: 'listener',
    rewardCode: 'WK-ABC234',
    premiumCode: 'PREMIUM1',
    type: 'premium',
    now,
    id: 'reward-redemption-receipt',
  });
  assert.equal(reward.redemption.redeemedBy, 'listener');
  assert.equal(reward.redemption.issuedBy, 'listening-reward');
  assert.equal(reward.redemption.redeemedAt, now);
  assert.equal(reward.redemption.autoRedeemed, true);
});

test('a lifetime entitlement is not downgraded by a premium code', () => {
  const now = Date.now();
  const state = community();
  const result = redeemPremiumCode({
    community: state,
    codes: { JACKPOT1: { type: 'jackpot', days: 7 } },
    code: 'JACKPOT1',
    user: 'lifetime',
    now,
    id: 'code-redemption-lifetime',
  });

  assert.equal(result.redemption.days, 7);
  assert.equal(result.redemption.until, null);
  assert.equal(state.profiles.lifetime.premiumUntil, null);
});

test('a premium listening reward is redeemed automatically', () => {
  const now = Date.now();
  const state = community();
  const result = redeemPremiumReward({
    community: state,
    user: 'listener',
    rewardCode: 'WK-ABC234',
    premiumCode: 'PREMIUM1',
    type: 'premium',
    now,
    id: 'reward-redemption-1',
  });

  assert.equal(result.redemption.kind, 'reward');
  assert.equal(result.redemption.user, 'listener');
  assert.equal(result.redemption.days, 30);
  assert.equal(result.redemption.autoRedeemed, true);
  assert.equal(result.redemption.rewardCode, 'WK-ABC234');
  assert.equal(result.redemption.until, now + 30 * 86400000);
  assert.equal(state.profiles.listener.premium, true);
  assert.equal(state.premiumCodeRedemptions.PREMIUM1.redemptionId, 'reward-redemption-1');
  assert.equal(state.premiumRedemptions['reward-redemption-1'].autoRedeemed, true);
});

test('a jackpot listening reward grants seven days', () => {
  const now = Date.now();
  const state = community();
  const result = redeemPremiumReward({
    community: state,
    user: 'listener',
    rewardCode: 'WK-JACKPOT',
    premiumCode: 'JACKPOT2',
    type: 'jackpot',
    now,
    id: 'reward-redemption-jackpot',
  });

  assert.equal(result.redemption.days, 7);
  assert.equal(state.profiles.listener.premiumUntil, now + 7 * 86400000);
});

test('the unified redemption feed includes gifts, codes, and rewards', () => {
  const now = Date.now();
  const state = community();
  state.premiumRedemptions = {
    gift1: { id: 'gift1', kind: 'gift', user: 'listener', giftedBy: 'friend', days: 7, at: now, redeemedAt: now },
  };
  redeemPremiumCode({
    community: state,
    codes: { CODE1234: { type: 'premium', days: 30 } },
    code: 'CODE1234',
    user: 'listener',
    now: now + 1,
    id: 'code-redemption-4',
  });
  redeemPremiumReward({
    community: state,
    user: 'listener',
    rewardCode: 'WK-REWARD',
    premiumCode: 'REWARD12',
    type: 'premium',
    now: now + 2,
    id: 'reward-redemption-2',
  });

  const records = listPremiumRedemptions(state);
  assert.deepEqual(records.map((record) => record.kind), ['reward', 'code', 'gift']);
  assert.equal(records[0].autoRedeemed, true);
});
