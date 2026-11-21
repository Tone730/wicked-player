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

/* Best-effort variant for telemetry: never breaks a request. */
function tryWriteJSON(file, value) {
  try { return atomicWriteJSON(file, value); }
  catch (e) { process.stderr.write(`[store] write failed for ${path.basename(file)}: ${e && e.message || e}\n`); return false; }
}

module.exports = { readJSON, atomicWriteJSON, tryWriteJSON };
