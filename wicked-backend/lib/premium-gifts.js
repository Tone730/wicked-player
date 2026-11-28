'use strict';

const crypto = require('crypto');
const { normalizeCommunityState } = require('./premium-store');

const GIFT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

class GiftError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'GiftError';
    this.status = status;
    this.code = code;
  }
}

function premiumActive(profile, now) {
  if (!profile) return false;
  if (profile.premiumUntil) return now < Number(profile.premiumUntil);
  return profile.premium === true;
}

function accountBanned(account, now) {
  if (!account || !account.banned) return false;
  const until = Number(account.bannedUntil);
  return !Number.isFinite(until) || until <= 0 || until > now;
}

/* Grant timed premium without ever downgrading an existing lifetime
   entitlement. The caller owns persistence so related audit state can be
   committed in the same atomic write. */
function grantPremiumDays(profiles, name, days, source, now = Date.now()) {
  const profile = profiles[name] || {};
  const lifetime = profile.premium === true
    && (profile.premiumUntil === null || profile.premiumUntil === undefined);
  if (lifetime) {
    profiles[name] = profile;
    return { profile, until: null, permanent: true };
  }
  const currentExpiry = Number(profile.premiumUntil) || 0;
  const baseExpiry = currentExpiry > now ? currentExpiry : now;
  const until = baseExpiry + (Number(days) || 30) * 86400000;
  profile.premium = true;
  profile.premiumUntil = until;
  profile.premiumSource = source || profile.premiumSource || 'premium';
  profiles[name] = profile;
  return { profile, until, permanent: false };
}

/* Apply a premium gift immediately. The caller persists the returned community
   state atomically, so the grant, global receipt, sender receipt, and recipient
   receipt are committed together. A client supplied request id makes the gift
   idempotent: retrying the same request returns the original receipt instead
   of granting premium twice. */
function redeemPremiumGift(options = {}) {
  /* A broken community document is a corrupt store, not an empty one: the gift
     grant and its receipts would be dropped while the request still reports
     success. The shape is validated so the route can fail closed. */
  const community = normalizeCommunityState(options.community && options.community
    ? options.community
    : { profiles: options.profiles || {} });
  const profiles = community.profiles;
  const users = options.users && typeof options.users === 'object' ? options.users : {};
  const sender = String(options.sender || '').trim();
  const recipient = String(options.recipient || '').trim();
  const now = Number(options.now) || Date.now();
  const id = String(options.id || '').trim() || crypto.randomUUID();
  const requestId = String(options.requestId || '').trim();
  const days = Number(options.days);
  if (days !== 7 && days !== 30) {
    throw new GiftError(400, 'INVALID_DAYS', 'Choose 7 or 30 days');
  }

  if (!sender || !recipient) {
    throw new GiftError(400, 'INVALID_RECIPIENT', 'Choose a recipient');
  }
  if (sender === recipient) {
    throw new GiftError(400, 'SELF_GIFT', 'You cannot gift yourself');
  }

  if (requestId) {
    const prior = community.giftRequests[requestId];
    if (prior) {
      const receipt = community.premiumRedemptions[prior.redemptionId];
      const sameRequest = prior.sender === sender
        && prior.recipient === recipient
        && Number(prior.days) === days;
      if (sameRequest && receipt) {
        return {
          redemption: { ...receipt },
          senderProfile: profiles[sender] || {},
          recipientProfile: profiles[recipient] || {},
          idempotent: true,
        };
      }
      throw new GiftError(409, 'REQUEST_REUSED', 'That gift request was already used with different details');
    }
  }

  const senderAccount = users[sender];
  if (!senderAccount) {
    throw new GiftError(401, 'ACCOUNT_NOT_FOUND', 'Your account could not be found');
  }
  if (accountBanned(senderAccount, now)) {
    throw new GiftError(403, 'ACCOUNT_BANNED', 'This account is banned');
  }

  const senderProfile = profiles[sender] || {};
  if (!premiumActive(senderProfile, now)) {
    throw new GiftError(403, 'PREMIUM_REQUIRED', 'Premium is required to gift it');
  }
  if (!Object.prototype.hasOwnProperty.call(users, recipient)) {
    throw new GiftError(404, 'RECIPIENT_NOT_FOUND', `No account named '${recipient}'`);
  }
  if (accountBanned(users[recipient], now)) {
    throw new GiftError(409, 'RECIPIENT_UNAVAILABLE', 'That account cannot receive premium right now');
  }
  if (senderProfile.lastGiftAt && now - Number(senderProfile.lastGiftAt) < GIFT_COOLDOWN_MS) {
    throw new GiftError(429, 'GIFT_COOLDOWN', 'You can send one gift every 7 days');
  }

  const granted = grantPremiumDays(profiles, recipient, days, `gift:${sender}`, now);
  const recipientProfile = granted.profile;
  const until = granted.until;

  const redemption = {
    id,
    kind: 'gift',
    user: recipient,
    redeemedBy: recipient,
    issuedBy: sender,
    giftedBy: sender,
    code: `gift:${sender}`,
    days,
    at: now,
    redeemedAt: now,
    status: 'redeemed',
    autoRedeemed: true,
    until,
  };

  senderProfile.lastGiftAt = now;
  senderProfile.giftedTo = Array.isArray(senderProfile.giftedTo) ? senderProfile.giftedTo : [];
  senderProfile.giftedTo.unshift({ ...redemption });
  senderProfile.giftedTo = senderProfile.giftedTo.slice(0, 50);
  profiles[sender] = senderProfile;

  recipientProfile.receivedGifts = Array.isArray(recipientProfile.receivedGifts)
    ? recipientProfile.receivedGifts
    : [];
  recipientProfile.receivedGifts.unshift({ ...redemption });
  recipientProfile.receivedGifts = recipientProfile.receivedGifts.slice(0, 50);
  profiles[recipient] = recipientProfile;

  community.premiumRedemptions[id] = { ...redemption };
  if (requestId) {
    community.giftRequests[requestId] = {
      redemptionId: id,
      sender,
      recipient,
      days,
      at: now,
    };
  }

  return { redemption, senderProfile, recipientProfile };
}

/* Build the admin-visible feed from the same atomic community write that
   grants the premium. Older gift records without a global receipt are still
   included so existing production history remains visible. */
function listGiftRedemptions(community) {
  const records = [];
  const seen = new Set();
  const add = (gift, fallbackSender = '') => {
    if (!gift || !gift.user) return;
    const giftedBy = gift.giftedBy || fallbackSender;
    const id = String(gift.id || '');
    const key = id ? `id:${id}` : `${gift.code || 'gift'}|${gift.user}|${gift.at || gift.redeemedAt || 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    records.push({
      id,
      kind: 'gift',
      user: gift.user,
      redeemedBy: gift.redeemedBy || gift.user,
      issuedBy: gift.issuedBy || giftedBy,
      giftedBy,
      code: gift.code || `gift:${giftedBy}`,
      days: Number(gift.days) || 0,
      at: Number(gift.at || gift.redeemedAt) || 0,
      redeemedAt: Number(gift.redeemedAt || gift.at) || 0,
      status: gift.status || 'redeemed',
      autoRedeemed: gift.autoRedeemed !== false,
      until: gift.until || null,
    });
  };

  const global = community && community.premiumRedemptions;
  if (global && typeof global === 'object') {
    for (const redemption of Object.values(global)) {
      if (redemption && redemption.kind === 'gift') add(redemption, redemption.giftedBy);
    }
  }

  const profiles = community && community.profiles;
  for (const [giftedBy, profile] of Object.entries(profiles || {})) {
    const gifts = Array.isArray(profile && profile.giftedTo) ? profile.giftedTo : [];
    for (const gift of gifts) add(gift, giftedBy);
  }

  records.sort((left, right) => right.at - left.at);
  return records;
}

module.exports = {
  GIFT_COOLDOWN_MS,
  GiftError,
  grantPremiumDays,
  listGiftRedemptions,
  premiumActive,
  redeemPremiumGift,
};
