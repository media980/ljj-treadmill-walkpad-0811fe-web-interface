# 🏃 LJJ Treadmill — Bluetooth Web Control

A Progressive Web App (PWA) to control a connected **LJJ-0811FE** walking pad (by LIJIUJIA) and other **FitShow**-compatible treadmills directly from a Chrome/Edge browser — no native app, no store, no account.

Works on Windows, Android, macOS, Linux and ChromeOS. **Does not work on iOS** (Apple blocks Web Bluetooth in Safari).

---

## 📑 Table of Contents

- [Features](#-features)
- [Compatibility](#-compatibility)
- [Installation](#-installation)
- [User Guide](#-user-guide)
  - [Connecting to the treadmill](#connecting-to-the-treadmill)
  - [Starting and stopping](#starting-and-stopping)
  - [Controlling speed](#controlling-speed)
  - [Reading live metrics](#reading-live-metrics)
  - [Installing as an app (PWA)](#installing-as-an-app-pwa)
  - [Using the activity badge](#using-the-activity-badge)
  - [Wake button and deep sleep](#wake-button-and-deep-sleep)
  - [BLE log and debugging](#ble-log-and-debugging)
- [Project Structure](#-project-structure)
- [Reverse-Engineered Protocol](#-reverse-engineered-protocol)
- [Limitations](#-limitations)
- [Customization](#-customization)
- [Troubleshooting](#-troubleshooting)
- [Project Status](#-project-status)
- [License](#-license)
- [Credits](#-credits)

---

## ✨ Features

- 🔗 **Direct Bluetooth connection** from the browser using the Web Bluetooth API — no pairing through OS settings needed
- ▶️ **Full control**: start, stop, speed adjustment, wake
- 📊 **Live metrics**: speed, elapsed time, distance, calories — all synced with the treadmill's display
- 🔄 **Two-way UI sync**: the speed slider follows the treadmill's actual speed, not just your last command
- 📱 **Installable as a PWA** on desktop and Android — icon on home screen, runs in standalone window
- ⏱️ **Elapsed time in the tab title** — visible at a glance in the taskbar
- 🔢 **Numeric badge on the app icon** showing minutes elapsed (Windows taskbar, Android home screen)
- 🔒 **Screen wake lock** during workouts — your device screen won't dim while the treadmill is running
- ⚠️ **Accidental close protection** — the browser prompts for confirmation if you try to close the tab while running
- 🔍 **Built-in BLE inspector** — view all GATT services, send raw hex commands, read notifications

---

## 🎯 Compatibility

Tested and confirmed working on:

- **LIJIUJIA LJJ-0811FE** walking pad (startup strategy "LJJ")
- **RUNimon** treadmill, Bluetooth name `FS-E30107` (startup strategy "FitShow standard") — Start/Stop/Restart implemented per the FitShow protocol; awaiting confirmation on hardware

Should work with any treadmill exposing the FitShow BLE service (UUID `0xFFF0`), including many rebranded walking pads sold under various Amazon/AliExpress generic brands. If the Bluetooth name starts with `FS-` or `LJJ-` and the official FitShow app works with it, this web app likely will too.

Browser requirements: **Chrome 89+**, **Edge 89+**, **Opera** or any Chromium-based browser on Windows, macOS, Linux, Android, ChromeOS. Safari is **not supported** (Apple does not implement Web Bluetooth).

---

## 🚀 Installation

### Option 1 — GitHub Pages

Enable GitHub Pages on your fork (Settings → Pages → Source: `main` → `/ (root)`). The app becomes available at `https://<user>.github.io/<repo>/`.

### Option 2 — Netlify Drop

Drag and drop the project folder onto [app.netlify.com/drop](https://app.netlify.com/drop) for an instant HTTPS URL without any account.

### Option 3 — Local testing

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/` in Chrome.

### Option 4 — Opening the HTML file directly

For quick experimentation without any server, you can clone or download the repo and double-click `index.html` to open it in your browser. Most features work this way, including Bluetooth control, speed adjustment and live metrics.

However, PWA installation and the taskbar badge feature **will not work** because they require the page to be served over HTTPS (or localhost). For the full experience, use one of the three options above.

> ⚠️ Web Bluetooth **requires HTTPS** (or `localhost` for development). On some browsers/versions, `file://` may also work for Bluetooth, but not for PWA features.

---

## 📖 User Guide

### Connecting to the treadmill

1. Turn on the treadmill and make sure the screen is active (not in deep sleep — see [limitations](#-limitations))
2. Open the web app in Chrome/Edge
3. Click **🔗 Connecter le tapis** (Connect the treadmill)
4. In the Bluetooth device picker, select the treadmill (its name usually starts with `LJJ-`, `FS-` or similar)
5. Wait for the status indicator to turn green with the treadmill's name

Once connected, the app starts polling the treadmill every 500 ms to read its status. You should see a steady exchange of TX/RX frames in the BLE log panel.

### Starting and stopping

- **▶ Start**: starts the treadmill and then applies the speed shown in the slider. The command sequence depends on the **startup strategy** (selector under the speed controls):
  - **Auto** (default): `LJJ-…` names use the LJJ strategy, everything else uses FitShow standard.
  - **FitShow standard** (RUNimon `FS-E30107` and most `FS-…` devices): sends the dedicated Start/Resume command `53 01`, waits until the treadmill reports *running* (after its 3-2-1 countdown), then sends the target speed. If the treadmill does not report a start within 10 s, the app gives up — it **never retries a start automatically**.
  - **LJJ-0811FE**: sends Wake (`44 01`) followed by Set Speed (`53 02`), with one speed confirmation 1.5 s later.
- **⏹ Stop**: has priority over everything — it cancels a start in progress, discards queued speed changes and is written immediately (no waiting for the next poll). If the treadmill still reports *running* 2 s later, Stop is re-sent (3 attempts maximum).

The running state shown in the app always comes from the treadmill's own status frames, not from the buttons pressed. After a stop, you can click Start again without any additional setup. The previously selected speed is remembered. Changing the speed while the belt is stopped only updates the setpoint; it never starts the belt.

### Controlling speed

Four ways to change speed, all of them work both when the treadmill is running and when it is idle:

- **Slider**: drag to any value between min and max speed. Release to commit.
- **± buttons**: increment/decrement by 0.5 km/h.
- **Preset buttons**: quick jump to 1, 2, 3, 4, 5 or 6 km/h.
- **Big number display**: read-only, shows the current setpoint.

The speed range is **auto-detected** from the treadmill at connection time (SPEED_INFO query). For the LJJ-0811FE this is 1.0 to 6.0 km/h.

**Two-way sync behavior**: the slider reflects the treadmill's actual speed, except during a 3-second grace period after you change it manually — to avoid having your adjustment overwritten by the next polling response.

### Reading live metrics

Four metrics are displayed and updated once per second:

- **Vitesse** — current belt speed in km/h (from treadmill)
- **Temps** — elapsed time in mm:ss (from treadmill)
- **Distance** — total distance in km (from treadmill)
- **Calories** — estimated calories burned (from treadmill)

Values come straight from the treadmill's counters, so they match exactly what you see on the physical display. Time and distance reset to zero when you Stop — this is the treadmill's behavior, not the app's.

### Installing as an app (PWA)

The app can be installed as a standalone application. Benefits:

- Dedicated icon on your desktop / home screen / taskbar
- Opens in its own window without browser UI
- Works as a first-class app (Alt+Tab on Windows, app switcher on Android)
- Enables the activity badge feature (see below)

To install:

- **Chrome / Edge desktop**: click the install icon in the address bar, or use the blue "Installer" banner in the app
- **Android Chrome**: tap the install prompt, or use the three-dot menu → "Install app"
- **iOS Safari** (limited — no Bluetooth available, just for UI preview): Share button → "Add to Home Screen"

Once installed, launching from the icon opens the app in standalone mode automatically.

### Using the activity badge

When running as an installed PWA on a supported platform (Windows 10/11, Android), the app displays the **elapsed minutes directly on the app icon** in the taskbar / home screen.

- Treadmill idle: no badge
- Running for 5 minutes: icon shows a "**5**" badge
- Running for 37 minutes: icon shows a "**37**" badge

This lets you glance at the taskbar and know your workout progress without switching to the app window. The tab title also shows the full `mm:ss 🏃` format, visible when hovering the icon.

Platform notes:
- **Windows 10/11 taskbar**: works with Chrome and Edge
- **Android home screen**: works on most launchers
- **macOS dock**: not supported by macOS
- **Linux**: varies by desktop environment

### Wake button and deep sleep

The **⏰ Wake** button sends a wake command (`02 44 01`) to the treadmill. This command is specific to the LJJ-0811FE; standard FitShow treadmills such as the RUNimon do not need it. Useful if:

- The treadmill shows no response to Start but the Bluetooth connection is still alive
- The treadmill was idle for a while and seems locked

Limitation: once the treadmill enters **deep sleep** (screen completely off, no response to any command), even this button cannot wake it up. The official FitShow app has the same limitation — this appears to be a hardware-level sleep mode that can only be broken by the treadmill's internal timer.

### BLE log and debugging

The bottom panel shows all Bluetooth frames exchanged with the treadmill in real time:

- **TX** (yellow): commands sent to the treadmill
- **RX** (green): responses or notifications from the treadmill
- **Info / Err**: app-level events

Controls:

- **Masquer polling** checkbox (enabled by default): hides the repetitive status heartbeat to keep the log readable, showing only a compact counter instead
- **⏸ Pause**: freezes the log so you can read it without it scrolling
- **Clear**: wipes the log and resets counters
- **Masquer / Afficher**: collapses the log panel

A **🔍 Debug trame running** panel under the metrics shows the last status frame broken down byte by byte with interpretations — useful for understanding the protocol or debugging a model variation.

---

## 📁 Project Structure

```
.
├── index.html          # UI (HTML + CSS + Web Bluetooth wiring)
├── treadmill-core.js   # FitShow protocol: frames, command queue, start strategies, Stop
├── manifest.json       # PWA manifest
├── sw.js               # Service worker (network-first, offline fallback)
├── icon-192.png        # 192×192 icon
├── icon-512.png        # 512×512 icon
├── package.json        # test scripts only (no runtime dependency)
├── test/               # automated tests with simulated treadmills
└── README.md           # This file
```

No build step, no runtime dependencies. `treadmill-core.js` has no DOM or Bluetooth code, so it can be tested in Node.

### Tests

```bash
npm test          # protocol/queue/start-stop tests (Node 18+, no install needed)
npm run test:ui   # optional: index.html in headless Chromium with a fake Bluetooth device (needs Playwright)
```

The tests use simulated treadmills (FitShow standard and LJJ-0811FE). They check the byte sequences and timing logic; they cannot prove the physical treadmill behaves the same way.

---

## 🔧 Reverse-Engineered Protocol

The treadmill uses a proprietary variant of the **FitShow** BLE protocol, close to but not identical to the public reference implementation ([tyge68/fitshow-treadmill](https://github.com/tyge68/fitshow-treadmill), which documents the Sportstech F31).

### BLE Service

| Element | UUID | Role |
|---|---|---|
| Service | `0000fff0-0000-1000-8000-00805f9b34fb` | Virtual serial port |
| Characteristic | `0000fff1-...` | Notifications (treadmill → app) |
| Characteristic | `0000fff2-...` | Writes (app → treadmill) |

### Frame Format

```
[0x02, opcode, ...parameters, checksum_XOR, 0x03]
```

- `0x02` = start of frame
- `checksum` = XOR of all bytes **between** the start byte and the checksum (exclusive of both)
- `0x03` = end of frame

### Commands

| Action | Frame (excluding checksum and 0x03) | Notes |
|---|---|---|
| Status (heartbeat) | `02 51` | every 500 ms |
| Start / Resume | `02 53 01 [sport ID ×4] [mode] [blocks] [value ×2]` | all zero = free run. Full frame: `02 53 01 00 00 00 00 00 00 00 00 52 03` |
| Set speed / incline target | `02 53 02 [speed×10] [incline]` | reply reports the **actual** speed (`02 53 02 00 00 51 03` when the belt is stopped) |
| Stop | `02 53 03` | full frame `02 53 03 50 03` |
| Pause | `02 53 06` | resumed with Start `53 01` |
| Query speed range | `02 50 02` | reply `02 50 02 [max] [min] [unit] cs 03` |
| Query incline range | `02 50 03` | |
| **Wake** (LJJ-0811FE only) | `02 44 01` | not part of standard FitShow |

Responses are matched to the command by opcode + sub-command only (never by parameters), because the speed reply reports the actual speed rather than the requested one. Status frames are always processed, whether they answer a poll or not.

### Startup strategies

- **FitShow standard** (RUNimon `FS-E30107`): `53 01` → status *countdown* (`51 02 [s]`) → status *running* (`51 03 …`) → `53 02 [target]`. Sending `53 02` while the belt is stopped does nothing on these treadmills (the reply reports speed 0), which is why the old Wake + Speed sequence could not start them.
- **LJJ-0811FE**: the official Start (`53 01`) is **ignored**; `44 01` (Wake) followed by `53 02 [speed]` starts the belt.

The strategy is picked from the Bluetooth name or forced in the UI.

### Status codes (`02 51 [code] …`)

| Code | Meaning |
|---|---|
| `00` | idle |
| `01` | session ended |
| `02` | start countdown (next byte = seconds left) |
| `03` | running |
| `04` | stopping / decelerating (the LJJ-0811FE also sends it while running) |
| `05` | error |
| `06` | safety key removed |
| `0A` | paused |

A belt is considered running when the code is `03`, or when a full 17-byte frame reports a speed above 0.

### Mandatory Polling

The firmware expects a **heartbeat** every 500 ms (`02 51`). Without this polling, control commands are rejected. This is not optional.

### 17-byte STATUS frame (response to `02 51` while running)

```
[0]  0x02                      start
[1]  0x51                      opcode status
[2]  state code                (see table above)
[3]  speed×10                  current speed in 0.1 km/h
[4]  incline                   current incline
[5..6] time (LE)               elapsed seconds
[7..8] distance (LE)           in decameters, divide by 100 for km
[9..10] calories×10 (LE)       divide by 10 for kcal
[11..14]                       reserved / unused
[15] checksum                  XOR of bytes 1..14
[16] 0x03                      end
```

---

## ⚠️ Limitations

- **No wake from deep sleep**: when the treadmill's screen fully turns off after prolonged inactivity, no BLE command can wake it back up. The official FitShow app has the same issue. Waiting for the treadmill to wake up on its own (timer-based, seemingly random) is the only workaround. There is no physical button or remote included with this model.
- **iOS is not supported**: Apple does not implement Web Bluetooth in Safari, and other browsers on iOS must use the Safari engine. Use an Android device, PC, or Mac.
- **No session history**: deliberately omitted to keep the app lightweight. The treadmill itself displays current session time and distance.
- **Bluetooth Classic not supported**: only BLE (Bluetooth Low Energy) works. Older treadmills using Bluetooth Classic SPP require a different approach.
- **Only one controller at a time**: FitShow-protocol treadmills accept only one Bluetooth client. Close the official FitShow app (and any other controller) before connecting with this web app.

---

## 🎨 Customization

Everything is in `index.html`, so grepping for the relevant keyword will take you there.

- **Colors**: CSS variables at the top of the `<style>` block (`--accent`, `--bg`, `--ok`, etc.)
- **Speed presets**: search for `speed-presets` in the HTML to change the preset buttons
- **Title emoji**: search for `${timeStr} 🏃` in the JS to swap the emoji (🏋️ 💪 ⏱️ 🔥 all work)
- **Polling interval**: `POLL_INTERVAL_MS` constant (default: 500 ms, don't go below 200)
- **Grace period for UI sync**: the 3-second window in `syncSpeedUI()` during which the slider won't be overwritten by polling responses
- **Default speed range**: the app queries the treadmill at connect time, but you can override `state.minSpeed` / `state.maxSpeed` defaults

---

## 🐛 Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Treadmill doesn't appear in the Bluetooth picker | Already paired with another device | Close FitShow on other devices, remove from OS Bluetooth settings |
| "Pas de service FitShow 0xFFF0" error | Wrong device selected or treadmill in deep sleep | Select the right device / verify screen is on |
| Start sent but treadmill doesn't move | Wrong startup strategy, safety key, or deep sleep | Check the "Démarrage" selector (FitShow standard for `FS-…`, LJJ for `LJJ-…`), insert the safety key, then wait for spontaneous wake if the screen is off |
| Commands work but speed is stuck at minimum | The treadmill ignored the setpoint briefly | Wait for the 1.5s auto-reconfirm, or click Start again |
| Install banner never appears | Service worker not registered, or already installed, or non-HTTPS | Open F12 → Application → Manifest and check for errors |
| PWA installed but no badge on Windows taskbar | App opened in browser tab, not standalone | Close the browser tab and launch via the installed app icon instead |
| Connection drops after a few seconds | Polling interrupted by another app | Make sure nothing else is querying the treadmill |
| Metrics show odd values (×10 or ×100 off) | Protocol variant differs from LJJ-0811FE | Open an issue with your treadmill model and a debug frame dump |

For deeper debugging, open Chrome DevTools (F12):

- **Application** → **Manifest**: validates PWA setup
- **Application** → **Service Workers**: confirms SW is active
- **Console**: app logs and runtime errors

---

## 🔒 Project Status

This project is provided **as-is**, in read-only mode. It was developed for a specific treadmill model (LJJ-0811FE) and shared publicly in the hope it helps others with similar hardware.

Feel free to fork and adapt it to your own needs — the code is intentionally kept simple and dependency-free to make that easy. The reverse-engineered protocol documentation in this README should give you everything you need to extend compatibility to other FitShow-variant treadmills.

---

## 📜 License

MIT — do whatever you want with it.

---

## 🙏 Credits

- Vibe coded with [Claude](https://claude.ai) (Opus 4.7) by Anthropic — protocol reverse-engineering and full implementation through iterative conversation
- [tyge68/fitshow-treadmill](https://github.com/tyge68/fitshow-treadmill) for documenting the base FitShow protocol (Sportstech F31 reference)
- The countless blog posts and GitHub issues about BLE reverse-engineering that made this possible
