# Torrent Downloader

A local-first BitTorrent client for macOS. Paste a magnet link, see what's inside it, pick the files you actually want, and download them.

Built because most free torrent clients either hide the useful controls behind a paywall, bolt on things nobody asked for, or quietly do the wrong thing — a progress bar that sticks at 99%, a "pause" that keeps transferring, a per-torrent setting that does nothing. This one aims to be small, honest about its limits, and correct in the places that matter.

![Torrent Downloader](resources/icons/icon-1024.png)

---

## What it does

- **Magnet links and `.torrent` files** — paste, drop, or open from the browser via the `magnet:` scheme
- **Metadata before commitment** — a magnet carries no file list, so it's fetched from the swarm and shown to you *before* anything is written to disk
- **Selective download** — tick the files you want, set per-file priority, skip the rest
- **Real pause** — actually stops the network, keeps every verified byte
- **Fast resume** — restart the app and it picks up where it left off, sample-verifying rather than rehashing gigabytes
- **Recheck** — hash-verify what's on disk and re-fetch only the damaged pieces
- **Seeding goals** — seed to a ratio, for a time, or indefinitely; global or per torrent
- **Bandwidth limits** — global download/upload caps, reachable from the title bar or the menu bar
- **Details** — files, peers, trackers, availability, ratio, piece counts
- **Light / dark / system** themes, menu bar item, native notifications

### What it deliberately does not do

No accounts. No cloud sync. No analytics, telemetry, ads, or remote database. No auto-update service. Your magnet links and torrent metadata never leave your Mac except as the BitTorrent protocol itself requires — talking to trackers, the DHT, and peers.

It is a plain BitTorrent client. It contains nothing for bypassing DRM, encryption, paywalls, or access controls, and that is a deliberate boundary rather than an oversight. What you choose to download with it is your responsibility.

---

## Install

**Requirements:** macOS 11 or later, Apple Silicon (arm64).

Download the `.dmg` from [Releases](../../releases), open it, and drag the app to Applications.

The build is **unsigned** — there's no Apple Developer certificate behind it. macOS will refuse to open it on the first try. Right-click the app → **Open** → **Open**, once. After that it launches normally. Or from a terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Torrent Downloader.app"
```

Intel Macs aren't built by default. `npm run dist:universal` produces a universal binary if you need one, though it hasn't been tested on Intel hardware.

---

## Build from source

```bash
git clone https://github.com/asadrao98/torrent-downloader.git
cd torrent-downloader
npm install
```

`npm install` compiles three optional native modules (`utp-native`, `bufferutil`, `utf-8-validate`) via `electron-builder install-app-deps`. You'll need Xcode Command Line Tools:

```bash
xcode-select --install
```

| Command | What it does |
|---|---|
| `npm run dev` | Run in development, with hot reload |
| `npm run build` | Typecheck and bundle to `out/` |
| `npm test` | Unit tests |
| `npm run test:integration` | Engine tests against a real loopback swarm |
| `npm run test:e2e` | Playwright tests driving the real app |
| `npm run typecheck` | All three TypeScript projects |
| `npm run pack:dir` | Unpacked `.app` in `dist/mac-arm64/` |
| `npm run dist` | `.app`, `.dmg` and `.zip` |
| `npm run dist:dmg` | `.dmg` only |
| `npm run dist:universal` | Universal arm64 + x86_64 build |

Two dev-mode caveats: the `magnet:` URL handler and Launch-at-Login only take effect in the **packaged** app, because in development they'd register against the Electron binary rather than this app.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Renderer  (React 19, sandboxed)                    │
│  no Node, no filesystem, no network                 │
└───────────────────────┬─────────────────────────────┘
                        │  contextBridge — ~35 named methods,
                        │  no generic invoke() escape hatch
┌───────────────────────┴─────────────────────────────┐
│  Main process (Node)                                │
│  ┌───────────────────────────────────────────────┐  │
│  │ TorrentManager   queue, seeding goals,        │  │
│  │                  persistence, snapshots       │  │
│  ├───────────────────────────────────────────────┤  │
│  │ TorrentEngine    ← the only WebTorrent-aware  │  │
│  │                    module in the codebase     │  │
│  └───────────────────────────────────────────────┘  │
└───────────────────────┬─────────────────────────────┘
                        │
        DHT · trackers · PEX · µTP/TCP peers · web seeds
```

```
app/
├── main/         engine, manager, IPC, persistence, settings, tray, menu
├── preload/      the contextBridge surface — the only renderer↔main channel
├── renderer/     React UI: pages, components, state, styles
└── shared/       types, magnet parsing, path safety, piece math (pure, tested)
```

### Why Electron + WebTorrent

The requirement was normal BitTorrent — real TCP/µTP peers, DHT, trackers, PEX — not a browser-only WebRTC client. The candidates were libtorrent (best coverage, painful to bundle), librqbit (good, needs a Rust toolchain and a sidecar binary), and WebTorrent in Node.

WebTorrent won on the tradeoff. In the **Node** main process it is not the WebRTC-only thing it's often assumed to be — it pulls `bittorrent-protocol` (real wire protocol over TCP), `bittorrent-dht`, `torrent-discovery` for HTTP/UDP trackers, `ut_pex`, `ut_metadata`, and optionally `utp-native` for µTP. Protocol encryption (MSE/PE) is on by default. And it needs no native toolchain beyond three optional addons, which keeps the build reproducible.

The cost is throughput — it's JavaScript doing SHA-1 and socket handling, so it won't match libtorrent on a large swarm. Everything WebTorrent-specific lives behind the `TorrentEngine` interface in `app/main/torrent-engine.ts`, so swapping in a libtorrent or librqbit sidecar means writing one more implementation of that interface and nothing else.

### Security

Torrent metadata is attacker-controlled input, and it's treated that way.

- **Path sanitisation** (`app/shared/path-safety.ts`) — strips traversal, absolute paths, drive letters, UNC prefixes, NUL and control characters, bidi overrides that fake a file extension, reserved device names, leading tildes, and over-long components; renames collisions so one file can't silently overwrite another
- **Filesystem containment** (`app/main/path-guard.ts`) — resolves through symlinks and refuses anything landing outside the download folder; also refuses protected system locations as download targets
- **Magnet validation** — tracker and web-seed URLs are allowlisted by scheme, so a magnet can't smuggle a `javascript:` or `file:` URL into the engine
- **Renderer sandbox** — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP, all navigation and window-open handled or denied

Paths are rewritten *before* the engine opens a file. Because `parse-torrent` re-encodes from the untouched raw info dict, rewriting file paths changes where bytes land without altering the info hash, piece hashes, or byte offsets.

---

## Upstream bugs worked around

These were found by measuring rather than trusting the library, and each has a regression test. They're documented here because anyone building on WebTorrent will hit them.

| Behaviour | Reality | Where |
|---|---|---|
| `torrent.pause()` | Blocks *new* peers and connections only. The piece-request loop never reads the flag, so connected wires keep downloading. Pause is implemented as capture-bitfield-then-destroy-handle. | `torrent-manager.ts` |
| `opts.fileModtimes` | Looks like a companion to `opts.bitfield`, but when mtimes match it calls `_markAllVerified()` — marking every piece verified and ignoring the bitfield. A partial torrent reports 100% and would serve unverified data. Never passed. | `torrent-engine.ts` |
| `File.downloaded` | Subtracts a whole piece as "irrelevant" when a file ends exactly on a piece boundary, so progress never reaches 100%. Replaced with byte-range overlap math. | `shared/piece-math.ts` |
| `file.deselect()` | `Selections.remove()` subtracts piece *ranges*. Adjacent files share their boundary piece, so deselecting a skipped file strips that piece from its selected neighbour and the download stalls a few KB short. Skipped files are simply never selected. | `torrent-engine.ts` |

Verified against **webtorrent 3.0.21**. A later release may fix any of them.

---

## Testing

| Suite | Count | What it actually does |
|---|---|---|
| Unit | 113 | Magnet parsing, path sanitisation, piece math, formatting — all pure |
| Integration | 23 | Runs a **real HTTP tracker and seeding client on loopback**: real wire protocol, real SHA-1 piece verification, real tracker announces |
| End-to-end | 19 | Playwright drives the built app — pastes a magnet, downloads to completion, pauses, rechecks, restarts, verifies bytes on disk |

Nothing is mocked. The integration suite downloads real files and hash-compares them against the seeder, corrupts a file to prove recheck detects and repairs it, and asserts a partially downloaded torrent never comes back reporting complete.

The one thing tested synthetically rather than live is the thousands-of-files case, which uses a generated `.torrent` instead of a real download.

---

## Known limitations

- **Apple Silicon only** in the published build; Intel is untested
- **Unsigned and un-notarised** — first launch needs the right-click → Open step
- **Bandwidth limits are global**, not per torrent. WebTorrent throttles per client, so a per-torrent cap can't be enforced — rather than ship a control that silently does nothing, there isn't one
- **Recheck progress is indeterminate.** WebTorrent emits `verified` only for pieces it finds intact and nothing for missing ones, so there's no honest way to derive a percentage. It shows a running count instead of a made-up number
- **Tracker errors aren't attributed.** The engine reports announce failures without naming the tracker, so a failing tracker shows as `idle` rather than being blamed incorrectly
- **BitTorrent v2-only torrents** are not supported; v1 and hybrid are
- Throughput is below a native client on large swarms

---

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Licence

MIT — see [LICENSE](LICENSE).
