# Wicked Player

Ad-free music player with effects, lyrics, overlays, community profiles and Discord Rich Presence.

## Download / Update

**Latest release (v3.5.8):** https://github.com/Tone730/wicked-player/releases/latest

Direct installer: https://github.com/Tone730/wicked-player/releases/latest/download/Wicked-Player-Setup-3.5.8.exe

Install once and the app auto-updates from GitHub (`latest.yml`). Existing installs from 3.5.0 onward pick up new releases automatically.

## What's in v3.5.8

- **Auto-configured Discord presence** — profile-driven details, state, album art, buttons and paused status, with reconnect/retry.
- **CustomRP preset export** — generate a `.crp` file for your own profile or a friend's public profile.
- **Profile Studio** — banners, animated/glowing tags, motion backgrounds, card shapes and premium effects.
- **Hosted mode** — the desktop app connects straight to `https://wickedplayer.dev`. No local server, cookies, VPN or proxy setup is needed; playback fixes run server-side.
- Smaller installer, faster updates.

## Repository layout

- `electron/` — Electron desktop app, electron-builder config and release publisher.
- `wicked-frontend/dist/` — built web UI shipped in the installer (`enhance.js?ov=14`, asset bundle `index-2kADS7Vh-p3.js`).
- `wicked-backend/` — source for the hosted server deployed at `wickedplayer.dev`.

## Building the desktop app

```powershell
cd electron
npm install
npx electron-builder -w
```

The installer is written to `electron/dist/`. `release.ps1 -Bump` builds, publishes a GitHub release and uploads the installer, blockmap and `latest.yml`.

Security note: the installer deliberately bundles **no** backend code and **no** `.env`. Only `discord-app.json` (public client ID + invite) is included. Do not add credentials to `electron/` or to `electron-builder.yml`.

## Running the hosted backend

The backend in `wicked-backend/` is deployed on the server. It requires a private `.env` (never committed) with `PORT`, `ADMIN_USER`, `ADMIN_PASS`, `ADMIN_KEY`, `ALLOW_REGISTRATION` and the Discord/Spotify OAuth settings. Start it with `node server.js`.

## Support

Report issues at https://github.com/Tone730/wicked-player/issues.
