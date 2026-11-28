'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dist = path.join(__dirname, '..', 'dist');

function loadPlaybackPolicy() {
  const source = fs.readFileSync(path.join(dist, 'playback-policy.js'), 'utf8');
  const sandbox = { window: {}, URL };
  vm.runInNewContext(source, sandbox, { filename: 'playback-policy.js' });
  return sandbox.window.wpPlaybackPolicy;
}

test('stream JSON resolves to a media URL and never exposes the JSON endpoint to audio elements', () => {
  const policy = loadPlaybackPolicy();
  const origin = 'https://wickedplayer.dev';

  assert.equal(
    policy.resolveMediaSource({
      proxied_url: '/audio?u=https%3A%2F%2Fmedia.example%2Ftrack.webm',
      audio_url: 'https://media.example/track.webm',
    }, origin),
    'https://wickedplayer.dev/audio?u=https%3A%2F%2Fmedia.example%2Ftrack.webm',
  );
  assert.equal(
    policy.resolveMediaSource({
      audio_url: 'https://media.example/track.webm',
    }, origin),
    'https://wickedplayer.dev/audio?u=https%3A%2F%2Fmedia.example%2Ftrack.webm',
  );
  assert.equal(policy.resolveMediaSource({ proxied_url: '/stream?q=track' }, origin), '');
  assert.equal(policy.resolveMediaSource(null, origin), '');
});

test('radio continuation yields to the application queue and to a newer selected track', () => {
  const policy = loadPlaybackPolicy();

  assert.equal(policy.shouldContinueRadio({
    queueLength: 12,
    queueIndex: 0,
    repeat: 'off',
    currentId: 'first',
  }), false);
  assert.equal(policy.shouldContinueRadio({
    queueLength: 1,
    queueIndex: 0,
    repeat: 'off',
    currentId: 'first',
  }), false);
  assert.equal(policy.shouldContinueRadio({
    queueLength: 0,
    queueIndex: -1,
    repeat: 'off',
    currentId: 'radio-track',
  }), true);
  assert.equal(policy.shouldContinueRadio({
    queueLength: 0,
    queueIndex: -1,
    repeat: 'off',
    currentId: 'new-track',
  }, {
    queueLength: 0,
    queueIndex: -1,
    repeat: 'off',
    currentId: 'old-track',
  }), false);
});

test('preview resume positions are clamped to the full media duration', () => {
  const policy = loadPlaybackPolicy();

  assert.equal(policy.clampResumePosition(12.5, 240), 12.5);
  assert.equal(policy.clampResumePosition(300, 240), 240);
  assert.equal(policy.clampResumePosition(-1, 240), 0);
});

test('track identity accepts both playback-context and catalog track shapes', () => {
  const policy = loadPlaybackPolicy();

  assert.equal(policy.sameTrack(
    { currentId: 'track-1', currentName: 'Killer', currentArtist: 'Phoebe Bridgers' },
    { id: 'track-1', name: 'Killer', artist: 'Phoebe Bridgers' },
  ), true);
  assert.equal(policy.sameTrack(
    { currentName: 'Killer', currentArtist: 'Phoebe Bridgers' },
    { name: 'Killer', artist: 'Phoebe Bridgers' },
  ), true);
  assert.equal(policy.sameTrack(
    { currentName: 'Killer', currentArtist: 'Phoebe Bridgers' },
    { name: 'Killer', artist: 'Billie Eilish' },
  ), false);
});

test('full-stream resume honors explicit pauses but accepts a naturally ended preview', () => {
  const policy = loadPlaybackPolicy();

  assert.equal(policy.shouldResumeFullStream({
    elementPlaying: false,
    appPlaying: true,
  }), true);
  assert.equal(policy.shouldResumeFullStream({
    elementPlaying: false,
    appPlaying: true,
    explicitlyPaused: true,
  }), false);
  assert.equal(policy.shouldResumeFullStream({
    elementPlaying: false,
    appPlaying: true,
    userPaused: true,
  }), false);
  assert.equal(policy.shouldResumeFullStream({
    elementPlaying: false,
    appPlaying: false,
  }), false);
});

test('explicit pause detection ignores editable spaces and recognizes transport pause controls', () => {
  const policy = loadPlaybackPolicy();
  const pauseButton = {
    className: 'cbtn',
    disabled: false,
    textContent: '',
    getAttribute() { return null; },
  };
  const buttonTarget = {
    tagName: 'BUTTON',
    closest() { return pauseButton; },
  };

  assert.equal(policy.isExplicitPauseEvent({
    type: 'keydown',
    code: 'Space',
    target: { tagName: 'INPUT' },
  }, { wasPlaying: true }), false);
  assert.equal(policy.isExplicitPauseEvent({
    type: 'keydown',
    code: 'Space',
    target: { tagName: 'BODY' },
  }, { wasPlaying: true }), true);
  assert.equal(policy.isExplicitPauseEvent({
    type: 'click',
    target: buttonTarget,
  }, { wasPlaying: true }), true);
  assert.equal(policy.isExplicitPauseEvent({
    type: 'click',
    target: buttonTarget,
  }, { wasPlaying: false }), false);
});

test('the enhancement layer uses the active audio element and resolves radio fallback JSON', () => {
  const enhance = fs.readFileSync(path.join(dist, 'enhance.js'), 'utf8');

  assert.match(enhance, /__wpGetActiveAudio/);
  assert.match(enhance, /__wpPlayTrack/);
  assert.match(enhance, /resolveMediaSource/);
  assert.match(enhance, /shouldContinueRadio/);
  assert.match(enhance, /requestSelectionSeq/);
  assert.match(enhance, /data\.preview && !stale/);
  assert.match(enhance, /__wpGetUserPauseSeq/);
  assert.match(enhance, /__wpShouldDeferEnded/);
  assert.match(enhance, /upgrade=1/);
  assert.match(enhance, /retryAfterMs/);
  assert.match(enhance, /explicitPauseByAudio/);
  assert.match(enhance, /explicitPauseByAudio\.delete\(a\)/);
  assert.match(enhance, /shouldResumeFullStream/);
  assert.match(enhance, /normalizeTrack/);
  assert.match(enhance, /playing !== true/);
  assert.doesNotMatch(enhance, /a\.src\s*=\s*fresh\.stream_url/);
});

test('the compiled app exposes active playback hooks and rejects stale selections', () => {
  const bundle = fs.readFileSync(path.join(dist, 'assets', 'index-2kADS7Vh-p4.js'), 'utf8');

  assert.match(bundle, /__wpGetActiveAudio/);
  assert.match(bundle, /__wpPlayTrack/);
  assert.match(bundle, /__wpGetPlaybackContext/);
  assert.match(bundle, /__wpSelectionSeq/);
  assert.match(bundle, /__wpGetUserPauseSeq/);
  assert.match(bundle, /__wpBumpUserPauseSeq/);
  assert.match(bundle, /__wpShouldDeferEnded/);
  assert.match(bundle, /playing:we/);
  assert.match(bundle, /wpUserPauseSeq\.current\+\+/);
  assert.match(bundle, /wpUserPauseSeq\.current\+\+,b\.pause\(\)/);
  assert.match(bundle, /wpUserPauseSeq\.current\+\+,a\.pause\(\)/);
  assert.match(bundle, /b>=10&&\(clearInterval\(P\),wpUserPauseSeq\.current\+\+/);
  assert.match(bundle, /wpSeq!==wpSelectionSeq\.current/);
  assert.match(bundle, /if\(wpSeq===wpSelectionSeq\.current\)Un/);
  assert.match(bundle, /if\(\(x\.currentSrc\|\|x\.src\)===V\)x\.pause\(\)/);
  assert.match(bundle, /wpSeq!==wpSelectionSeq\.current\|\|Oe===e\.current/);
  assert.doesNotMatch(bundle, /return nu\(x\.bitrate/);
});

test('the desktop probe follows the active audio element and the release includes playback policy', () => {
  const electronMain = fs.readFileSync(path.join(dist, '..', '..', 'electron', 'main.js'), 'utf8');
  const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const releaseScript = fs.readFileSync(path.join(dist, '..', '..', 'electron', 'release.ps1'), 'utf8');

  assert.match(electronMain, /__wpGetActiveAudio/);
  assert.match(electronMain, /output\.on\('error'/);
  assert.match(index, /playback-policy\.js/);
  assert.match(releaseScript, /playback-policy\.js/);
});

test('the desktop active-audio probe is centralized and generates valid JavaScript', () => {
  const electronMain = fs.readFileSync(path.join(dist, '..', '..', 'electron', 'main.js'), 'utf8');
  const activeStart = electronMain.indexOf('function activeAudioProbe()');
  const activeEnd = electronMain.indexOf('/* A real function', activeStart);
  const playerStart = electronMain.indexOf('function playerStateProbe()');
  const playerEnd = electronMain.indexOf('const ACTIVE_AUDIO_PROBE_SCRIPT', playerStart);

  assert.ok(activeStart >= 0 && activeEnd > activeStart);
  assert.ok(playerStart >= 0 && playerEnd > playerStart);
  assert.equal((electronMain.match(/document\.querySelector\(['"]audio['"]\)/g) || []).length, 1);

  const factory = new Function(
    electronMain.slice(activeStart, activeEnd)
    + electronMain.slice(playerStart, playerEnd)
    + '\nreturn { activeAudioProbe, playerStateProbe };',
  );
  const { activeAudioProbe, playerStateProbe } = factory();
  const script = `(() => {
    const activeAudioProbe = ${activeAudioProbe.toString()};
    return (${playerStateProbe.toString()})();
  })()`;
  const activeAudio = { paused: false, currentTime: 12.5, duration: 200 };
  const context = {
    window: { __wpGetActiveAudio: () => activeAudio },
    document: {
      querySelector: (selector) => selector === 'audio' ? null : { innerText: 'Song\nArtist' },
      querySelectorAll: () => [],
    },
    location: { origin: 'https://wickedplayer.dev' },
  };

  const state = vm.runInNewContext(script, context);
  assert.equal(state.playing, true);
  assert.equal(state.title, 'Song');
  assert.equal(state.artist, 'Artist');
  assert.equal(state.pos, 12.5);
  assert.equal(state.dur, 200);
});
