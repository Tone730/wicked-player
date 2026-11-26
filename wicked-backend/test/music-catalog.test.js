'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  canonicalGenreName,
  collectWithin,
  genreDefinition,
  genreMatches,
  isFullStream,
  makeStreamUrl,
  mergeTracks,
  pickBestMatchingTrack,
  trackMatchScore,
} = require('../lib/music-catalog');

test('genre matching accepts the requested genre and rejects unrelated genres', () => {
  assert.equal(canonicalGenreName('hip hop'), 'Hip-Hop/Rap');
  assert.equal(genreMatches('Pop', 'Pop'), true);
  assert.equal(genreMatches('Hip-Hop/Rap', 'Hip-Hop/Rap'), true);
  assert.equal(genreMatches('Alternative', 'Rock'), false);
  assert.equal(genreMatches('Hip-Hop/Rap', 'Pop'), false);
  assert.equal(genreMatches(null, 'Pop'), false);
});

test('every compiled genre card has a dedicated backend definition', () => {
  const bundle = fs.readFileSync(path.join(
    __dirname, '..', '..', 'wicked-frontend', 'dist', 'assets', 'index-2kADS7Vh-p4.js',
  ), 'utf8');
  const match = bundle.match(/const Hp=(\[\[.*?\]\]);/s);
  assert.ok(match, 'compiled genre grid not found');

  const labels = JSON.parse(match[1]).map((entry) => entry[0]);
  assert.equal(labels.length, 40);
  for (const label of labels) {
    assert.equal(canonicalGenreName(label), label, `${label} must have its own canonical genre`);
    const definition = genreDefinition(label);
    assert.ok(definition.spotifyQuery, `${label} needs a curated Spotify query`);
    assert.ok(definition.itunesGenres.length, `${label} needs explicit iTunes genre evidence`);
  }
});

test('merged search results are deduplicated and exact title matches rank first', () => {
  const merged = mergeTracks([
    [
      { id: 'sp-1', name: 'Popular Song', artist: 'Artist A', stream_url: '/stream?q=Popular%20Song' },
      { id: 'it-1', name: 'Target', artist: 'Artist B', stream_url: '/stream?q=Target' },
    ],
    [
      { id: 'dz-1', name: 'target', artist: 'Artist B', stream_url: '/stream?q=target' },
      { id: 'sp-2', name: 'Targeted', artist: 'Artist C', stream_url: '/stream?q=Targeted' },
    ],
  ], 'target');

  assert.deepEqual(merged.map((track) => track.id), ['it-1', 'sp-2', 'sp-1']);
});

test('merged search results rank the exact title and artist before a remix', () => {
  const merged = mergeTracks([[
    { id: 'sp-remix', name: 'Billie Eilish - Bad Guy (Samy Jebari Remix)', artist: 'Samy Jebari', stream_url: '/stream?q=remix' },
    { id: 'sp-original', name: 'bad guy', artist: 'Billie Eilish', stream_url: '/stream?q=original' },
  ]], 'Billie Eilish bad guy');

  assert.deepEqual(merged.map((track) => track.id), ['sp-original', 'sp-remix']);
});

test('provider collection keeps results that arrive before the response deadline', async () => {
  const results = await collectWithin([
    Promise.resolve(['fast']),
    new Promise((resolve) => setTimeout(() => resolve(['slow']), 80)),
  ], 20);

  assert.deepEqual(results[0], ['fast']);
  assert.deepEqual(results[1], []);
});

test('fallback matching rejects a different artist with the same song title', () => {
  const query = 'Bad Guy Billie Eilish';
  const wrong = { name: 'Bad Guy', artist: 'Charlie Puth' };
  const exact = { name: 'Bad Guy', artist: 'Billie Eilish' };

  assert.equal(trackMatchScore(wrong, query), -1);
  assert.ok(trackMatchScore(exact, query) >= 140);
  assert.equal(pickBestMatchingTrack([wrong, exact], query), exact);
  assert.equal(pickBestMatchingTrack([wrong], query), null);
});

test('fallback matching accepts a YouTube title that contains the requested track', () => {
  const query = 'Billie Eilish bad guy';
  const candidate = {
    name: 'Billie Eilish - bad guy (Audio)',
    artist: 'Music Topic BR',
  };

  assert.ok(trackMatchScore(candidate, query) >= 140);
});

test('only full-resolution streams are eligible for the full stream cache', () => {
  assert.equal(isFullStream({ audio_url: 'https://example.test/full.mp3' }), true);
  assert.equal(isFullStream({ audio_url: 'https://example.test/preview.mp3', preview: true }), false);
  assert.equal(isFullStream({ preview: true }), false);
  assert.equal(isFullStream(null), false);
});

test('stream URLs carry an exact provider preview when one is available', () => {
  const url = makeStreamUrl('Bad Guy Billie Eilish', 'https://example.test/preview.m4a?x=1');

  assert.equal(url.startsWith('/stream?q=Bad%20Guy%20Billie%20Eilish&preview='), true);
  assert.equal(url.includes(encodeURIComponent('https://example.test/preview.m4a?x=1')), true);
  assert.equal(makeStreamUrl('Bad Guy Billie Eilish', 'javascript:alert(1)'), '/stream?q=Bad%20Guy%20Billie%20Eilish');
});
