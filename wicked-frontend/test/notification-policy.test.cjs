'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dist = path.join(__dirname, '..', 'dist');

function loadPolicy() {
  const source = fs.readFileSync(path.join(dist, 'notification-policy.js'), 'utf8');
  const sandbox = { module: { exports: {} }, exports: {}, window: {} };
  vm.runInNewContext(source, sandbox, { filename: 'notification-policy.js' });
  return sandbox.module.exports;
}

test('server failures are classified by endpoint instead of all being save failures', () => {
  const policy = loadPolicy();

  assert.deepEqual(
    { ...policy.classifyResponse('/stream?q=Bad%20Guy', 'GET', 502) },
    { kind: 'playback', message: "Couldn't play this track", notify: false, retry: false },
  );
  assert.equal(policy.classifyResponse('/api/profile', 'POST', 502).kind, 'save');
  assert.match(policy.classifyResponse('/api/profile', 'POST', 502).message, /^Save failed \(502\)/);
  assert.equal(policy.classifyResponse('/api/profile', 'GET', 502).kind, 'ignored');
  assert.equal(policy.classifyResponse('/library/playlists', 'GET', 500).kind, 'ignored');
  assert.equal(policy.classifyResponse('/api/presence/config', 'GET', 500).kind, 'ignored');
  assert.equal(policy.classifyResponse('/library/history', 'POST', 502).notify, false);
  assert.equal(policy.classifyResponse('/search?q=pop', 'GET', 500).notify, false);
});

test('rate limits are retryable and repeated notifications are deduplicated', () => {
  const policy = loadPolicy();
  const busy = policy.classifyResponse('/search?q=pop', 'GET', 429);

  assert.equal(busy.kind, 'busy');
  assert.equal(busy.retry, true);
  assert.equal(policy.classifyResponse('/api/profile', 'POST', 429).retry, false);
  assert.equal(policy.classifyResponse('/stream?q=test', 'GET', 429).kind, 'playback');
  assert.equal(policy.classifyResponse('/stream?q=test', 'GET', 429).retry, true);

  const deduper = policy.createNotificationDeduper(1000);
  assert.equal(deduper('Save failed (502). Please try again.', 1000), true);
  assert.equal(deduper('Save failed (502). Please try again.', 1200), false);
  assert.equal(deduper('Save failed (502). Please try again.', 2100), true);
});

test('the compiled genre card uses the dedicated genre endpoint', () => {
  const bundle = fs.readFileSync(path.join(dist, 'assets', 'index-2kADS7Vh-p4.js'), 'utf8');

  assert.match(bundle, /async function Hg\(a\)/);
  assert.match(bundle, /\/genre\?q=/);
  assert.match(bundle, /onClick:\(\)=>Hg\(a\)/);
  assert.doesNotMatch(bundle, /onClick:\(\)=>Hs\(a\)/);
});

test('the enhancement layer queues prefetches instead of resolving every hovered track', () => {
  const enhance = fs.readFileSync(path.join(dist, 'enhance.js'), 'utf8');

  assert.match(enhance, /api\/stream-cache\/warm/);
  assert.doesNotMatch(enhance, /fetch\('\/stream\?q=' \+ encodeURIComponent\(q\)/);
});

test('upgrades remove legacy preview entries from the session stream cache', () => {
  const enhance = fs.readFileSync(path.join(dist, 'enhance.js'), 'utf8');

  assert.match(enhance, /removedCachedPreview/);
  assert.match(enhance, /streamMem\[key\]\?\.data\?\.preview/);
  assert.match(enhance, /if \(removedCachedPreview\) saveStream\(\)/);
});

test('the release publisher packages the authoritative compiled frontend', () => {
  const releaseScript = fs.readFileSync(path.join(
    dist, '..', '..', 'electron', 'release.ps1',
  ), 'utf8');
  const makeLatest = fs.readFileSync(path.join(
    dist, '..', '..', 'electron', 'make-latest.js',
  ), 'utf8');
  const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');

  assert.doesNotMatch(releaseScript, /npm run build/);
  assert.match(releaseScript, /verifying frontend distribution/);
  assert.match(releaseScript, /index-2kADS7Vh-p4\.js/);
  assert.ok(releaseScript.includes('enhance\\.js\\?ov=18'));
  assert.ok(releaseScript.includes('notification-policy\\.js\\?ov=1'));
  assert.ok(releaseScript.includes('playback-policy\\.js\\?ov=2'));
  assert.ok(releaseScript.includes('index-2kADS7Vh-p4\\.js\\?v=3514'));
  assert.match(releaseScript, /node make-latest\.js/);
  assert.match(releaseScript, /Wicked-Player-Setup-\$V\.exe/);
  assert.match(makeLatest, /Wicked-Player-Setup-\$\{pkg\.version\}\.exe/);
  assert.match(index, /assets\/index-2kADS7Vh-p4\.js/);
  assert.match(index, /notification-policy\.js/);
  assert.match(index, /playback-policy\.js/);
  assert.match(index, /enhance\.js/);
});

test('preview playback upgrades to the cached full stream without caching the preview', () => {
  const enhance = fs.readFileSync(path.join(dist, 'enhance.js'), 'utf8');
  const bundle = fs.readFileSync(path.join(dist, 'assets', 'index-2kADS7Vh-p4.js'), 'utf8');

  assert.match(enhance, /schedulePreviewUpgrade/);
  assert.match(enhance, /if \(!key \|\| !preview\?\.preview\) return;/);
  assert.match(enhance, /applyFullStream/);
  assert.match(bundle, /x\.preview\|\|r\.current\.set\(d,x\)/);
});
