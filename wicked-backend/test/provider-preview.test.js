'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveFastestWithPreview, resolveProviderPreview } = require('../lib/provider-preview');

test('provider preview resolution returns the strict title-and-artist match', async () => {
  const calls = [];
  const preview = await resolveProviderPreview('Lorde Green Light', {
    getJson: async (provider, params) => {
      calls.push({ provider, params });
      if (provider === 'deezer') {
        return {
          data: [{
            title_short: 'Green Light',
            artist: { name: 'Lorde' },
            preview: 'https://cdn.example.test/deezer.mp3',
          }],
        };
      }
      return {
        data: {
          results: [{
            trackName: 'Green Light',
            artistName: 'Lorde',
            previewUrl: 'https://cdn.example.test/itunes.m4a',
          }],
        },
      };
    },
  });

  assert.equal(preview.title, 'Green Light');
  assert.equal(preview.audio_url, 'https://cdn.example.test/deezer.mp3');
  assert.equal(preview.source, 'deezer-preview');
  assert.equal(preview.preview, true);
  assert.deepEqual(calls.map((call) => call.provider).sort(), ['deezer', 'itunes']);
  assert.equal(calls.find((call) => call.provider === 'deezer').params.limit, 5);
  assert.equal(calls.find((call) => call.provider === 'itunes').params.limit, 5);
});

test('provider preview resolution rejects a title-only match with the wrong artist', async () => {
  const preview = await resolveProviderPreview('Lorde Green Light', {
    getJson: async (provider) => provider === 'deezer'
      ? { data: [{ title_short: 'Green Light', artist: { name: 'Wrong Artist' }, preview: 'https://cdn.example.test/wrong.mp3' }] }
      : { data: { results: [] } },
  });

  assert.equal(preview, null);
});

test('provider preview resolution survives one provider failing', async () => {
  const preview = await resolveProviderPreview('Lorde Green Light', {
    getJson: async (provider) => {
      if (provider === 'deezer') throw new Error('provider unavailable');
      return {
        data: {
          results: [{
            trackName: 'Green Light',
            artistName: 'Lorde',
            previewUrl: 'https://cdn.example.test/itunes.m4a',
          }],
        },
      };
    },
  });

  assert.equal(preview.audio_url, 'https://cdn.example.test/itunes.m4a');
  assert.equal(preview.source, 'itunes-preview');
});

test('provider preview resolution rejects non-HTTPS preview URLs', async () => {
  const preview = await resolveProviderPreview('Lorde Green Light', {
    getJson: async (provider) => provider === 'deezer'
      ? { data: [{ title_short: 'Green Light', artist: { name: 'Lorde' }, preview: 'http://cdn.example.test/insecure.mp3' }] }
      : { data: { results: [] } },
  });

  assert.equal(preview, null);
});

test('provider preview resolution does not wait for the slower provider', async () => {
  let itunesSettled = false;
  const started = Date.now();
  const preview = await resolveProviderPreview('Lorde Green Light', {
    getJson: async (provider) => {
      if (provider === 'itunes') {
        /* The slow provider must not delay an already usable preview. */
        await new Promise((resolve) => setTimeout(resolve, 300));
        itunesSettled = true;
        return { data: { results: [] } };
      }
      return {
        data: [{
          title_short: 'Green Light',
          artist: { name: 'Lorde' },
          preview: 'https://cdn.example.test/deezer.mp3',
        }],
      };
    },
  });

  assert.equal(preview.audio_url, 'https://cdn.example.test/deezer.mp3');
  assert.ok(Date.now() - started < 250, 'the preview waited for the slow provider');
  assert.equal(itunesSettled, false);
});

test('fast preview playback wins without cancelling full resolution', async () => {
  let fullFinished = false;
  const full = new Promise((resolve) => {
    setTimeout(() => {
      fullFinished = true;
      resolve({ audio_url: 'https://cdn.example.test/full.mp3', preview: false });
    }, 20);
  });
  const result = await resolveFastestWithPreview(
    full,
    Promise.resolve({ audio_url: 'https://cdn.example.test/preview.mp3', preview: true }),
  );

  assert.equal(result.source, 'preview');
  assert.equal(result.data.preview, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fullFinished, true);
});

test('fast preview playback waits for full resolution when no preview exists', async () => {
  const result = await resolveFastestWithPreview(
    Promise.resolve({ audio_url: 'https://cdn.example.test/full.mp3', preview: false }),
    Promise.resolve(null),
  );

  assert.equal(result.source, 'full');
  assert.equal(result.data.preview, false);
});
