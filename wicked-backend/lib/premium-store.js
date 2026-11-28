'use strict';
/* Schema-checked access to the authoritative premium stores.
   The community, reward, and code documents are the source of truth for
   premium entitlements, redemption receipts, and code consumption. A
   syntactically valid but structurally broken document (for example
   "profiles": []) must never be treated as an empty store: the readers below
   reject it so the request fails closed instead of silently dropping a grant
   that was already reported as successful. */

const { readJSONStrict, atomicWriteJSON } = require('./store');

class PremiumStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PremiumStoreError';
    this.status = 503;
    this.code = 'STORE_UNAVAILABLE';
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/* Community sections that must always be plain maps. A missing section is
   initialized for migration; a section that exists with the wrong shape is a
   corrupt store and raises instead. */
const COMMUNITY_MAP_SECTIONS = ['profiles', 'premiumRedemptions', 'premiumCodeRedemptions', 'giftRequests'];

function normalizeCommunityState(value) {
  if (!isPlainObject(value)) {
    throw new PremiumStoreError('The community store has an invalid shape.');
  }
  for (const key of COMMUNITY_MAP_SECTIONS) {
    const section = value[key];
    if (section === undefined || section === null) {
      value[key] = {};
      continue;
    }
    if (!isPlainObject(section)) {
      throw new PremiumStoreError(`The community store section '${key}' has an invalid shape.`);
    }
  }
  return value;
}

function readCommunityStore(file) {
  let raw;
  try {
    raw = readJSONStrict(file, null);
  } catch (error) {
    throw new PremiumStoreError(`The community store could not be read: ${error && error.message || error}`);
  }
  if (raw === null || raw === undefined) return normalizeCommunityState({ profiles: {} });
  return normalizeCommunityState(raw);
}

function readRewardsStore(file) {
  let raw;
  try {
    raw = readJSONStrict(file, null);
  } catch (error) {
    throw new PremiumStoreError(`The reward store could not be read: ${error && error.message || error}`);
  }
  if (raw === null || raw === undefined) return { issued: [] };
  if (!isPlainObject(raw)) {
    throw new PremiumStoreError('The reward store has an invalid shape.');
  }
  if (raw.issued !== undefined && raw.issued !== null && !Array.isArray(raw.issued)) {
    throw new PremiumStoreError('The reward store has an invalid issued list.');
  }
  raw.issued = Array.isArray(raw.issued) ? raw.issued : [];
  return raw;
}

function readCodesStore(file) {
  let raw;
  try {
    raw = readJSONStrict(file, null);
  } catch (error) {
    throw new PremiumStoreError(`The code store could not be read: ${error && error.message || error}`);
  }
  if (raw === null || raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new PremiumStoreError('The code store has an invalid shape.');
  }
  return raw;
}

/* One place for every authoritative premium write, so a failed read can never
   be turned into an empty document on disk. */
function writeCommunityStore(file, state) {
  return atomicWriteJSON(file, normalizeCommunityState(state));
}

module.exports = {
  PremiumStoreError,
  isPlainObject,
  normalizeCommunityState,
  readCommunityStore,
  readRewardsStore,
  readCodesStore,
  writeCommunityStore,
};
