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
  const term = String(query || '').trim();

  const sources = [
    { name: 'deezer', params: { q: term, limit }, toCandidates: deezerCandidates },
    { name: 'itunes', params: { term, media: 'music', entity: 'song', limit }, toCandidates: itunesCandidates },
  ];

  const attempts = sources.map(async (source) => {
    const payload = await getJson(source.name, source.params, timeoutMs);
    const best = pickBestMatchingTrack(source.toCandidates(payload), term);
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
  });

  /* The first provider with a valid match wins. Waiting for the slower
     provider as well would add its latency to every cold start, so a failed
     or non-matching provider simply does not win the race. */
  return new Promise((resolve) => {
    let pending = attempts.length;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    for (const attempt of attempts) {
      Promise.resolve(attempt).then((value) => {
        if (value) {
          finish(value);
          return;
        }
        pending -= 1;
        if (pending === 0) finish(null);
      }, () => {
        pending -= 1;
        if (pending === 0) finish(null);
      });
    }
  });
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
