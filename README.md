# Wicked Player

Ad-free music player with effects, lyrics, overlays, community profiles and Discord Rich Presence.

## Download / Update

**Latest release (v3.5.11):** https://github.com/Tone730/wicked-player/releases/latest

Direct installer: https://github.com/Tone730/wicked-player/releases/latest/download/Wicked-Player-Setup-3.5.11.exe

Install once and the app auto-updates from GitHub (`latest.yml`). Existing installs from 3.5.0 onward pick up new releases automatically.

## Screenshots

### Search and player

![Wicked Player search and player](docs/screenshots/02-player.png)

### Now playing

![Wicked Player now playing](docs/screenshots/03-now-playing.png)

### Discord presence settings

![Wicked Player Discord presence settings](docs/screenshots/04-presence.png)

## What's in v3.5.11

- **Reliable cover art** — fixed the player state probe so Discord actually receives the current track's title, artist and album art instead of silently getting no state.
- **Faster startup** — hosted mode reads the saved home server directly and skips the bundled backend wait entirely.
- **Lower CPU usage** — state polling dropped from 500 ms to 1 s, with duplicate overlay and tray updates skipped.
- **Track-aware Discord presence** — your Discord activity shows the song title and artist that is actually playing, even when you have custom profile presence text.
- **Auto-configured Discord presence** — profile-driven details, state, buttons and paused status, with reconnect/retry.
- **CustomRP preset export** — generate a `.crp` file for your own profile or a friend's public profile.
- **Profile Studio** — banners, animated/glowing tags, motion backgrounds, card shapes and premium effects.
- **Hosted mode** — the desktop app connects straight to `https://wickedplayer.dev`. No local server, cookies, VPN or proxy setup is needed; playback fixes run server-side.
- Smaller installer, faster updates.

## Repository layout

- `electron/` — Electron desktop app, electron-builder config and release publisher.
- `wicked-frontend/dist/` — built web UI shipped in the installer (`enhance.js?ov=14`, asset bundle `index-2kADS7Vh-p3.js`).
- `wicked-backend/` — source for the hosted server deployed at `wickedplayer.dev`.
- `docs/screenshots/` — real screenshots used on this page.

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
