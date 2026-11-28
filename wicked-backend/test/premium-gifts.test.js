'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GIFT_COOLDOWN_MS,
  GiftError,
  listGiftRedemptions,
  redeemPremiumGift,
} = require('../lib/premium-gifts');

function community() {
  const now = Date.now();
  return {
    profiles: {
      sender: {
        premium: true,
        premiumUntil: now + 30 * 86400000,
      },
      recipient: {
        premium: false,
        premiumUntil: 0,
      },
    },
  };
}

test('a premium gift is redeemed automatically and recorded for the sender, recipient, and admin', () => {
  const now = Date.now();
  const state = community();
  const result = redeemPremiumGift({
    community: state,
    users: { sender: {}, recipient: {} },
    sender: 'sender',
    recipient: 'recipient',
    days: 7,
    now,
    id: 'gift-test-1',
  });

  assert.equal(result.redemption.status, 'redeemed');
  assert.equal(result.redemption.kind, 'gift');
  assert.equal(result.redemption.user, 'recipient');
  assert.equal(result.redemption.giftedBy, 'sender');
  assert.equal(result.redemption.redeemedAt, now);
  assert.equal(result.redemption.until, now + 7 * 86400000);
  assert.equal(state.profiles.recipient.premium, true);
  assert.equal(state.profiles.recipient.premiumUntil, now + 7 * 86400000);
  assert.equal(state.profiles.sender.giftedTo[0].status, 'redeemed');
  assert.equal(state.profiles.sender.giftedTo[0].user, 'recipient');
  assert.equal(state.profiles.sender.giftedTo[0].id, 'gift-test-1');
  assert.equal(state.profiles.recipient.receivedGifts[0].id, 'gift-test-1');
  assert.equal(state.premiumRedemptions['gift-test-1'].user, 'recipient');
});

test('the same gift request id returns the original receipt without granting twice', () => {
  const now = Date.now();
  const state = community();
  const users = { sender: {}, recipient: {} };
  const first = redeemPremiumGift({
    community: state,
    users,
    sender: 'sender',
    recipient: 'recipient',
    days: 7,
    now,
    id: 'gift-test-request-1',
    requestId: 'req-abcdef123456',
  });
  const retry = redeemPremiumGift({
    community: state,
    users,
    sender: 'sender',
    recipient: 'recipient',
    days: 7,
    now: now + 5000,
    id: 'gift-test-request-2',
    requestId: 'req-abcdef123456',
  });

  assert.equal(retry.idempotent, true);
  assert.equal(retry.redemption.id, first.redemption.id);
  assert.equal(state.profiles.recipient.premiumUntil, now + 7 * 86400000);
  assert.equal(Object.keys(state.premiumRedemptions).length, 1);
});

test('a reused gift request id with different details is rejected', () => {
  const now = Date.now();
  const state = community();
  const users = { sender: {}, recipient: {}, other: {} };
  redeemPremiumGift({
    community: state,
    users,
    sender: 'sender',
    recipient: 'recipient',
    days: 7,
    now,
    id: 'gift-test-request-3',
    requestId: 'req-abcdef123457',
  });

  assert.throws(() => redeemPremiumGift({
    community: state,
    users,
    sender: 'sender',
    recipient: 'other',
    days: 30,
    now: now + 1000,
    id: 'gift-test-request-4',
    requestId: 'req-abcdef123457',
  }), (error) => error instanceof GiftError && error.status === 409 && error.code === 'REQUEST_REUSED');
  assert.equal(state.profiles.other, undefined);
});

test('a gift receipt records the recipient as the redeemer', () => {
  const now = Date.now();
  const state = community();
  const result = redeemPremiumGift({
    community: state,
    users: { sender: {}, recipient: {} },
    sender: 'sender',
    recipient: 'recipient',
    days: 30,
    now,
    id: 'gift-test-redeemer',
  });
  assert.equal(result.redemption.redeemedBy, 'recipient');
  assert.equal(result.redemption.issuedBy, 'sender');
  assert.equal(result.redemption.autoRedeemed, true);
});

test('a premium gift extends the recipient current premium expiry', () => {
  const now = Date.now();
  const state = community();
  state.profiles.recipient.premium = true;
  state.profiles.recipient.premiumUntil = now + 10 * 86400000;

  const result = redeemPremiumGift({
    community: state,
    users: { sender: {}, recipient: {} },
    sender: 'sender',
    recipient: 'recipient',
    days: 30,
    now,
    id: 'gift-test-2',
  });

  assert.equal(result.redemption.until, now + 40 * 86400000);
  assert.equal(state.profiles.recipient.premiumUntil, now + 40 * 86400000);
});

test('a premium gift does not downgrade a lifetime recipient', () => {
  const now = Date.now();
  const state = community();
  state.profiles.recipient.premium = true;
  state.profiles.recipient.premiumUntil = null;

  const result = redeemPremiumGift({
    community: state,
    users: { sender: {}, recipient: {} },
    sender: 'sender',
    recipient: 'recipient',
    days: 30,
    now,
    id: 'gift-lifetime-1',
  });

  assert.equal(result.redemption.until, null);
  assert.equal(state.profiles.recipient.premiumUntil, null);
  assert.equal(state.profiles.recipient.premium, true);
});

test('a premium gift rejects unsupported durations', () => {
  const state = community();
  assert.throws(() => redeemPremiumGift({
    community: state,
    users: { sender: {}, recipient: {} },
    sender: 'sender',
    recipient: 'recipient',
    days: 14,
  }), (error) => error instanceof GiftError && error.status === 400 && error.code === 'INVALID_DAYS');
  assert.equal(state.profiles.recipient.premium, false);
});

test('a non-premium account cannot gift premium', () => {
  const state = community();
  state.profiles.sender.premium = false;
  state.profiles.sender.premiumUntil = 0;

  assert.throws(() => redeemPremiumGift({
    community: state,
    users: { sender: {}, recipient: {} },
    sender: 'sender',
    recipient: 'recipient',
    days: 7,
  }), (error) => error instanceof GiftError && error.status === 403);
  assert.equal(state.profiles.recipient.premium, false);
});

test('a gift cannot target an unknown account or the sender', () => {
  const state = community();
  assert.throws(() => redeemPremiumGift({
    community: state,
    users: { sender: {} },
    sender: 'sender',
    recipient: 'missing',
    days: 7,
  }), (error) => error instanceof GiftError && error.status === 404);
  assert.throws(() => redeemPremiumGift({
    community: state,
    users: { sender: {}, recipient: {} },
    sender: 'sender',
    recipient: 'sender',
    days: 7,
  }), (error) => error instanceof GiftError && error.status === 400);
});

test('a premium member can send only one gift every seven days', () => {
  const now = Date.now();
  const state = community();
  state.profiles.sender.lastGiftAt = now - GIFT_COOLDOWN_MS + 1;

  assert.throws(() => redeemPremiumGift({
    community: state,
    users: { sender: {}, recipient: {} },
    sender: 'sender',
    recipient: 'recipient',
    days: 7,
    now,
  }), (error) => error instanceof GiftError && error.status === 429);
  assert.equal(state.profiles.recipient.premium, false);
});

test('banned accounts cannot send or receive a premium gift', () => {
  const now = Date.now();
  const state = community();
  const bannedSender = { sender: { banned: true }, recipient: {} };
  assert.throws(() => redeemPremiumGift({
    community: state,
    users: bannedSender,
    sender: 'sender',
    recipient: 'recipient',
    days: 7,
    now,
  }), (error) => error instanceof GiftError && error.status === 403 && error.code === 'ACCOUNT_BANNED');
  assert.equal(state.profiles.recipient.premium, false);

  const bannedRecipient = { sender: {}, recipient: { banned: true, bannedUntil: now + 1000 } };
  assert.throws(() => redeemPremiumGift({
    community: state,
    users: bannedRecipient,
    sender: 'sender',
    recipient: 'recipient',
    days: 7,
    now,
  }), (error) => error instanceof GiftError && error.status === 409 && error.code === 'RECIPIENT_UNAVAILABLE');
  assert.equal(state.profiles.recipient.premium, false);
});

test('gift redemption history is available to the admin feed', () => {
  const now = Date.now();
  const state = community();
  redeemPremiumGift({
    community: state,
    users: { sender: {}, recipient: {} },
    sender: 'sender',
    recipient: 'recipient',
    days: 7,
    now,
    id: 'gift-test-3',
  });

  const records = listGiftRedemptions(state);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'gift-test-3');
  assert.equal(records[0].user, 'recipient');
  assert.equal(records[0].giftedBy, 'sender');
});
