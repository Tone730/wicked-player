'use strict';
/* Lightweight persisted HTTP access log for the admin panel.
   Buffered in memory and flushed atomically on an interval so request
   handling never waits on disk. No raw IP storage by default: clients are
   identified by the hashed anonymous visitor id (or their session user). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tryWriteJSON, readJSON } = require('./store');

const FILE = path.join(__dirname, '..', 'data', 'access.json');
const MAX_ROWS = 2000;
let rows = [];
let loaded = false;
let dirty = false;

function load() {
  if (loaded) return;
  loaded = true;
  const saved = readJSON(FILE, []);
  rows = Array.isArray(saved) ? saved.slice(0, MAX_ROWS) : [];
}

function hashId(v) {
  return v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 16) : null;
}
function cookieVal(req, name) {
  const raw = (req && req.headers && req.headers.cookie) || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
    }
  }
  return null;
}

function add(row) {
  load();
  rows.unshift(row);
  if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
  dirty = true;
}

function middleware(req, res, next) {
  const started = Date.now();
  res.once('finish', () => {
    try {
      let u = req.wpUser || null;
      if (!u) { try { u = require('../auth').peekUser(req); } catch {} }
      add({
        ts: Date.now(),
        method: String(req.method || '').slice(0, 10),
        path: String(req.path || req.originalUrl || '').split('?')[0].slice(0, 160),
        status: res.statusCode,
        ms: Date.now() - started,
        vid: hashId(cookieVal(req, 'wpvid')),
        user: u ? u.username || u.user || null : null,
        ua: String(req.headers && req.headers['user-agent'] || '').slice(0, 120),
      });
    } catch {}
  });
  next();
}

function recordDenied(req, status, reason) {
  try {
    add({
      ts: Date.now(), method: String(req.method || '').slice(0, 10),
      path: String(req.path || req.originalUrl || '').split('?')[0].slice(0, 160),
      status: Number(status) || 403, ms: 0,
      vid: hashId(cookieVal(req, 'wpvid')),
      user: null, denied: String(reason || 'denied').slice(0, 60),
      ua: String(req.headers && req.headers['user-agent'] || '').slice(0, 120),
    });
  } catch {}
}

function flush() {
  if (!dirty) return;
  dirty = false;
  tryWriteJSON(FILE, rows);
}
const timer = setInterval(flush, 15000);
if (timer.unref) timer.unref();

function list(limit) {
  load();
  const n = Math.max(0, Math.min(parseInt(limit, 10) || 200, MAX_ROWS));
  return { count: rows.length, rows: rows.slice(0, n) };
}

module.exports = { middleware, recordDenied, list, flush, FILE };
