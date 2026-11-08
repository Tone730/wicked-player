import { io } from 'socket.io-client';

let sock = null;
export function getSocket() {
  if (!sock) sock = io('http://localhost:5000');
  return sock;
}

const KEY = 'wp-me';
export function getMe() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}
export function setMe(p) {
  if (p) localStorage.setItem(KEY, JSON.stringify(p));
  else localStorage.removeItem(KEY);
}
