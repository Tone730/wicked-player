'use strict';

/* Shared catalog rules for search and genre browsing. Keeping these pure makes
   it possible to verify relevance and latency behavior without starting the
   production server. */

/* Keep this vocabulary in lockstep with the compiled genre grid. The
   spotifyQuery field is always curated here (never copied from user input),
   and literal queries are reserved for subgenres Spotify does not expose as a
   genre filter. */
const GENRES = [
  { name: 'Pop', aliases: ['pop', 'pop music'], spotifyQuery: 'genre:pop', itunesGenres: ['pop'] },
  { name: 'Rock', aliases: ['rock', 'rock music'], spotifyQuery: 'genre:rock', itunesGenres: ['rock'] },
  {
    name: 'Hip-Hop/Rap',
    aliases: ['hip-hop/rap', 'hip hop/rap', 'hip-hop rap', 'hip hop rap', 'hip hop', 'rap'],
    spotifyQuery: 'hip hop',
    itunesGenres: ['hip hop rap', 'rap'],
  },
  {
    name: 'R&B/Soul',
    aliases: ['r&b/soul', 'r and b/soul', 'r&b soul', 'r and b soul', 'r&b', 'r and b', 'rnb'],
    spotifyQuery: 'genre:r&b',
    itunesGenres: ['r and b soul', 'r and b', 'soul'],
  },
  { name: 'Electronic', aliases: ['electronic', 'electronic music', 'electronica'], spotifyQuery: 'genre:electronic', itunesGenres: ['electronic'] },
  { name: 'Dance', aliases: ['dance', 'dance music', 'dance pop'], spotifyQuery: 'genre:dance', itunesGenres: ['dance'] },
  { name: 'Techno', aliases: ['techno'], spotifyQuery: 'genre:techno', itunesGenres: ['techno'] },
  { name: 'House', aliases: ['house', 'house music'], spotifyQuery: 'genre:house', itunesGenres: ['house'] },
  { name: 'Lo-Fi', aliases: ['lo-fi', 'lofi', 'lo fi'], spotifyQuery: 'lo-fi', itunesGenres: ['lo fi', 'lofi'] },
  { name: 'Jazz', aliases: ['jazz', 'jazz music'], spotifyQuery: 'genre:jazz', itunesGenres: ['jazz'] },
  { name: 'Classical', aliases: ['classical', 'classical music'], spotifyQuery: 'classical music', itunesGenres: ['classical'] },
  { name: 'Country', aliases: ['country', 'country music'], spotifyQuery: 'genre:country', itunesGenres: ['country'] },
  { name: 'Metal', aliases: ['metal', 'heavy metal'], spotifyQuery: 'genre:metal', itunesGenres: ['metal'] },
  { name: 'Punk', aliases: ['punk', 'punk rock'], spotifyQuery: 'genre:punk', itunesGenres: ['punk'] },
  { name: 'Alternative', aliases: ['alternative', 'alternative music', 'alt'], spotifyQuery: 'alternative music', itunesGenres: ['alternative'] },
  { name: 'Indie', aliases: ['indie', 'indie music'], spotifyQuery: 'genre:indie', itunesGenres: ['indie'] },
  { name: 'Blues', aliases: ['blues', 'blues music'], spotifyQuery: 'blues music', itunesGenres: ['blues'] },
  { name: 'Reggae', aliases: ['reggae', 'reggae music'], spotifyQuery: 'genre:reggae', itunesGenres: ['reggae'] },
  { name: 'Ska', aliases: ['ska'], spotifyQuery: 'genre:ska', itunesGenres: ['ska'] },
  { name: 'Funk', aliases: ['funk', 'funk music'], spotifyQuery: 'genre:funk', itunesGenres: ['funk'] },
  { name: 'Soul', aliases: ['soul', 'soul music'], spotifyQuery: 'genre:soul', itunesGenres: ['soul'] },
  { name: 'Disco', aliases: ['disco', 'disco music'], spotifyQuery: 'disco music', itunesGenres: ['disco'] },
  { name: 'Trap', aliases: ['trap', 'trap music'], spotifyQuery: 'genre:trap', itunesGenres: ['trap'] },
  {
    name: 'Drum & Bass',
    aliases: ['drum & bass', 'drum and bass', 'drum n bass', 'dnb'],
    spotifyQuery: 'genre:drum & bass',
    itunesGenres: ['drum and bass', 'drum bass', 'dnb'],
  },
  { name: 'Dubstep', aliases: ['dubstep', 'dubstep music'], spotifyQuery: 'dubstep', itunesGenres: ['dubstep'] },
  { name: 'Afrobeats', aliases: ['afrobeats', 'afro beats', 'afro-beats'], spotifyQuery: 'afrobeats', itunesGenres: ['afrobeats', 'afro beat'] },
  { name: 'Reggaeton', aliases: ['reggaeton'], spotifyQuery: 'reggaeton', itunesGenres: ['reggaeton'] },
  { name: 'Salsa', aliases: ['salsa', 'salsa music'], spotifyQuery: 'genre:salsa', itunesGenres: ['salsa'] },
  { name: 'K-Pop', aliases: ['k-pop', 'kpop', 'k pop'], spotifyQuery: 'k-pop', itunesGenres: ['k pop'] },
  { name: 'J-Pop', aliases: ['j-pop', 'jpop', 'j pop'], spotifyQuery: 'j-pop', itunesGenres: ['j pop'] },
  { name: 'Latin', aliases: ['latin', 'latin music'], spotifyQuery: 'genre:latin', itunesGenres: ['latin'] },
  { name: 'Bachata', aliases: ['bachata', 'bachata music'], spotifyQuery: 'bachata', itunesGenres: ['bachata'] },
  { name: 'Gospel', aliases: ['gospel', 'gospel music'], spotifyQuery: 'gospel music', itunesGenres: ['gospel'] },
  { name: 'Soundtrack', aliases: ['soundtrack', 'soundtracks', 'sound track'], spotifyQuery: 'soundtrack music', itunesGenres: ['soundtrack', 'soundtracks', 'musical'] },
  { name: 'Ambient', aliases: ['ambient', 'ambient music'], spotifyQuery: 'ambient music', itunesGenres: ['ambient'] },
  {
    name: 'Classical Crossover',
    aliases: ['classical crossover', 'classical crossover music'],
    spotifyQuery: 'classical crossover',
    itunesGenres: ['classical crossover', 'classical'],
  },
  { name: 'Folk', aliases: ['folk', 'folk music'], spotifyQuery: 'genre:folk', itunesGenres: ['folk', 'folk rock'] },
  { name: 'Acoustic', aliases: ['acoustic', 'acoustic music'], spotifyQuery: 'acoustic music', itunesGenres: ['acoustic'] },
  { name: 'Chillhop', aliases: ['chillhop', 'chill hop'], spotifyQuery: 'genre:chillhop', itunesGenres: ['chillhop', 'chill hop'] },
  { name: 'Synthwave', aliases: ['synthwave', 'synth wave'], spotifyQuery: 'genre:synthwave', itunesGenres: ['synthwave', 'synth wave'] },
];

function normalized(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function genreDefinition(value) {
  const wanted = normalized(value);
  if (!wanted) return null;
  return GENRES.find((genre) => genre.aliases.some((alias) => normalized(alias) === wanted)) || null;
}

function canonicalGenreName(value) {
  return genreDefinition(value)?.name || null;
}

function genreMatches(trackGenre, requestedGenre) {
  const definition = genreDefinition(requestedGenre);
  if (!definition || !trackGenre) return false;
  const actual = normalized(trackGenre);
  return definition.itunesGenres.some((genre) => normalized(genre) === actual);
}

function trackKey(track) {
  return [track?.name || '', track?.artist || '']
    .map((value) => normalized(value).replace(/\s+/g, ' '))
    .join('|');
}

function relevanceScore(track, query) {
  const wanted = normalized(query);
  if (!wanted) return 0;
  const strict = trackMatchScore(track, wanted);
  if (strict >= 0) return strict;
  const title = normalized(track?.name);
  const artist = normalized(track?.artist);
  let score = 0;
  if (title.startsWith(wanted)) score += 80;
  else if (title.includes(wanted)) score += 30;
  if (artist.includes(wanted)) score += 8;
  return score;
}

function candidateName(candidate) {
  return candidate?.name
    || candidate?.title
    || candidate?.title_short
    || candidate?.trackName
    || '';
}

function candidateArtist(candidate) {
  if (typeof candidate?.artist === 'string') return candidate.artist;
  return candidate?.artist?.name
    || candidate?.artistName
    || candidate?.uploader
    || candidate?.uploaderName
    || candidate?.channel
    || '';
}

function tokenSet(value) {
  return new Set(normalized(value).split(' ').filter(Boolean));
}

function intersectionSize(left, right) {
  let count = 0;
  for (const token of left) if (right.has(token)) count++;
  return count;
}

/* Strictly score a candidate against a title+artist query. Search providers
   often return the right song title under a different artist, so a title-only
   fuzzy match is not enough when the requested artist is known. */
function trackMatchScore(candidate, query) {
  const wanted = normalized(query);
  if (!wanted) return -1;

  const title = normalized(candidateName(candidate));
  const artist = normalized(candidateArtist(candidate));
  const combined = [title, artist].filter(Boolean).join(' ');
  if (!title && !artist) return -1;
  if (wanted === combined) return 350;
  if (wanted === title) return 300;
  if (wanted === artist) return 250;

  const wantedTokens = tokenSet(wanted);
  const titleTokens = tokenSet(title);
  const artistTokens = tokenSet(artist);
  const combinedTokens = tokenSet(combined);
  const titleOverlap = intersectionSize(titleTokens, wantedTokens);
  const artistOverlap = intersectionSize(artistTokens, wantedTokens);
  const wantedCoverage = intersectionSize(combinedTokens, wantedTokens) / wantedTokens.size;

  const titleIsExactPart = titleTokens.size > 0
    && titleOverlap === titleTokens.size
    && titleTokens.size < wantedTokens.size;
  const artistIsExactPart = artistTokens.size > 0
    && artistOverlap === artistTokens.size
    && artistTokens.size < wantedTokens.size;

  if (artistIsExactPart && titleOverlap > 0) return 200;
  if (titleIsExactPart && artistOverlap > 0) return 180;
  if (wantedCoverage >= 0.8 && (titleOverlap > 0 || artistOverlap > 0)) return 140;
  return -1;
}

function pickBestMatchingTrack(candidates, query, minimumScore = 140) {
  let best = null;
  let bestScore = -1;
  for (const candidate of candidates || []) {
    const score = trackMatchScore(candidate, query);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= minimumScore ? best : null;
}

function mergeTracks(groups, query = '', limit = 100) {
  const seen = new Set();
  const candidates = [];
  let order = 0;
  for (const group of groups || []) {
    if (!Array.isArray(group)) continue;
    for (const track of group) {
      if (!track?.name || !track?.stream_url) continue;
      const key = trackKey(track);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push({ track, order: order++ });
    }
  }
  candidates.sort((a, b) => {
    const score = relevanceScore(b.track, query) - relevanceScore(a.track, query);
    return score || a.order - b.order;
  });
  return candidates.slice(0, limit).map((entry) => entry.track);
}

async function collectWithin(promises, timeoutMs) {
  const values = new Array(promises.length).fill(null);
  const settled = Promise.all(promises.map((promise, index) => Promise.resolve(promise)
    .then((value) => { values[index] = value; })
    .catch(() => { values[index] = null; })));

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, Math.max(0, Number(timeoutMs) || 0));
  });
  await Promise.race([settled, deadline]);
  if (timer) clearTimeout(timer);
  return values.map((value) => (value == null ? [] : value));
}

function isFullStream(data) {
  return Boolean(data && data.audio_url && !data.preview);
}

function safePreviewUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function makeStreamUrl(query, previewUrl) {
  const base = `/stream?q=${encodeURIComponent(String(query || '').trim())}`;
  const preview = safePreviewUrl(previewUrl);
  return preview ? `${base}&preview=${encodeURIComponent(preview)}` : base;
}

module.exports = {
  GENRES,
  canonicalGenreName,
  collectWithin,
  genreDefinition,
  genreMatches,
  isFullStream,
  makeStreamUrl,
  mergeTracks,
  normalized,
  pickBestMatchingTrack,
  safePreviewUrl,
  trackMatchScore,
};
