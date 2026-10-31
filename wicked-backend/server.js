const express = require('express');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(session({ secret: 'wicked-secret', resave: false, saveUninitialized: true }));

// ---- helpers -------------------------------------------------
const usersFile = "./wicked-backend/data/users.json";
const codesFile = "./wicked-backend/data/codes.json";

async function jsonRead(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return {}; }
}
async function jsonWrite(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

// ---- login --------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { email } = req.body;
  const users = await jsonRead(usersFile);
  if (!users[email]) return res.status(404).json({ msg: 'User not found' });
  if (users[email].revoked) return res.status(403).json({ msg: 'Access revoked' });
  req.session.user = email;
  res.json({ premium: users[email].premium ?? false, me: email });
});

// ---- admin ---------------------------------------------
const ADMIN_KEY = '72e9a3f1-5c08-4b6c-8e6b-7f2f60e0eda3';
const adminAuth = (req, res, next) => {
  if (req.get('X-ADMIN-KEY') !== ADMIN_KEY) return res.status(401).json({ msg: 'no' });
  next();
};

app.post('/api/admin/give-premium', adminAuth, async (req, res) => {
  const { email } = req.body;
  const users = await jsonRead(usersFile);
  users[email] = users[email] || { premium: false, revoked: false };
  users[email].premium = true;
  await jsonWrite(usersFile, users);
  res.json({ ok: true });
});

app.post('/api/admin/revoke-premium', adminAuth, async (req, res) => {
  const { email } = req.body;
  const users = await jsonRead(usersFile);
  if (users[email]) {
    users[email].premium = false;
    users[email].revoked = true;
  }
  await jsonWrite(usersFile, users);
  res.json({ ok: true });
});

app.post('/api/admin/generate-code', adminAuth, async (req, res) => {
  const len = req.body.len || 8;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = Array.from({ length: len }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length))
  ).join('');
  const codes = await jsonRead(codesFile);
  codes[code] = true;
  await jsonWrite(codesFile, codes);
  res.json({ code });
});

app.post('/api/redeem-code', async (req, res) => {
  const { code } = req.body;
  const codes = await jsonRead(codesFile);
  if (!codes[code]) return res.status(400).json({ msg: 'Invalid code' });
  const users = await jsonRead(usersFile);
  const email = req.session.user;
  if (!email) return res.status(400).json({ msg: 'Must be logged in' });
  users[email] = users[email] || { premium: false, revoked: false };
  users[email].premium = true;
  delete codes[code];
  await jsonWrite(usersFile, users);
  await jsonWrite(codesFile, codes);
  res.json({ ok: true });
});

// ---- socket.io ---------------------------------
io.on('connection', socket => {
  const user = socket.handshake.session.user || 'anonymous';
  socket.user = user;
  updateLastSeen(user);
  broadcastOnline();
  socket.on('disconnect', () => broadcastOnline());
});

async function updateLastSeen(email) {
  const users = await jsonRead(usersFile);
  users[email] = users[email] || { premium: false, revoked: false };
  users[email].lastSeen = Date.now();
  await jsonWrite(usersFile, users);
}

async function broadcastOnline() {
  const users = await jsonRead(usersFile);
  const online = Object.values(io.sockets.sockets)
    .map(s => s.handshake.session.user)
    .filter(Boolean);
  const payload = Object.keys(users).reduce((o, k) => {
    o[k] = {
      premium: users[k].premium,
      online: online.includes(k),
      lastSeen: users[k].lastSeen || 0
    };
    return o;
  }, {});
  io.emit('online', payload);
}

// ---- serve the Vite build ---------------------------------
app.use(express.static(path.join(__dirname, '..', 'wicked-frontend', 'dist')));
app.get('*', (req, res) => res.sendFile(
  path.join(__dirname, '..', 'wicked-frontend', 'dist', 'index.html')
));

server.listen(process.env.PORT || 5000, () => console.log('⚡️ Backend up'));