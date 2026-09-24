# Timer

A cross-platform desktop timer that stays visible and can be driven by other programs.

Two things make it different from a normal timer app: a frameless, always-on-top overlay that
floats over whatever you are working in, and an embedded REST API so scripts, hotkey tools, or CI
jobs can start, pause, and reset it — and get notified the moment it finishes.

| | |
|---|---|
| **Overlay** | Floating (compact) and Mini (expanded) modes, draggable, always-on-top |
| **API** | `http://127.0.0.1:3000` REST + Socket.IO, token-authenticated |
| **Alerts** | Bundled chime + native Windows/macOS notification |
| **Integrations** | Google Tasks — complete a to-do when the timer ends |
| **Packaging** | `.exe` (NSIS) and `.dmg` via electron-builder |

---

## Quick start

```bash
npm install
npm run assets     # generates the chime and app icon (already committed)
npm run dev        # live-reloading overlay + settings
```

The overlay appears with a tray icon beside it. The gear opens Settings; the **×** hides the
overlay (the app keeps running — quit from the tray).

### Build installers

```bash
npm run dist:win   # -> dist/Timer Setup <version>.exe
npm run dist:mac   # -> dist/Timer-<version>.dmg   (must run on macOS)
```

`electron-builder` cannot build a macOS disk image from Windows. The included GitHub Actions
workflow (`.github/workflows/release.yml`) builds each target on its own runner; push a `v*` tag
and both installers are attached to the release.

Builds are **unsigned**, so Windows SmartScreen and macOS Gatekeeper will warn on first run. Add a
certificate and the matching `electron-builder` env vars when you are ready to ship publicly.

---

## The local API

The server binds to `127.0.0.1` only and requires a token on every `/api` route.

**Finding the port and token.** The app writes both to a discovery file on every launch, so
scripts never need anything pasted in by hand:

- Windows — `%APPDATA%\timer-desktop\api.json`
- macOS — `~/Library/Application Support/timer-desktop/api.json`

```json
{ "port": 3000, "token": "…", "baseUrl": "http://127.0.0.1:3000", "pid": 27944 }
```

If port 3000 is busy the app steps up to 3001, 3002, … and records where it landed. Settings shows
the live port, and you can set a different preferred port there.

### Endpoints

Authenticate with `X-API-Key: <token>` or `Authorization: Bearer <token>`.

| Method | Route | Body | Notes |
|---|---|---|---|
| `GET` | `/api/health` | — | **No auth.** Confirms which port the app is on. |
| `GET` | `/api/timer/status` | — | Current snapshot |
| `POST` | `/api/timer/start` | `{ durationMs?, label?, mode? }` | Omit `durationMs` to use the saved default. `mode` (see below) switches before starting |
| `POST` | `/api/timer/pause` | — | |
| `POST` | `/api/timer/resume` | — | |
| `POST` | `/api/timer/toggle` | — | Start / pause / resume as appropriate — the "one click" verb |
| `POST` | `/api/timer/reset` | — | |
| `POST` | `/api/timer/stop` | — | |
| `POST` | `/api/timer/mode` | `{ mode }` | Switches without starting a run |

Every response is a timer snapshot:

```json
{
  "mode": "timer",              // timer | stopwatch
  "state": "running",           // idle | running | paused | expired
  "durationMs": 1500000,
  "remainingMs": 1468553,
  "elapsedMs": 31447,
  "label": "Focus block",
  "expiresAt": 1789470157849,   // epoch ms, null unless a timer is running
  "isActive": true
}
```

### Timer vs. stopwatch

`mode` picks the direction: **timer** counts down from `durationMs` and fires `timer:expired` at
zero; **stopwatch** counts up from zero with no ceiling and never expires. Both share every other
verb — the same `toggle`, `pause`, `resume`, and `reset` drive either one, so a single button (or a
single `POST /api/timer/toggle`) is genuinely all it takes to start a stopwatch counting up.

In stopwatch mode `remainingMs` mirrors `elapsedMs`, so anything reading `remainingMs` to display
"the current value" keeps working without a special case; `durationMs` is left at whatever the
timer was last configured to, simply unused. **Switching `mode` always resets** — there's no
sensible way to carry a countdown's remaining time into a count-up, so rather than guess at a
translation it just drops whatever was in progress. The Settings UI and overlay both grey out
mode-switching while something is running or paused, for exactly that reason; the API itself
doesn't enforce it, since a script asking to switch presumably means it.

```bash
# start a stopwatch in one call
curl -X POST http://127.0.0.1:3000/api/timer/start \
  -H "X-API-Key: $TOKEN" -H "Content-Type: application/json" \
  -d '{"mode": "stopwatch", "label": "Cooking"}'
```

### Examples

```bash
# bash
TOKEN=$(node -p "require(process.env.APPDATA+'/timer-desktop/api.json').token")
curl -X POST http://127.0.0.1:3000/api/timer/start \
  -H "X-API-Key: $TOKEN" -H "Content-Type: application/json" \
  -d '{"durationMs": 1500000, "label": "Focus"}'
```

```powershell
# PowerShell
$api = Get-Content "$env:APPDATA\timer-desktop\api.json" | ConvertFrom-Json
$h = @{ 'X-API-Key' = $api.token; 'Content-Type' = 'application/json' }
Invoke-RestMethod "$($api.baseUrl)/api/timer/start" -Method Post -Headers $h `
  -Body '{"durationMs":1500000,"label":"Focus"}'
```

### Live events (Socket.IO)

```js
import { io } from 'socket.io-client'
import { readFileSync } from 'node:fs'

const api = JSON.parse(readFileSync(`${process.env.APPDATA}/timer-desktop/api.json`, 'utf8'))
const socket = io(api.baseUrl, { auth: { token: api.token } })

socket.on('timer:state', (s) => console.log('state ->', s.state))
socket.on('timer:tick', (s) => console.log(Math.ceil(s.remainingMs / 1000)))  // once per second
socket.on('timer:expired', (s) => console.log('done:', s.label))
```

### A note on security

The server sends **no CORS headers at all**, and every `/api` route requires a custom header. A web
page you visit therefore cannot drive your timer: its preflight request fails. Combined with the
`127.0.0.1` bind, only local processes that can read your user directory can reach the API.

Regenerating the token in Settings takes effect on the next launch — the running server keeps the
token it started with.

---

## Google Tasks integration

Optional. The app is fully functional without it; the Settings panel simply shows a "not
configured" notice.

### 1. Create the OAuth client

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
2. **APIs & Services → Library** → enable the **Google Tasks API** and the **Google Calendar API**
   (the latter is used read-only, to pick up the real time of day when a linked task has been
   time-blocked from Calendar — see step 3 below).
3. **APIs & Services → OAuth consent screen** → configure it. While the app is in *Testing*, add
   your own Google account under **Test users**, or sign-in will be refused.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Desktop app**
   - Under *Authorized redirect URIs*, add `http://127.0.0.1`

   Google ignores the port for loopback redirect URIs on desktop clients, which is exactly what
   lets the app's dynamic port fallback keep working.

### 2. Give the app the credentials

```bash
cp .env.example .env
```

```ini
MAIN_VITE_GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
MAIN_VITE_GOOGLE_CLIENT_SECRET=xxxxx
```

The `MAIN_VITE_` prefix is what exposes these to the main process — a plain `GOOGLE_CLIENT_ID`
will not be picked up. Restart `npm run dev` afterwards.

For an already-installed build you can instead drop a `google-oauth.json` into the user data
directory, which avoids rebuilding:

```json
{ "clientId": "…", "clientSecret": "…" }
```

### 3. Connect

Settings → **Google Tasks** → *Connect Google account*. Sign-in opens in your normal browser
(Google blocks OAuth inside embedded app windows), then pick a task list and a task and enable
*Complete the task when the timer ends*.

Selecting a task also starts (or schedules) the stopwatch for it. Google's Tasks API never exposes
a task's actual time of day — the classic date/time picker inside the Tasks app is decorative and
always comes back as midnight — so this only picks up a real start time if the task has been
time-blocked from *Google Calendar* itself (click an empty slot → **Task**, rather than setting a
time from within the Tasks app). Without a Calendar time block, the stopwatch just starts
immediately when the task is selected.

Tokens are encrypted with Electron's `safeStorage`, which is backed by the OS keychain — DPAPI on
Windows, Keychain on macOS. If no keychain is available, Settings says so plainly rather than
silently downgrading.

The desktop client secret is not really confidential (it ships inside the binary); the flow relies
on **PKCE**, which is what actually protects the exchange.

---

## Project layout

```
src/main/
  main.js          app lifecycle, windows, tray, IPC, notifications
  server.js        Express REST + Socket.IO, port fallback, token auth
  timer-engine.js  the timer state machine (deadline-based)
  auth.js          Google OAuth (loopback + PKCE) and Tasks calls
  store.js         electron-store schema, safeStorage token handling
  tray.js          tray icon and menu
src/preload/
  preload.js       contextBridge allowlist -> window.timerAPI
src/renderer/
  App.jsx          hash router: #/overlay and #/settings
  components/      Overlay, SettingsWindow, ProgressRing, Icons
  hooks/useTimer.js  IPC subscriptions and the chime
scripts/
  generate-assets.mjs  synthesizes chime.wav, icon.png, and the tray icons from scratch
```

### Customizing the look

Three files, each holding the tokens the other two can't reach (colors are CSS, window
dimensions are a main-process/Electron concern, and a handful of values are numeric React props
rather than classes) -- edit, save, and `npm run dev`'s hot reload shows it instantly for the two
renderer files; window sizes need a relaunch since Electron doesn't hot-reload the main process.

| File | Controls | Example |
|---|---|---|
| [`src/renderer/styles.css`](src/renderer/styles.css) | Colors (light + dark), corner radius, backdrop blur, spacing density, type scale | Raise `--spacing` to make every gap, button, and icon in the app bigger at once |
| [`src/renderer/lib/theme.js`](src/renderer/lib/theme.js) | The few numbers that have to be JS, not a class -- currently just the progress ring's pixel size and stroke width | `RING_SIZE.mini` |
| [`src/main/store.js`](src/main/store.js) | The overlay window's actual pixel dimensions (`OVERLAY_SIZES`, `OVERLAY_COMPACT_SIZES`) | Widen the floating overlay |

Most of `styles.css`'s tokens (radius, blur, type scale) are Tailwind's own built-in scale keys
(`rounded-lg` already reads `--radius-lg`) rather than app-specific inventions -- they're named
explicitly so the values are sitting in one visible file instead of an implicit default buried in
`node_modules`. Changing one of them updates every component that already uses the matching
Tailwind utility, with no component code to touch.

### Design notes

A few decisions that are easy to undo by accident:

- **The timer is deadline-based.** It stores an absolute `expiresAt` and derives the remaining time
  from the wall clock. A timer that decrements a counter on an interval drifts and stops dead when
  the machine sleeps; this one wakes up correctly expired.

- **The main process owns all state.** The REST API, the tray, and the UI are three controllers
  over one `TimerEngine`. Nothing keeps a second copy of the countdown.

- **Timer and stopwatch are the same state machine.** Both anchor on a single `Date.now()`
  timestamp plus whatever was already banked, so `start`/`pause`/`resume`/`reset`/`toggle` don't
  fork into a parallel implementation for counting up — only the few lines that compute the live
  value and decide whether zero means anything differ.

- **The preload is CommonJS (`.cjs`).** Sandboxed preload scripts cannot be ES modules, and
  `"type": "module"` in `package.json` would otherwise make a `.js` preload fail to load.

- **`autoplayPolicy: 'no-user-gesture-required'`** on every window. When the API starts a timer
  there has been no click in the overlay, so Chromium would otherwise block the chime.

- **`app.setAppUserModelId(...)` runs before any window.** Windows silently drops notifications
  from an app that has not set one.

- **The overlay's clock is `shrink-0`.** As a flexible child it collapsed under its own content
  width and the overflowing digits painted straight over the buttons.

- **Tailwind v4 is configured in CSS**, in the `@theme` block in `src/renderer/styles.css`. A
  `tailwind.config.js` is a v3 concept and would be ignored.

- **`build/icon.png` is copied via `extraResources`.** electron-builder compiles it into the
  executable icon but does not otherwise ship it. `build/tray-timer.png` and
  `build/tray-stopwatch.png` (also `extraResources`) are what the tray actually loads at
  runtime -- `src/main/tray.js` picks between them to reflect the timer's current mode.

---

## Troubleshooting

**The overlay is gone.** It is hidden, not closed — click the tray icon. On Windows 11 new tray
icons start in the overflow area behind the `^` chevron; drag it out to pin it.

**`npm run dev` can't find the API.** Check the terminal for `[server] listening on …`. If the
server failed to start the GUI still works; only REST control is unavailable.

**Notifications don't appear on Windows.** Check Settings → *Desktop notification* is on, and that
Windows Focus Assist / Do Not Disturb is off.

**`ELECTRON_RUN_AS_NODE`.** If this variable is set in your shell, `electron` runs as plain Node
and the app exits immediately with a module error. Unset it before launching.
