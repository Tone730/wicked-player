# Wicked Player

Ad-free music player with effects, lyrics, overlays, community profiles and Discord Rich Presence.

## Download / Update

**Latest release (v3.5.14):** https://github.com/Tone730/wicked-player/releases/latest

Direct installer: https://github.com/Tone730/wicked-player/releases/latest/download/Wicked-Player-Setup-3.5.14.exe

Install once and the app auto-updates from GitHub (`latest.yml`). Existing installs from 3.5.0 onward pick up new releases automatically.

## Screenshots

### Search and player

![Wicked Player search and player](docs/screenshots/02-player.png)

### Now playing

![Wicked Player now playing](docs/screenshots/03-now-playing.png)

### Discord presence settings

![Wicked Player Discord presence settings](docs/screenshots/04-presence.png)

## What's in v3.5.14

- **Automatic Premium redemption** — member-to-member Premium gifts and Premium/jackpot listening rewards are redeemed immediately for the recipient.
- **Visible redemption receipts** — senders, recipients, and admins can see who redeemed which gift or reward and when; the admin log also updates live.
- **Faster cold-start playback** — a strict provider preview is resolved alongside yt-dlp, so playback can begin in a fraction of a second while the complete stream continues resolving in the background.
- **Reliable Premium persistence** — the grant, receipt, and code-consumption state are committed atomically, so the app never reports success for a redemption that was not saved.
- **Safe preview caching** — provider previews never enter the full-stream cache and are upgraded to the complete track when resolution finishes.
- **Reliable full-track playback** — the newest selection preempts stale resolver work, preview endings no longer skip the queue, and full streams resume at the correct position.
- **Accurate genre cards and track matching** — all 40 genre cards use a dedicated, genre-constrained catalog route, and fuzzy matches from a different artist are rejected.
- **Cleaner error reporting** — playback failures and rate limits are reported accurately without misleading “Saved” or “Save failed (502)” popups.
- **Hosted mode** — the desktop app connects straight to `https://wickedplayer.dev`. No local server, cookies, VPN, or proxy setup is needed; playback fixes run server-side.

## Repository layout

- `electron/` — Electron desktop app, electron-builder config and release publisher.
- `wicked-frontend/dist/` — authoritative compiled web UI and playback-policy assets shipped in the installer (including asset bundle `index-2kADS7Vh-p4.js`).
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
