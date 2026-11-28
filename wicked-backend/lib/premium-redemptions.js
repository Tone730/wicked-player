'use strict';

const crypto = require('crypto');
const { grantPremiumDays } = require('./premium-gifts');

class PremiumRedemptionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PremiumRedemptionError';
    this.status = status;
    this.code = code;
  }
}

function ensureCommunity(community) {
  const state = community && typeof community === 'object' ? community : {};
  state.profiles = state.profiles && typeof state.profiles === 'object' ? state.profiles : {};
  state.premiumRedemptions = state.premiumRedemptions && typeof state.premiumRedemptions === 'object'
    ? state.premiumRedemptions
    : {};
  state.premiumCodeRedemptions = state.premiumCodeRedemptions && typeof state.premiumCodeRedemptions === 'object'
    ? state.premiumCodeRedemptions
    : {};
  return state;
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

/* Codes are short opaque tokens. Rejecting malformed input keeps junk and
   oversized strings out of the lookup and the persisted receipt. */
function validateCodeShape(code) {
  if (!code) throw new PremiumRedemptionError(400, 'CODE_REQUIRED', 'Enter your code');
  if (!/^[A-Z0-9][A-Z0-9-]{3,31}$/.test(code)) {
    throw new PremiumRedemptionError(400, 'CODE_INVALID', 'That code format is not valid');
  }
}

function durationFor(entry, fallback = 30, hint = null) {
  const days = Number(entry && entry.days);
  if (days === 7 || days === 30) return days;
  if (entry && entry.type === 'jackpot') return 7;
  /* Legacy reward codes were stored without their duration. The reward that
     issued the code still knows whether it was a 7-day jackpot. */
  const hinted = Number(hint && hint.days);
  if (hinted === 7 || hinted === 30) return hinted;
  if (hint && hint.type === 'jackpot') return 7;
  return fallback;
}

function commitRedemption(community, redemption, code) {
  const id = String(redemption.id || '').trim() || crypto.randomUUID();
  const receipt = { ...redemption, id };
  community.premiumRedemptions[id] = receipt;
  if (code) {
    community.premiumCodeRedemptions[code] = {
      redemptionId: id,
      user: receipt.user,
      usedAt: receipt.redeemedAt || receipt.at || Date.now(),
      days: receipt.days,
      code,
    };
  }
  return receipt;
}

/* Redeem an issued premium code. The grant, global redemption receipt, and
   code-consumption marker are all written into one community document so a
   successful response always means the code cannot be reused. Retrying the
   same code for the same user returns the original receipt instead of
   granting premium twice. */
function redeemPremiumCode(options = {}) {
  const community = ensureCommunity(options.community);
  const codes = options.codes && typeof options.codes === 'object' ? options.codes : {};
  const user = String(options.user || '').trim();
  const code = normalizeCode(options.code);
  const now = Number(options.now) || Date.now();
  const id = String(options.id || '').trim() || crypto.randomUUID();

  if (!user) throw new PremiumRedemptionError(401, 'LOGIN_REQUIRED', 'Login required');
  validateCodeShape(code);
  const entry = codes[code];
  if (!entry) throw new PremiumRedemptionError(404, 'UNKNOWN_CODE', 'Unknown code. Check for typos.');

  const marker = community.premiumCodeRedemptions[code];
  if (marker) {
    const receipt = community.premiumRedemptions[marker.redemptionId];
    if (receipt && receipt.user === user) {
      return { redemption: { ...receipt }, profile: community.profiles[user] || {}, idempotent: true };
    }
    throw new PremiumRedemptionError(409, 'CODE_USED', 'That code was already used');
  }
  if (entry && entry.used) {
    throw new PremiumRedemptionError(409, 'CODE_USED', 'That code was already used');
  }

  const days = durationFor(entry, 30, (options.hints && options.hints[code]) || null);
  const granted = grantPremiumDays(community.profiles, user, days, `code:${code}`, now);
  const redemption = commitRedemption(community, {
    id,
    kind: 'code',
    user,
    redeemedBy: user,
    issuedBy: 'code',
    code,
    days,
    at: now,
    redeemedAt: now,
    status: 'redeemed',
    autoRedeemed: false,
    until: granted.until,
    source: `code:${code}`,
  }, code);

  return { redemption, profile: granted.profile };
}

/* Listening rewards that contain premium are redeemed for their owner as soon
   as the reward is issued. Non-premium rewards never enter this path.
   The redemption id is the idempotency key: a retried redemption returns the
   original receipt instead of extending premium a second time. */
function redeemPremiumReward(options = {}) {
  const community = ensureCommunity(options.community);
  const user = String(options.user || '').trim();
  const rewardCode = normalizeCode(options.rewardCode);
  const premiumCode = normalizeCode(options.premiumCode);
  const type = String(options.type || '').trim();
  const now = Number(options.now) || Date.now();
  const id = String(options.id || '').trim() || crypto.randomUUID();

  if (!user) throw new PremiumRedemptionError(401, 'LOGIN_REQUIRED', 'Login required');
  if (!rewardCode || !premiumCode) {
    throw new PremiumRedemptionError(400, 'REWARD_INVALID', 'This premium reward is invalid');
  }
  const existing = community.premiumRedemptions[id];
  if (existing) {
    return { redemption: { ...existing }, profile: community.profiles[user] || {}, idempotent: true };
  }
  if (community.premiumCodeRedemptions[premiumCode]) {
    throw new PremiumRedemptionError(409, 'REWARD_USED', 'This premium reward was already redeemed');
  }

  const days = durationFor({ type }, 30);
  const granted = grantPremiumDays(community.profiles, user, days, `reward:${rewardCode}`, now);
  const redemption = commitRedemption(community, {
    id,
    kind: 'reward',
    user,
    redeemedBy: user,
    issuedBy: 'listening-reward',
    code: premiumCode,
    rewardCode,
    days,
    at: now,
    redeemedAt: now,
    status: 'redeemed',
    autoRedeemed: true,
    until: granted.until,
    source: `reward:${rewardCode}`,
  }, premiumCode);

  return { redemption, profile: granted.profile };
}

function listPremiumRedemptions(community) {
  const state = ensureCommunity(community);
  return Object.values(state.premiumRedemptions)
    .filter((row) => row && row.user)
    .map((row) => ({ ...row }))
    .sort((left, right) => Number(right.redeemedAt || right.at || 0) - Number(left.redeemedAt || left.at || 0));
}

module.exports = {
  PremiumRedemptionError,
  ensureCommunity,
  listPremiumRedemptions,
  redeemPremiumCode,
  redeemPremiumReward,
};
