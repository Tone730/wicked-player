'use strict';

const { pickBestMatchingTrack, safePreviewUrl } = require('./music-catalog');

function deezerCandidates(payload) {
  const rows = Array.isArray(payload && payload.data) ? payload.data : [];
  return rows.map((track) => ({
    name: track.title_short || track.title || '',
    artist: track.artist?.name || '',
    previewUrl: track.preview || '',
    duration: 30,
    source: 'deezer-preview',
  }));
}

function itunesCandidates(payload) {
  const rows = Array.isArray(payload && payload.data && payload.data.results)
    ? payload.data.results
    : [];
  return rows.map((track) => ({
    name: track.trackName || '',
    artist: track.artistName || '',
    previewUrl: track.previewUrl || '',
    duration: 30,
    source: 'itunes-preview',
  }));
}

/* Resolve a short provider preview without involving yt-dlp. The resolver is
   deliberately strict: a matching title with the wrong artist is not a valid
   substitute for the requested track. */
async function resolveProviderPreview(query, options = {}) {
  const getJson = options.getJson;
  if (typeof getJson !== 'function') throw new TypeError('getJson must be a function');
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 5));
  const timeoutMs = Math.max(250, Math.min(6000, Number(options.timeoutMs) || 2500));

  const [deezer, itunes] = await Promise.allSettled([
    getJson('deezer', { q: String(query || '').trim(), limit }, timeoutMs),
    getJson('itunes', { term: String(query || '').trim(), media: 'music', entity: 'song', limit }, timeoutMs),
  ]);

  const candidates = [];
  if (deezer.status === 'fulfilled') candidates.push(...deezerCandidates(deezer.value));
  if (itunes.status === 'fulfilled') candidates.push(...itunesCandidates(itunes.value));

  const best = pickBestMatchingTrack(candidates, query);
  if (!best) return null;
  const audioUrl = safePreviewUrl(best.previewUrl);
  if (!audioUrl) return null;

  return {
    title: best.name || '',
    duration: Number(best.duration) || 30,
    audio_url: audioUrl,
    source: best.source || 'provider-preview',
    preview: true,
  };
}

/* Return the first usable response without cancelling the other work. A
   missing preview deliberately leaves the preview branch pending so the full
   stream remains the only possible winner. */
function resolveFastestWithPreview(fullPromise, previewPromise) {
  const full = Promise.resolve(fullPromise).then((data) => ({ source: 'full', data }));
  const preview = Promise.resolve(previewPromise).then((data) => (
    data ? { source: 'preview', data } : new Promise(() => {})
  ));
  return Promise.race([full, preview]);
}

module.exports = { resolveFastestWithPreview, resolveProviderPreview };
