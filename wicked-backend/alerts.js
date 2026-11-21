'use strict';
/* Self-contained alerting helper for Wicked Player.
   Records operational alerts to data/alerts.json, optionally emits them over
   socket.io to the admin panel, and optionally POSTs to a webhook.
   All outputs are best-effort: alerting must never break playback. */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DATA_DIR = path.join(__dirname, 'data');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const MAX_ALERTS = 200;
const COOLDOWN_MS = 5 * 60 * 1000; // dedupe identical alerts within 5 minutes

let io = null;
let memory = [];
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    memory = Array.isArray(raw) ? raw.slice(0, MAX_ALERTS) : [];
  } catch {
    memory = [];
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = ALERTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(memory, null, 2));
    fs.renameSync(tmp, ALERTS_FILE);
  } catch (e) {
    console.error('[alerts] persist failed:', e && e.message || e);
  }
}

function attachSocket(socketIo) { io = socketIo; }

function postWebhook(alert) {
  const url = process.env.ALERT_WEBHOOK_URL || '';
  if (!/^https?:\/\//i.test(url)) return;
  try {
    const lib = url.startsWith('https:') ? https : http;
    const body = JSON.stringify({
      username: 'Wicked Player Alerts',
      content: `**${String(alert.severity).toUpperCase()}** ${alert.message}` +
        (alert.meta ? `\n\`\`\`\n${JSON.stringify(alert.meta, null, 2)}\n\`\`\`` : ''),
    });
    const u = new URL(url);
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 4000,
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch (e) {
    console.error('[alerts] webhook failed:', e && e.message || e);
  }
}

/** Record an operational alert. Never throws. */
function record(type, severity, message, meta) {
  try {
    load();
    const now = Date.now();
    const key = `${type}|${message}`;
    const recent = memory.find((a) => a.key === key && now - a.ts < COOLDOWN_MS);
    if (recent) return recent;
    const alert = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      key,
      type: String(type || 'general'),
      severity: String(severity || 'info'),
      message: String(message || ''),
      meta: meta || null,
      ts: now,
      iso: new Date(now).toISOString(),
    };
    memory.unshift(alert);
    if (memory.length > MAX_ALERTS) memory.length = MAX_ALERTS;
    persist();
    try {
      if (io) {
        /* Admin-only room; falls back to a global emit if no admin has joined
           yet so the alert is still visible to an admin panel opened later. */
        const room = io.sockets.adapter.rooms.get('admins');
        if (room && room.size) io.to('admins').emit('admin:alert', alert);
        else io.emit('admin:alert', alert);
      }
    } catch {}
    postWebhook(alert);
    process.stderr.write(`[alert:${alert.severity}] ${alert.message}\n`);
    return alert;
  } catch (e) {
    console.error('[alerts] record failed:', e && e.message || e);
    return null;
  }
}

function list(limit) {
  load();
  const n = Math.max(0, Math.min(parseInt(limit, 10) || 50, MAX_ALERTS));
  return { count: memory.length, alerts: memory.slice(0, n) };
}

function clear() {
  memory = [];
  persist();
  return { ok: true };
}

module.exports = { record, list, clear, attachSocket, ALERTS_FILE };
