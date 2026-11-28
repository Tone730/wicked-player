'use strict';
/* Atomic JSON persistence for Wicked Player state files.
   Truncate-in-place writes can leave a half-written file after a crash or a
   disk error, which the readers silently turn into an empty store ("all my
   playlists vanished"). Every state file goes through temp-file + rename so a
   reader always sees either the old complete document or the new one. */
const fs = require('fs');
const path = require('path');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function atomicWriteJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/* Strict reader for authoritative state (community, rewards, codes).
   A missing file may start empty, but a corrupt or unreadable file must never
   be silently replaced with an empty fallback - that would let a redemption
   overwrite real premium history. */
function readJSONStrict(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path.basename(file)}`);
  }
}

/* Best-effort variant for telemetry: never breaks a request. */
function tryWriteJSON(file, value) {
  try { return atomicWriteJSON(file, value); }
  catch (e) { process.stderr.write(`[store] write failed for ${path.basename(file)}: ${e && e.message || e}\n`); return false; }
}

module.exports = { readJSON, readJSONStrict, atomicWriteJSON, tryWriteJSON };
